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
  NS_HTTPX_CONNECT,
} from "../constants.js";
import { DiscoCache } from "../discovery.js";
import { CodecError, fromXmppError, HttpxError } from "../errors.js";
import { IbbManager, type IbbDuplex } from "../ibb/ibb.js";
import { generateId, type XmppSession } from "../session.js";
import type { Socks5Adapter } from "../socks5/protocol.js";
import {
  ChunkedSender,
  ChunkReassembler,
  ChunkRouter,
} from "../transport/chunked.js";
import { createDefaultRegistry } from "../transport/default-registry.js";
import type { TransportRegistry } from "../transport/registry.js";
import { inlineToBytes, isInline } from "../transport/inline.js";
import {
  selectEncoding,
  type BodySource,
  type StreamMechanism,
} from "../transport/select.js";
import type { HttpxBodyInit, HttpxRequestInit } from "../types.js";
import { resourceForm } from "../urls.js";
import {
  deferredStream,
  iterateStream,
  streamFromBytes,
  textEncoder,
} from "../util/bytes.js";
import {
  decompressStream,
  parseContentEncodings,
} from "../util/compression.js";
import { HttpxResponse } from "./response.js";

export interface HttpxClientOptions {
  /** IQ timeout; also bounds streamed request-body transfer. Default 60 s. */
  defaultTimeoutMs?: number;
  /** Advertised in <req maxChunkSize=…> for chunked responses. */
  maxChunkSize?: number;
  /** Response-body mechanisms to advertise; all default to true. */
  accept?: { ibb?: boolean; sipub?: boolean; jingle?: boolean };
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
  /**
   * IBB blocks kept in flight when streaming a request body, and the number
   * an inbound response body may run ahead before acks are withheld. Default
   * 8. One block costs a round trip, so this is the multiplier on a
   * high-latency path; 1 restores the block-at-a-time sender. The
   * session budget (`ibbSessionWindow`) caps it.
   */
  ibbWindow?: number;
  /**
   * IBB blocks in flight across every stream on this session together — the
   * fair scheduler's budget. Default 16. When it is full, freed slots go to
   * waiting streams in turn, so one large transfer cannot starve the rest.
   * Per session: shared with anything else using IBB on it.
   */
  ibbSessionWindow?: number;
  /**
   * Decoded bytes per IBB block for *request* bodies. XEP-0332 gives the
   * responder no way to advertise a limit for those, so unlike the response
   * direction — where `maxChunkSize` above tells the server what this client
   * can receive — there is nothing to negotiate with and this is simply the
   * size used. Default 4096. Derive it with `stanzaBudgets(maxStanzaBytes)`,
   * against the *responder's* limit.
   */
  ibbBlockSize?: number;
  /**
   * Advertise Accept-Encoding: gzip, deflate (responses are transparently
   * decompressed either way). Default true.
   */
  compress?: boolean;
  /** Explicit sender JID — required when the session is a component. */
  from?: string;
  /**
   * Enables XEP-0065 SOCKS5 Bytestreams as a sipub stream-method alongside
   * IBB (Node-only — see xmpp-httpx/node's createSocks5Adapter).
   */
  socks5?: Socks5Adapter;
}

export interface HttpxConnectInit {
  /** The tunnel's target in authority-form: "example.org:443". */
  authority: string;
  headers?: HeadersInit;
  /**
   * Bounds the CONNECT <req> IQ; defaults to the client's IQ timeout. The
   * wait for the exit's <open> that follows a 2xx is bounded separately, by
   * the client's idleTimeoutMs.
   */
  timeoutMs?: number;
  /** Aborts establishment. Once connect() resolves the tunnel is yours. */
  signal?: AbortSignal;
  /** Elements in other namespaces to carry inside the <req/>, verbatim. */
  extensions?: Element[];
}

