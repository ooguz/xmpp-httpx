import xml, { Element } from "@xmpp/xml";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_BUFFERED_BYTES,
  NS_HTTPX,
} from "../constants.js";
import { HttpxError } from "../errors.js";
import { bareJid, type XmppSession } from "../session.js";
import { decodeBase64, encodeBase64 } from "../util/base64.js";
import { BlockBuffer, iterateStream } from "../util/bytes.js";

/**
 * The chunkedBase64 mechanism (XEP-0332 §6.4): after the IQ carrying
 * <chunkedBase64 streamId=…/>, the body arrives in separate <message>
 * stanzas holding <chunk xmlns='urn:xmpp:http' streamId nr last?>base64</chunk>.
 * nr is 0-based; chunks may arrive out of order and carry no ack mechanism.
 */

export class ChunkedSender {
  readonly #session: XmppSession;
  readonly #to: string;
  readonly #from: string | undefined;
  readonly #streamId: string;
  readonly #chunkSize: number;

  constructor(
    session: XmppSession,
    options: {
      to: string;
      streamId: string;
      /** Decoded bytes per chunk. */
      chunkSize: number;
      /** Explicit sender JID — required when sending from a component. */
      from?: string;
    },
  ) {
    this.#session = session;
    this.#to = options.to;
    this.#from = options.from;
    this.#streamId = options.streamId;
    this.#chunkSize = options.chunkSize;
  }

  /**
   * Sends the whole body as chunk messages. Pacing comes from awaiting each
   * session.send() (socket backpressure) — the protocol itself has no acks.
   */
  async send(
    body: ReadableStream<Uint8Array> | Uint8Array,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    const signal = options?.signal;
    let nr = 0;
    const pending = new BlockBuffer();

    // Invariant: at most chunkSize bytes stay buffered, so the final flush is
    // a single chunk — a full buffer is held back in case it turns out last.
    const push = async (part: Uint8Array) => {
      pending.push(part);
      while (pending.size > this.#chunkSize) {
        await this.#sendChunk(nr++, false, pending.take(this.#chunkSize));
      }
    };

    if (body instanceof Uint8Array) {
      await push(body);
    } else {
      for await (const part of iterateStream(body)) {
        signal?.throwIfAborted();
        await push(part);
      }
    }
    signal?.throwIfAborted();
    // Final chunk; an empty body is a single empty chunk with last='true'.
    await this.#sendChunk(nr, true, pending.drain());
  }

  async #sendChunk(nr: number, last: boolean, bytes: Uint8Array) {
    const attrs: Record<string, string> = {
      xmlns: NS_HTTPX,
      streamId: this.#streamId,
      nr: String(nr),
    };
    if (last) attrs["last"] = "true";
    const message = xml(
      "message",
      this.#from !== undefined ? { to: this.#to, from: this.#from } : { to: this.#to },
      xml("chunk", attrs, encodeBase64(bytes)),
    );
    await this.#session.send(message);
  }
}

/**
 * Reassembles chunk messages into an ordered byte stream. Out-of-order
 * chunks are buffered (bounded); duplicates, overflow, and idle timeouts
 * error the stream.
 */
export class ChunkReassembler {
  readonly streamId: string;
  readonly readable: ReadableStream<Uint8Array>;
  /** Invoked exactly once when the stream completes, errors, or is cancelled. */
  onFinished: (() => void) | undefined;

  #controller!: ReadableStreamDefaultController<Uint8Array>;
  #pending = new Map<number, { bytes: Uint8Array; last: boolean }>();
  #pendingBytes = 0;
  #nextNr = 0;
  #lastNr: number | undefined;
  #finished = false;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #maxBufferedBytes: number;
  readonly #idleTimeoutMs: number;

  constructor(options: {
    streamId: string;
    maxBufferedBytes?: number;
    idleTimeoutMs?: number;
  }) {
    this.streamId = options.streamId;
    this.#maxBufferedBytes =
      options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
      cancel: () => {
        this.#finish();
      },
    });
    this.#resetIdleTimer();
  }

  push(nr: number, last: boolean, base64Payload: string): void {
    if (this.#finished) return;
    this.#resetIdleTimer();

    if (nr < this.#nextNr || this.#pending.has(nr)) {
      this.abort(
        new HttpxError("stream-error", `duplicate chunk nr=${nr} on ${this.streamId}`),
      );
      return;
    }
    if (this.#lastNr !== undefined && nr > this.#lastNr) {
      this.abort(
        new HttpxError(
          "stream-error",
          `chunk nr=${nr} after last=${this.#lastNr} on ${this.streamId}`,
        ),
      );
      return;
    }

    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(base64Payload);
    } catch (err) {
      this.abort(
        new HttpxError("stream-error", `invalid base64 in chunk nr=${nr}`, {
          cause: err,
        }),
      );
      return;
    }

    if (last) this.#lastNr = nr;
    this.#pending.set(nr, { bytes, last });
    this.#pendingBytes += bytes.length;
    if (this.#pendingBytes > this.#maxBufferedBytes) {
      this.abort(
        new HttpxError(
          "payload-too-large",
          `chunk buffer exceeded ${this.#maxBufferedBytes} bytes on ${this.streamId}`,
        ),
      );
      return;
    }

    this.#drain();
  }

  abort(reason: Error): void {
    if (this.#finished) return;
    this.#controller.error(reason);
    this.#finish();
  }

  #drain(): void {
    for (;;) {
      const entry = this.#pending.get(this.#nextNr);
      if (!entry) return;
      this.#pending.delete(this.#nextNr);
      this.#pendingBytes -= entry.bytes.length;
      this.#nextNr++;
      if (entry.bytes.length > 0) this.#controller.enqueue(entry.bytes);
      if (entry.last) {
        this.#controller.close();
        this.#finish();
        return;
      }
    }
  }

  #resetIdleTimer(): void {
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    if (this.#finished) return;
    this.#idleTimer = setTimeout(() => {
      this.abort(
        new HttpxError(
          "timeout",
          `chunked stream ${this.streamId} idle for ${this.#idleTimeoutMs}ms`,
        ),
      );
    }, this.#idleTimeoutMs);
    // Don't hold the Node event loop open for an idle watchdog.
    (this.#idleTimer as { unref?: () => void }).unref?.();
  }

  #finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    this.#pending.clear();
    this.#pendingBytes = 0;
    this.onFinished?.();
  }
}

