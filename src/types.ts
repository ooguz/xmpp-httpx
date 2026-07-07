import type { Element } from "@xmpp/xml";

export const HTTP_METHODS = [
  "OPTIONS",
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "TRACE",
  "PATCH",
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
  signal?: AbortSignal;
}