export interface HttpxConnectResult {
  /**
   * The exit's answer. For a tunnel it is a 2xx with no body; anything else
   * (403, 502, 504…) is an ordinary response and may carry an explanation.
   */
  response: HttpxResponse;
  /** Both directions of the tunnel on a 2xx, otherwise null. */
  tunnel: IbbDuplex | null;
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

/**
 * Best-effort teardown of a not-yet-read body on abort. A body the consumer
 * is actively reading (locked) is the consumer's to abandon.
 */
function attachAbortCancel(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): ReadableStream<Uint8Array> {
  signal?.addEventListener(
    "abort",
    () => {
      if (!body.locked) {
        void body
          .cancel(new HttpxError("aborted", "request aborted"))
          .catch(() => {});
      }
    },
    { once: true },
  );
  return body;
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
  readonly #registry: TransportRegistry;
  readonly #disco: DiscoCache;
  #closed = false;

  constructor(session: XmppSession, options: HttpxClientOptions = {}) {
    this.#session = session;
    // Our own copy: setStanzaBudgets() adjusts it later without touching the
    // caller's object.
    this.#options = { ...options };
    this.#router = ChunkRouter.acquire(session);
    this.#ibb = IbbManager.acquire(session);
    if (options.ibbWindow !== undefined) {
      // Per session, not per stream: an <open> arrives before any per-stream
      // setup exists. Shared with anything else using IBB on this session.
      this.#ibb.receiveWindowBlocks = options.ibbWindow;
    }
    if (options.ibbSessionWindow !== undefined) {
      this.#ibb.sendWindowBlocks = options.ibbSessionWindow;
    }
    this.#registry = createDefaultRegistry(
      session,
      options.socks5 !== undefined ? { socks5: options.socks5 } : undefined,
    );
    this.#disco = new DiscoCache(session);
  }

  /**
   * Re-derives the sizes the stream's stanza limit bounds — inline request
   * bodies, the chunk size asked of the peer (its stanzas cross our server
   * too) and this client's own IBB blocks — typically from
   * `stanzaBudgets(maxBytes)` once the server has advertised its limit
   * (XEP-0478; see `applyStreamLimits`). Requests already in flight keep the
   * sizes they started with.
   */
  setStanzaBudgets(budgets: { inlineBudgetBytes: number; maxChunkSize: number }): void {
    this.#options.inlineBudgetBytes = budgets.inlineBudgetBytes;
    this.#options.maxChunkSize = budgets.maxChunkSize;
    this.#options.ibbBlockSize = budgets.maxChunkSize;
  }

