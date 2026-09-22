import xml, { Element } from "@xmpp/xml";
import {
  DEFAULT_IBB_ACCEPT_TIMEOUT_MS,
  DEFAULT_IBB_BLOCK_SIZE,
  DEFAULT_IBB_WINDOW,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_BUFFERED_BYTES,
  MAX_CHUNK_SIZE,
  MAX_IBB_WINDOW,
  NS_IBB,
  NS_STANZAS,
} from "../constants.js";
import { fromXmppError, HttpxError } from "../errors.js";
import {
  bareJid,
  generateId,
  type IqContext,
  type XmppSession,
} from "../session.js";
import { decodeBase64, encodeBase64 } from "../util/base64.js";
import { BlockBuffer } from "../util/bytes.js";

/**
 * XEP-0047 In-Band Bytestreams, both directions.
 *
 * Sending uses IQ-carried <data> exclusively: each block is acknowledged by
 * an IQ result, which provides flow control and error propagation for free.
 * Up to `window` blocks are in flight at once — the result of block k is what
 * releases block k+window — so throughput stops being one block per round
 * trip without giving up the acks. Receiving additionally tolerates
 * message-carried <data> for interop.
 *
 * Ordering is preserved by construction and nowhere else: a block is taken
 * from the buffer, base64-encoded, given its seq and handed to iqCaller in
 * one synchronous step, and both @xmpp/connection and the mock session reach
 * their socket write synchronously from request(). The receiver accepts no
 * gaps (a seq jump kills the stream), so an await anywhere between taking a
 * block and sending it would corrupt the stream rather than merely slow it.
 *
 * Unsolicited incoming <open>s are not accepted: only sids pre-announced via
 * expectIncoming() are. Because the announcing stanza and the <open> can race
 * in the event loop, an unclaimed <open> is parked briefly (the IQ reply is
 * simply withheld) before being refused with <not-acceptable/>.
 */

export interface IbbOutStream {
  readonly sid: string;
  /**
   * Hands the bytes over: a sub-block remainder stays buffered *by reference*
   * until a later write or close() sends it, so the caller must not mutate
   * the array after this resolves (the same contract as a WHATWG or Node
   * stream sink — reusing a scratch buffer between writes corrupts the tail).
   *
   * Resolves once every full block it produced has been *sent*, not acked:
   * with a window > 1 those blocks are still outstanding. It still blocks
   * while the window is full, so it remains the backpressure the callers'
   * pump loops rely on — it just yields after `window` blocks instead of
   * one. A block that fails later is reported by a subsequent write() or by
   * close(), which waits for every outstanding ack.
   */
  write(bytes: Uint8Array): Promise<void>;
  /**
   * Flushes any buffered partial block, waits for every outstanding block to
   * be acknowledged, and sends <close/>. Rejects with the stream's failure if
   * any block failed — so a caller that awaits close() has the same
   * end-to-end guarantee it had when every write awaited its own ack.
   */
  close(): Promise<void>;
  /** Best-effort <close/> without flushing; the local error is remembered. */
  abort(reason: Error): Promise<void>;
}

export interface IbbInStream {
  readonly sid: string;
  readonly from: string;
  readonly blockSize: number;
  readonly readable: ReadableStream<Uint8Array>;
}

/**
 * One IBB session used in both directions: `readable` is what the peer sends,
 * write() is what we send, on the same sid with independent seq counters.
 *
 * There is no half-close. close() and abort() end both directions, and so
 * does the peer's <close/>: `readable` then ends cleanly and later writes
 * reject. Cancelling `readable` is an abort — a tunnel whose reader has gone
 * has nobody left to read the answer.
 */
export interface IbbDuplex extends IbbOutStream {
  /** The peer's full JID. */
  readonly peer: string;
  readonly blockSize: number;
  readonly readable: ReadableStream<Uint8Array>;
}

/**
 * Per-stream watchdog setting. A number is the stream's idle timeout; `false`
 * turns the idle watchdog off — for a tunnel, which is idle by nature (a
 * WebSocket can sit silent for hours) and whose liveness comes from the XMPP
 * session and from the TCP side instead. Off means *every* timer that fires on
 * absence of traffic: the inbound idle timer and the stretched deadline of a
 * receiver withholding acks. The sender's per-block ack deadline is not one of
 * them and stays — it only runs while bytes are outstanding.
 */
export type IbbIdleTimeout = number | false;

export interface DuplexOptions {
  /** Blocks in flight on our sending half; see openOutgoing. */
  window?: number;
  /** Our JID, for components. */
  from?: string;
  /** Default `false` — a duplex is a tunnel unless told otherwise. */
  idleTimeoutMs?: IbbIdleTimeout;
}

interface InStreamState {
  controller: ReadableStreamDefaultController<Uint8Array>;
  expectedSeq: number;
  finished: boolean;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Resolvers waiting for the consumer to relieve backpressure. */
  pullWaiters: Array<() => void>;
  cancelled: boolean;
  /**
   * Per stream, not per manager: a tunnel's `false` is not a body's 30 s.
   * Undefined reads the manager's idleTimeoutMs at each arming, which is
   * exactly what every stream did before this field existed.
   */
  idleTimeoutMs: IbbIdleTimeout | undefined;
  /** Duplex only: the peer's <close/> also ends our sending half. */
  onPeerClose?: () => void;
  /** Duplex only: a fatal inbound error (seq gap, idle) ends the whole stream. */
  onFail?: (error: Error) => void;
  /** Duplex only: replaces the default "send <close/>" on cancel. */
  onCancel?: (reason: unknown) => void;
}

