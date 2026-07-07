import type { DataDescriptor } from "../codec/data.js";
import type { StreamAcceptFlags } from "./select.js";

/**
 * A body to hand to a handshake-driven transport (sipub, jingle). The
 * transport builds its <data> descriptor synchronously and registers pending
 * state; `open()` is called (at most once) when the peer completes the
 * handshake and bytes actually start flowing.
 */
export interface BodyOffer {
  open(): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>;
  contentLength?: number;
  contentType?: string;
  /** File name announced in transfer metadata. Default "body". */
  name?: string;
  /** Explicit sender JID — required when the session is a component. */
  from?: string;
  blockSize?: number;
  /** Offers expire unclaimed after this. */
  ttlMs?: number;
  /** Failures after the descriptor was already sent land here. */
  onError?: (err: unknown) => void;
}

/**
 * A handshake-driven body-transport mechanism. The built-ins (inline,
 * chunkedBase64, ibb) are wired directly in client/server for simplicity;
 * sipub and jingle register here.
 */
export interface BodyTransport {
  /** DataDescriptor kind this transport produces/consumes. */
  readonly kind: string;
  /** Whether the peer's <req> accept flags permit sending via this transport. */
  accepts(accept: StreamAcceptFlags): boolean;
  /** Send side: build the descriptor and register the pending handshake. */
  offer(peer: string, body: BodyOffer): DataDescriptor;
  /** Receive side: a lazy stream that drives the handshake on first read. */
  receive(
    peer: string,
    descriptor: DataDescriptor,
    options?: { timeoutMs?: number; ourJid?: string },
  ): ReadableStream<Uint8Array>;
  /** Ref-count release of the underlying per-session manager. */
  release(): void;
}

export class TransportRegistry {
  #transports = new Map<string, BodyTransport>();

  register(transport: BodyTransport): void {
    this.#transports.set(transport.kind, transport);
  }

  get(kind: string): BodyTransport | undefined {
    return this.#transports.get(kind);
  }

  releaseAll(): void {
    for (const transport of this.#transports.values()) {
      transport.release();
    }
    this.#transports.clear();
  }
}
