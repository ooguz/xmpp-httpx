import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Duplex } from "node:stream";
import { HttpxError, parseHttpxUrl } from "xmpp-httpx";
import { buildTag, TagBuffer, type DpipTag } from "./dpip.js";

/**
 * One Dillo connection, start to finish.
 *
 * Dillo (via dpid) opens a fresh connection per request and speaks exactly
 * two tags: `auth`, then the command — `open_url` for a page, or `DpiBye`
 * when dpid is shutting the plugin down. The reply to `open_url` is a
 * `start_send_page` tag followed, in raw mode until EOF, by an HTTP response:
 * status line, headers, blank line, body. Dillo's cache parses that block
 * the same way it parses a response from an http origin (`src/cache.c`),
 * so status codes, `Content-Type`, `Content-Length` and `Location` all mean
 * what they mean on the web.
 *
 * Deliberately free of XMPP: the fetch is injected, which is what lets the
 * integration test drive this over the in-memory session pair.
 */

export interface DpiRequestContext {
  /** A line for Dillo's status bar, shown while the page is pending. */
  status(message: string): void;
}

export interface ServeOptions {
  /** Resolve an httpx URL to a WHATWG Response. Errors become error pages. */
  fetch(url: string, context: DpiRequestContext): Promise<Response>;
  /** Verify the shared secret dpid handed Dillo (`~/.dillo/dpid_comm_keys`). */
  checkAuth(message: string): boolean | Promise<boolean>;
  /** dpid sent `DpiBye`: the plugin should exit once this connection closes. */
  onBye?(): void;
  log?(line: string): void;
  /** How long to wait for a tag before giving up on a silent peer. */
  tagTimeoutMs?: number;
}

/**
 * Thrown by the fetch layer when the plugin itself is not ready — no config,
 * cannot sign in — as opposed to the server answering badly. Rendered as a
 * 503 page whose hint tells the user what to fix.
 */
export class DpiSetupError extends Error {
  readonly hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "DpiSetupError";
    this.hint = hint;
  }
}