interface OrphanChunk {
  nr: number;
  last: boolean;
  payload: string;
  arrivedAt: number;
}

const ORPHAN_MAX_TOTAL_PAYLOAD = 512 * 1024;
const ORPHAN_TTL_MS = 10_000;

/**
 * Routes incoming <chunk> messages to reassemblers, keyed by (bare peer JID,
 * streamId). Chunks arriving before expect() is called are buffered briefly:
 * stanza events fire synchronously in arrival order, so a chunk in the same
 * network flush as the IQ result can be dispatched before the requester's
 * continuation registers the reassembler.
 *
 * One shared router per session (acquire/release) so multiple clients and
 * servers on a session don't double-buffer orphans.
 */
export class ChunkRouter {
  static #instances = new WeakMap<object, ChunkRouter>();

  static acquire(session: XmppSession): ChunkRouter {
    let router = ChunkRouter.#instances.get(session);
    if (!router) {
      router = new ChunkRouter(session);
      ChunkRouter.#instances.set(session, router);
    }
    router.#refs++;
    if (router.#refs === 1) router.#start();
    return router;
  }

  readonly #session: XmppSession;
  #refs = 0;
  #expected = new Map<string, ChunkReassembler>();
  #orphans = new Map<string, OrphanChunk[]>();
  #orphanBytes = 0;
  readonly #onStanza = (stanza: Element) => this.#handleStanza(stanza);

  private constructor(session: XmppSession) {
    this.#session = session;
  }

  release(): void {
    this.#refs--;
    if (this.#refs <= 0) {
      this.#refs = 0;
      this.#session.removeListener("stanza", this.#onStanza);
      for (const reassembler of this.#expected.values()) {
        reassembler.abort(new HttpxError("aborted", "chunk router closed"));
      }
      this.#expected.clear();
      this.#orphans.clear();
      this.#orphanBytes = 0;
    }
  }

  expect(peer: string, reassembler: ChunkReassembler): void {
    const key = this.#key(peer, reassembler.streamId);
    this.#expected.set(key, reassembler);
    const previous = reassembler.onFinished;
    reassembler.onFinished = () => {
      this.#expected.delete(key);
      previous?.();
    };

    const buffered = this.#orphans.get(key);
    if (buffered) {
      this.#orphans.delete(key);
      for (const chunk of buffered) {
        this.#orphanBytes -= chunk.payload.length;
        reassembler.push(chunk.nr, chunk.last, chunk.payload);
      }
    }
  }

  #start(): void {
    this.#session.on("stanza", this.#onStanza);
  }

  #key(peer: string, streamId: string): string {
    return `${bareJid(peer)}\n${streamId}`;
  }

  #handleStanza(stanza: Element): void {
    if (stanza.getName() !== "message") return;
    const chunk = stanza.getChild("chunk", NS_HTTPX);
    if (!chunk) return;

    const from = stanza.attrs["from"];
    const streamId = chunk.attrs["streamId"];
    const nr = Number(chunk.attrs["nr"]);
    if (!from || !streamId || !Number.isInteger(nr) || nr < 0) return;
    const last = chunk.attrs["last"] === "true" || chunk.attrs["last"] === "1";
    const payload = chunk.getText();

    const key = this.#key(from, streamId);
    const reassembler = this.#expected.get(key);
    if (reassembler) {
      reassembler.push(nr, last, payload);
      return;
    }
    this.#bufferOrphan(key, { nr, last, payload, arrivedAt: Date.now() });
  }

  #bufferOrphan(key: string, chunk: OrphanChunk): void {
    this.#sweepOrphans();
    if (this.#orphanBytes + chunk.payload.length > ORPHAN_MAX_TOTAL_PAYLOAD) {
      return; // Nobody claimed this stream; dropping is the only option.
    }
    let list = this.#orphans.get(key);
    if (!list) {
      list = [];
      this.#orphans.set(key, list);
    }
    list.push(chunk);
    this.#orphanBytes += chunk.payload.length;
  }

  #sweepOrphans(): void {
    const cutoff = Date.now() - ORPHAN_TTL_MS;
    for (const [key, list] of this.#orphans) {
      const kept = list.filter((c) => c.arrivedAt >= cutoff);
      if (kept.length !== list.length) {
        for (const c of list) {
          if (c.arrivedAt < cutoff) this.#orphanBytes -= c.payload.length;
        }
        if (kept.length === 0) this.#orphans.delete(key);
        else this.#orphans.set(key, kept);
      }
    }
  }
}
