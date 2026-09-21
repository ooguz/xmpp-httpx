import xml, { Element } from "@xmpp/xml";
import type { DataDescriptor } from "../codec/data.js";
import { decodeReq } from "../codec/req.js";
import { encodeResp, type RespStanza } from "../codec/resp.js";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_INLINE_BUDGET,
  DEFAULT_MAX_BUFFERED_BYTES,
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  HTTP_VERSION,
  MIN_CHUNK_SIZE,
  NS_HTTPX,
  NS_STANZAS,
} from "../constants.js";
import { advertiseHttpx } from "../discovery.js";
import { HttpxError } from "../errors.js";
import { IbbManager } from "../ibb/ibb.js";
import type { IqContext, XmppSession } from "../session.js";
import { generateId } from "../session.js";
import type { Socks5Adapter } from "../socks5/protocol.js";
import {
  ChunkedSender,
  ChunkReassembler,
  ChunkRouter,
} from "../transport/chunked.js";
import { createDefaultRegistry } from "../transport/default-registry.js";
import { inlineToBytes, isInline } from "../transport/inline.js";
import type { TransportRegistry } from "../transport/registry.js";
import {
  selectEncoding,
  type BodySource,
  type StreamAcceptFlags,
  type StreamMechanism,
} from "../transport/select.js";
import type { HttpMethod, HttpxBodyInit } from "../types.js";
import { base64Length } from "../util/base64.js";
import {
  chooseEncoding,
  compressStream,
  decompressStream,
  isCompressibleContentType,
  MIN_COMPRESS_BYTES,
  parseContentEncodings,
} from "../util/compression.js";
import {
  bytesFromStream,
  deferredStream,
  iterateStream,
  limitStream,
  streamFromBytes,
  textEncoder,
} from "../util/bytes.js";
import { formatHttpxUrl, resourceForm } from "../urls.js";
import { denyAllWithWarning, type AuthorizeFn } from "./policy.js";

export interface HttpxServerRequest {
  /** Full JID of the requester. */
  from: string;
  /** JID the request was addressed to — meaningful for components. */
  to: string;
  method: HttpMethod;
  /** Path + optional query as sent in <req resource=…>. */
  resource: string;
  /**
   * Reconstructed httpx:// URL, for routing convenience. For the two forms
   * that already name their own target — absolute-form, and CONNECT's
   * authority-form — this is the `resource` verbatim instead.
   */
  url: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  /** What the requester accepts for the response body. */
  accept: StreamAcceptFlags;
}

export interface HttpxHandlerResponse {
  /** Defaults to 200. */
  status?: number;
  statusMessage?: string;
  headers?: HeadersInit;
  body?: HttpxBodyInit;
}

/**
 * Returning a WHATWG Response is supported directly, which makes
 * reverse-proxying to an HTTP origin literally `return fetch(...)`.
 */
export type HttpxHandler = (
  req: HttpxServerRequest,
) => Response | HttpxHandlerResponse | Promise<Response | HttpxHandlerResponse>;

export interface HttpxServerOptions {
  /**
   * Authorization hook, called before the body is consumed. Defaults to
   * deny-all (with a one-time warning) per the XEP's security considerations
   * — pass policy helpers from ./policy.js or your own function.
   */
  authorize?: AuthorizeFn;
  /** Max encoded bytes inlined into the result IQ. Default 4096. */
  inlineBudgetBytes?: number;
  /** Stream mechanism preference for large response bodies. */
  preferredStreams?: readonly StreamMechanism[];
  /** Cap on request body size. Default 8 MiB. */
  maxRequestBodyBytes?: number;
  /** Idle timeout for streamed request bodies. */
  idleTimeoutMs?: number;
  /**
   * IBB blocks kept in flight when streaming a response body, and the number
   * an inbound request body may run ahead before acks are withheld. Default
   * 8. One block costs a round trip, so this is the multiplier on a
   * high-latency path; 1 restores the block-at-a-time sender.
   */
  ibbWindow?: number;
  /**
   * Ceiling on the decoded bytes per IBB block this server sends. The block
   * size is the requester's call — it is the side whose stanza limit has to
   * carry the base64 — so this only ever lowers what `<req maxChunkSize=…>`
   * asked for, never raises it. Derive the requester's side with
   * `stanzaBudgets(maxStanzaBytes)`.
   */
  ibbBlockSize?: number;
  /** Answer disco#info with the urn:xmpp:http feature. Default true. */
  advertise?: boolean;
  /**
   * Compress compressible response bodies when the requester sent
   * Accept-Encoding, and transparently decompress encoded request bodies.
   * Default true.
   */
  compress?: boolean;
  /** Called with errors from handlers and post-reply body streaming. */
  onError?: (error: unknown, context: { from: string; resource?: string }) => void;
  /**
   * Enables XEP-0065 SOCKS5 Bytestreams as a sipub stream-method alongside
   * IBB (Node-only — see xmpp-httpx/node's createSocks5Adapter).
   */
  socks5?: Socks5Adapter;
}

