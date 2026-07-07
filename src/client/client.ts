import xml, { Element } from "@xmpp/xml";
import type { DataDescriptor } from "../codec/data.js";
import { encodeReq, type ReqStanza } from "../codec/req.js";
import { decodeResp } from "../codec/resp.js";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_INLINE_BUDGET,
  DEFAULT_IQ_TIMEOUT_MS,
  DEFAULT_MAX_BUFFERED_BYTES,
  HTTP_VERSION,
  NS_HTTPX,
} from "../constants.js";
import { DiscoCache } from "../discovery.js";
import { CodecError, fromXmppError, HttpxError } from "../errors.js";
import { IbbManager } from "../ibb/ibb.js";
import { generateId, type XmppSession } from "../session.js";
import {
  ChunkedSender,
  ChunkReassembler,
  ChunkRouter,
} from "../transport/chunked.js";
import { inlineToBytes, isInline } from "../transport/inline.js";
import {
  selectEncoding,
  type BodySource,
  type StreamMechanism,
} from "../transport/select.js";
import type { HttpxBodyInit, HttpxRequestInit } from "../types.js";
import {
  deferredStream,
  iterateStream,
  streamFromBytes,
  textEncoder,
} from "../util/bytes.js";
import { HttpxResponse } from "./response.js";

export interface HttpxClientOptions {
  /** IQ timeout; also bounds streamed request-body transfer. Default 60 s. */
  defaultTimeoutMs?: number;
  /** Advertised in <req maxChunkSize=…> for chunked responses. */
  maxChunkSize?: number;
  /** Response-body mechanisms to advertise. sipub/jingle are always false in v1. */
  accept?: { ibb?: boolean };
  /** Check the peer for urn:xmpp:http via disco#info first. Default true. */
  discover?: boolean;
  /** Inline budget for request bodies (encoded bytes). */
  inlineBudgetBytes?: number;
  /** Mechanism preference for streamed request bodies. */
  preferredStreams?: readonly StreamMechanism[];
  /** Cap on buffered out-of-order response chunks. */
  maxBufferedBytes?: number;
  /** Idle timeout for streamed response bodies. */
  idleTimeoutMs?: number;
  /** Explicit sender JID — required when the session is a component. */
  from?: string;
}

interface NormalizedBody {
  source: BodySource;
  stream?: ReadableStream<Uint8Array>;
}

function normalizeBody(body: HttpxBodyInit | undefined): NormalizedBody {
  if (body === undefined) return { source: { kind: "empty" } };
  if (typeof body === "string") {
    const bytes = textEncoder.encode(body);
    return { source: bytes.length === 0 ? { kind: "empty" } : { kind: "bytes", bytes } };
  }
  if (body instanceof Uint8Array) {
    return {
      source: body.length === 0 ? { kind: "empty" } : { kind: "bytes", bytes: body },
    };
  }
  if (body instanceof ReadableStream) {
    return { source: { kind: "stream" }, stream: body };
  }
  return { source: { kind: "element", element: body as Element } };
}

