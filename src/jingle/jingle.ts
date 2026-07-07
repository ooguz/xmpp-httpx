import xml, { Element } from "@xmpp/xml";
import type { DataDescriptor } from "../codec/data.js";
import {
  DEFAULT_IBB_BLOCK_SIZE,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_OFFER_TTL_MS,
  MAX_CHUNK_SIZE,
  NS_JINGLE,
  NS_JINGLE_ERRORS,
  NS_JINGLE_FT,
  NS_JINGLE_IBB,
  NS_STANZAS,
} from "../constants.js";
import { fromXmppError, HttpxError } from "../errors.js";
import { IbbManager } from "../ibb/ibb.js";
import {
  bareJid,
  generateId,
  type IqContext,
  type XmppSession,
} from "../session.js";
import type { BodyOffer, BodyTransport } from "../transport/registry.js";
import type { StreamAcceptFlags } from "../transport/select.js";
import { deferredStream, iterateStream } from "../util/bytes.js";
import { cloneElement } from "../util/xml.js";

/**
 * Minimal Jingle (XEP-0166) subset for the "jingle" data mechanism of
 * XEP-0332: a file-transfer content (XEP-0234, description ignored on
 * receive) over the XEP-0261 In-Band Bytestreams transport, whose sid is a
 * plain XEP-0047 sid handled by the shared IbbManager. No ICE/SOCKS5/DTLS.
 *
 * Deviation forced by XEP-0332 (documented in docs/protocol-notes.md): the
 * <jingle action='session-initiate'> embedded in <data> IS the initiate — no
 * separate initiate IQ is sent; a duplicate initiate IQ bearing a known sid
 * is acked as a hedge.
 */

export interface JingleOffer {
  readonly sessionId: string;
  readonly transportSid: string;
  /** The <jingle action='session-initiate'> element to embed in <data>. */
  readonly element: Element;
  cancel(reason?: Error): void;
}

interface SessionState {
  direction: "out" | "in";
  peer: string; // bare JID
  transportSid: string;
  blockSize: number;
  body?: BodyOffer; // out only
  accepted: boolean;
  ttlTimer?: ReturnType<typeof setTimeout>;
}

function jingleIqError(condition: string): Element {
  return xml(
    "error",
    { type: "cancel" },
    xml(condition, { xmlns: NS_STANZAS }),
    xml("unknown-session", { xmlns: NS_JINGLE_ERRORS }),
  );
}

export class JingleManager {
  static #instances = new WeakMap<object, JingleManager>();

  static acquire(session: XmppSession): JingleManager {
    let manager = JingleManager.#instances.get(session);
    if (!manager) {
      manager = new JingleManager(session);
      JingleManager.#instances.set(session, manager);
    }
    manager.#refs++;
    manager.#ensureStarted();
    return manager;
  }

  readonly #session: XmppSession;
  readonly #ibb: IbbManager;
  #refs = 0;
  #handlersRegistered = false;
  #sessions = new Map<string, SessionState>();

  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;

  private constructor(session: XmppSession) {
    this.#session = session;
    this.#ibb = IbbManager.acquire(session);
  }

  release(): void {
    this.#refs--;
    if (this.#refs > 0) return;
    this.#refs = 0;
    for (const state of this.#sessions.values()) {
      if (state.ttlTimer !== undefined) clearTimeout(state.ttlTimer);
    }
    this.#sessions.clear();
    this.#ibb.release();
  }

  // --------------------------------------------------------------- initiator

  /** Builds a session-initiate and registers the pending session. Nothing is
   * sent — the element travels inside the httpx <data> and the peer accepts. */
  offer(to: string, body: BodyOffer): JingleOffer {
    const sessionId = generateId("jsess");
    const transportSid = generateId("jibb");
    const blockSize = Math.min(
      body.blockSize ?? DEFAULT_IBB_BLOCK_SIZE,
      MAX_CHUNK_SIZE,
    );

    const file = xml("file", null, xml("name", null, body.name ?? "body"));
    if (body.contentType !== undefined) {
      file.append(xml("media-type", null, body.contentType));
    }
    file.append(xml("size", null, String(body.contentLength ?? 0)));

    const element = xml(
      "jingle",
      {
        xmlns: NS_JINGLE,
        action: "session-initiate",
        initiator: body.from ?? this.#session.jid?.toString() ?? "",
        sid: sessionId,
      },
      xml(
        "content",
        { creator: "initiator", name: "http-body", senders: "initiator" },
        xml("description", { xmlns: NS_JINGLE_FT }, file),
        xml("transport", {
          xmlns: NS_JINGLE_IBB,
          "block-size": String(blockSize),
          sid: transportSid,
        }),
      ),
    );

    const key = this.#key(to, sessionId);
    const ttlTimer = setTimeout(() => {
      this.#sessions.delete(key);
    }, body.ttlMs ?? DEFAULT_OFFER_TTL_MS);
    (ttlTimer as { unref?: () => void }).unref?.();

    this.#sessions.set(key, {
      direction: "out",
      peer: bareJid(to),
      transportSid,
      blockSize,
      body,
      accepted: false,
      ttlTimer,
    });