const DEFAULT_STATUS_MESSAGES: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  413: "Payload Too Large",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  504: "Gateway Timeout",
};

interface NormalizedResponse {
  status: number;
  statusMessage: string;
  headers: Headers;
  source: BodySource;
  stream?: ReadableStream<Uint8Array>;
}

export class HttpxServer {
  readonly #session: XmppSession;
  readonly #options: HttpxServerOptions;
  #handler: HttpxHandler | undefined;
  #router: ChunkRouter | undefined;
  #ibb: IbbManager | undefined;
  #registry: TransportRegistry | undefined;
  #started = false;

  constructor(session: XmppSession, options: HttpxServerOptions = {}) {
    this.#session = session;
    this.#options = options;
  }

  handle(handler: HttpxHandler): this {
    this.#handler = handler;
    return this;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#router = ChunkRouter.acquire(this.#session);
    this.#ibb = IbbManager.acquire(this.#session);
    if (this.#options.ibbWindow !== undefined) {
      // Per session, not per stream: an <open> arrives before any per-stream
      // setup exists. Shared with anything else using IBB on this session.
      this.#ibb.receiveWindowBlocks = this.#options.ibbWindow;
    }
    this.#registry = createDefaultRegistry(
      this.#session,
      this.#options.socks5 !== undefined ? { socks5: this.#options.socks5 } : undefined,
    );
    this.#session.iqCallee.set(NS_HTTPX, "req", (ctx) => this.#onReq(ctx));
    if (this.#options.advertise !== false) {
      advertiseHttpx(this.#session);
    }
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#router?.release();
    this.#router = undefined;
    this.#ibb?.release();
    this.#ibb = undefined;
    this.#registry?.releaseAll();
    this.#registry = undefined;
    // The iqCallee handler stays registered (middleware has no removal);
    // it answers service-unavailable while stopped.
  }

  async #onReq(ctx: IqContext): Promise<Element> {
    if (!this.#started || !this.#router || !this.#ibb) {
      return iqError("cancel", "service-unavailable");
    }

    const from = ctx.from?.toString() ?? "";
    const to = ctx.to?.toString() ?? this.#session.jid?.toString() ?? "";
    if (from === "") return iqError("modify", "bad-request");

    let req;
    try {
      req = decodeReq(ctx.element);
    } catch (err) {
      this.#options.onError?.(err, { from });
      return iqError("modify", "bad-request");
    }

    const authorize = this.#options.authorize ?? denyAllWithWarning;
    let allowed: boolean;
    try {
      allowed = await authorize(from, {
        method: req.method,
        resource: req.resource,
        to,
      });
    } catch (err) {
      this.#options.onError?.(err, { from, resource: req.resource });
      allowed = false;
    }
    if (!allowed) {
      return iqError("cancel", "forbidden");
    }

