import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startWebProxy } from "../../examples/electron/src/web-proxy.js";
import { createConnectHandler } from "../../src/node/connect-proxy.js";
import { DestinationPolicy } from "../../src/node/destination.js";
import { createForwardProxyHandler } from "../../src/node/forward-proxy.js";
import { allowAll } from "../../src/server/policy.js";
import { HttpxServer } from "../../src/server/server.js";
import type { XmppSession } from "../../src/session.js";
import { createSessionPair } from "../../src/testing/mock-session.js";

/**
 * The Electron shell's web proxy, with no Electron: Chromium's side is played
 * by node:http as a proxy client, the exit by an HttpxServer built from the
 * library's forward-proxy pieces, and XMPP by the in-memory session pair.
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const sockets = new Set<net.Socket>();
  server.on("connection", (s: net.Socket) => sockets.add(s));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  );
  return (server.address() as net.AddressInfo).port;
}

/** An http origin that says what it was asked. */
const origin = () =>
  listen(
    http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "set-cookie": ["a=1", "b=2"] });
      res.end(`origin saw ${req.method} ${req.url}`);
    }),
  );

/** A TCP echo server that hangs up after a newline. */
const echo = () =>
  listen(
    net.createServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        socket.write(chunk);
        if (chunk.includes(0x0a)) socket.end();
      });
    }),
  );

/** An exit on the far side of a session pair; loopback opened for the tests. */
async function setup(options: { exitJid?: string; connected?: boolean; policy?: DestinationPolicy } = {}) {
  const [clientSession, serverSession] = createSessionPair("alice@example.org/desktop", "exit.example.org");
  const policy = options.policy ?? new DestinationPolicy({ allowPrivate: true, allowPorts: [] });
  const exit = new HttpxServer(serverSession, { authorize: allowAll(), tunnels: true });
  const tunnels = createConnectHandler({ policy });
  const forward = createForwardProxyHandler({ policy });
  exit.handle((req) => (req.method === "CONNECT" ? tunnels(req) : forward(req)));
  exit.start();
  const exitJid = options.exitJid ?? "exit.example.org";
  const connected = options.connected ?? true;
  const proxy = await startWebProxy({
    session: () => (connected ? (clientSession as XmppSession) : null),
    exit: () => exitJid,
  });
  cleanups.push(async () => {
    await proxy.close();
    exit.stop();
  });
  return { proxy, policy };
}

/** `GET http://…` through the proxy, as Chromium sends it. */
function get(proxyPort: number, target: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: target }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (c: Buffer) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString(), headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** `CONNECT host:port` through the proxy; the socket when the tunnel opened. */
function connect(proxyPort: number, authority: string): Promise<{ status: number; socket: net.Socket; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: authority });
    req.on("connect", (res: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
      cleanups.push(() => void socket.destroy());
      // What followed the reply's headers in the same read arrives as `head`.
      const parts: Buffer[] = [head];
      if (res.statusCode !== 200) {
        socket.on("data", (c: Buffer) => parts.push(c));
        socket.on("end", () => resolve({ status: res.statusCode ?? 0, socket, body: Buffer.concat(parts).toString() }));
        socket.on("error", () => resolve({ status: res.statusCode ?? 0, socket, body: Buffer.concat(parts).toString() }));
        return;
      }
      resolve({ status: 200, socket, body: "" });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("the shell's web proxy", () => {
  it("carries a plain http request to the origin through the exit", async () => {
    const port = await origin();
    const policy = new DestinationPolicy({ allowPrivate: true, allowPorts: [port] });
    const { proxy } = await setup({ policy });
    const res = await get(proxy.port, `http://127.0.0.1:${port}/hello?x=1`);
    expect(res.status).toBe(200);
    expect(res.body).toBe("origin saw GET /hello?x=1");
    expect(res.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
  });

  it("tunnels CONNECT through the exit, bytes both ways", async () => {
    const port = await echo();
    const { proxy } = await setup({ policy: new DestinationPolicy({ allowPrivate: true, allowPorts: [port] }) });
    const { status, socket } = await connect(proxy.port, `127.0.0.1:${port}`);
    expect(status).toBe(200);
    const echoed = new Promise<string>((resolve) => {
      const parts: Buffer[] = [];
      socket.on("data", (c: Buffer) => parts.push(c));
      socket.on("end", () => resolve(Buffer.concat(parts).toString()));
    });
    socket.write("ping\n");
    expect(await echoed).toBe("ping\n");
  });

  it("passes the exit's refusal on: a destination its policy forbids is a 403", async () => {
    const port = await echo();
    const { proxy } = await setup({ policy: new DestinationPolicy({ allowPorts: [port] }) }); // loopback closed
    expect((await connect(proxy.port, `127.0.0.1:${port}`)).status).toBe(403);
  });

  it("fails closed with no exit set: an explanatory 502, nothing sent", async () => {
    const { proxy } = await setup({ exitJid: "" });
    const plain = await get(proxy.port, "http://example.org/");
    expect(plain.status).toBe(502);
    expect(plain.body).toContain("No exit is set");
    const tunnel = await connect(proxy.port, "example.org:443");
    expect(tunnel.status).toBe(502);
    expect(tunnel.body).toContain("No exit is set");
  });

  it("fails closed while disconnected", async () => {
    const { proxy } = await setup({ connected: false });
    const res = await get(proxy.port, "http://example.org/");
    expect(res.status).toBe(502);
    expect(res.body).toContain("Not connected");
  });

  it("refuses a request that is not addressed to a proxy", async () => {
    const { proxy } = await setup();
    expect((await get(proxy.port, "/")).status).toBe(400);
  });
});
