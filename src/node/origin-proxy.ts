import type { HttpxHandler } from "../server/server.js";

/**
 * A reverse-proxy handler fronting a real HTTP origin: the httpx gateway
 * deployment shape. Node-only subpath export (relies on Node's fetch
 * accepting request-body streams with duplex: "half").
 */

// Hop-by-hop headers must not be forwarded (RFC 9110 §7.6.1) — XEP-0332 §9
// additionally requires connection-management headers to be ignored, since
// XMPP has no persistent-connection semantics.
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

export interface OriginProxyOptions {
  /** Add X-Forwarded-For with the requester's bare JID. Default true. */
  forwardedFor?: boolean;
  /**
   * Header carrying the requester's full, XMPP-authenticated JID — the
   * httpx replacement for cookies/Basic auth: the origin can trust it
   * because the XMPP server verified it via SASL. Default "x-httpx-from";
   * pass false to omit.
   */
  jidHeader?: string | false;
  /** Follow redirects at the proxy instead of forwarding them. Default false. */
  followRedirects?: boolean;
}

export function createOriginProxyHandler(
  origin: string | URL,
  options: OriginProxyOptions = {},
): HttpxHandler {
  const base = new URL(origin);

  return async (req) => {
    const url = new URL(req.resource, base);

    const headers = new Headers(req.headers);
    for (const name of HOP_BY_HOP) headers.delete(name);
    // fetch derives Host from the target URL; the httpx Host is not for the origin.
    headers.delete("host");
    if (options.forwardedFor !== false) {
      const bare = req.from.split("/")[0] ?? req.from;
      headers.set("x-forwarded-for", bare);
    }
    if (options.jidHeader !== false) {
      const headerName = options.jidHeader ?? "x-httpx-from";
      headers.set(headerName, req.from);
    }

    const hasBody =
      req.body !== null && req.method !== "GET" && req.method !== "HEAD";
    const init: RequestInit & { duplex?: "half" } = {
      method: req.method,
      headers,
      redirect: options.followRedirects ? "follow" : "manual",
      ...(hasBody ? { body: req.body, duplex: "half" } : {}),
    };

    const upstream = await fetch(url, init);

    const responseHeaders = new Headers(upstream.headers);
    for (const name of HOP_BY_HOP) responseHeaders.delete(name);
    // fetch transparently decompresses but keeps the original headers;
    // they would misdescribe the bytes we actually forward.
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  };
}