    // Materialize the request body (may be a not-yet-started stream).
    let body: ReadableStream<Uint8Array> | null;
    try {
      body = this.#openRequestBody(from, req.data, to);
    } catch (err) {
      if (err instanceof HttpxError && err.code === "not-implemented") {
        return this.#respond({
          status: 501,
          statusMessage: "Not Implemented",
          headers: new Headers(),
          source: { kind: "empty" },
        });
      }
      if (err instanceof HttpxError && err.code === "payload-too-large") {
        return this.#respond({
          status: 413,
          statusMessage: "Payload Too Large",
          headers: new Headers(),
          source: { kind: "empty" },
        });
      }
      throw err;
    }

    // Transparently undo request-body content codings (the peer may have
    // pre-compressed). A second limit bounds decompression expansion.
    if (body && this.#options.compress !== false) {
      const codings = parseContentEncodings(req.headers.get("content-encoding"));
      if (codings && codings.length > 0) {
        body = limitStream(
          decompressStream(body, codings),
          this.#options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES,
        );
        req.headers.delete("content-encoding");
        req.headers.delete("content-length");
      }
    }

    const request: HttpxServerRequest = {
      from,
      to,
      method: req.method,
      resource: req.resource,
      url: resourceToUrl(to, req.resource),
      headers: req.headers,
      body,
      accept: {
        ibb: req.accept.ibb,
        chunked: true,
        sipub: req.accept.sipub,
        jingle: req.accept.jingle,
        ...(req.maxChunkSize !== undefined
          ? { maxChunkSize: req.maxChunkSize }
          : {}),
      },
    };

    let normalized: NormalizedResponse;
    try {
      const handler = this.#handler;
      if (!handler) {
        normalized = {
          status: 501,
          statusMessage: "Not Implemented",
          headers: new Headers(),
          source: { kind: "empty" },
        };
      } else {
        normalized = await this.#maybeCompress(
          await this.#normalizeResult(await handler(request)),
          req.headers,
        );
      }
    } catch (err) {
      this.#options.onError?.(err, { from, resource: req.resource });
      normalized = {
        status: 500,
        statusMessage: "Internal Server Error",
        headers: new Headers(),
        source: { kind: "empty" },
      };
    } finally {
      // Drop an unconsumed request body so its transport doesn't linger.
      if (body && !body.locked) {
        void body.cancel(new HttpxError("aborted", "request body unused")).catch(() => {});
      }
    }

    return this.#respond(normalized, {
      peer: from,
      ourJid: to,
      accept: request.accept,
    });
  }

  /** Buffers small streamed bodies so they can still be inlined. */
  async #normalizeResult(
    result: Response | HttpxHandlerResponse,
  ): Promise<NormalizedResponse> {
    const inlineBudget = this.#options.inlineBudgetBytes ?? DEFAULT_INLINE_BUDGET;

    let status: number;
    let statusMessage: string | undefined;
    let headers: Headers;
    let source: BodySource;
    let stream: ReadableStream<Uint8Array> | undefined;

    if (result instanceof Response) {
      status = result.status;
      statusMessage = result.statusText || undefined;
      headers = new Headers(result.headers);
      if (result.body === null) {
        source = { kind: "empty" };
      } else {
        const contentLength = Number(headers.get("content-length"));
        if (
          Number.isInteger(contentLength) &&
          contentLength >= 0 &&
          base64Length(contentLength) <= inlineBudget
        ) {
          const bytes = await bytesFromStream(result.body);
          source = bytes.length === 0 ? { kind: "empty" } : { kind: "bytes", bytes };
        } else {
          source = {
            kind: "stream",
            ...(Number.isInteger(contentLength) && contentLength >= 0
              ? { contentLength }
              : {}),
          };
          stream = result.body;
        }
      }
    } else {
      status = result.status ?? 200;
      statusMessage = result.statusMessage;
      headers = new Headers(result.headers);
      const body = result.body;
      if (body === undefined) {
        source = { kind: "empty" };
      } else if (typeof body === "string") {
        const bytes = textEncoder.encode(body);
        source = bytes.length === 0 ? { kind: "empty" } : { kind: "bytes", bytes };
        if (!headers.has("content-type")) {
          headers.set("content-type", "text/plain; charset=utf-8");
        }
      } else if (body instanceof Uint8Array) {
        source = body.length === 0 ? { kind: "empty" } : { kind: "bytes", bytes: body };
      } else if (body instanceof ReadableStream) {
        const contentLength = Number(headers.get("content-length"));
        if (
          Number.isInteger(contentLength) &&
          contentLength >= 0 &&
          base64Length(contentLength) <= inlineBudget
        ) {
          const bytes = await bytesFromStream(body);
          source = bytes.length === 0 ? { kind: "empty" } : { kind: "bytes", bytes };
        } else {
          source = {
            kind: "stream",
            ...(Number.isInteger(contentLength) && contentLength >= 0
              ? { contentLength }
              : {}),
          };
          stream = body;
        }
      } else {
        source = { kind: "element", element: body as Element };
      }
    }

    return {
      status,
      statusMessage:
        statusMessage ?? DEFAULT_STATUS_MESSAGES[status] ?? String(status),
      headers,
      source,
      ...(stream !== undefined ? { stream } : {}),
    };
  }

  /**
   * Compresses a compressible response body when the requester advertised
   * Accept-Encoding. Byte bodies are compressed eagerly — a gzipped body
   * often fits inline where the raw one needed a stream — and kept only
   * when actually smaller; streams are wrapped lazily.
   */
  async #maybeCompress(
    normalized: NormalizedResponse,
    requestHeaders: Headers,
  ): Promise<NormalizedResponse> {
    if (this.#options.compress === false) return normalized;
    if (normalized.headers.has("content-encoding")) return normalized;
    if (!isCompressibleContentType(normalized.headers.get("content-type"))) {
      return normalized;
    }
    const encoding = chooseEncoding(requestHeaders.get("accept-encoding"));
    if (!encoding) return normalized;

    if (normalized.source.kind === "bytes") {
      if (normalized.source.bytes.length < MIN_COMPRESS_BYTES) return normalized;
      const compressed = await bytesFromStream(
        compressStream(streamFromBytes(normalized.source.bytes), encoding),
      );
      if (compressed.length >= normalized.source.bytes.length) return normalized;
      const headers = new Headers(normalized.headers);
      headers.set("content-encoding", encoding);
      headers.set("content-length", String(compressed.length));
      headers.append("vary", "accept-encoding");
      return { ...normalized, headers, source: { kind: "bytes", bytes: compressed } };
    }

    if (normalized.source.kind === "stream" && normalized.stream) {
      const headers = new Headers(normalized.headers);
      headers.set("content-encoding", encoding);
      headers.delete("content-length"); // length now unknown
      headers.append("vary", "accept-encoding");
      return {
        ...normalized,
        headers,
        source: { kind: "stream" },
        stream: compressStream(normalized.stream, encoding),
      };
    }

    // XML element bodies stay uncompressed — they inline as XML.
    return normalized;
  }

  #openRequestBody(
    from: string,
    data: DataDescriptor | undefined,
    ourJid: string,
  ): ReadableStream<Uint8Array> | null {
    if (data === undefined) return null;
    const maxBytes =
      this.#options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;

    if (isInline(data)) {
      const bytes = inlineToBytes(data);
      if (bytes.length > maxBytes) {
        throw new HttpxError("payload-too-large", "inline request body too large");
      }
      return streamFromBytes(bytes);
    }

    if (data.kind === "chunkedBase64") {
      const reassembler = new ChunkReassembler({
        streamId: data.streamId,
        maxBufferedBytes: DEFAULT_MAX_BUFFERED_BYTES,
        idleTimeoutMs: this.#options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      });
      this.#router!.expect(from, reassembler);
      return limitStream(reassembler.readable, maxBytes);
    }

    if (data.kind === "ibb") {
      const sid = data.sid;
      const ibb = this.#ibb!;
      const timeoutMs = this.#options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
      return limitStream(
        deferredStream(async () => {
          const incoming = await ibb.expectIncoming(from, sid, { timeoutMs });
          return incoming.readable;
        }),
        maxBytes,
      );
    }

    if (data.kind === "sipub" || data.kind === "jingle") {
      const transport = this.#registry!.get(data.kind)!;
      const timeoutMs = this.#options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
      return limitStream(
        transport.receive(from, data, {
          timeoutMs,
          ...(ourJid !== "" ? { ourJid } : {}),
        }),
        maxBytes,
      );
    }

    throw new HttpxError(
      "not-implemented",
      `request uses unsupported data mechanism`,
    );
  }

  /**
   * Builds the <resp> element. Streamed bodies are sent after the IQ reply:
   * the sends are scheduled on a macrotask, which runs after the callee
   * middleware's own send call, preserving wire order.
   */
  #respond(
    normalized: NormalizedResponse,
    streamContext?: {
      peer: string;
      ourJid: string;
      accept: StreamAcceptFlags;
    },
  ): Element {
    const resp: RespStanza = {
      version: HTTP_VERSION,
      statusCode: normalized.status,
      statusMessage: normalized.statusMessage,
      headers: normalized.headers,
    };

    if (normalized.source.kind !== "empty" && streamContext) {
      const contentType = normalized.headers.get("content-type");
      const decision = selectEncoding({
        body: normalized.source,
        ...(contentType !== null ? { contentType } : {}),
        accept: streamContext.accept,
        inlineBudgetBytes:
          this.#options.inlineBudgetBytes ?? DEFAULT_INLINE_BUDGET,
        preferredStreams: this.#options.preferredStreams ?? [
          "ibb",
          "chunkedBase64",
        ],
      });

      switch (decision.mode) {
        case "none":
          break;
        case "text":
          resp.data = { kind: "text", text: decision.text };
          break;
        case "xml":
          resp.data = { kind: "xml", element: decision.element };
          break;
        case "base64":
          resp.data = { kind: "base64", bytes: decision.bytes };
          break;
        case "chunkedBase64": {
          const streamId = generateId("stream");
          resp.data = { kind: "chunkedBase64", streamId };
          this.#scheduleChunkedSend(
            streamContext.peer,
            streamContext.ourJid,
            streamId,
            decision.chunkSize,
            this.#materializeStream(normalized),
          );
          break;
        }
        case "ibb": {
          const sid = generateId("ibb");
          resp.data = { kind: "ibb", sid };
          this.#scheduleIbbSend(
            streamContext.peer,
            streamContext.ourJid,
            sid,
            // A cap, never a raise: the requester's stanza limit is what
            // has to carry the base64. Clamped so a nonsense option cannot
            // produce a block below the XEP's floor.
            Math.max(
              MIN_CHUNK_SIZE,
              Math.min(
                decision.blockSize,
                this.#options.ibbBlockSize ?? decision.blockSize,
              ),
            ),
            this.#materializeStream(normalized),
          );
          break;
        }
        case "sipub":
        case "jingle": {
          const transport = this.#registry!.get(decision.mode)!;
          resp.data = transport.offer(streamContext.peer, {
            open: () => this.#materializeStream(normalized),
            ...(contentLengthOf(normalized) !== undefined
              ? { contentLength: contentLengthOf(normalized)! }
              : {}),
            ...(contentType !== null ? { contentType } : {}),
            ...(streamContext.ourJid !== ""
              ? { from: streamContext.ourJid }
              : {}),
            ...(decision.mode === "jingle"
              ? { blockSize: decision.blockSize }
              : {}),
            onError: (err) =>
              this.#options.onError?.(err, { from: streamContext.peer }),
          });
          break;
        }
        case "too-large": {
          resp.statusCode = 413;
          resp.statusMessage = DEFAULT_STATUS_MESSAGES[413]!;
          void normalized.stream?.cancel().catch(() => {});
          break;
        }
      }
    }

    return encodeResp(resp);
  }

  #materializeStream(normalized: NormalizedResponse): ReadableStream<Uint8Array> {
    if (normalized.stream) return normalized.stream;
    if (normalized.source.kind === "bytes") {
      return streamFromBytes(normalized.source.bytes);
    }
    if (normalized.source.kind === "element") {
      return streamFromBytes(
        textEncoder.encode(normalized.source.element.toString()),
      );
    }
    return streamFromBytes(new Uint8Array(0));
  }

  #scheduleChunkedSend(
    peer: string,
    ourJid: string,
    streamId: string,
    chunkSize: number,
    stream: ReadableStream<Uint8Array>,
  ): void {
    setTimeout(() => {
      const sender = new ChunkedSender(this.#session, {
        to: peer,
        streamId,
        chunkSize,
        ...(ourJid !== "" ? { from: ourJid } : {}),
      });
      sender.send(stream).catch((err: unknown) => {
        this.#options.onError?.(err, { from: peer });
      });
    }, 0);
  }

  #scheduleIbbSend(
    peer: string,
    ourJid: string,
    sid: string,
    blockSize: number,
    stream: ReadableStream<Uint8Array>,
  ): void {
    const ibb = this.#ibb;
    setTimeout(() => {
      void (async () => {
        if (!ibb) return;
        const out = await ibb.openOutgoing(peer, {
          sid,
          blockSize,
          ...(this.#options.ibbWindow !== undefined
            ? { window: this.#options.ibbWindow }
            : {}),
          ...(ourJid !== "" ? { from: ourJid } : {}),
        });
        try {
          for await (const part of iterateStream(stream)) {
            await out.write(part);
          }
          await out.close();
        } catch (err) {
          const reason = err instanceof Error ? err : new Error(String(err));
          await out.abort(reason);
          throw reason;
        }
      })().catch((err: unknown) => {
        this.#options.onError?.(err, { from: peer });
      });
    }, 0);
  }
}

function contentLengthOf(normalized: NormalizedResponse): number | undefined {
  if (normalized.source.kind === "bytes") return normalized.source.bytes.length;
  if (normalized.source.kind === "stream") return normalized.source.contentLength;
  return undefined;
}

function iqError(type: "cancel" | "modify" | "wait", condition: string): Element {
  return xml("error", { type }, xml(condition, { xmlns: NS_STANZAS }));
}

function resourceToUrl(jid: string, resource: string): string {
  // Absolute-form already names its own target, and authority-form names a
  // host and port rather than anything with a path: neither becomes an
  // httpx:// URL without inventing something. Pass them through verbatim.
  const form = resourceForm(resource);
  if (form === "absolute" || form === "authority") return resource;

  const queryIndex = resource.indexOf("?");
  if (queryIndex === -1) {
    return formatHttpxUrl({ jid, path: resource });
  }
  return formatHttpxUrl({
    jid,
    path: resource.slice(0, queryIndex),
    search: resource.slice(queryIndex),
  });
}