interface OpenSource {
  ctx: IqContext;
  blockSize: number;
}

interface ParkedOpen extends OpenSource {
  accept: (result: Element | boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Expectation {
  /** Builds the stream for the arrived <open> — plain inbound or duplex. */
  claim: (source: OpenSource) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface InboundDescriptor {
  /** The peer's full JID. */
  from: string;
  /** Our JID as the peer addressed it — needed on components. */
  ourJid: string | undefined;
  sid: string;
  blockSize: number;
}

function describeOpen(source: OpenSource): InboundDescriptor {
  return {
    from: source.ctx.from?.toString() ?? "",
    ourJid: source.ctx.to?.toString(),
    sid: source.ctx.element.attrs["sid"] ?? "",
    blockSize: source.blockSize,
  };
}

function iqError(
  type: "cancel" | "modify" | "wait",
  condition: string,
): Element {
  return xml("error", { type }, xml(condition, { xmlns: NS_STANZAS }));
}

/**
 * A window of blocks, from whatever the caller supplied. The finite check is
 * load-bearing, not defensive: `inFlight >= NaN` is false, so a NaN window
 * would silently admit every block at once and remove backpressure entirely —
 * the one property this whole mechanism exists to keep.
 */
function clampWindow(value: number | undefined): number {
  const wanted = value ?? DEFAULT_IBB_WINDOW;
  if (!Number.isFinite(wanted)) return DEFAULT_IBB_WINDOW;
  return Math.max(1, Math.min(MAX_IBB_WINDOW, Math.floor(wanted)));
}

export class IbbManager {
  static #instances = new WeakMap<object, IbbManager>();

  /**
   * One manager per session: @xmpp/iq routes each (namespace, tag) pair to
   * the first registered handler, so the IBB handlers must be singletons.
   */
  static acquire(session: XmppSession): IbbManager {
    let manager = IbbManager.#instances.get(session);
    if (!manager) {
      manager = new IbbManager(session);
      IbbManager.#instances.set(session, manager);
    }
    manager.#refs++;
    manager.#ensureStarted();
    return manager;
  }

  readonly #session: XmppSession;
  #refs = 0;
  #started = false;
  #inStreams = new Map<string, InStreamState>();
  #parkedOpens = new Map<string, ParkedOpen>();
  #expectations = new Map<string, Expectation>();
  readonly #onStanza = (stanza: Element) => this.#handleMessageData(stanza);

  acceptTimeoutMs = DEFAULT_IBB_ACCEPT_TIMEOUT_MS;
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
  /**
   * Blocks an incoming stream will hold unread before it starts withholding
   * acks. This is the receiver's half of the window: whatever the sender
   * keeps in flight, the effective count is the smaller of the two, with no
   * negotiation needed — the receiver simply stops acking. Per manager (so
   * per session) because an <open> arrives before any per-stream setup.
   */
  receiveWindowBlocks = DEFAULT_IBB_WINDOW;

  private constructor(session: XmppSession) {
    this.#session = session;
  }

  release(): void {
    this.#refs--;
    if (this.#refs > 0) return;
    this.#refs = 0;
    // iqCallee middleware cannot be unregistered; deactivate by state.
    for (const [key, state] of this.#inStreams) {
      this.#finishInStream(
        key,
        state,
        new HttpxError("aborted", "IBB manager closed"),
      );
    }
    for (const [, expectation] of this.#expectations) {
      if (expectation.timer !== undefined) clearTimeout(expectation.timer);
      expectation.reject(new HttpxError("aborted", "IBB manager closed"));
    }
    this.#expectations.clear();
    this.#session.removeListener("stanza", this.#onStanza);
    this.#started = false;
  }

  // ---------------------------------------------------------------- outbound

  async openOutgoing(
    to: string,
    options?: {
      blockSize?: number;
      /**
       * Blocks allowed in flight at once; the ack of block k releases block
       * k+window. Default DEFAULT_IBB_WINDOW, clamped to [1, MAX_IBB_WINDOW];
       * a window of 1 is exactly the old block-at-a-time sender.
       *
       * Per stream, never a manager field: one IbbManager is shared by the
       * client, the server, sipub and jingle on a session, and a download's
       * window is not an upload's.
       */
      window?: number;
      from?: string;
      sid?: string;
    },
  ): Promise<IbbOutStream> {
    const sid = options?.sid ?? generateId("ibb");
    const blockSize = options?.blockSize ?? DEFAULT_IBB_BLOCK_SIZE;
    const from = options?.from;
    await this.#request(to, from, this.#openElement(sid, blockSize));
    return this.#createOutStream(to, from, sid, blockSize, options?.window)
      .stream;
  }

  /**
   * Opens a stream that carries bytes both ways (design: one sid, two
   * directions, each with its own seq counter — XEP-0047's seq is per
   * sender). The inbound half is registered *before* the <open> leaves, so
   * the peer may start sending the moment it accepts.
   *
   * There is no half-close: close() from either side ends both directions,
   * which is what a CONNECT tunnel needs (TLS never half-closes).
   */
  async openDuplex(
    to: string,
    options?: DuplexOptions & { sid?: string; blockSize?: number },
  ): Promise<IbbDuplex> {
    const sid = options?.sid ?? generateId("ibb");
    const blockSize = options?.blockSize ?? DEFAULT_IBB_BLOCK_SIZE;
    const from = options?.from;
    const key = this.#key(to, sid);
    if (
      this.#inStreams.has(key) ||
      this.#parkedOpens.has(key) ||
      this.#expectations.has(key)
    ) {
      throw new HttpxError("stream-error", `IBB sid ${sid} is already in use`);
    }
    const duplex = this.#createDuplex(key, {
      peer: to,
      from,
      sid,
      blockSize,
      window: options?.window,
      idleTimeoutMs: options?.idleTimeoutMs,
    });
    try {
      await this.#request(to, from, this.#openElement(sid, blockSize));
    } catch (err) {
      // Refused: nothing was ever sent on it, so there is no <close/> to send
      // — just drop the half registered above. A *timeout* is different: the
      // peer may well have accepted, and with its watchdog off it would keep
      // that half for the session unless told.
      duplex.discard(err instanceof Error ? err : new Error(String(err)));
      if (err instanceof HttpxError && err.code === "timeout") {
        this.#request(to, from, xml("close", { xmlns: NS_IBB, sid })).catch(() => {});
      }
      throw err;
    }
    return duplex.handle;
  }

  #openElement(sid: string, blockSize: number): Element {
    return xml("open", {
      xmlns: NS_IBB,
      sid,
      "block-size": String(blockSize),
      stanza: "iq",
    });
  }