/** Headers that describe the connection, not the resource. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const REASON: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  413: "Payload Too Large",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

export async function serveConnection(socket: Duplex, options: ServeOptions): Promise<void> {
  const log = options.log ?? (() => undefined);
  const reader = new TagReader(socket, options.tagTimeoutMs ?? 10_000);

  try {
    const auth = await reader.next();
    if (auth === null || auth.cmd !== "auth" || !(await options.checkAuth(auth.msg ?? ""))) {
      log("refused a connection that did not authenticate");
      socket.destroy();
      return;
    }

    const request = await reader.next();
    if (request === null) return;

    if (request.cmd === "DpiBye") {
      log("dpid said DpiBye");
      socket.end();
      options.onBye?.();
      return;
    }
    if (request.cmd !== "open_url" || request.url === undefined) {
      log(`ignoring unknown command ${JSON.stringify(request.cmd ?? "")}`);
      socket.end();
      return;
    }

    await respond(socket, request.url, options, log);
  } catch (err) {
    log(`connection failed: ${err instanceof Error ? err.message : String(err)}`);
    socket.destroy();
  } finally {
    reader.dispose();
  }
}

async function respond(
  socket: Duplex,
  url: string,
  options: ServeOptions,
  log: (line: string) => void,
): Promise<void> {
  const started = Date.now();
  const context: DpiRequestContext = {
    status: (message) => {
      if (!socket.destroyed) socket.write(buildTag({ cmd: "send_status_message", msg: message }));
    },
  };

  let response: Response;
  try {
    parseHttpxUrl(url); // a URL Dillo routed here that is not httpx is a 400, not a crash
    response = await options.fetch(url, context);
  } catch (err) {
    response = errorResponse(url, err);
  }

  log(`${url} → ${response.status} (${Date.now() - started}ms)`);
  if (socket.destroyed) return;

  socket.write(buildTag({ cmd: "start_send_page", url }));
  socket.write(formatHead(response));

  if (response.body === null) {
    socket.end();
    return;
  }
  // pipeline ends the socket when the body ends — and destroys it if the body
  // errors midway, so Dillo sees a truncated transfer rather than a clean end
  // it might cache.
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), socket);
}

export function formatHead(response: Response): string {
  const reason = response.statusText !== "" ? response.statusText : (REASON[response.status] ?? "");
  let head = `HTTP/1.1 ${response.status} ${reason}\r\n`;
  response.headers.forEach((value, name) => {
    if (HOP_BY_HOP.has(name)) return;
    // WHATWG Headers already reject CR/LF in a value; belt and braces here,
    // since a stray newline would end the header block early.
    head += `${name}: ${value.replaceAll(/[\r\n]+/g, " ")}\r\n`;
  });
  return `${head}\r\n`;
}

/** A failure the user can read: status from the error, message escaped. */
export function errorResponse(url: string, err: unknown): Response {
  let status = 502;
  let title = `Could not load ${url}`;
  let hint: string | undefined;
  if (err instanceof DpiSetupError) {
    status = 503;
    title = "httpx plugin is not ready";
    hint = err.hint;
  } else if (err instanceof HttpxError) {
    status = err.httpEquivalent;
    if (status === 403) hint = "The server refused the request — it may not allow your JID.";
    if (status === 504) hint = "The server did not answer in time. Reload to try again.";
  } else if (err instanceof TypeError) {
    status = 400;
    title = "Not an httpx address";
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new Response(renderErrorPage(title, detail, hint), {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function renderErrorPage(title: string, detail: string, hint?: string): string {
  const escape = (text: string): string =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escape(title)}</title></head>
<body><h1>${escape(title)}</h1><pre>${escape(detail)}</pre>${
    hint === undefined ? "" : `<p><i>${escape(hint)}</i></p>`
  }<p><small>xmpp-httpx Dillo plugin</small></p></body></html>
`;
}

/** Promise-shaped access to the tags on a socket, one at a time. */
class TagReader {
  private readonly buffer = new TagBuffer();
  private waiting: ((tag: DpipTag | null) => void) | null = null;
  private failed: ((err: Error) => void) | null = null;
  private ended = false;

  constructor(
    private readonly socket: Duplex,
    private readonly timeoutMs: number,
  ) {
    socket.on("data", this.onData);
    socket.on("end", this.onEnd);
    socket.on("close", this.onEnd);
    socket.on("error", this.onError);
  }

  next(): Promise<DpipTag | null> {
    const ready = this.buffer.nextTag();
    if (ready !== null) return Promise.resolve(ready);
    if (this.ended) return Promise.resolve(null);
    return new Promise<DpipTag | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        this.failed = null;
        reject(new Error(`no dpip tag within ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.waiting = (tag) => {
        clearTimeout(timer);
        resolve(tag);
      };
      this.failed = (err) => {
        clearTimeout(timer);
        reject(err);
      };
    });
  }

  dispose(): void {
    this.socket.off("data", this.onData);
    this.socket.off("end", this.onEnd);
    this.socket.off("close", this.onEnd);
    this.socket.off("error", this.onError);
  }

  private readonly onData = (chunk: Uint8Array): void => {
    try {
      this.buffer.push(chunk);
      const tag = this.waiting === null ? null : this.buffer.nextTag();
      if (tag !== null) this.settle(tag);
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  };

  private readonly onEnd = (): void => {
    this.ended = true;
    if (this.waiting !== null) this.settle(null);
  };

  private readonly onError = (err: Error): void => {
    this.ended = true;
    this.fail(err);
  };

  private settle(tag: DpipTag | null): void {
    const waiting = this.waiting;
    this.waiting = null;
    this.failed = null;
    waiting?.(tag);
  }

  private fail(err: Error): void {
    const failed = this.failed;
    this.waiting = null;
    this.failed = null;
    failed?.(err);
  }
}
