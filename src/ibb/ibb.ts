import xml, { Element } from "@xmpp/xml";
import {
  DEFAULT_IBB_ACCEPT_TIMEOUT_MS,
  DEFAULT_IBB_BLOCK_SIZE,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_BUFFERED_BYTES,
  MAX_CHUNK_SIZE,
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
 * Receiving additionally tolerates message-carried <data> for interop.
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
   */
  write(bytes: Uint8Array): Promise<void>;
  /** Flushes any buffered partial block and sends <close/>. */
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
    options?: { blockSize?: number; from?: string; sid?: string },
  ): Promise<IbbOutStream> {
    const sid = options?.sid ?? generateId("ibb");
    const blockSize = options?.blockSize ?? DEFAULT_IBB_BLOCK_SIZE;
    const from = options?.from;

    const open = xml("open", {
      xmlns: NS_IBB,
      sid,
      "block-size": String(blockSize),
      stanza: "iq",
    });
    await this.#request(to, from, open);

    let seq = 0;
    const buffered = new BlockBuffer();
    let closed = false;
    let failed: Error | undefined;

    const sendBlock = async (bytes: Uint8Array) => {
      const data = xml(
        "data",
        { xmlns: NS_IBB, sid, seq: String(seq) },
        encodeBase64(bytes),
      );
      seq = (seq + 1) % 65536;
      await this.#request(to, from, data);
    };

    const ensureUsable = () => {
      if (failed) throw failed;
      if (closed) throw new HttpxError("stream-error", "IBB stream closed");
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
        try {
          while (buffered.size >= blockSize) {
            await sendBlock(buffered.take(blockSize));
          }
        } catch (err) {
          failed = fromXmppError(err);
          throw failed;
        }
      },
      close: async (): Promise<void> => {
        ensureUsable();
        closed = true;
        try {
          if (buffered.size > 0) {
            await sendBlock(buffered.drain());
          }
          await sendClose();
        } catch (err) {
          failed = fromXmppError(err);
          throw failed;
        }
      },
      abort: async (reason: Error): Promise<void> => {
        if (closed || failed) return;
        failed = reason;
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
  ): Promise<Element> {
    const attrs: Record<string, string> =
      from !== undefined ? { type: "set", to, from } : { type: "set", to };
    try {
      // Bound each block by the idle timeout — a peer that stops acking
      // must not stall the sender for the session's full IQ timeout.
      return await this.#session.iqCaller.request(
        xml("iq", attrs, child),
        this.idleTimeoutMs,
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
      new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }),
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
      await new Promise<void>((resolve) => state.pullWaiters.push(resolve));
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

  #armIdleTimer(key: string, state: InStreamState): void {
    if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      this.#finishInStream(
        key,
        state,
        new HttpxError("timeout", "IBB stream idle timeout"),
      );
    }, this.idleTimeoutMs);
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
