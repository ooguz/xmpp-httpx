import xml, { Element } from "@xmpp/xml";
import type { DataDescriptor } from "../codec/data.js";
import {
  DEFAULT_IBB_ACCEPT_TIMEOUT_MS,
  DEFAULT_IBB_BLOCK_SIZE,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_OFFER_TTL_MS,
  NS_FEATURE_NEG,
  NS_IBB,
  NS_SI,
  NS_SIPUB,
  NS_SI_FT,
  NS_STANZAS,
  NS_XDATA,
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

/**
 * XEP-0137 (Publishing Stream Initiation Requests) over XEP-0095 SI with the
 * IBB stream method — the "sipub" data mechanism of XEP-0332.
 *
 * Flow (publisher = body sender): the <sipub> element travels inside <data>;
 * the retriever sends IQ-get <start id>; the publisher replies
 * <starting sid> and then makes an SI offer whose id IS the XEP-0047 sid;
 * the retriever accepts the IBB stream method and the body flows over the
 * plain IbbManager data plane.
 *
 * Deliberate profile (documented in docs/protocol-notes.md): only the IBB
 * stream method is offered/accepted; each publication is one-shot and bound
 * to the requesting peer's bare JID; <file size='0'> when length unknown.
 */

export interface SipubPublication {
  readonly id: string;
  /** The <sipub> element to embed in <data>. */
  readonly element: Element;
  cancel(reason?: Error): void;
}

interface PublicationState {
  to: string; // bare JID allowed to start this publication
  body: BodyOffer;
  consumed: boolean;
  ttlTimer: ReturnType<typeof setTimeout>;
}

interface OfferExpectation {
  resolve: (
    stream:
      | ReadableStream<Uint8Array>
      | PromiseLike<ReadableStream<Uint8Array>>,
  ) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ParkedOffer {
  ctx: IqContext;
  reply: (result: Element | boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

function iqError(
  type: "cancel" | "modify" | "auth",
  condition: string,
  ...extra: Element[]
): Element {
  return xml(
    "error",
    { type },
    xml(condition, { xmlns: NS_STANZAS }),
    ...extra,
  );
}

export class SipubManager {
  static #instances = new WeakMap<object, SipubManager>();

  static acquire(session: XmppSession): SipubManager {
    let manager = SipubManager.#instances.get(session);
    if (!manager) {
      manager = new SipubManager(session);
      SipubManager.#instances.set(session, manager);
    }
    manager.#refs++;
    manager.#ensureStarted();
    return manager;
  }

  readonly #session: XmppSession;
  readonly #ibb: IbbManager;
  #refs = 0;
  #handlersRegistered = false;
  #publications = new Map<string, PublicationState>();
  #expectedOffers = new Map<string, OfferExpectation>();
  #parkedOffers = new Map<string, ParkedOffer>();

  acceptTimeoutMs = DEFAULT_IBB_ACCEPT_TIMEOUT_MS;
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;

  private constructor(session: XmppSession) {
    this.#session = session;
    this.#ibb = IbbManager.acquire(session);
  }

  release(): void {
    this.#refs--;
    if (this.#refs > 0) return;
    this.#refs = 0;
    for (const publication of this.#publications.values()) {
      clearTimeout(publication.ttlTimer);
    }
    this.#publications.clear();
    for (const expectation of this.#expectedOffers.values()) {
      clearTimeout(expectation.timer);
      expectation.reject(new HttpxError("aborted", "sipub manager closed"));
    }
    this.#expectedOffers.clear();
    this.#ibb.release();
  }

  // --------------------------------------------------------------- publisher

  /** Registers a one-shot publication for `to` (bare-JID matched) and builds
   * the <sipub> element. Nothing is sent — the peer moves next. */
  publish(to: string, body: BodyOffer): SipubPublication {
    const id = generateId("sipub");
    const fileAttrs: Record<string, string> = {
      xmlns: NS_SI_FT,
      name: body.name ?? "body",
      size: String(body.contentLength ?? 0),
    };
    const sipubAttrs: Record<string, string> = {
      xmlns: NS_SIPUB,
      from: body.from ?? this.#session.jid?.toString() ?? "",
      id,
      profile: NS_SI_FT,
    };
    if (body.contentType !== undefined) {
      sipubAttrs["mime-type"] = body.contentType;
    }
    const element = xml("sipub", sipubAttrs, xml("file", fileAttrs));

    const ttlTimer = setTimeout(() => {
      this.#publications.delete(id);
    }, body.ttlMs ?? DEFAULT_OFFER_TTL_MS);
    (ttlTimer as { unref?: () => void }).unref?.();

    this.#publications.set(id, {
      to: bareJid(to),
      body,
      consumed: false,
      ttlTimer,
    });

    return {
      id,
      element,
      cancel: () => {
        const state = this.#publications.get(id);
        if (state) {
          clearTimeout(state.ttlTimer);
          this.#publications.delete(id);
        }
      },
    };
  }

  #onStart(ctx: IqContext): Element {
    const from = ctx.from?.toString();
    const id = ctx.element.attrs["id"];
    if (!from || !id) return iqError("modify", "bad-request");

    const publication = this.#publications.get(id);
    if (!publication || publication.consumed) {
      return iqError("modify", "not-acceptable");
    }
    if (bareJid(from) !== publication.to) {
      return iqError("auth", "forbidden");
    }

    publication.consumed = true;
    clearTimeout(publication.ttlTimer);
    const sid = generateId("si");

    // Send the SI offer after the <starting> result has flushed.
    setTimeout(() => {
      this.#runPublisherTransfer(from, ctx.to?.toString(), sid, publication)
        .catch((err: unknown) => publication.body.onError?.(err))
        .finally(() => this.#publications.delete(id));
    }, 0);

    return xml("starting", { xmlns: NS_SIPUB, sid });
  }

  async #runPublisherTransfer(
    to: string,
    ourJid: string | undefined,
    sid: string,
    publication: PublicationState,
  ): Promise<void> {
    const { body } = publication;
    const siAttrs: Record<string, string> = {
      xmlns: NS_SI,
      id: sid,
      profile: NS_SI_FT,
    };
    if (body.contentType !== undefined) siAttrs["mime-type"] = body.contentType;
    const offer = xml(
      "si",
      siAttrs,
      xml("file", {
        xmlns: NS_SI_FT,
        name: body.name ?? "body",
        size: String(body.contentLength ?? 0),
      }),
      xml(
        "feature",
        { xmlns: NS_FEATURE_NEG },
        xml(
          "x",
          { xmlns: NS_XDATA, type: "form" },
          xml(
            "field",
            { var: "stream-method", type: "list-single" },
            xml("option", null, xml("value", null, NS_IBB)),
          ),
        ),
      ),
    );

    const iqAttrs: Record<string, string> =
      body.from !== undefined
        ? { type: "set", to, from: body.from }
        : ourJid !== undefined
          ? { type: "set", to, from: ourJid }
          : { type: "set", to };
    let accepted: Element;
    try {
      accepted = await this.#session.iqCaller.request(
        xml("iq", iqAttrs, offer),
        this.idleTimeoutMs,
      );
    } catch (err) {
      throw fromXmppError(err);
    }

    const chosen = accepted
      .getChild("si", NS_SI)
      ?.getChild("feature", NS_FEATURE_NEG)
      ?.getChild("x", NS_XDATA)
      ?.getChildren("field")
      .find((f) => f.attrs["var"] === "stream-method")
      ?.getChildText("value");
    if (chosen !== NS_IBB) {
      throw new HttpxError(
        "protocol-error",
        `sipub retriever chose unsupported stream method "${chosen ?? ""}"`,
      );
    }

    const openOptions: {
      sid: string;
      blockSize: number;
      from?: string;
    } = {
      sid,
      blockSize: body.blockSize ?? DEFAULT_IBB_BLOCK_SIZE,
    };
    const explicitFrom = body.from ?? ourJid;
    if (explicitFrom !== undefined) openOptions.from = explicitFrom;

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
  }

  // --------------------------------------------------------------- retriever

  /** Drives start → starting → SI offer → accept → IBB. Lazy: the handshake
   * begins on first read of the returned stream. */
  retrieve(
    from: string,
    sipub: { id: string },
    options?: { timeoutMs?: number; ourJid?: string },
  ): ReadableStream<Uint8Array> {
    const timeoutMs = options?.timeoutMs ?? this.idleTimeoutMs;
    return deferredStream(async () => {
      const attrs: Record<string, string> =
        options?.ourJid !== undefined
          ? { type: "get", to: from, from: options.ourJid }
          : { type: "get", to: from };
      let starting: Element;
      try {
        starting = await this.#session.iqCaller.request(
          xml("iq", attrs, xml("start", { xmlns: NS_SIPUB, id: sipub.id })),
          timeoutMs,
        );
      } catch (err) {
        throw fromXmppError(err);
      }
      const sid = starting.getChild("starting", NS_SIPUB)?.attrs["sid"];
      if (!sid) {
        throw new HttpxError(
          "protocol-error",
          "sipub <starting> without sid",
        );
      }
      return this.#awaitOffer(from, sid, timeoutMs);
    });
  }

  /** Resolves once the SI offer for (peer, sid) has been accepted. */
  #awaitOffer(
    peer: string,
    sid: string,
    timeoutMs: number,
  ): Promise<ReadableStream<Uint8Array>> {
    const key = this.#key(peer, sid);

    const parked = this.#parkedOffers.get(key);
    if (parked) {
      this.#parkedOffers.delete(key);
      clearTimeout(parked.timer);
      const result = this.#acceptOffer(parked.ctx, sid);
      parked.reply(result.reply);
      return result.stream;
    }

    return new Promise<ReadableStream<Uint8Array>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#expectedOffers.delete(key);
        reject(
          new HttpxError("timeout", `sipub SI offer for ${sid} never arrived`),
        );
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.#expectedOffers.set(key, { resolve, reject, timer });
    });
  }

  #onSiOffer(ctx: IqContext): Element | boolean | Promise<Element | boolean> {
    const from = ctx.from?.toString();
    const sid = ctx.element.attrs["id"];
    if (!from || !sid) return iqError("modify", "bad-request");

    const key = this.#key(from, sid);
    const expectation = this.#expectedOffers.get(key);
    if (expectation) {
      this.#expectedOffers.delete(key);
      clearTimeout(expectation.timer);
      const result = this.#acceptOffer(ctx, sid);
      expectation.resolve(result.stream);
      return result.reply;
    }

    // Unclaimed: park briefly — the <starting> result and this offer can
    // race the retriever's registration.
    return new Promise<Element | boolean>((reply) => {
      const timer = setTimeout(() => {
        this.#parkedOffers.delete(key);
        reply(iqError("cancel", "not-acceptable"));
      }, this.acceptTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.#parkedOffers.set(key, { ctx, reply, timer });
    });
  }

  /** Validates the offer, arms IBB, and builds the accepting result. */
  #acceptOffer(
    ctx: IqContext,
    sid: string,
  ): { reply: Element; stream: Promise<ReadableStream<Uint8Array>> } {
    const from = ctx.from?.toString() ?? "";
    const offeredMethods =
      ctx.element
        .getChild("feature", NS_FEATURE_NEG)
        ?.getChild("x", NS_XDATA)
        ?.getChildren("field")
        .find((f) => f.attrs["var"] === "stream-method")
        ?.getChildren("option")
        .map((o) => o.getChildText("value")) ?? [];

    if (!offeredMethods.includes(NS_IBB)) {
      return {
        reply: iqError(
          "cancel",
          "bad-request",
          xml("no-valid-streams", { xmlns: NS_SI }),
        ),
        stream: Promise.reject(
          new HttpxError("not-implemented", "sipub offer without IBB method"),
        ),
      };
    }

    // Arm the IBB expectation BEFORE the accepting reply goes out.
    const stream = this.#ibb
      .expectIncoming(from, sid, { timeoutMs: this.idleTimeoutMs })
      .then((incoming) => incoming.readable);
    // The rejection is consumed by the retriever; avoid unhandled noise if
    // the offer was parked-and-expired instead.
    stream.catch(() => {});

    const reply = xml(
      "si",
      { xmlns: NS_SI },
      xml(
        "feature",
        { xmlns: NS_FEATURE_NEG },
        xml(
          "x",
          { xmlns: NS_XDATA, type: "submit" },
          xml(
            "field",
            { var: "stream-method" },
            xml("value", null, NS_IBB),
          ),
        ),
      ),
    );
    return { reply, stream };
  }

  #ensureStarted(): void {
    if (this.#handlersRegistered) return;
    this.#handlersRegistered = true;
    this.#session.iqCallee.get(NS_SIPUB, "start", (ctx) => this.#onStart(ctx));
    this.#session.iqCallee.set(NS_SI, "si", (ctx) => this.#onSiOffer(ctx));
  }

  #key(peer: string, sid: string): string {
    return `${bareJid(peer)}\n${sid}`;
  }
}

/** BodyTransport adapter for the registry. */
export class SipubTransport implements BodyTransport {
  readonly kind = "sipub";
  readonly #manager: SipubManager;

  constructor(session: XmppSession) {
    this.#manager = SipubManager.acquire(session);
  }

  accepts(accept: StreamAcceptFlags): boolean {
    return accept.sipub;
  }

  offer(peer: string, body: BodyOffer): DataDescriptor {
    const publication = this.#manager.publish(peer, body);
    return { kind: "sipub", id: publication.id, element: publication.element };
  }

  receive(
    peer: string,
    descriptor: DataDescriptor,
    options?: { timeoutMs?: number; ourJid?: string },
  ): ReadableStream<Uint8Array> {
    if (descriptor.kind !== "sipub") {
      throw new HttpxError("protocol-error", "not a sipub descriptor");
    }
    return this.#manager.retrieve(peer, { id: descriptor.id }, options);
  }

  release(): void {
    this.#manager.release();
  }
}
