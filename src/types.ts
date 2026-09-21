import type { Element } from "@xmpp/xml";

/**
 * CONNECT is a deliberate departure from XEP-0332 v0.5.1, whose method list
 * stops at PATCH — see docs/protocol-notes.md. Without it a tunnel cannot be
 * requested at all, and the alternative (a private method name) would be a
 * larger deviation than reusing the one HTTP already has.
 */
export const HTTP_METHODS = [
  "OPTIONS",
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "TRACE",
  "PATCH",
  "CONNECT",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value);
}

/**
 * Which streaming mechanisms the requester accepts for the response body,
 * mirroring the sipub/ibb/jingle attributes of <req> (each defaults to true
 * on the wire). chunkedBase64 has no attribute — it is always acceptable.
 */
export interface StreamAccept {
  sipub: boolean;
  ibb: boolean;
  jingle: boolean;
}

/** Body values accepted by the client API and handler responses. */
export type HttpxBodyInit =
  | string
  | Uint8Array
  | Element
  | ReadableStream<Uint8Array>;

export interface HttpxRequestInit {
  /** Defaults to "GET". */
  method?: HttpMethod;
  /** Path + optional query, e.g. "/index.html?x=1". Defaults to "/". */
  resource?: string;
  headers?: HeadersInit;
  body?: HttpxBodyInit;
  /** Overrides the client's default IQ timeout for this request. */
  timeoutMs?: number;
  /**
   * Overrides the client's idle timeout for *this* response body — the gap
   * allowed between chunks/blocks of a streamed body. Useful per request
   * because a slow large download and a quick page have different patience.
   */
  idleTimeoutMs?: number;
  signal?: AbortSignal;
}