  /**
   * The sending half, for a sid that is already open — by our own <open>
   * (openOutgoing, openDuplex) or by the peer's (expectDuplex). Everything
   * below the first line is the windowed sender exactly as it was; the only
   * additions are the peer-close exit and the hook a duplex uses to retire its
   * inbound half just before our own <close/> leaves.
   */
  #createOutStream(
    to: string,
    from: string | undefined,
    sid: string,
    blockSize: number,
    requestedWindow: number | undefined,
    hooks?: {
      /** Runs once, right before our <close/> is sent (by close or abort). */
      beforeSendClose?: (reason?: Error) => void;
      /**
       * Send what each write() leaves over instead of holding it for the next
       * write or close(). A body is written to completion and then closed, so
       * holding a sub-block tail costs nothing; a tunnel is interactive, and a
       * 500-byte TLS ClientHello held for a write that only comes after the
       * answer would deadlock it. Coalescing survives: bytes written while
       * the window is full accumulate and leave in full blocks.
       */
      flushEachWrite?: boolean;
      /**
       * A block failed and the stream is now failed. Called once, from the
       * rejection that latched it — so a duplex can tear down its other half
       * even when nobody is writing or closing to notice.
       */
      onFail?: (error: Error) => void;
      /** An ack arrived: the peer is alive and taking our bytes. */
      onActivity?: () => void;
    },
  ): { stream: IbbOutStream; peerClosed: () => void } {
    const window = clampWindow(requestedWindow);
    // Each block carries its own deadline, started when it was *dispatched* —
    // so the last block of a window has been waiting for the whole window to
    // drain by the time its own ack is due. Scaling the deadline by the window
    // restores what the old sender gave every block: idleTimeoutMs of patience
    // measured from its predecessor's ack. Without it, windowing would kill
    // exactly the slow consumers that backpressure exists to serve.
    //
    // This is not an idle watchdog and a tunnel keeps it: it only runs while
    // this side has bytes outstanding, and a peer that holds them unanswered
    // for window x idleTimeoutMs is stuck, not idle.
    const blockTimeoutMs = this.idleTimeoutMs * window;

    let seq = 0;
    /** Blocks dispatched so far. Unwrapped, unlike seq, so it orders failures. */
    let dispatched = 0;
    const buffered = new BlockBuffer();
    let closed = false;
    /**
     * The peer sent <close/> on this sid (only possible for a duplex: a plain
     * sender's sid has no inbound half to receive it). The stream is over in
     * both directions; what we still had in flight is lost, as it is when a
     * TCP peer closes — there is no half-close to wait in.
     */
    let closedByPeer = false;
    /**
     * The failure that closed the stream, latched to the *earliest* block
     * that failed. A dead receiver rejects every outstanding block and each
     * block carries its own timeout, so rejection order is not send order:
     * without the ordinal the reported error would vary run to run.
     */
    let failed: { ordinal: number; error: Error } | undefined;
    let inFlight = 0;
    /** Woken when a slot frees, when the stream fails, and on drain. */
    const slotWaiters: Array<() => void> = [];
    const drainWaiters: Array<() => void> = [];

    const wake = (waiters: Array<() => void>) => {
      for (const waiter of waiters) waiter();
    };

    const settle = () => {
      inFlight--;
      wake(slotWaiters.splice(0));
      if (inFlight === 0) wake(drainWaiters.splice(0));
    };

    /**
     * Takes one block and puts it on the wire. Synchronous end to end on
     * purpose: encoding, the seq assignment and the send must not be split
     * by an await, or a concurrent writer interleaves and the receiver —
     * which tolerates no gaps — kills the stream.
     */
    const dispatch = (bytes: Uint8Array) => {
      const data = xml(
        "data",
        { xmlns: NS_IBB, sid, seq: String(seq) },
        encodeBase64(bytes),
      );
      seq = (seq + 1) % 65536;
      const ordinal = dispatched++;
      inFlight++;
      // The rejection handler is attached here, at dispatch, not where the
      // block is awaited: with a window the other in-flight blocks reject
      // with nobody awaiting them, and an unhandled rejection is fatal.
      this.#request(to, from, data, blockTimeoutMs).then(
        () => {
          hooks?.onActivity?.();
          settle();
        },
        (err: unknown) => {
          const error = fromXmppError(err);
          // After the peer's <close/>, a block it never took (answered
          // item-not-found once its state is gone) is the ordinary cost of
          // the stream ending. Any other refusal is still a refusal.
          const discarded = closedByPeer && error.code === "not-found";
          if (!discarded && (!failed || ordinal < failed.ordinal)) {
            const first = !failed;
            failed = { ordinal, error };
            if (first) hooks?.onFail?.(error);
          }
          settle();
        },
      );
    };

    const throwIfFailed = () => {
      if (failed) throw failed.error;
    };

    const throwIfPeerClosed = () => {
      if (closedByPeer) {
        throw new HttpxError("stream-error", "IBB stream closed by peer");
      }
    };

    const ensureUsable = () => {
      throwIfFailed();
      throwIfPeerClosed();
      if (closed) throw new HttpxError("stream-error", "IBB stream closed");
    };

    /** Admits blocks while the buffer holds them and the window has room. */
    const pump = async (take: () => Uint8Array, hasBlock: () => boolean) => {
      while (hasBlock()) {
        throwIfFailed();
        throwIfPeerClosed();
        if (inFlight >= window) {
          await new Promise<void>((resolve) => slotWaiters.push(resolve));
          continue; // re-check: another writer may have taken the slot
        }
        dispatch(take());
      }
    };

    /** Our <close/> is on the wire; nothing may follow it. */
    let closeSent = false;
    const sendClose = async (reason?: Error) => {
      closeSent = true;
      hooks?.beforeSendClose?.(reason);
      const close = xml("close", { xmlns: NS_IBB, sid });
      await this.#request(to, from, close);
    };

    const stream: IbbOutStream = {
      sid,
      write: async (bytes: Uint8Array): Promise<void> => {
        ensureUsable();
        buffered.push(bytes);
        if (hooks?.flushEachWrite) {
          // Tested at take time, like close()'s tail (see there).
          await pump(
            () => buffered.take(Math.min(blockSize, buffered.size)),
            () => buffered.size > 0,
          );
          return;
        }
        await pump(
          () => buffered.take(blockSize),
          () => buffered.size >= blockSize,
        );
      },
      close: async (): Promise<void> => {
        // A block that failed before the peer closed is still this stream's
        // failure; only then does "the peer already closed it" mean done.
        throwIfFailed();
        if (closedByPeer) return;
        ensureUsable();
        closed = true;
        // Tested at take time, not latched on entry: an un-awaited write()
        // racing this one can drain the buffer while close()'s pump is parked
        // on a window slot, and a latched "there was a remainder" would then
        // send a zero-length block, burning a seq and a round trip.
        try {
          await pump(
            () => buffered.drain(),
            () => buffered.size > 0,
          );
        } catch (err) {
          if (!failed && closedByPeer) return;
          throw err;
        }
        // An abort() landing mid-drain ends the wait: it has sent the one
        // <close/> already, and its reason is what this close() reports.
        while (inFlight > 0 && !closedByPeer && failed?.ordinal !== -1) {
          await new Promise<void>((resolve) => drainWaiters.push(resolve));
        }
        // Only now is every block accounted for: a caller awaiting close()
        // gets the same delivery guarantee it had when write() awaited each
        // block's own ack.
        throwIfFailed();
        if (closedByPeer) return;
        try {
          await sendClose();
        } catch (err) {
          // The two <close/>s crossed on the wire: the peer's reached us
          // before its answer to ours, so the stream is closed either way.
          if (closedByPeer) return;
          failed ??= { ordinal: dispatched, error: fromXmppError(err) };
          throw failed.error;
        }
      },
      abort: async (reason: Error): Promise<void> => {
        // Not `closed`: a close() still draining has not sent its <close/>,
        // and an abort then must stop its pump — or the pump keeps sending
        // <data/> after the abort's <close/>.
        if (closeSent || failed || closedByPeer) return;
        // Ordinal -1: no block has failed yet (or `failed` would be set), and
        // the local reason is the true cause — a later rejection from a block
        // already in flight must not overwrite it.
        failed = { ordinal: -1, error: reason };
        wake(slotWaiters.splice(0));
        wake(drainWaiters.splice(0));
        try {
          await sendClose(reason);
        } catch {
          // The peer may already be gone; nothing more to do.
        }
      },
    };

    const peerClosed = () => {
      if (closedByPeer) return;
      closedByPeer = true;
      // Nothing will ever free a slot or drain the window for us now.
      wake(slotWaiters.splice(0));
      wake(drainWaiters.splice(0));
    };

    return { stream, peerClosed };
  }

  async #request(
    to: string,
    from: string | undefined,
    child: Element,
    timeoutMs?: number,
  ): Promise<Element> {
    const attrs: Record<string, string> =
      from !== undefined ? { type: "set", to, from } : { type: "set", to };
    try {
      // Bound each block by the idle timeout — a peer that stops acking
      // must not stall the sender for the session's full IQ timeout. Data
      // blocks pass a window-scaled deadline; <open>/<close> use the plain one.
      return await this.#session.iqCaller.request(
        xml("iq", attrs, child),
        timeoutMs ?? this.idleTimeoutMs,
      );
    } catch (err) {
      throw fromXmppError(err);
    }
  }

  // ----------------------------------------------------------------- inbound

  /**
   * Announces that an <open> for `sid` from `from` (bare-JID matched) is
   * expected and returns the stream once it arrives. If the <open> already
   * arrived and is parked, it is claimed immediately.
   *
   * `timeoutMs` bounds the wait for the <open>; `idleTimeoutMs` is the
   * stream's own watchdog afterwards. Both default to the manager's
   * idleTimeoutMs, which is what every stream used before either existed.
   */
  expectIncoming(
    from: string,
    sid: string,
    options?: { timeoutMs?: number; idleTimeoutMs?: IbbIdleTimeout },
  ): Promise<IbbInStream> {
    const key = this.#key(from, sid);
    const idleTimeoutMs = options?.idleTimeoutMs;
    return this.#expect(key, sid, options?.timeoutMs, (source) =>
      this.#createInStream(key, source, { idleTimeoutMs }),
    );
  }

  /**
   * The accepting side of openDuplex(): waits for the peer's <open> on `sid`
   * and answers it with a stream we can also send on. Our sending half
   * adopts the peer's sid and block-size — it never sends an <open> of its
   * own, because the sid is already open.
   */
  expectDuplex(
    from: string,
    sid: string,
    options?: DuplexOptions & { timeoutMs?: number },
  ): Promise<IbbDuplex> {
    const key = this.#key(from, sid);
    return this.#expect(key, sid, options?.timeoutMs, (source) => {
      const peer = source.ctx.from?.toString() ?? from;
      const ourJid = options?.from ?? source.ctx.to?.toString();
      return this.#createDuplex(key, {
        peer,
        from: ourJid,
        sid,
        blockSize: source.blockSize,
        window: options?.window,
        idleTimeoutMs: options?.idleTimeoutMs,
      }).handle;
    });
  }

  #expect<T>(
    key: string,
    sid: string,
    timeoutMs: number | undefined,
    build: (source: OpenSource) => T,
  ): Promise<T> {
    const parked = this.#parkedOpens.get(key);
    if (parked) {
      this.#parkedOpens.delete(key);
      clearTimeout(parked.timer);
      const stream = build(parked);
      parked.accept(true);
      return Promise.resolve(stream);
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#expectations.delete(key);
        reject(
          new HttpxError("timeout", `IBB open for ${sid} never arrived`),
        );
      }, timeoutMs ?? this.idleTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.#expectations.set(key, {
        claim: (source) => resolve(build(source)),
        reject,
        timer,
      });
    });
  }

  #ensureStarted(): void {
    if (this.#started) return;
    this.#started = true;
    this.#session.on("stanza", this.#onStanza);
    if (this.#handlersRegistered) return;
    this.#handlersRegistered = true;
    this.#session.iqCallee.set(NS_IBB, "open", (ctx) => this.#onOpen(ctx));
    this.#session.iqCallee.set(NS_IBB, "data", (ctx) => this.#onData(ctx));
    this.#session.iqCallee.set(NS_IBB, "close", (ctx) => this.#onClose(ctx));
  }

  #handlersRegistered = false;

  #key(from: string, sid: string): string {
    return `${bareJid(from)}\n${sid}`;
  }

  #onOpen(ctx: IqContext): Element | boolean | Promise<Element | boolean> {
    const from = ctx.from?.toString();
    const sid = ctx.element.attrs["sid"];
    const blockSize = Number(ctx.element.attrs["block-size"]);
    if (!from || !sid || !Number.isInteger(blockSize) || blockSize <= 0) {
      return iqError("modify", "bad-request");
    }
    if (blockSize > MAX_CHUNK_SIZE) {
      return iqError("modify", "resource-constraint");
    }

    const key = this.#key(from, sid);
    if (this.#inStreams.has(key) || this.#parkedOpens.has(key)) {
      return iqError("cancel", "not-acceptable");
    }

    const expectation = this.#expectations.get(key);
    if (expectation) {
      this.#expectations.delete(key);
      if (expectation.timer !== undefined) clearTimeout(expectation.timer);
      expectation.claim({ ctx, blockSize });
      return true;
    }

    // Unclaimed: park the open and withhold the IQ reply briefly so a
    // racing expectIncoming() can still claim it.
    return new Promise<Element | boolean>((resolveReply) => {
      const timer = setTimeout(() => {
        this.#parkedOpens.delete(key);
        resolveReply(iqError("cancel", "not-acceptable"));
      }, this.acceptTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.#parkedOpens.set(key, {
        ctx,
        blockSize,
        accept: resolveReply,
        timer,
      });
    });
  }

  #createInStream(
    key: string,
    source: OpenSource | InboundDescriptor,
    options: {
      idleTimeoutMs: IbbIdleTimeout | undefined;
      onPeerClose?: () => void;
      onCancel?: (reason: unknown) => void;
      onFail?: (error: Error) => void;
    },
  ): IbbInStream {
    const { from, ourJid, sid, blockSize } =
      "ctx" in source ? describeOpen(source) : source;

    const state: InStreamState = {
      controller: undefined as unknown as ReadableStreamDefaultController<Uint8Array>,
      expectedSeq: 0,
      finished: false,
      idleTimer: undefined,
      pullWaiters: [],
      cancelled: false,
      idleTimeoutMs: options.idleTimeoutMs,
      ...(options.onPeerClose ? { onPeerClose: options.onPeerClose } : {}),
      ...(options.onCancel ? { onCancel: options.onCancel } : {}),
      ...(options.onFail ? { onFail: options.onFail } : {}),
    };

    const readable = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          state.controller = controller;
        },
        pull: () => {
          // Consumer progress is liveness. Without this a stream that is
          // *correctly* backpressured — window full, sender deliberately
          // silent, consumer reading slowly — would trip the idle timer,
          // which only ever saw block arrivals.
          this.#armIdleTimer(key, state);
          for (const waiter of state.pullWaiters.splice(0)) waiter();
        },
        cancel: (reason: unknown) => {
          if (state.onCancel) {
            state.onCancel(reason);
            return;
          }
          state.cancelled = true;
          this.#finishInStream(key, state);
          // Tell the peer we're done (XEP-0047 allows either party to close).
          const close = xml("close", { xmlns: NS_IBB, sid });
          this.#request(from, ourJid, close).catch(() => {
            // Peer may have closed already; best-effort only.
          });
        },
      },
      new ByteLengthQueuingStrategy({
        highWaterMark: this.#receiveBufferBytes(blockSize),
      }),
    );

    this.#armIdleTimer(key, state);
    this.#inStreams.set(key, state);
    return { sid, from, blockSize, readable };
  }

  /**
   * Both halves of a duplex over one sid. The inbound half is an ordinary
   * inbound stream with two hooks; the outbound half is the ordinary windowed
   * sender with one. What ties them together is the teardown, which has to
   * end both halves on every path — close, abort, the peer's <close/>, a
   * cancelled reader, a failed block — and has to survive the two sides
   * closing at the same moment.
   *
   * Crossing closes are why a closing duplex leaves a *tombstone*: its
   * inbound state stays registered, finished and marked cancelled, until our
   * own <close/> is answered. Without it the peer's <close/>, sent before it
   * saw ours, finds nothing and is answered item-not-found — and since the
   * peer did the same to ours, both close() calls would fail on a tunnel
   * that both sides closed cleanly. While the tombstone stands, the peer's
   * crossing <close/> is answered with a result, and its crossing <data/> is
   * acked and discarded rather than refused.
   */
  #createDuplex(
    key: string,
    init: {
      peer: string;
      from: string | undefined;
      sid: string;
      blockSize: number;
      window: number | undefined;
      idleTimeoutMs: IbbIdleTimeout | undefined;
    },
  ): { handle: IbbDuplex; discard: (reason: Error) => void } {
    // Filled in once the inbound half exists; the closures below run later.
    const inbound: { state: InStreamState | undefined } = { state: undefined };

    /**
     * Retires the inbound half: ends the reader (cleanly, or with `error`)
     * and — if `keepTombstone` — leaves the entry registered for a crossing
     * <close/>. Idempotent; a half already finished is left as it is.
     */
    const retireInbound = (error: Error | undefined, keepTombstone: boolean) => {
      const state = inbound.state;
      if (!state || state.finished) return;
      state.cancelled = true; // crossing <data/> is acked and discarded
      try {
        if (error) state.controller.error(error);
        else state.controller.close();
      } catch {
        // Already closed or errored by the reader.
      }
      state.finished = true;
      if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
      for (const waiter of state.pullWaiters.splice(0)) waiter();
      if (!keepTombstone) this.#dropInStream(key, state);
    };

    const removeTombstone = () => {
      if (inbound.state) this.#dropInStream(key, inbound.state);
    };

    /**
     * Whether the peer knows the stream is over: our <close/> went out, or
     * theirs came in. A plain sender that fails stays silent — the peer's
     * watchdog reaps its half — but a tunnel's peer usually has no watchdog,
     * so a duplex that fails without saying so leaves it open for the
     * session. Every teardown path ends in tellPeer().
     */
    let peerKnows = false;
    const tellPeer = async () => {
      if (peerKnows) return;
      peerKnows = true;
      try {
        await this.#request(
          init.peer,
          init.from,
          xml("close", { xmlns: NS_IBB, sid: init.sid }),
        );
      } catch {
        // Best effort: the peer may be why we are failing.
      }
    };

    const out = this.#createOutStream(
      init.peer,
      init.from,
      init.sid,
      init.blockSize,
      init.window,
      {
        // Our <close/> is about to leave: from here on the peer may be
        // closing too, so stop delivering but keep answering.
        beforeSendClose: (reason) => {
          peerKnows = true;
          retireInbound(reason, true);
        },
        flushEachWrite: true,
        // A refused block kills the tunnel now, not whenever someone next
        // writes: with the watchdog off, nothing else would.
        onFail: (error) => void abort(error),
        // Acks are liveness too. A numeric idle timeout on a duplex measures
        // silence in *both* directions; an upload with nothing coming back is
        // not idle. Left alone while the reader is deliberately withholding
        // acks — re-arming then would cut the stretched deadline short.
        onActivity: () => {
          const state = inbound.state;
          if (state && !state.finished && state.pullWaiters.length === 0) {
            this.#armIdleTimer(key, state);
          }
        },
      },
    );

    let closing: Promise<void> | undefined;
    const abort = async (reason: Error): Promise<void> => {
      try {
        await out.stream.abort(reason);
        // out.abort() is a no-op on a stream that already failed or closed,
        // and then neither its hook nor its <close/> ran.
        retireInbound(reason, true);
        await tellPeer();
      } finally {
        // With the watchdog off nothing else would ever remove it.
        retireInbound(reason, false);
        removeTombstone();
      }
    };

    const reader = this.#createInStream(
      key,
      {
        from: init.peer,
        ourJid: init.from,
        sid: init.sid,
        blockSize: init.blockSize,
      },
      {
        idleTimeoutMs: init.idleTimeoutMs ?? false,
        onPeerClose: () => {
          peerKnows = true;
          out.peerClosed();
        },
        onFail: (error) => void abort(error),
        onCancel: (reason) => {
          void abort(
            reason instanceof Error
              ? reason
              : new HttpxError("aborted", "duplex reader cancelled"),
          );
        },
      },
    );
    inbound.state = this.#inStreams.get(key);

    const handle: IbbDuplex = {
      sid: init.sid,
      peer: init.peer,
      blockSize: init.blockSize,
      readable: reader.readable,
      write: (bytes) => out.stream.write(bytes),
      // Idempotent: a second close() joins the first. Otherwise the sender's
      // "already closed" refusal reaches the catch below as if a block had
      // failed, and tears the tunnel down under the first close() mid-flush.
      close: () =>
        (closing ??= (async () => {
          try {
            await out.stream.close();
          } catch (err) {
            // A block failed, so close() never reached its <close/>.
            retireInbound(err instanceof Error ? err : new Error(String(err)), true);
            await tellPeer();
            throw err;
          } finally {
            removeTombstone();
          }
        })()),
      abort,
    };

    return {
      handle,
      // The <open> was refused: the peer holds nothing to be told about.
      discard: (reason) => {
        peerKnows = true;
        retireInbound(reason, false);
        removeTombstone();
      },
    };
  }

  async #onData(ctx: IqContext): Promise<Element | boolean> {
    const from = ctx.from?.toString();
    const sid = ctx.element.attrs["sid"];
    if (!from || !sid) return iqError("modify", "bad-request");

    const key = this.#key(from, sid);
    const state = this.#inStreams.get(key);
    if (!state || state.finished) {
      // Data for a cancelled stream: acknowledge and discard so the sender
      // isn't stuck; data for an unknown stream is an error.
      return state?.cancelled ? true : iqError("cancel", "item-not-found");
    }

    const seq = Number(ctx.element.attrs["seq"]);
    if (!Number.isInteger(seq) || seq !== state.expectedSeq) {
      this.#finishInStream(
        key,
        state,
        new HttpxError("stream-error", `IBB seq mismatch on ${sid}`),
      );
      return iqError("cancel", "unexpected-request");
    }

    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(ctx.element.getText());
    } catch {
      this.#finishInStream(
        key,
        state,
        new HttpxError("stream-error", `invalid base64 in IBB data on ${sid}`),
      );
      return iqError("modify", "bad-request");
    }

    state.expectedSeq = (state.expectedSeq + 1) % 65536;
    this.#armIdleTimer(key, state);
    if (bytes.length > 0) state.controller.enqueue(bytes);

    // Withhold the ack while the consumer lags — real flow control.
    while (
      !state.finished &&
      (state.controller.desiredSize ?? 1) <= 0
    ) {
      // While we are the reason nothing is arriving, "idle" is our own doing:
      // a stream that is correctly backpressured must not time itself out on
      // the ordinary deadline. pull() is not enough to keep it alive — it
      // only fires once desiredSize goes positive again, which under deep
      // backpressure is several consumer reads away. So the clock is
      // stretched across the window rather than stopped: a consumer working
      // through a full window still has room, and a stream whose consumer
      // walked away is still reaped instead of living for the session.
      this.#armIdleTimer(key, state, true);
      await new Promise<void>((resolve) => state.pullWaiters.push(resolve));
    }
    // Resume measuring only once nobody is parked any more.
    if (state.pullWaiters.length === 0) this.#armIdleTimer(key, state);
    // The stream may have died while this handler was parked. Acking then
    // would tell the sender that bytes nobody will ever read arrived — and
    // under a window that is up to `window` false acks before the next block
    // hits the item-not-found above, so the failure stops being prompt.
    if (state.finished && !state.cancelled) {
      return iqError("cancel", "item-not-found");
    }
    return true;
  }

  #onClose(ctx: IqContext): Element | boolean {
    const from = ctx.from?.toString();
    const sid = ctx.element.attrs["sid"];
    if (!from || !sid) return iqError("modify", "bad-request");

    const key = this.#key(from, sid);
    const state = this.#inStreams.get(key);
    if (!state) return iqError("cancel", "item-not-found");

    if (state.finished) {
      // A duplex tombstone: we are closing too and the two <close/>s
      // crossed. The stream is closed either way — say so, and let our own
      // close() know the peer's came first. The tombstone's owner removes it.
      state.onPeerClose?.();
      return true;
    }
    try {
      state.controller.close();
    } catch {
      // Already errored.
    }
    this.#finishInStream(key, state);
    // No half-close: on a duplex the peer's <close/> ends our direction too.
    state.onPeerClose?.();
    return true;
  }

  /** Lenient receive path for message-carried <data> (no ack, no pushback). */
  #handleMessageData(stanza: Element): void {
    if (stanza.getName() !== "message") return;
    const data = stanza.getChild("data", NS_IBB);
    if (!data) return;
    const from = stanza.attrs["from"];
    const sid = data.attrs["sid"];
    if (!from || !sid) return;

    const key = this.#key(from, sid);
    const state = this.#inStreams.get(key);
    if (!state || state.finished) return;

    const seq = Number(data.attrs["seq"]);
    if (!Number.isInteger(seq) || seq !== state.expectedSeq) {
      this.#finishInStream(
        key,
        state,
        new HttpxError("stream-error", `IBB seq mismatch on ${sid}`),
      );
      return;
    }

    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(data.getText());
    } catch {
      this.#finishInStream(
        key,
        state,
        new HttpxError("stream-error", `invalid base64 in IBB data on ${sid}`),
      );
      return;
    }

    state.expectedSeq = (state.expectedSeq + 1) % 65536;
    this.#armIdleTimer(key, state);
    if (bytes.length > 0) state.controller.enqueue(bytes);

    // Message-carried data has no ack to withhold; cap runaway buffering.
    if ((state.controller.desiredSize ?? 0) < -DEFAULT_MAX_BUFFERED_BYTES) {
      this.#finishInStream(
        key,
        state,
        new HttpxError("payload-too-large", `IBB buffer overflow on ${sid}`),
      );
    }
  }

  /**
   * How much an inbound stream buffers before it withholds acks. It has to
   * exceed the window the peer may have in flight, or the very first block
   * drives desiredSize to 0 and every ack waits for a consumer read — the
   * sender's window collapses back to one block per round trip. The extra
   * block is what keeps desiredSize positive *after* a full window lands.
   *
   * Capped at DEFAULT_MAX_BUFFERED_BYTES so a peer cannot turn a large
   * block-size into per-stream memory: the block size is the *peer's* choice
   * on the receive side, and streams are cheap to open.
   */
  #receiveBufferBytes(blockSize: number): number {
    const window = clampWindow(this.receiveWindowBlocks);
    return Math.min(
      DEFAULT_MAX_BUFFERED_BYTES,
      Math.max(64 * 1024, (window + 1) * blockSize),
    );
  }

  /**
   * The deadline that applies while this side is deliberately withholding an
   * ack. The peer is silent on our instructions, so the ordinary idle timeout
   * would be measuring our own decision; but leaving it off entirely means a
   * consumer that walks away keeps the stream — and its buffered bytes, and
   * every parked handler — alive for the rest of the session. One idle
   * timeout per block of the window is the honest budget: it is how long a
   * consumer working steadily through a full window is allowed to take.
   */
  #stalledTimeoutMs(idleTimeoutMs: number): number {
    return idleTimeoutMs * (clampWindow(this.receiveWindowBlocks) + 1);
  }

  #armIdleTimer(key: string, state: InStreamState, stalled = false): void {
    // pull() can fire after the stream is done (a consumer draining what is
    // already queued); re-arming then would resurrect a dead stream's timer.
    if (state.finished) return;
    if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
    // A tunnel's watchdog is off — both deadlines, the stalled one included.
    const idle = state.idleTimeoutMs ?? this.idleTimeoutMs;
    if (idle === false) return;
    state.idleTimer = setTimeout(() => {
      this.#finishInStream(
        key,
        state,
        new HttpxError("timeout", "IBB stream idle timeout"),
      );
    }, stalled ? this.#stalledTimeoutMs(idle) : idle);
    (state.idleTimer as { unref?: () => void }).unref?.();
  }

  /** Unregisters `state` — only if it is still the entry under `key`. */
  #dropInStream(key: string, state: InStreamState): void {
    if (this.#inStreams.get(key) === state) this.#inStreams.delete(key);
  }

  #finishInStream(key: string, state: InStreamState, error?: Error): void {
    if (state.finished) {
      this.#dropInStream(key, state);
      return;
    }
    state.finished = true;
    if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
    for (const waiter of state.pullWaiters.splice(0)) waiter();
    if (error && !state.cancelled) {
      try {
        state.controller.error(error);
      } catch {
        // Stream already closed.
      }
    }
    this.#dropInStream(key, state);
    // Deferred to a macrotask: the handler that found the error (a seq gap in
    // #onData) has yet to return its IQ error. Tearing down now would put our
    // <close/> on the wire first, and the sender — seeing the stream closed
    // before the refusal — would take its refused block for an ordinary
    // post-close discard.
    if (error && state.onFail) {
      const onFail = state.onFail;
      setTimeout(() => onFail(error), 0);
    }
  }
}