    return {
      sessionId,
      transportSid,
      element,
      cancel: () => {
        const state = this.#sessions.get(key);
        if (state && !state.accepted) {
          if (state.ttlTimer !== undefined) clearTimeout(state.ttlTimer);
          this.#sessions.delete(key);
        }
      },
    };
  }

  #onSessionAccept(ctx: IqContext): Element | boolean {
    const from = ctx.from?.toString();
    const sid = ctx.element.attrs["sid"];
    if (!from || !sid) return jingleIqError("item-not-found");

    const key = this.#key(from, sid);
    const state = this.#sessions.get(key);
    if (!state || state.direction !== "out" || state.accepted) {
      return jingleIqError("item-not-found");
    }

    const transport = ctx.element
      .getChild("content")
      ?.getChild("transport", NS_JINGLE_IBB);
    const echoedSid = transport?.attrs["sid"];
    if (!transport || echoedSid !== state.transportSid) {
      return xml(
        "error",
        { type: "cancel" },
        xml("bad-request", { xmlns: NS_STANZAS }),
      );
    }
    const acceptedBlock = Number(transport.attrs["block-size"]);
    const blockSize =
      Number.isInteger(acceptedBlock) && acceptedBlock > 0
        ? Math.min(state.blockSize, acceptedBlock, MAX_CHUNK_SIZE)
        : state.blockSize;

    state.accepted = true;
    if (state.ttlTimer !== undefined) clearTimeout(state.ttlTimer);

    // Pump the body after the ack has flushed.
    setTimeout(() => {
      this.#runInitiatorTransfer(from, sid, key, { ...state, blockSize }).catch(
        (err: unknown) => state.body?.onError?.(err),
      );
    }, 0);

    return true;
  }

  async #runInitiatorTransfer(
    to: string,
    sessionId: string,
    key: string,
    state: SessionState,
  ): Promise<void> {
    const body = state.body!;
    const openOptions: { sid: string; blockSize: number; from?: string } = {
      sid: state.transportSid,
      blockSize: state.blockSize,
    };
    if (body.from !== undefined) openOptions.from = body.from;

    try {
      const out = await this.#ibb.openOutgoing(to, openOptions);
      try {
        const stream = await body.open();
        for await (const part of iterateStream(stream)) {
          await out.write(part);
        }
        await out.close();
      } catch (err) {
        const reason = err instanceof Error ? err : new Error(String(err));
        await out.abort(reason);
        throw reason;
      }
      await this.#terminate(to, body.from, sessionId, "success");
    } catch (err) {
      await this.#terminate(to, body.from, sessionId, "failed-transport").catch(
        () => {},
      );
      throw fromXmppError(err);
    } finally {
      this.#sessions.delete(key);
    }
  }

  async #terminate(
    to: string,
    from: string | undefined,
    sessionId: string,
    reason: string,
  ): Promise<void> {
    const attrs: Record<string, string> =
      from !== undefined ? { type: "set", to, from } : { type: "set", to };
    await this.#session.iqCaller.request(
      xml(
        "iq",
        attrs,
        xml(
          "jingle",
          { xmlns: NS_JINGLE, action: "session-terminate", sid: sessionId },
          xml("reason", null, xml(reason, null)),
        ),
      ),
      this.idleTimeoutMs,
    );
  }

  // --------------------------------------------------------------- responder

  /** Accepts an embedded session-initiate and returns the body stream.
   * Lazy: session-accept is sent on first read. */
  receive(
    from: string,
    initiate: Element,
    options?: { timeoutMs?: number; ourJid?: string },
  ): ReadableStream<Uint8Array> {
    const timeoutMs = options?.timeoutMs ?? this.idleTimeoutMs;
    return deferredStream(async () => {
      const sessionId = initiate.attrs["sid"];
      if (!sessionId) {
        throw new HttpxError("protocol-error", "jingle initiate without sid");
      }
      const content = initiate.getChild("content");
      const transport = content?.getChild("transport", NS_JINGLE_IBB);
      const transportSid = transport?.attrs["sid"];
      if (!content || !transport || !transportSid) {
        // Not an IBB transport — decline the session and give up.
        await this.#terminate(from, options?.ourJid, sessionId, "decline").catch(
          () => {},
        );
        throw new HttpxError(
          "not-implemented",
          "jingle offer without an in-band bytestreams transport",
        );
      }

      const offeredBlock = Number(transport.attrs["block-size"]);
      const blockSize =
        Number.isInteger(offeredBlock) && offeredBlock > 0
          ? Math.min(offeredBlock, MAX_CHUNK_SIZE)
          : DEFAULT_IBB_BLOCK_SIZE;

      const key = this.#key(from, sessionId);
      this.#sessions.set(key, {
        direction: "in",
        peer: bareJid(from),
        transportSid,
        blockSize,
        accepted: true,
      });

      // Arm the data plane BEFORE accepting.
      const incoming = this.#ibb.expectIncoming(from, transportSid, {
        timeoutMs,
      });
      incoming.catch(() => {}); // consumed below; silence park-expiry noise

      const description = content.getChild("description");
      const acceptEl = xml(
        "jingle",
        {
          xmlns: NS_JINGLE,
          action: "session-accept",
          responder:
            options?.ourJid ?? this.#session.jid?.toString() ?? "",
          sid: sessionId,
        },
        xml(
          "content",
          {
            creator: content.attrs["creator"] ?? "initiator",
            name: content.attrs["name"] ?? "http-body",
            senders: content.attrs["senders"] ?? "initiator",
          },
          ...(description ? [cloneElement(description)] : []),
          xml("transport", {
            xmlns: NS_JINGLE_IBB,
            "block-size": String(blockSize),
            sid: transportSid,
          }),
        ),
      );
      const attrs: Record<string, string> =
        options?.ourJid !== undefined
          ? { type: "set", to: from, from: options.ourJid }
          : { type: "set", to: from };
      try {
        await this.#session.iqCaller.request(
          xml("iq", attrs, acceptEl),
          timeoutMs,
        );
      } catch (err) {
        this.#sessions.delete(key);
        throw fromXmppError(err);
      }

      return (await incoming).readable;
    });
  }

  // ---------------------------------------------------------------- dispatch

  #dispatch(ctx: IqContext): Element | boolean | Promise<Element | boolean> {
    const action = ctx.element.attrs["action"];
    switch (action) {
      case "session-accept":
        return this.#onSessionAccept(ctx);
      case "session-terminate":
        return this.#onSessionTerminate(ctx);
      case "session-initiate":
        return this.#onSessionInitiate(ctx);
      default:
        return this.#onSessionInfo(ctx);
    }
  }

  #onSessionTerminate(ctx: IqContext): Element | boolean {
    const from = ctx.from?.toString();
    const sid = ctx.element.attrs["sid"];
    if (!from || !sid) return jingleIqError("item-not-found");
    const key = this.#key(from, sid);
    const state = this.#sessions.get(key);
    if (!state) return jingleIqError("item-not-found");
    // An in-progress receive ends via the IBB close (success path) or its
    // idle timeout (failure path); terminate only cleans up session state.
    if (state.ttlTimer !== undefined) clearTimeout(state.ttlTimer);
    this.#sessions.delete(key);
    return true;
  }

  /** Duplicate of the initiate embedded in <data>: ack if known, else refuse. */
  #onSessionInitiate(ctx: IqContext): Element | boolean {
    const from = ctx.from?.toString();
    const sid = ctx.element.attrs["sid"];
    if (from && sid && this.#sessions.has(this.#key(from, sid))) {
      return true;
    }
    return xml(
      "error",
      { type: "cancel" },
      xml("service-unavailable", { xmlns: NS_STANZAS }),
    );
  }

  /** session-info / transport-info / anything else: ack known, refuse unknown. */
  #onSessionInfo(ctx: IqContext): Element | boolean {
    const from = ctx.from?.toString();
    const sid = ctx.element.attrs["sid"];
    if (from && sid && this.#sessions.has(this.#key(from, sid))) {
      return true;
    }
    return jingleIqError("item-not-found");
  }

  #ensureStarted(): void {
    if (this.#handlersRegistered) return;
    this.#handlersRegistered = true;
    this.#session.iqCallee.set(NS_JINGLE, "jingle", (ctx) => this.#dispatch(ctx));
  }

  #key(peer: string, sessionId: string): string {
    return `${bareJid(peer)}\n${sessionId}`;
  }
}

/** BodyTransport adapter for the registry. */
export class JingleTransport implements BodyTransport {
  readonly kind = "jingle";
  readonly #manager: JingleManager;

  constructor(session: XmppSession) {
    this.#manager = JingleManager.acquire(session);
  }

  accepts(accept: StreamAcceptFlags): boolean {
    return accept.jingle;
  }

  offer(peer: string, body: BodyOffer): DataDescriptor {
    const jingleOffer = this.#manager.offer(peer, body);
    return {
      kind: "jingle",
      sid: jingleOffer.sessionId,
      element: jingleOffer.element,
    };
  }

  receive(
    peer: string,
    descriptor: DataDescriptor,
    options?: { timeoutMs?: number; ourJid?: string },
  ): ReadableStream<Uint8Array> {
    if (descriptor.kind !== "jingle") {
      throw new HttpxError("protocol-error", "not a jingle descriptor");
    }
    return this.#manager.receive(peer, descriptor.element, options);
  }

  release(): void {
    this.#manager.release();
  }
}
