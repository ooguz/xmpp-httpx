import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import type { HttpxHandler, HttpxServerRequest } from "../server/server.js";
import { stripHopByHop } from "./hop-by-hop.js";
import { DestinationPolicy, DestinationRefused } from "./destination.js";

/**
 * A *forward* proxy handler: the destination comes from the request, not from
 * a fixed origin (compare `createOriginProxyHandler`, a reverse proxy).
 *
 * - `resource` in absolute-form (`https://host/path`) names the target and
 *   its scheme; the request's own Host is ignored, as forward proxies do.
 * - Origin-form (`/path`) with a Host header is plain `http://`, for
 *   XEP-0332 clients that know nothing of absolute-form.
 *
 * Every connection goes through the destination policy's `lookup`, so the
 * address that is checked is the address that is dialled. Redirects are
 * passed back, never followed: following one would be a second request the
 * policy never saw (and the browser follows them anyway).
 */

export interface ForwardProxyOptions {
  policy: DestinationPolicy;
  /** Names this proxy in the plain-text refusals it sends. Default "xmpp-httpx". */
  name?: string;
  /** Upstream connect + first-byte deadline. Default 30 s. */
  timeoutMs?: number;
  /**
   * Extra CA certificates (PEM) to trust for HTTPS origins, for a private CA
   * on the exit's network. Certificate validation itself is never optional.
   */
  upstreamCa?: string[];
  /** Called with upstream failures, for the operator's log. */
  onUpstreamError?: (error: unknown, target: string) => void;
}

type Answer = { status: number; statusMessage?: string; headers?: HeadersInit; body?: string };

function refusal(name: string, status: number, message: string): Answer {
  return {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: `${name}: ${message}\n`,
  };
}

/** A host[:port] as a Host header or an authority may carry it. */
const AUTHORITY = /^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::[0-9]{1,5})?$/;

/** `scheme://authority` as a URL, or undefined for one no parser takes. */
function originURL(scheme: string, authority: string): URL | undefined {
  if (!AUTHORITY.test(authority)) return undefined;
  // Judged from the text: URL drops a scheme's default port and takes a bare
  // "host:" as no port at all, so its .port cannot tell "…:80" from "…:".
  const port = /^(?:\[[^\]]*\]|[^:]*)(?::([0-9]*))?$/.exec(authority)?.[1];
  if (port !== undefined && (port === "" || Number(port) < 1 || Number(port) > 65535)) {
    return undefined;
  }
  try {
    return new URL(`${scheme}://${authority}`);
  } catch {
    return undefined; // "1.2.3.256", "1.2.3.4.5", and the like
  }
}

export interface ForwardTarget {
  /** Scheme and authority; its path is not used. */
  origin: URL;
  /** The request path exactly as sent — never re-encoded by URL parsing. */
  path: string;
}

/** The upstream a request names, or why it names none. */
export function forwardTarget(
  req: Pick<HttpxServerRequest, "resource" | "headers">,
): ForwardTarget | string {
  const resource = req.resource;
  const absolute = /^(https?):\/\/([^/?#]*)([^#]*)/i.exec(resource);
  if (absolute) {
    const [, scheme, authority, rest] = absolute as unknown as [string, string, string, string];
    if (authority.includes("@")) return "credentials in the URL are not forwarded";
    const origin = originURL(scheme.toLowerCase(), authority);
    if (!origin) return "malformed authority in the URL";
    return { origin, path: rest || "/" };
  }
  if (resource.startsWith("/") && !resource.startsWith("//")) {
    const host = req.headers.get("host");
    if (!host) return "origin-form request without a Host header";
    const origin = originURL("http", host);
    if (!origin) return "Host header does not name a plain host[:port]";
    return { origin, path: resource.replace(/#.*$/, "") };
  }
  return "this exit forwards http:// and https:// requests only";
}

export function createForwardProxyHandler(options: ForwardProxyOptions): HttpxHandler {
  const { policy } = options;
  const name = options.name ?? "xmpp-httpx";
  const refuse = (status: number, message: string): Answer => refusal(name, status, message);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const agents = {
    "http:": new http.Agent({ keepAlive: true }),
    "https:": new https.Agent({ keepAlive: true, ...(options.upstreamCa ? { ca: options.upstreamCa } : {}) }),
  };

  return async (req) => {
    if (req.method === "CONNECT") return refuse(405, "CONNECT is a tunnel, not a request");
    const parsed = forwardTarget(req);
    if (typeof parsed === "string") return refuse(400, parsed);
    const target = parsed.origin;

    const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
    const portVerdict = policy.checkPort(port);
    if (!portVerdict.allowed) return refuse(403, portVerdict.reason);
    // An IP literal never reaches `lookup`, so check it here.
    const hostname = target.hostname.replace(/^\[(.*)\]$/, "$1");
    if (isIP(hostname) !== 0) {
      const verdict = policy.checkAddress(hostname);
      if (!verdict.allowed) return refuse(403, verdict.reason);
    }

    const headers = stripHopByHop(req.headers);
    headers.delete("host");
    // Nothing that names the requester goes upstream. The exit is the client
    // as far as the origin is concerned.
    headers.delete("x-httpx-from");
    const hasBody = req.body !== null;

    try {
      return await new Promise<Response>((resolve, reject) => {
        const upstream = (target.protocol === "https:" ? https : http).request(
          {
            method: req.method,
            protocol: target.protocol,
            hostname,
            port,
            path: parsed.path,
            headers: { ...Object.fromEntries(headers), host: target.host },
            agent: agents[target.protocol as "http:" | "https:"],
            lookup: policy.lookup,
            timeout: timeoutMs,
            // SNI and certificate checks use the name, never the address.
            ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
          },
          (res) => {
            // The deadline was for connecting and the first byte. A body may
            // legitimately pause for longer — an event stream, a slow
            // download — and the XMPP side has its own idle watchdog.
            upstream.setTimeout(0);
            const out = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (value === undefined) continue;
              for (const v of Array.isArray(value) ? value : [value]) out.append(name, v);
            }
            const clean = stripHopByHop(out);
            const nullBody =
              req.method === "HEAD" || res.statusCode === 204 || res.statusCode === 304;
            if (nullBody) res.resume();
            resolve(
              new Response(nullBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
                status: res.statusCode ?? 502,
                statusText: res.statusMessage ?? "",
                headers: clean,
              }),
            );
          },
        );
        upstream.on("timeout", () => upstream.destroy(Object.assign(new Error("upstream timeout"), { code: "ETIMEDOUT" })));
        upstream.on("error", reject);
        if (hasBody) {
          Readable.fromWeb(req.body as import("node:stream/web").ReadableStream<Uint8Array>)
            .on("error", (err) => upstream.destroy(err))
            .pipe(upstream);
        } else {
          upstream.end();
        }
      });
    } catch (err) {
      options.onUpstreamError?.(err, target.origin);
      if (err instanceof DestinationRefused) return refuse(403, err.message);
      // http.request refuses a path with spaces or control characters.
      if ((err as NodeJS.ErrnoException).code === "ERR_UNESCAPED_CHARACTERS") {
        return refuse(400, "the request path contains characters HTTP forbids");
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ETIMEDOUT") return refuse(504, `${target.host} did not answer in time`);
      if (code === "ENOTFOUND" || code === "EAI_AGAIN") return refuse(502, `${target.hostname} does not resolve`);
      return refuse(502, `${target.host} could not be reached (${code ?? "error"})`);
    }
  };
}
