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
  NS_JINGLE_S5B,
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
import {
  buildActivated,
  buildCandidateError,
  buildCandidateUsed,
  buildTransport,
  candidatePriority,
  parseInfo,
  parseTransport,
  s5bDstAddr,
  sortCandidates,
  type S5bCandidate,
} from "../socks5/jingle-s5b.js";
import type {
  Socks5Adapter,
  Socks5ConnectResult,
  Socks5Duplex,
  StreamhostCandidate,
} from "../socks5/protocol.js";
import type { BodyOffer, BodyTransport } from "../transport/registry.js";
import { S5bNegotiation } from "./s5b-negotiation.js";
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
  /** Which transport the session is currently on. */
  transport: "ibb" | "s5b";
  /** Present while an s5b negotiation is in flight (or has completed). */
  s5b?: S5bNegotiation;
}

/**
 * Both peers may dial each other before the winner is known, so the losing
 * connection has to be let go — quietly, since its failure is of no interest.
 */
async function discard(duplex: Socks5Duplex | undefined): Promise<void> {
  if (!duplex) return;
  await duplex.out.abort(new Error("candidate not chosen")).catch(() => {});
  await duplex.readable.cancel().catch(() => {});
}

/** Maps our candidate list to what the SOCKS5 adapter speaks. */
function toStreamhosts(
  candidates: readonly S5bCandidate[],
): StreamhostCandidate[] {
  return candidates.map((candidate) => ({
    jid: candidate.jid,
    host: candidate.host,
    port: candidate.port,
  }));
}

/**
 * Candidates from the adapter, priced per XEP-0260 §2.1. A streamhost whose JID
 * is our own is a candidate we host (direct); anything else is a proxy, and the
 * local preference keeps the adapter's ordering.
 */