async function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new HttpxError("aborted", "request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export class HttpxClient {
  readonly #session: XmppSession;
  readonly #options: HttpxClientOptions;
  readonly #router: ChunkRouter;
  readonly #ibb: IbbManager;
  readonly #disco: DiscoCache;
  #closed = false;

  constructor(session: XmppSession, options: HttpxClientOptions = {}) {
    this.#session = session;
    this.#options = options;
    this.#router = ChunkRouter.acquire(session);
    this.#ibb = IbbManager.acquire(session);
    this.#disco = new DiscoCache(session);
  }

  async request(to: string, init: HttpxRequestInit = {}): Promise<HttpxResponse> {
    if (this.#closed) {
      throw new HttpxError("aborted", "client is closed");
    }
    const signal = init.signal;
    signal?.throwIfAborted();

    const from = this.#options.from;
    if (this.#options.discover !== false) {
      const support = await withAbort(this.#disco.supportsHttpx(to, from), signal);
      if (support === "no") {
        throw new HttpxError(
          "not-implemented",
          `${to} does not advertise ${NS_HTTPX}`,
        );
      }
    }

    const headers = new Headers(init.headers);
    const { source, stream } = normalizeBody(init.body);
    if (typeof init.body === "string" && !headers.has("content-type")) {
      headers.set("content-type", "text/plain; charset=utf-8");
    }

    const acceptIbb = this.#options.accept?.ibb ?? true;
    const decision = selectEncoding({
      body: source,
      ...(headers.get("content-type") !== null
        ? { contentType: headers.get("content-type")! }
        : {}),
      // The XEP offers no way to learn what the responder accepts for
      // *request* bodies; assume the mechanisms we ourselves implement.
      accept: { ibb: acceptIbb, chunked: true },
      inlineBudgetBytes: this.#options.inlineBudgetBytes ?? DEFAULT_INLINE_BUDGET,
      preferredStreams: this.#options.preferredStreams ?? ["ibb", "chunkedBase64"],
    });

    let data: DataDescriptor | undefined;
    let streamBody:
      | { mechanism: "chunkedBase64"; id: string; chunkSize: number }
      | { mechanism: "ibb"; id: string; blockSize: number }
      | undefined;
    switch (decision.mode) {
      case "none":
        break;
      case "text":
        data = { kind: "text", text: decision.text };
        break;
      case "xml":
        data = { kind: "xml", element: decision.element };
        break;
      case "base64":
        data = { kind: "base64", bytes: decision.bytes };
        break;
      case "chunkedBase64": {
        const id = generateId("stream");
        data = { kind: "chunkedBase64", streamId: id };
        streamBody = { mechanism: "chunkedBase64", id, chunkSize: decision.chunkSize };
        break;
      }
      case "ibb": {
        const id = generateId("ibb");
        data = { kind: "ibb", sid: id };
        streamBody = { mechanism: "ibb", id, blockSize: decision.blockSize };
        break;
      }
      case "too-large":
        throw new HttpxError("payload-too-large", "request body too large");
    }

    const req: ReqStanza = {
      method: init.method ?? "GET",
      resource: init.resource ?? "/",
      version: HTTP_VERSION,
      accept: { sipub: false, ibb: acceptIbb, jingle: false },
      headers,
      ...(this.#options.maxChunkSize !== undefined
        ? { maxChunkSize: this.#options.maxChunkSize }
        : {}),
      ...(data !== undefined ? { data } : {}),
    };

    const iqAttrs: Record<string, string> =
      from !== undefined ? { type: "set", to, from } : { type: "set", to };
    const iq = xml("iq", iqAttrs, encodeReq(req));

    const timeoutMs = init.timeoutMs ?? this.#options.defaultTimeoutMs ?? DEFAULT_IQ_TIMEOUT_MS;
    const resultPromise = this.#session.iqCaller.request(iq, timeoutMs);
    // The rejection is consumed below; stop it surfacing as unhandled while
    // the request body is still being streamed.
    resultPromise.catch(() => {});

    if (streamBody && stream) {
      await this.#sendRequestBody(to, from, streamBody, stream, signal);
    }

    let result: Element;
    try {
      result = await withAbort(resultPromise, signal);
    } catch (err) {
      throw fromXmppError(err);
    }

    const respEl = result.getChild("resp", NS_HTTPX);
    if (!respEl) {
      throw new CodecError("IQ result without a <resp> element");
    }
    const resp = decodeResp(respEl);
    const peer = result.attrs["from"] ?? to;

    return new HttpxResponse({
      statusCode: resp.statusCode,
      ...(resp.statusMessage !== undefined
        ? { statusMessage: resp.statusMessage }
        : {}),
      version: resp.version,
      headers: resp.headers,
      body: this.#openResponseBody(peer, resp.data),
    });
  }

  async #sendRequestBody(
    to: string,
    from: string | undefined,
    streamBody:
      | { mechanism: "chunkedBase64"; id: string; chunkSize: number }
      | { mechanism: "ibb"; id: string; blockSize: number },
    stream: ReadableStream<Uint8Array>,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (streamBody.mechanism === "chunkedBase64") {
      const sender = new ChunkedSender(this.#session, {
        to,
        streamId: streamBody.id,
        chunkSize: streamBody.chunkSize,
        ...(from !== undefined ? { from } : {}),
      });
      await sender.send(stream, signal !== undefined ? { signal } : {});
      return;
    }

    const out = await this.#ibb.openOutgoing(to, {
      sid: streamBody.id,
      blockSize: streamBody.blockSize,
      ...(from !== undefined ? { from } : {}),
    });
    try {
      for await (const part of iterateStream(stream)) {
        signal?.throwIfAborted();
        await out.write(part);
      }
      await out.close();
    } catch (err) {
      const reason = err instanceof Error ? err : new Error(String(err));
      await out.abort(reason);
      throw reason;
    }
  }

  #openResponseBody(
    peer: string,
    data: DataDescriptor | undefined,
  ): ReadableStream<Uint8Array> | null {
    if (data === undefined) return null;

    if (isInline(data)) {
      return streamFromBytes(inlineToBytes(data));
    }

    if (data.kind === "chunkedBase64") {
      const reassembler = new ChunkReassembler({
        streamId: data.streamId,
        maxBufferedBytes:
          this.#options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
        idleTimeoutMs: this.#options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      });
      this.#router.expect(peer, reassembler);
      return reassembler.readable;
    }

    if (data.kind === "ibb") {
      const sid = data.sid;
      return deferredStream(async () => {
        const incoming = await this.#ibb.expectIncoming(peer, sid, {
          timeoutMs: this.#options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
        });
        return incoming.readable;
      });
    }

    throw new HttpxError(
      "not-implemented",
      `response uses unsupported data mechanism "${data.name}"`,
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#router.release();
    this.#ibb.release();
  }
}
