import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Readable } from "node:stream";
import { HttpxClient, type XmppSession } from "xmpp-httpx";
import { bridgeTunnel, stripHopByHop } from "xmpp-httpx/node";

/**
 * The ordinary web through an n146-style exit, for the shell's own Chromium.
 *
 * A local HTTP proxy that the shell points Chromium at. `https://` (and any
 * other CONNECT) becomes a XEP-0332 CONNECT tunnel to the exit over the shell's
 * XMPP session, piped with `bridgeTunnel`: TLS stays between Chromium and the
 * site, and the exit learns the host and port only. A plain `http://` request
 * becomes an absolute-form XEP-0332 request to the exit, which can read it, as
 * anyone on the path could read plain http anyway.
 *
 * It fails closed. With no exit set, or no XMPP session, every request gets an
 * explanatory 502 page. Chromium is always pointed here, so a web address never
 * loads directly from the shell.
 *
 * Deliberately Electron-free, like protocol.ts, so it is testable against the
 * in-memory session pair with no display.
 */

export interface WebProxyOptions {
  /** The live session, or null while disconnected. Called per request. */
  session: () => XmppSession | null;
  /** The exit's JID, or "" for none. Called per request. */
  exit: () => string;
  /** Per-request IQ timeout for plain http requests. */
  timeoutMs?: number;
  /** Called once per request or tunnel, for the shell's log. */
  onRequest?: (info: { target: string; status: number }) => void;
}

export interface WebProxy {
  /** The loopback port Chromium is pointed at. */
  readonly port: number;
  close(): Promise<void>;
}

const REASONS: Record<number, string> = {
  400: "Bad Request",
  403: "Forbidden",
  405: "Method Not Allowed",
  502: "Bad Gateway",
  504: "Gateway Timeout",
};

/** What a request gets when there is nowhere to send it. */
function unavailable(session: XmppSession | null, exit: string): string | undefined {
  if (exit === "") {
    return "No exit is set. Web addresses go through an exit; set one in the connection settings.";
  }
  if (session === null) return "Not connected to XMPP.";
  return undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function startWebProxy(options: WebProxyOptions): Promise<WebProxy> {
  // One client per session: its discovery cache and IBB state live there.
  const clients = new WeakMap<XmppSession, HttpxClient>();
  const clientFor = (session: XmppSession): HttpxClient => {
    let client = clients.get(session);
    if (!client) {
      client = new HttpxClient(session);
      clients.set(session, client);
    }
    return client;
  };
  const report = (target: string, status: number): void => options.onRequest?.({ target, status });

  const server = http.createServer();
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  // Plain http, as a forward proxy receives it: `GET http://host/path`.
  server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
    void (async () => {
      const target = req.url ?? "";
      const fail = (status: number, message: string): void => {
        report(target, status);
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(status, REASONS[status] ?? "", { "content-type": "text/plain; charset=utf-8" });
        res.end(`httpx shell: ${message}\n`);
      };
      if (!/^http:\/\//i.test(target)) {
        fail(400, "this proxy takes http:// requests and CONNECT tunnels only");
        return;
      }
      const session = options.session();
      const exit = options.exit();
      const why = unavailable(session, exit);
      if (why !== undefined || session === null) {
        fail(502, why ?? "Not connected to XMPP.");
        return;
      }

      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
      }
      const method = (req.method ?? "GET").toUpperCase();
      const hasBody = method !== "GET" && method !== "HEAD";
      try {
        const response = await clientFor(session).request(exit, {
          method: method as "GET",
          resource: target.replace(/#.*$/, ""),
          headers: stripHopByHop(headers),
          ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array> } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        });
        // Each Set-Cookie stays separate; every other field arrives combined.
        const out: Record<string, string[]> = {};
        for (const [name, value] of stripHopByHop(response.headers)) (out[name] ??= []).push(value);
        res.writeHead(response.statusCode, response.statusMessage || undefined, out);
        report(target, response.statusCode);
        if (response.body === null || method === "HEAD") {
          res.end();
          return;
        }
        for await (const chunk of response.body) {
          if (!res.write(chunk)) await new Promise((resolve) => res.once("drain", resolve));
        }
        res.end();
      } catch (err) {
        fail(502, `the exit could not be reached: ${errorText(err)}`);
      }
    })();
  });

  // https:// and anything else Chromium tunnels: CONNECT host:port.
  server.on("connect", (req: http.IncomingMessage, socket: Socket, head: Buffer) => {
    // Nothing may be read before the bridge exists, and a reset meanwhile must
    // not become an uncaught 'error'.
    socket.pause();
    socket.on("error", () => {});
    const authority = req.url ?? "";
    const answer = (status: number, message?: string): void => {
      report(authority, status);
      const body = message === undefined ? "" : `httpx shell: ${message}\n`;
      socket.end(
        `HTTP/1.1 ${status} ${REASONS[status] ?? ""}\r\ncontent-type: text/plain; charset=utf-8\r\n` +
          `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      );
    };
    void (async () => {
      const session = options.session();
      const exit = options.exit();
      const why = unavailable(session, exit);
      if (why !== undefined || session === null) {
        answer(502, why ?? "Not connected to XMPP.");
        return;
      }
      try {
        const { response, tunnel } = await clientFor(session).connect(exit, { authority });
        if (tunnel === null) {
          answer(response.statusCode >= 400 ? response.statusCode : 502, `the exit answered ${response.statusCode}`);
          return;
        }
        report(authority, 200);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        await bridgeTunnel(socket, tunnel, head.length > 0 ? { initial: new Uint8Array(head) } : {});
      } catch (err) {
        answer(502, `the exit could not open a tunnel: ${errorText(err)}`);
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