  async request(to: string, init: HttpxRequestInit = {}): Promise<HttpxResponse> {
    if (this.#closed) {
      throw new HttpxError("aborted", "client is closed");
    }
    const signal = init.signal;
    signal?.throwIfAborted();
    if (init.method === "CONNECT") {
      // A CONNECT answer is a stream in both directions; request() could only
      // ever expose the half that reads.
      throw new HttpxError(
        "protocol-error",
        "CONNECT opens a tunnel; use HttpxClient.connect()",
      );
    }

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
    if (this.#options.compress !== false && !headers.has("accept-encoding")) {
      headers.set("accept-encoding", "gzip, deflate");
    }

    const acceptIbb = this.#options.accept?.ibb ?? true;
    const acceptSipub = this.#options.accept?.sipub ?? true;
    const acceptJingle = this.#options.accept?.jingle ?? true;
    const contentType = headers.get("content-type");
    const decision = selectEncoding({
      body: source,
      ...(contentType !== null ? { contentType } : {}),
      // The XEP offers no way to learn what the responder accepts for
      // *request* bodies; assume the mechanisms we ourselves implement, and
      // let ibbBlockSize stand in for the maxChunkSize the peer cannot send.
      accept: {
        ibb: acceptIbb,
        chunked: true,
        sipub: true,
        jingle: true,
        ...(this.#options.ibbBlockSize !== undefined
          ? { maxChunkSize: this.#options.ibbBlockSize }
          : {}),
      },
      inlineBudgetBytes: this.#options.inlineBudgetBytes ?? DEFAULT_INLINE_BUDGET,
      preferredStreams: this.#options.preferredStreams ?? ["ibb", "chunkedBase64"],
    });

    // A body announced as a stream must be sent as one whatever it came as:
    // bytes or an element past the inline budget travel exactly like a
    // ReadableStream would.
    const streamOfBody = (): ReadableStream<Uint8Array> =>
      stream ??
      (source.kind === "bytes"
        ? streamFromBytes(source.bytes)
        : source.kind === "element"
          ? streamFromBytes(textEncoder.encode(source.element.toString()))
          : streamFromBytes(new Uint8Array(0)));

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
      case "sipub":
      case "jingle": {
        // Handshake-driven: the server calls back; nothing to send post-IQ.
        const transport = this.#registry.get(decision.mode)!;
        data = transport.offer(to, {
          open: streamOfBody,
          ...(source.kind === "bytes"
            ? { contentLength: source.bytes.length }
            : source.kind === "stream" && source.contentLength !== undefined
              ? { contentLength: source.contentLength }
              : {}),
          ...(contentType !== null ? { contentType } : {}),
          ...(from !== undefined ? { from } : {}),
          ...(decision.mode === "jingle"
            ? { blockSize: decision.blockSize }
            : {}),
        });
        break;
      }
      case "too-large":
        throw new HttpxError("payload-too-large", "request body too large");
    }

    const req: ReqStanza = {
      method: init.method ?? "GET",
      resource: init.resource ?? "/",
      version: HTTP_VERSION,
      accept: { sipub: acceptSipub, ibb: acceptIbb, jingle: acceptJingle },
      headers,
      ...(this.#options.maxChunkSize !== undefined
        ? { maxChunkSize: this.#options.maxChunkSize }
        : {}),
      ...(data !== undefined ? { data } : {}),
      ...(init.extensions && init.extensions.length > 0 ? { extensions: init.extensions } : {}),
    };

    const iqAttrs: Record<string, string> =
      from !== undefined ? { type: "set", to, from } : { type: "set", to };
    const iq = xml("iq", iqAttrs, encodeReq(req));

    const timeoutMs = init.timeoutMs ?? this.#options.defaultTimeoutMs ?? DEFAULT_IQ_TIMEOUT_MS;
    const resultPromise = this.#session.iqCaller.request(iq, timeoutMs);
    // The rejection is consumed below; stop it surfacing as unhandled while
    // the request body is still being streamed.
    resultPromise.catch(() => {});

    if (streamBody) {
      try {
        await this.#sendRequestBody(to, from, streamBody, streamOfBody(), signal);
      } catch (err) {
        throw fromXmppError(err);
      }
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

    // Transparently undo known content codings; unknown codings are left
    // for the caller along with their header.
    let body = this.#openResponseBody(peer, resp.data, signal, init.idleTimeoutMs);
    const codings = parseContentEncodings(resp.headers.get("content-encoding"));
    if (body && codings && codings.length > 0) {
      body = decompressStream(body, codings);
      resp.headers.delete("content-encoding");
      resp.headers.delete("content-length");
    }

    return new HttpxResponse({
      statusCode: resp.statusCode,
      ...(resp.statusMessage !== undefined
        ? { statusMessage: resp.statusMessage }
        : {}),
      version: resp.version,
      headers: resp.headers,
      body,
      ...(resp.extensions ? { extensions: resp.extensions } : {}),
    });
  }

  /**
   * Asks `to` for a CONNECT tunnel to `init.authority` (design §4.2). On a
   * 2xx the exit opens one IBB stream and both directions travel on it; the
   * returned tunnel is that stream, with its idle watchdog off — a tunnel is
   * idle by nature, and its liveness is the XMPP session's and the TCP
   * side's business.
   */
  async connect(to: string, init: HttpxConnectInit): Promise<HttpxConnectResult> {
    if (this.#closed) {
      throw new HttpxError("aborted", "client is closed");
    }
    const signal = init.signal;
    signal?.throwIfAborted();
    if (resourceForm(init.authority) !== "authority") {
      throw new CodecError(
        `CONNECT needs an authority-form target (host:port), got "${init.authority}"`,
      );
    }

    const from = this.#options.from;
    if (this.#options.discover !== false) {
      // design §4.4: refuse up front rather than send a method the peer may
      // reject as bad-request. One disco answer serves both questions; as
      // everywhere, "unknown" (no usable disco) proceeds.
      for (const feature of [NS_HTTPX, NS_HTTPX_CONNECT]) {
        const support = await withAbort(this.#disco.supports(to, feature, from), signal);
        if (support === "no") {
          throw new HttpxError(
            "not-implemented",
            `${to} does not advertise ${feature}`,
          );
        }
      }
    }

    const req: ReqStanza = {
      method: "CONNECT",
      resource: init.authority,
      version: HTTP_VERSION,
      // A tunnel is one IBB stream: say so, rather than let the exit pick a
      // mechanism that cannot carry the other direction.
      accept: { sipub: false, ibb: true, jingle: false },
      headers: new Headers(init.headers),
      ...(this.#options.maxChunkSize !== undefined
        ? { maxChunkSize: this.#options.maxChunkSize }
        : {}),
      ...(init.extensions && init.extensions.length > 0 ? { extensions: init.extensions } : {}),
    };
    const iqAttrs: Record<string, string> =
      from !== undefined ? { type: "set", to, from } : { type: "set", to };
    const timeoutMs =
      init.timeoutMs ?? this.#options.defaultTimeoutMs ?? DEFAULT_IQ_TIMEOUT_MS;

    let result: Element;
    try {
      result = await withAbort(
        this.#session.iqCaller.request(xml("iq", iqAttrs, encodeReq(req)), timeoutMs),
        signal,
      );
    } catch (err) {
      throw fromXmppError(err);
    }

    const respEl = result.getChild("resp", NS_HTTPX);
    if (!respEl) {
      throw new CodecError("IQ result without a <resp> element");
    }
    const resp = decodeResp(respEl);
    const peer = result.attrs["from"] ?? to;
    const response = (body: ReadableStream<Uint8Array> | null) =>
      new HttpxResponse({
        statusCode: resp.statusCode,
        ...(resp.statusMessage !== undefined
          ? { statusMessage: resp.statusMessage }
          : {}),
        version: resp.version,
        headers: resp.headers,
        body,
        ...(resp.extensions ? { extensions: resp.extensions } : {}),
      });

    if (resp.statusCode < 200 || resp.statusCode > 299) {
      return {
        response: response(this.#openResponseBody(peer, resp.data, signal)),
        tunnel: null,
      };
    }

    if (resp.data?.kind !== "ibb") {
      // A 2xx is the exit saying the tunnel exists. Without a stream to carry
      // it there is nothing to hand back, and pretending otherwise would give
      // the caller a pipe that silently goes nowhere.
      throw new HttpxError(
        "protocol-error",
        "CONNECT answered 2xx without an IBB stream",
      );
    }

    const pending = this.#ibb.expectDuplex(peer, resp.data.sid, {
      timeoutMs: this.#options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      ...(this.#options.ibbWindow !== undefined
        ? { window: this.#options.ibbWindow }
        : {}),
      ...(from !== undefined ? { from } : {}),
    });
    let tunnel: IbbDuplex;
    try {
      tunnel = await withAbort(pending, signal);
    } catch (err) {
      // Abandoned while the <open> was on its way: a tunnel with its
      // watchdog off would otherwise live, unowned, for the session.
      const reason = err instanceof Error ? err : new Error(String(err));
      pending.then((late) => late.abort(reason)).catch(() => {});
      throw fromXmppError(err);
    }
    return { response: response(null), tunnel };
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
      ...(this.#options.ibbWindow !== undefined
        ? { window: this.#options.ibbWindow }
        : {}),
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
    signal?: AbortSignal | undefined,
    /** Per-request override; falls back to the client option, then the default. */
    idleTimeoutMs?: number | undefined,
  ): ReadableStream<Uint8Array> | null {
    if (data === undefined) return null;
    const idle =
      idleTimeoutMs ?? this.#options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

    if (isInline(data)) {
      return streamFromBytes(inlineToBytes(data));
    }

    if (data.kind === "chunkedBase64") {
      const reassembler = new ChunkReassembler({
        streamId: data.streamId,
        maxBufferedBytes:
          this.#options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
        idleTimeoutMs: idle,
      });
      if (signal) {
        const onAbort = () =>
          reassembler.abort(new HttpxError("aborted", "request aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        // Chained (not clobbered) by ChunkRouter.expect below.
        reassembler.onFinished = () =>
          signal.removeEventListener("abort", onAbort);
      }
      this.#router.expect(peer, reassembler);
      return reassembler.readable;
    }

    if (data.kind === "ibb") {
      const sid = data.sid;
      // The stream's own watchdog follows the configured timeout — per stream
      // now; it used to be the manager's whatever the client was told. Left
      // unset, it is still the manager's.
      const explicitIdle = idleTimeoutMs ?? this.#options.idleTimeoutMs;
      const body = deferredStream(async () => {
        const incoming = await this.#ibb.expectIncoming(peer, sid, {
          timeoutMs: idle,
          ...(explicitIdle !== undefined ? { idleTimeoutMs: explicitIdle } : {}),
        });
        return incoming.readable;
      });
      return attachAbortCancel(body, signal);
    }

    if (data.kind === "sipub" || data.kind === "jingle") {
      const transport = this.#registry.get(data.kind)!;
      const body = transport.receive(peer, data, {
        timeoutMs: idle,
        ...(this.#options.from !== undefined
          ? { ourJid: this.#options.from }
          : {}),
      });
      return attachAbortCancel(body, signal);
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
    this.#registry.releaseAll();
    this.#disco.dispose();
  }
}
