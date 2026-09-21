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

interface InStreamState {
  controller: ReadableStreamDefaultController<Uint8Array>;
  expectedSeq: number;
  finished: boolean;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Resolvers waiting for the consumer to relieve backpressure. */
  pullWaiters: Array<() => void>;
  cancelled: boolean;
}

interface ParkedOpen {
  ctx: IqContext;
  blockSize: number;
  accept: (result: Element | boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Expectation {
  resolve: (stream: IbbInStream) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
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
    const window = clampWindow(options?.window);
    const from = options?.from;
    // Each block carries its own deadline, started when it was *dispatched* —
    // so the last block of a window has been waiting for the whole window to
    // drain by the time its own ack is due. Scaling the deadline by the window
    // restores what the old sender gave every block: idleTimeoutMs of patience
    // measured from its predecessor's ack. Without it, windowing would kill
    // exactly the slow consumers that backpressure exists to serve.
    const blockTimeoutMs = this.idleTimeoutMs * window;

    const open = xml("open", {
      xmlns: NS_IBB,
      sid,
      "block-size": String(blockSize),
      stanza: "iq",
    });
    await this.#request(to, from, open);

    let seq = 0;
    /** Blocks dispatched so far. Unwrapped, unlike seq, so it orders failures. */
    let dispatched = 0;
    const buffered = new BlockBuffer();
    let closed = false;
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
      this.#request(to, from, data, blockTimeoutMs).then(settle, (err: unknown) => {
        if (!failed || ordinal < failed.ordinal) {
          failed = { ordinal, error: fromXmppError(err) };
        }
        settle();
      });
    };

    const throwIfFailed = () => {
      if (failed) throw failed.error;
    };

    const ensureUsable = () => {
      throwIfFailed();
      if (closed) throw new HttpxError("stream-error", "IBB stream closed");
    };

    /** Admits blocks while the buffer holds them and the window has room. */
    const pump = async (take: () => Uint8Array, hasBlock: () => boolean) => {
      while (hasBlock()) {
        throwIfFailed();
        if (inFlight >= window) {
          await new Promise<void>((resolve) => slotWaiters.push(resolve));
          continue; // re-check: another writer may have taken the slot
        }
        dispatch(take());
      }
    };

    const sendClose = async () => {
      const close = xml("close", { xmlns: NS_IBB, sid });
      await this.#request(to, from, close);
    };

    return {
      sid,
      write: async (bytes: Uint8Array): Promise<void> => {
        ensureUsable();
        buffered.push(bytes);
        await pump(
          () => buffered.take(blockSize),
          () => buffered.size >= blockSize,
        );
      },
      close: async (): Promise<void> => {
        ensureUsable();
        closed = true;
        // Tested at take time, not latched on entry: an un-awaited write()
        // racing this one can drain the buffer while close()'s pump is parked
        // on a window slot, and a latched "there was a remainder" would then
        // send a zero-length block, burning a seq and a round trip.
        await pump(
          () => buffered.drain(),
          () => buffered.size > 0,
        );
        while (inFlight > 0) {
          await new Promise<void>((resolve) => drainWaiters.push(resolve));
        }
        // Only now is every block accounted for: a caller awaiting close()
        // gets the same delivery guarantee it had when write() awaited each
        // block's own ack.
        throwIfFailed();
        try {
          await sendClose();
        } catch (err) {
          failed ??= { ordinal: dispatched, error: fromXmppError(err) };
          throw failed.error;
        }
      },
      abort: async (reason: Error): Promise<void> => {
        if (closed || failed) return;
        // Ordinal -1: no block has failed yet (or `failed` would be set), and
        // the local reason is the true cause — a later rejection from a block
        // already in flight must not overwrite it.
        failed = { ordinal: -1, error: reason };
        wake(slotWaiters.splice(0));
        try {
          await sendClose();
        } catch {
          // The peer may already be gone; nothing more to do.
        }
      },
    };
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
   */
  expectIncoming(
    from: string,
    sid: string,
    options?: { timeoutMs?: number },
  ): Promise<IbbInStream> {
    const key = this.#key(from, sid);

    const parked = this.#parkedOpens.get(key);
    if (parked) {
      this.#parkedOpens.delete(key);
      clearTimeout(parked.timer);
      const stream = this.#createInStream(key, parked);
      parked.accept(true);
      return Promise.resolve(stream);
    }

    return new Promise<IbbInStream>((resolve, reject) => {
      const timeoutMs = options?.timeoutMs ?? this.idleTimeoutMs;
      const timer = setTimeout(() => {
        this.#expectations.delete(key);
        reject(
          new HttpxError("timeout", `IBB open for ${sid} never arrived`),
        );
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.#expectations.set(key, { resolve, reject, timer });
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
      const stream = this.#createInStream(key, { ctx, blockSize });
      expectation.resolve(stream);
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
    source: { ctx: IqContext; blockSize: number },
  ): IbbInStream {
    const from = source.ctx.from?.toString() ?? "";
    const sid = source.ctx.element.attrs["sid"] ?? "";

    const state: InStreamState = {
      controller: undefined as unknown as ReadableStreamDefaultController<Uint8Array>,
      expectedSeq: 0,
      finished: false,
      idleTimer: undefined,
      pullWaiters: [],
      cancelled: false,
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
        cancel: () => {
          state.cancelled = true;
          this.#finishInStream(key, state);
          // Tell the peer we're done (XEP-0047 allows either party to close).
          const ourJid = source.ctx.to?.toString();
          const close = xml("close", { xmlns: NS_IBB, sid });
          this.#request(from, ourJid, close).catch(() => {
            // Peer may have closed already; best-effort only.
          });
        },
      },
      new ByteLengthQueuingStrategy({
        highWaterMark: this.#receiveBufferBytes(source.blockSize),
      }),
    );

    this.#armIdleTimer(key, state);
    this.#inStreams.set(key, state);
    return { sid, from, blockSize: source.blockSize, readable };
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
      this.#armIdleTimer(key, state, this.#stalledTimeoutMs());
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

    if (!state.finished) {
      try {
        state.controller.close();
      } catch {
        // Already errored.
      }
    }
    this.#finishInStream(key, state);
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
  #stalledTimeoutMs(): number {
    return this.idleTimeoutMs * (clampWindow(this.receiveWindowBlocks) + 1);
  }

  #armIdleTimer(key: string, state: InStreamState, timeoutMs?: number): void {
    // pull() can fire after the stream is done (a consumer draining what is
    // already queued); re-arming then would resurrect a dead stream's timer.
    if (state.finished) return;
    if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      this.#finishInStream(
        key,
        state,
        new HttpxError("timeout", "IBB stream idle timeout"),
      );
    }, timeoutMs ?? this.idleTimeoutMs);
    (state.idleTimer as { unref?: () => void }).unref?.();
  }

  #finishInStream(key: string, state: InStreamState, error?: Error): void {
    if (state.finished) {
      this.#inStreams.delete(key);
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
    this.#inStreams.delete(key);
  }
}