function toS5bCandidates(
  streamhosts: readonly StreamhostCandidate[],
  ourJid: string,
): S5bCandidate[] {
  return streamhosts.map((streamhost, index) => {
    const type = streamhost.jid === ourJid ? "direct" : "proxy";
    return {
      cid: `c${index + 1}`,
      jid: streamhost.jid,
      host: streamhost.host,
      port: streamhost.port,
      priority: candidatePriority(type, streamhosts.length - index - 1),
      type,
    };
  });
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

  static acquire(session: XmppSession, socks5?: Socks5Adapter): JingleManager {
    let manager = JingleManager.#instances.get(session);
    if (!manager) {
      manager = new JingleManager(session);
      JingleManager.#instances.set(session, manager);
    }
    // A later acquire may be the one that brings the adapter (the client wires
    // it per session, not per transport).
    if (socks5 && !manager.#socks5) manager.#socks5 = socks5;
    manager.#refs++;
    manager.#ensureStarted();
    return manager;
  }

  readonly #session: XmppSession;
  readonly #ibb: IbbManager;
  /** Present only on Node, and only when the caller supplied one. */
  #socks5: Socks5Adapter | undefined;
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

    const ourJid = body.from ?? this.#session.jid?.toString() ?? "";
    // s5b when an adapter is available, IBB otherwise. The candidates cannot go
    // in the initiate: gathering them (and hashing dstaddr) is async, while this
    // element has to be returned synchronously to be embedded in <data>. They
    // follow in a transport-info, which XEP-0260 §2.3 provides for.
    const useS5b = this.#socks5 !== undefined;

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
        useS5b
          ? xml("transport", { xmlns: NS_JINGLE_S5B, sid: transportSid, mode: "tcp" })
          : xml("transport", {
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
      transport: useS5b ? "s5b" : "ibb",
      ...(useS5b
        ? {
            s5b: new S5bNegotiation({
              sid: transportSid,
              dstaddr: "", // filled once hashed, below
              isInitiator: true,
              initiatorJid: ourJid,
              responderJid: to,
            }),
          }
        : {}),
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

    if (state.transport === "s5b") {
      return this.#acceptS5b(ctx, from, sid, key, state);
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

  /** session-accept for an s5b session: record the peer's candidates and go. */
  #acceptS5b(
    ctx: IqContext,
    from: string,
    sessionId: string,
    key: string,
    state: SessionState,
  ): Element | boolean {
    const transportEl = ctx.element
      .getChild("content")
      ?.getChild("transport", NS_JINGLE_S5B);
    if (!transportEl) {
      return xml("error", { type: "cancel" }, xml("bad-request", { xmlns: NS_STANZAS }));
    }
    let parsed;
    try {
      parsed = parseTransport(transportEl);
    } catch {
      return xml("error", { type: "cancel" }, xml("bad-request", { xmlns: NS_STANZAS }));
    }
    if (parsed.sid !== state.transportSid) {
      return xml("error", { type: "cancel" }, xml("bad-request", { xmlns: NS_STANZAS }));
    }

    state.accepted = true;
    if (state.ttlTimer !== undefined) clearTimeout(state.ttlTimer);

    const negotiation = state.s5b!;
    if (parsed.candidates.length > 0) {
      negotiation.receiveRemoteCandidates(parsed.candidates);
    } else {
      negotiation.noRemoteCandidates();
    }

    setTimeout(() => {
      this.#runInitiatorS5b(from, sessionId, key, state).catch((err: unknown) =>
        state.body?.onError?.(err),
      );
    }, 0);
    return true;
  }

  /**
   * The initiator's half of XEP-0260: offer candidates, report on the peer's,
   * then either write the body over the agreed candidate or fall back to IBB.
   *
   * One asymmetry to be explicit about: we always report `<candidate-error/>` for
   * the peer's candidates. Using one would mean *writing* over a socket we dialled
   * ourselves, and the `Socks5Adapter` surface only exposes a read side for
   * `connect()`. Reporting an error is the conformant way to say "none of yours
   * are usable to me", and it leaves the peer's report to decide the winner.
   */
  async #runInitiatorS5b(
    to: string,
    sessionId: string,
    key: string,
    state: SessionState,
  ): Promise<void> {
    const body = state.body!;
    const negotiation = state.s5b!;
    const socks5 = this.#socks5;
    if (!socks5) throw new HttpxError("not-implemented", "no socks5 adapter");

    const ctx = {
      requesterJid: negotiation.initiatorJid,
      targetJid: negotiation.responderJid,
    };
    /** A connection we opened that may yet lose the negotiation. */
    let dialled: Socks5ConnectResult | undefined;

    try {
      negotiation.dstaddr = await s5bDstAddr(
        negotiation.sid,
        negotiation.initiatorJid,
        negotiation.responderJid,
      );

      let streamhosts: StreamhostCandidate[] = [];
      try {
        streamhosts = [...(await socks5.candidatesFor(negotiation.sid, ctx))];
      } catch {
        streamhosts = []; // no candidates is a negotiation outcome, not a crash
      }
      const candidates = toS5bCandidates(streamhosts, negotiation.initiatorJid);
      negotiation.offerLocal(candidates);

      if (candidates.length > 0) {
        await this.#sendTransportInfo(
          to,
          body.from,
          sessionId,
          buildTransport({
            sid: negotiation.sid,
            mode: "tcp",
            dstaddr: negotiation.dstaddr,
            candidates,
          }),
        );
      }

      // Try the responder's candidates as a client. Both sides dial, which is
      // the point of XEP-0260: whichever direction is reachable wins.
      dialled = await this.#dialPeerCandidates(negotiation, socks5, ctx);
      const usedRemote = dialled
        ? negotiation.remoteCandidates.find(
            (candidate) => candidate.jid === dialled!.usedJid,
          )
        : undefined;

      if (dialled && usedRemote) {
        negotiation.setLocalReport({ kind: "used", candidate: usedRemote });
        await this.#sendTransportInfo(
          to,
          body.from,
          sessionId,
          buildCandidateUsed(negotiation.sid, usedRemote.cid),
        );
      } else {
        negotiation.setLocalReport({ kind: "error" });
        await this.#sendTransportInfo(
          to,
          body.from,
          sessionId,
          buildCandidateError(negotiation.sid),
        );
      }

      const outcome = await negotiation.outcome(this.idleTimeoutMs);
      if (outcome.kind === "fallback") {
        await discard(dialled);
        dialled = undefined;
        await this.#replaceWithIbb(to, sessionId, key, state);
        return;
      }

      const chosen = outcome.candidate;
      let out;
      if (outcome.offeredBy === "local") {
        // Our streamhost won: take up the connection the peer opened to it (or
        // dial our proxy), and let go of whatever we dialled ourselves.
        await discard(dialled);
        dialled = undefined;
        ({ out } = await socks5.openChosen(negotiation.sid, chosen.jid, {
          ...ctx,
          candidates: streamhosts,
        }));
        if (chosen.type === "proxy") {
          // openChosen already sent the XEP-0065 <activate/> to the proxy; this
          // tells the peer it may start reading.
          await this.#sendTransportInfo(
            to,
            body.from,
            sessionId,
            buildActivated(negotiation.sid, chosen.cid),
          );
        }
      } else {
        // The responder's streamhost won: we write over the socket we dialled.
        out = dialled!.out;
        dialled = undefined; // ownership passes to the transfer below
        if (chosen.type === "proxy") {
          // Their proxy relays nothing until they activate it.
          await negotiation.waitActivation(this.idleTimeoutMs);
        }
      }

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
      this.#sessions.delete(key);
    } catch (err) {
      await discard(dialled);
      negotiation.fail(err);
      await this.#terminate(to, body.from, sessionId, "failed-transport").catch(
        () => {},
      );
      this.#sessions.delete(key);
      throw fromXmppError(err);
    }
  }

  /** Dials the peer's candidates, best first. Undefined when none can be used. */
  async #dialPeerCandidates(
    negotiation: S5bNegotiation,
    socks5: Socks5Adapter,
    ctx: { requesterJid: string; targetJid: string },
  ): Promise<Socks5ConnectResult | undefined> {
    const candidates = sortCandidates([
      ...(await negotiation.waitRemoteCandidates(this.idleTimeoutMs)),
    ]);
    if (candidates.length === 0) return undefined;
    try {
      return await socks5.connect(
        negotiation.sid,
        toStreamhosts(candidates),
        ctx,
      );
    } catch {
      return undefined; // every candidate refused: a report, not a crash
    }
  }

  /** XEP-0260 §2.5 fallback: replace the s5b transport with IBB and carry on. */
  async #replaceWithIbb(
    to: string,
    sessionId: string,
    key: string,
    state: SessionState,
  ): Promise<void> {
    const body = state.body!;
    const negotiation = state.s5b!;
    const ibbSid = generateId("jibb");

    await this.#sendJingle(to, body.from, sessionId, "transport-replace", [
      xml("transport", {
        xmlns: NS_JINGLE_IBB,
        "block-size": String(state.blockSize),
        sid: ibbSid,
      }),
    ]);
    // Do not write a byte until the peer has accepted and armed its receiver.
    await negotiation.waitSwitch(this.idleTimeoutMs);

    state.transport = "ibb";
    state.transportSid = ibbSid;
    await this.#runInitiatorTransfer(to, sessionId, key, state);
  }

  #sendTransportInfo(
    to: string,
    from: string | undefined,
    sessionId: string,
    transportEl: Element,
  ): Promise<unknown> {
    return this.#sendJingle(to, from, sessionId, "transport-info", [transportEl]);
  }

  #sendJingle(
    to: string,
    from: string | undefined,
    sessionId: string,
    action: string,
    children: Element[],
  ): Promise<unknown> {
    const attrs: Record<string, string> =
      from !== undefined ? { type: "set", to, from } : { type: "set", to };
    return this.#session.iqCaller.request(
      xml(
        "iq",
        attrs,
        xml(
          "jingle",
          { xmlns: NS_JINGLE, action, sid: sessionId },
          xml(
            "content",
            { creator: "initiator", name: "http-body" },
            ...children,
          ),
        ),
      ),
      this.idleTimeoutMs,
    );
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
      const s5bTransport = content?.getChild("transport", NS_JINGLE_S5B);
      if (content && s5bTransport) {
        return this.#receiveS5b(from, sessionId, content, s5bTransport, {
          timeoutMs,
          ...(options?.ourJid !== undefined ? { ourJid: options.ourJid } : {}),
        });
      }

      const transport = content?.getChild("transport", NS_JINGLE_IBB);
      const transportSid = transport?.attrs["sid"];
      if (!content || !transport || !transportSid) {
        // Neither transport we implement — decline the session and give up.
        await this.#terminate(from, options?.ourJid, sessionId, "decline").catch(
          () => {},
        );
        throw new HttpxError(
          "not-implemented",
          "jingle offer without a supported transport",
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
        transport: "ibb",
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

  /**
   * The responder's half of XEP-0260. Runs inside the body stream's deferred
   * open, so every wait is bounded and a failure surfaces as a body error.
   *
   * We offer no candidates of our own: the initiator cannot write over a socket
   * it dialled (see #runInitiatorS5b), so a candidate we hosted could never be
   * used, and advertising one would only open a listener for nothing.
   */
  async #receiveS5b(
    from: string,
    sessionId: string,
    content: Element,
    transportEl: Element,
    options: { timeoutMs: number; ourJid?: string },
  ): Promise<ReadableStream<Uint8Array>> {
    const timeoutMs = options.timeoutMs;
    const ourJid = options.ourJid ?? this.#session.jid?.toString() ?? "";
    const initiatorJid = content.parent?.attrs["initiator"] ?? from;

    let offered;
    try {
      offered = parseTransport(transportEl);
    } catch (err) {
      await this.#terminate(from, options.ourJid, sessionId, "decline").catch(() => {});
      throw fromXmppError(err);
    }

    const key = this.#key(from, sessionId);
    const negotiation = new S5bNegotiation({
      sid: offered.sid,
      // The wire value is informational: both sides can derive it, and ours is
      // computed below so an absent dstaddr is not fatal.
      dstaddr: offered.dstaddr ?? "",
      isInitiator: false,
      initiatorJid,
      responderJid: ourJid,
    });
    const state: SessionState = {
      direction: "in",
      peer: bareJid(from),
      transportSid: offered.sid,
      blockSize: DEFAULT_IBB_BLOCK_SIZE,
      accepted: true,
      transport: "s5b",
      s5b: negotiation,
    };
    this.#sessions.set(key, state);

    if (offered.candidates.length > 0) {
      negotiation.receiveRemoteCandidates(offered.candidates);
    }

    // Gather our own candidates before accepting, so they travel in the accept
    // rather than needing a further round trip. An adapter with no listener and
    // no proxy simply yields none, which is the common client case.
    const ctx = { requesterJid: initiatorJid, targetJid: ourJid };
    let ourStreamhosts: StreamhostCandidate[] = [];
    if (this.#socks5) {
      try {
        ourStreamhosts = [...(await this.#socks5.candidatesFor(offered.sid, ctx))];
      } catch {
        ourStreamhosts = [];
      }
    }
    const ourCandidates = toS5bCandidates(ourStreamhosts, ourJid);
    negotiation.offerLocal(ourCandidates);

    // Accept, echoing the transport with whatever we can host.
    const description = content.getChild("description");
    const acceptEl = xml(
      "jingle",
      {
        xmlns: NS_JINGLE,
        action: "session-accept",
        responder: ourJid,
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
        buildTransport({
          sid: offered.sid,
          mode: "tcp",
          candidates: ourCandidates,
        }),
      ),
    );
    const attrs: Record<string, string> =
      options.ourJid !== undefined
        ? { type: "set", to: from, from: options.ourJid }
        : { type: "set", to: from };
    try {
      await this.#session.iqCaller.request(xml("iq", attrs, acceptEl), timeoutMs);
    } catch (err) {
      this.#sessions.delete(key);
      throw fromXmppError(err);
    }

    let dialled: Socks5ConnectResult | undefined;
    try {
      const socks5 = this.#socks5;

      if (socks5) {
        dialled = await this.#dialPeerCandidates(negotiation, socks5, ctx);
        const used = dialled
          ? negotiation.remoteCandidates.find(
              (candidate) => candidate.jid === dialled!.usedJid,
            )
          : undefined;
        if (dialled && used) {
          negotiation.setLocalReport({ kind: "used", candidate: used });
          await this.#sendResponderInfo(
            from,
            options.ourJid,
            sessionId,
            buildCandidateUsed(offered.sid, used.cid),
          );
        } else {
          negotiation.setLocalReport({ kind: "error" });
          await this.#sendResponderInfo(
            from,
            options.ourJid,
            sessionId,
            buildCandidateError(offered.sid),
          );
        }
      } else {
        // No adapter (a browser, say): we cannot use s5b at all, so say so and
        // let the initiator replace the transport with IBB.
        negotiation.noRemoteCandidates();
        negotiation.setLocalReport({ kind: "error" });
        await this.#sendResponderInfo(
          from,
          options.ourJid,
          sessionId,
          buildCandidateError(offered.sid),
        );
      }

      const outcome = await negotiation.outcome(timeoutMs);
      if (outcome.kind === "fallback") {
        await discard(dialled);
        dialled = undefined;
        return await this.#receiveAfterReplace(from, sessionId, key, state, options);
      }

      if (outcome.offeredBy === "remote") {
        // An initiator-offered candidate won, so we read over the socket we
        // dialled; a proxy of theirs relays nothing until they activate it.
        const readable = dialled!.readable;
        dialled = undefined;
        if (outcome.candidate.type === "proxy") {
          await negotiation.waitActivation(timeoutMs);
        }
        return readable;
      }

      // Our own streamhost won: take up the connection the initiator opened to
      // it (or dial our proxy) and read from that instead.
      await discard(dialled);
      dialled = undefined;
      const mine = await this.#socks5!.openChosen(offered.sid, outcome.candidate.jid, {
        ...ctx,
        candidates: ourStreamhosts,
        // The party that dialled our proxy is the initiator, not ctx.targetJid
        // (which is us) — the hash inputs must stay put, so this is separate.
        activateJid: initiatorJid,
      });
      if (outcome.candidate.type === "proxy") {
        await this.#sendResponderInfo(
          from,
          options.ourJid,
          sessionId,
          buildActivated(offered.sid, outcome.candidate.cid),
        );
      }
      return mine.readable;
    } catch (err) {
      await discard(dialled);
      negotiation.fail(err);
      this.#sessions.delete(key);
      throw fromXmppError(err);
    }
  }

  /** Waits for the initiator's transport-replace, then reads over IBB. */
  async #receiveAfterReplace(
    from: string,
    sessionId: string,
    key: string,
    state: SessionState,
    options: { timeoutMs: number; ourJid?: string },
  ): Promise<ReadableStream<Uint8Array>> {
    const negotiation = state.s5b!;
    await negotiation.waitSwitch(options.timeoutMs);

    // Arm the data plane BEFORE accepting the replacement, so the initiator
    // cannot start writing into nothing.
    const incoming = this.#ibb.expectIncoming(from, state.transportSid, {
      timeoutMs: options.timeoutMs,
    });
    incoming.catch(() => {});

    await this.#sendResponderJingle(from, options.ourJid, sessionId, "transport-accept", [
      xml("transport", {
        xmlns: NS_JINGLE_IBB,
        "block-size": String(state.blockSize),
        sid: state.transportSid,
      }),
    ]);

    return (await incoming).readable;
  }

  #sendResponderInfo(
    to: string,
    from: string | undefined,
    sessionId: string,
    transportEl: Element,
  ): Promise<unknown> {
    return this.#sendResponderJingle(to, from, sessionId, "transport-info", [
      transportEl,
    ]);
  }

  #sendResponderJingle(
    to: string,
    from: string | undefined,
    sessionId: string,
    action: string,
    children: Element[],
  ): Promise<unknown> {
    const attrs: Record<string, string> =
      from !== undefined ? { type: "set", to, from } : { type: "set", to };
    return this.#session.iqCaller.request(
      xml(
        "iq",
        attrs,
        xml(
          "jingle",
          { xmlns: NS_JINGLE, action, sid: sessionId },
          xml("content", { creator: "initiator", name: "http-body" }, ...children),
        ),
      ),
      this.idleTimeoutMs,
    );
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
      case "transport-info":
        return this.#onTransportInfo(ctx);
      case "transport-replace":
        return this.#onTransportReplace(ctx);
      case "transport-accept":
        return this.#onTransportAccept(ctx);
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

  /**
   * transport-info: either more candidates, or one of the four s5b payloads.
   * Sessions on IBB have no use for it and simply ack, as before.
   */
  #onTransportInfo(ctx: IqContext): Element | boolean {
    const state = this.#stateFor(ctx);
    if (!state) return jingleIqError("item-not-found");
    const negotiation = state.s5b;
    const transportEl = ctx.element
      .getChild("content")
      ?.getChild("transport", NS_JINGLE_S5B);
    if (!negotiation || !transportEl) return true; // nothing to do; still valid

    try {
      if (transportEl.getChildren("candidate").length > 0) {
        negotiation.receiveRemoteCandidates(parseTransport(transportEl).candidates);
        return true;
      }
      const info = parseInfo(transportEl);
      switch (info.kind) {
        case "candidate-used":
          negotiation.setRemoteUsed(info.cid);
          break;
        case "candidate-error":
          negotiation.setRemoteError();
          break;
        case "activated":
          negotiation.markActivated(info.cid);
          break;
        case "proxy-error":
          negotiation.fail(
            new HttpxError("stream-error", "peer could not activate its proxy"),
          );
          break;
      }
      return true;
    } catch {
      return xml("error", { type: "cancel" }, xml("bad-request", { xmlns: NS_STANZAS }));
    }
  }

  /** The initiator gave up on s5b and offers IBB instead (responder side). */
  #onTransportReplace(ctx: IqContext): Element | boolean {
    const state = this.#stateFor(ctx);
    if (!state) return jingleIqError("item-not-found");
    const transportEl = ctx.element
      .getChild("content")
      ?.getChild("transport", NS_JINGLE_IBB);
    const replacementSid = transportEl?.attrs["sid"];
    if (!transportEl || !replacementSid) {
      // Only IBB is offered as a replacement here; anything else is refused
      // rather than silently accepted.
      return xml("error", { type: "cancel" }, xml("bad-request", { xmlns: NS_STANZAS }));
    }

    const offeredBlock = Number(transportEl.attrs["block-size"]);
    state.transport = "ibb";
    state.transportSid = replacementSid;
    if (Number.isInteger(offeredBlock) && offeredBlock > 0) {
      state.blockSize = Math.min(offeredBlock, MAX_CHUNK_SIZE);
    }
    // The receive() coroutine arms IBB and only then sends transport-accept, so
    // the initiator cannot start writing into an unarmed receiver.
    state.s5b?.markSwitch();
    return true;
  }

  /** The responder accepted our replacement transport (initiator side). */
  #onTransportAccept(ctx: IqContext): Element | boolean {
    const state = this.#stateFor(ctx);
    if (!state) return jingleIqError("item-not-found");
    state.s5b?.markSwitch();
    return true;
  }

  #stateFor(ctx: IqContext): SessionState | undefined {
    const from = ctx.from?.toString();
    const sid = ctx.element.attrs["sid"];
    if (!from || !sid) return undefined;
    return this.#sessions.get(this.#key(from, sid));
  }

  /** session-info / anything else: ack known, refuse unknown. */
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

  constructor(session: XmppSession, socks5?: Socks5Adapter) {
    this.#manager = JingleManager.acquire(session, socks5);
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
