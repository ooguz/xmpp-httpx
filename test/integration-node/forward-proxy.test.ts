import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HttpxClient } from "../../src/client/client.js";
import { createConnectHandler } from "../../src/node/connect-proxy.js";
import { DestinationPolicy } from "../../src/node/destination.js";
import { createForwardProxyHandler } from "../../src/node/forward-proxy.js";
import { allowAll } from "../../src/server/policy.js";
import { HttpxServer, type HttpxServerRequest } from "../../src/server/server.js";
import { createSessionPair } from "../../src/testing/mock-session.js";
import { concatBytes, textDecoder } from "../../src/util/bytes.js";

/**
 * The forward-proxy pieces against real local sockets. The destination
 * policy's own address rules are covered in destination.test.ts; here it is
 * the handlers that are checked: that they honour the policy, carry the
 * request faithfully, and turn every failure into an ordinary status.
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A loopback origin that records each request and answers per path. */
async function origin(): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(parts).toString() });
      if (req.url === "/moved") {
        res.writeHead(302, { location: "http://elsewhere.example/" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain", connection: "x-secret", "x-secret": "hop" });
      res.end(`hello ${req.method} ${req.url}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as net.AddressInfo).port, seen };
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function request(resource: string, init: { method?: string; headers?: HeadersInit; body?: string } = {}): HttpxServerRequest {
  return {
    from: "alice@example.org/browser",
    to: "exit.example.org",
    method: (init.method ?? "GET") as HttpxServerRequest["method"],
    resource,
    url: resource,
    headers: new Headers(init.headers),
    body: init.body === undefined ? null : new Response(init.body).body,
    accept: { ibb: true, chunked: true, sipub: false, jingle: false },
    extensions: [],
  };
}

async function answer(handler: ReturnType<typeof createForwardProxyHandler>, req: HttpxServerRequest) {
  const out = await handler(req);
  if (out instanceof Response) return { status: out.status, headers: out.headers, text: await out.text() };
  const body = out.body;
  return {
    status: out.status ?? 200,
    headers: new Headers(out.headers),
    text: typeof body === "string" ? body : "",
  };
}

/** Loopback allowed, so the tests can reach their own origin. */
const open = (ports: number[]) => new DestinationPolicy({ allowPrivate: true, allowPorts: ports });

describe("createForwardProxyHandler", () => {
  it("forwards an absolute-form request, path verbatim, without hop-by-hop or identity headers", async () => {
    const { port, seen } = await origin();
    const handler = createForwardProxyHandler({ policy: open([port]) });
    const res = await answer(
      handler,
      request(`http://127.0.0.1:${port}/a%20b?x=%2F`, {
        method: "POST",
        headers: { "x-httpx-from": "alice@example.org/browser", "proxy-authorization": "Basic c2VjcmV0", host: "ignored.example" },
        body: "payload",
      }),
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe("hello POST /a%20b?x=%2F");
    expect(res.headers.has("x-secret")).toBe(false); // named by Connection
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toBe("payload");
    expect(seen[0]!.headers.host).toBe(`127.0.0.1:${port}`);
    expect(seen[0]!.headers["x-httpx-from"]).toBeUndefined();
    expect(seen[0]!.headers["proxy-authorization"]).toBeUndefined();
  });

  it("hands redirects back instead of following them", async () => {
    const { port, seen } = await origin();
    const res = await answer(createForwardProxyHandler({ policy: open([port]) }), request(`http://127.0.0.1:${port}/moved`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://elsewhere.example/");
    expect(seen).toHaveLength(1);
  });

  it("refuses loopback under the default policy, naming itself in the refusal", async () => {
    const { port, seen } = await origin();
    const handler = createForwardProxyHandler({
      policy: new DestinationPolicy({ allowPorts: [port] }),
      name: "test-exit",
    });
    const res = await answer(handler, request(`http://127.0.0.1:${port}/`));
    expect(res.status).toBe(403);
    expect(res.text).toMatch(/^test-exit: /);
    expect(seen).toHaveLength(0);
  });

  it("refuses a name that resolves to loopback, checked where it is dialled", async () => {
    // A name, not an IP literal: only the socket's lookup can catch this one.
    const { port, seen } = await origin();
    const handler = createForwardProxyHandler({ policy: new DestinationPolicy({ allowPorts: [port] }) });
    const res = await answer(handler, request(`http://localhost:${port}/`));
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("refuses a port the policy does not allow", async () => {
    const { port, seen } = await origin();
    const res = await answer(createForwardProxyHandler({ policy: open([port + 1]) }), request(`http://127.0.0.1:${port}/`));
    expect(res.status).toBe(403);
    expect(res.text).toMatch(/^xmpp-httpx: port /);
    expect(seen).toHaveLength(0);
  });

  it("answers 400 for a target it cannot parse and 405 for CONNECT", async () => {
    const handler = createForwardProxyHandler({ policy: open([80]) });
    expect((await answer(handler, request("ftp://example.org/"))).status).toBe(400);
    expect((await answer(handler, request("example.org:443", { method: "CONNECT" }))).status).toBe(405);
  });

  it("answers 502 when the destination refuses the connection", async () => {
    const port = await closedPort();
    const errors: unknown[] = [];
    const handler = createForwardProxyHandler({ policy: open([port]), onUpstreamError: (e) => errors.push(e) });
    const res = await answer(handler, request(`http://127.0.0.1:${port}/`));
    expect(res.status).toBe(502);
    expect(errors).toHaveLength(1);
  });
});

describe("createConnectHandler", () => {
  function setup(policy: DestinationPolicy) {
    const [clientSession, serverSession] = createSessionPair();
    const server = new HttpxServer(serverSession, { authorize: allowAll(), tunnels: true });
    server.handle(createConnectHandler({ policy }));
    server.start();
    const client = new HttpxClient(clientSession);
    cleanups.push(async () => {
      await client.close();
      server.stop();
    });
    return { client, to: serverSession.jid.toString() };
  }

  async function echo(): Promise<number> {
    const accepted = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      accepted.add(socket);
      socket.on("data", (chunk: Buffer) => {
        socket.write(chunk);
        if (chunk.includes(0x0a)) socket.end(); // a newline ends the exchange
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of accepted) socket.destroy();
          server.close(() => resolve());
        }),
    );
    return (server.address() as net.AddressInfo).port;
  }

  it("dials an allowed destination and pipes both ways", async () => {
    const port = await echo();
    const { client, to } = setup(open([port]));
    const { response, tunnel } = await client.connect(to, { authority: `127.0.0.1:${port}` });
    expect(response.statusCode).toBe(200);
    const reading = (async () => {
      const parts: Uint8Array[] = [];
      for await (const chunk of tunnel!.readable) parts.push(chunk);
      return textDecoder.decode(concatBytes(parts));
    })();
    await tunnel!.write(new TextEncoder().encode("ping\n"));
    expect(await reading).toBe("ping\n");
  });

  it("answers 403 for a destination the policy refuses, without dialling", async () => {
    let dialled = false;
    const server = net.createServer(() => {
      dialled = true;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as net.AddressInfo).port;
    const { client, to } = setup(new DestinationPolicy({ allowPorts: [port] })); // loopback closed
    const { response, tunnel } = await client.connect(to, { authority: `127.0.0.1:${port}` });
    expect(response.statusCode).toBe(403);
    expect(tunnel).toBeNull();
    expect(dialled).toBe(false);
  });

  it("answers 403 for a name that resolves to loopback", async () => {
    const port = await echo();
    const { client, to } = setup(new DestinationPolicy({ allowPorts: [port] }));
    const { response, tunnel } = await client.connect(to, { authority: `localhost:${port}` });
    expect(response.statusCode).toBe(403);
    expect(tunnel).toBeNull();
  });

  it("answers 502 when the destination refuses the connection", async () => {
    const port = await closedPort();
    const { client, to } = setup(open([port]));
    const { response, tunnel } = await client.connect(to, { authority: `127.0.0.1:${port}` });
    expect(response.statusCode).toBe(502);
    expect(tunnel).toBeNull();
  });
});
