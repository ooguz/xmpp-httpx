import { HttpxError, httpxFetch, parseHttpxUrl, type XmppSession } from "xmpp-httpx";

/**
 * The whole reason for an Electron shell: `protocol.handle("httpx", …)` makes
 * `httpx://` a scheme Chromium itself fetches. The address bar is real, history
 * is real, and **subresources come for free** — an `<img src="logo.png">` or a
 * `background-image: url(...)` inside an httpx page is resolved and fetched
 * through this same handler, so none of the extension's blob-URL rewriting is
 * needed.
 *
 * Deliberately Electron-free: it maps a WHATWG `Request` to a `Response`, which
 * is exactly what `protocol.handle` wants and exactly what `httpxFetch` already
 * returns. That also makes it testable against the in-memory session pair from
 * `xmpp-httpx/testing`, with no display and no app.
 */

export interface HttpxProtocolOptions {
  /** The live session, or null while disconnected. Called per request. */
  session: () => XmppSession | null;
  /**
   * Let page scripts run. Default **false**: this project's stance is that an
   * httpx page is a document, not an application, and the extension refuses
   * scripts outright. Here the refusal is a CSP rather than a stripped tag,
   * because Chromium is doing the parsing.
   */
  allowScripts?: boolean;
  /** Per-request IQ timeout. */
  timeoutMs?: number;
  /** Called for every request, for the shell's log/UI. */
  onRequest?: (info: { url: string; status: number; durationMs: number }) => void;
}

/** Headers we always impose on a page, whatever the origin server said. */
function securityHeaders(allowScripts: boolean): Record<string, string> {
  const csp = [
    "default-src 'self' httpx:",
    // Inline CSS is how httpx pages style themselves (there is no <link> chain
    // worth having over XMPP), so it has to be allowed.
    "style-src 'self' httpx: 'unsafe-inline'",
    "img-src 'self' httpx: data:",
    "font-src 'self' httpx: data:",
    allowScripts ? "script-src 'self' httpx:" : "script-src 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self' httpx:",
    // No http(s) subresources: an httpx page pulling from the web would leak
    // the visit and defeat the point of the transport.
    "connect-src 'self' httpx:",
  ].join("; ");

  return {
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

/**
 * How an account JID survives a URL that cannot carry userinfo.
 *
 * The Fetch standard forbids credentials in a `Request` URL — `new
 * Request("httpx://alice@example.org/")` throws, exactly as it does for http —
 * and `protocol.handle` hands this module a `Request`. So `httpx://user@host/`
 * simply cannot reach the handler, and the JID's user part has to travel inside
 * the host instead.
 *
 * A **component domain** (`httpx://web.example.org/`) needs none of this, which
 * is why it is the shape the shell is built around: it is also what the gateway
 * CLI serves. Account JIDs are best-effort — a localpart with characters a
 * hostname cannot hold will not survive the trip.
 */
export const JID_HOST_SEPARATOR = "--at--";

/** `alice@example.org` → `alice--at--example.org`; a domain is left alone. */
export function encodeJidForHost(jid: string): string {
  const at = jid.indexOf("@");
  if (at === -1) return jid;
  return `${jid.slice(0, at)}${JID_HOST_SEPARATOR}${jid.slice(at + 1)}`;
}

/** The reverse; hosts arrive lowercased, which JID localparts tolerate. */
export function decodeJidFromHost(host: string): string {
  const index = host.indexOf(JID_HOST_SEPARATOR);
  if (index === -1) return host;
  return `${host.slice(0, index)}@${host.slice(index + JID_HOST_SEPARATOR.length)}`;
}

/**
 * A URL the user typed (`httpx://alice@example.org/x`) → one Chromium can
 * actually navigate to and hand back to us.
 */
export function toNavigableUrl(typed: string): string {
  const url = parseHttpxUrl(typed);
  return `httpx://${encodeJidForHost(url.jid)}${url.path}${url.search}`;
}

/** The inverse, for the address bar: show the JID, not the encoding. */
export function toDisplayUrl(navigable: string): string {
  try {
    const url = new URL(navigable);
    return `httpx://${decodeJidFromHost(url.hostname)}${url.pathname}${url.search}`;
  } catch {
    return navigable;
  }
}

/** Turns the URL Chromium hands us back into an httpx URL string. */
export function httpxUrlFromRequest(requestUrl: string): string {
  const url = new URL(requestUrl);
  // `username` should always be empty (Fetch forbids credentials), but if a
  // future Chromium ever passes one through, honor it rather than lose it.
  const jid =
    url.username === ""
      ? decodeJidFromHost(url.hostname)
      : `${decodeURIComponent(url.username)}@${url.hostname}`;
  return `httpx://${jid}${url.pathname}${url.search}`;
}

/**
 * The shell's own error documents. Exported because the escaping here is the
 * only thing standing between a server-supplied error message and the page, and
 * that deserves a direct test.
 */
export function renderErrorPage(title: string, detail: string, hint?: string): string {
  const escape = (text: string): string =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem;
         color-scheme: light dark }
  h1 { font-size: 1.3rem } pre { white-space: pre-wrap; opacity: 0.8; font-size: 0.9rem }
  p.hint { opacity: 0.75 }
</style></head><body>
<h1>${escape(title)}</h1><pre>${escape(detail)}</pre>
${hint === undefined ? "" : `<p class="hint">${escape(hint)}</p>`}
</body></html>`;
}

function htmlResponse(status: number, body: string, allowScripts: boolean): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...securityHeaders(allowScripts),
    },
  });
}

export function createHttpxProtocolHandler(
  options: HttpxProtocolOptions,
): (request: Request) => Promise<Response> {
  const allowScripts = options.allowScripts ?? false;

  return async (request: Request): Promise<Response> => {
    const started = Date.now();

    let href: string;
    try {
      href = parseHttpxUrl(httpxUrlFromRequest(request.url)).href;
    } catch (err) {
      return htmlResponse(
        400,
        renderErrorPage("Not an httpx address", String(err)),
        allowScripts,
      );
    }

    const session = options.session();
    if (session === null) {
      options.onRequest?.({ url: href, status: 503, durationMs: Date.now() - started });
      // A page, not a network error: the address bar should show something the
      // user can act on.
      return htmlResponse(
        503,
        renderErrorPage(
          "Not connected to XMPP",
          `Cannot load ${href} yet.`,
          "Open the connection settings and sign in, then reload.",
        ),
        allowScripts,
      );
    }

    // Buffer a request body rather than forwarding the stream: form posts are
    // small, and it keeps this free of duplex-stream caveats.
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : new Uint8Array(await request.arrayBuffer());

    try {
      const response = await httpxFetch(href, {
        session,
        method: request.method,
        headers: request.headers,
        ...(body !== undefined && body.length > 0 ? { body } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });

      // Our headers win: a page must not be able to loosen its own CSP.
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(securityHeaders(allowScripts))) {
        headers.set(name, value);
      }

      options.onRequest?.({
        url: href,
        status: response.status,
        durationMs: Date.now() - started,
      });

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (err) {
      const status = err instanceof HttpxError ? err.httpEquivalent : 502;
      options.onRequest?.({ url: href, status, durationMs: Date.now() - started });
      return htmlResponse(
        status,
        renderErrorPage(
          `Could not load ${href}`,
          err instanceof Error ? err.message : String(err),
          status === 403
            ? "The server refused the request — it may not allow your JID."
            : undefined,
        ),
        allowScripts,
      );
    }
  };
}
