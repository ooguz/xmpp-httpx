import net from "node:net";
import xml from "@xmpp/xml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpxClient } from "../../src/client/client.js";
import { createSocks5Adapter } from "../../src/node/socks5.js";
import { allowAll } from "../../src/server/policy.js";
import {
  HttpxServer,
  type HttpxHandler,
  type HttpxServerOptions,
} from "../../src/server/server.js";
import type { XmppSession } from "../../src/session.js";
import {
  buildConnectReply,
  buildMethodSelection,
  parseConnectRequest,
  type Socks5Adapter,
} from "../../src/socks5/protocol.js";
import { bytesFromStream, streamFromBytes } from "../../src/util/bytes.js";
import { createSessionPair } from "../../src/testing/mock-session.js";

/**
 * SOCKS5 Bytestreams (XEP-0065) needs real TCP sockets, so it can never run
 * under the browser vitest project — see vitest.config.ts's NODE_ONLY glob.
 */

function patternBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function stubSession(jid: string): XmppSession {
  return {
    jid: { toString: () => jid },
    send: async () => {},
    iqCaller: { request: async () => xml("iq", { type: "result" }) },
    iqCallee: { get: () => {}, set: () => {} },
    on: () => undefined,
    removeListener: () => undefined,
  };
}

/**
 * An independent minimal XEP-0065 proxy: pairs two sockets that CONNECT with
 * the same domain hash and pipes bytes between them. Deliberately NOT built
 * from src/node/socks5.ts's own handshake code, so a bug shared between the
 * "client" and "server" handshake implementations would still be caught.
 */
function startFakeProxy(): Promise<{
  host: string;
  port: number;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const waiting = new Map<string, net.Socket>();

    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      const onGreeting = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 2) return;
        const nmethods = buffer[1]!;
        if (buffer.length < 2 + nmethods) return;
        socket.removeListener("data", onGreeting);
        buffer = buffer.subarray(2 + nmethods);
        socket.write(Buffer.from(buildMethodSelection()));

        const onRequest = (more: Buffer) => {
          buffer = Buffer.concat([buffer, more]);
          if (buffer.length < 5) return;
          const len = buffer[4]!;
          if (buffer.length < 5 + len + 2) return;
          socket.removeListener("data", onRequest);
          const { domain } = parseConnectRequest(new Uint8Array(buffer));
          socket.write(Buffer.from(buildConnectReply(domain, true)));

          const partner = waiting.get(domain);
          if (partner) {
            waiting.delete(domain);
            socket.pipe(partner);
            partner.pipe(socket);
          } else {
            waiting.set(domain, socket);
          }
        };
        socket.on("data", onRequest);
      };
      socket.on("data", onGreeting);
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("failed to bind fake proxy"));
        return;
      }
      resolve({
        host: "127.0.0.1",
        port: addr.port,
        close: () => server.close(),
      });
    });
  });
}

describe("SOCKS5 bytestreams adapter (XEP-0065)", () => {
  it("relays bytes end-to-end through an external proxy candidate", async () => {
    const proxy = await startFakeProxy();
    cleanups.push(() => proxy.close());

    const publisherAdapter = createSocks5Adapter(
      stubSession("publisher@example.org/res"),
      { proxyJid: "proxy.example.org", proxyHost: proxy.host, proxyPort: proxy.port },
    );
    const retrieverAdapter = createSocks5Adapter(
      stubSession("retriever@example.org/res"),
      { proxyJid: "proxy.example.org", proxyHost: proxy.host, proxyPort: proxy.port },
    );
    cleanups.push(() => {
      publisherAdapter.release();
      retrieverAdapter.release();
    });

    const sid = "test-sid-proxy";
    const ctx = {
      requesterJid: "publisher@example.org/res",
      targetJid: "retriever@example.org/res",
    };

    const candidates = await publisherAdapter.candidatesFor(sid, ctx);
    expect(candidates).toEqual([
      { jid: "proxy.example.org", host: proxy.host, port: proxy.port },
    ]);

    const [out, result] = await Promise.all([
      publisherAdapter.openOutgoing(sid, "proxy.example.org", { ...ctx, candidates }),
      retrieverAdapter.connect(sid, candidates, ctx),
    ]);
    expect(result.usedJid).toBe("proxy.example.org");

    const payload = patternBytes(200_000);
    const writer = (async () => {
      await out.write(payload);
      await out.close();
    })();
    const received = await bytesFromStream(result.readable);
    await writer;
    expect(received).toEqual(payload);
  });

  it("rejects a streamhost-used naming a candidate we never offered", async () => {
    const adapter = createSocks5Adapter(stubSession("publisher@example.org/res"), {});
    cleanups.push(() => adapter.release());
    await expect(
      adapter.openOutgoing(
        "sid",
        "nobody@example.org",
        {
          requesterJid: "publisher@example.org/res",
          targetJid: "retriever@example.org/res",
          candidates: [],
        },
      ),
    ).rejects.toThrow(/never offered/);
  });
});

function setup(
  handler: HttpxHandler,
  buildServerOptions: (serverSession: XmppSession) => HttpxServerOptions,
  buildClientOptions: (
    clientSession: XmppSession,
  ) => ConstructorParameters<typeof HttpxClient>[1],
) {
  const [clientSession, serverSession] = createSessionPair();
  const server = new HttpxServer(serverSession, {
    authorize: allowAll(),
    ...buildServerOptions(serverSession),
  });
  server.handle(handler);
  server.start();
  const client = new HttpxClient(clientSession, buildClientOptions(clientSession));
  cleanups.push(async () => {
    await client.close();
    server.stop();
  });
  return { client, clientSession, serverSession };
}

describe("SOCKS5 bytestreams as a sipub stream-method", () => {
  it("streams a response body directly (publisher self-hosts a streamhost)", async () => {
    const body = patternBytes(150_000);
    const openOutgoing = vi.fn();

    const { client } = setup(
      () => ({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        body: streamFromBytes(body),
      }),
      (serverSession) => {
        const realAdapter = createSocks5Adapter(serverSession, {
          listen: { host: "127.0.0.1", port: 0 },
        });
        cleanups.push(() => realAdapter.release());
        // Spy on openOutgoing so a regression that silently falls back to
        // IBB (still delivering correct bytes!) fails this test loudly.
        const serverSocks5: Socks5Adapter = {
          ...realAdapter,
          openOutgoing: (...args) => {
            openOutgoing(...args);
            return realAdapter.openOutgoing(...args);
          },
        };
        return { preferredStreams: ["sipub"], socks5: serverSocks5 };
      },
      (clientSession) => ({ socks5: createSocks5Adapter(clientSession, {}) }),
    );

    const resp = await client.request("server@example.org", { resource: "/s5b" });
    expect(resp.statusCode).toBe(200);
    expect(await bytesFromStream(resp.body!)).toEqual(body);
    expect(openOutgoing).toHaveBeenCalledTimes(1);
  });

  it("streams a jingle body over a negotiated s5b candidate (XEP-0260)", async () => {
    // The same self-hosted-streamhost shape as above, but negotiated through
    // Jingle rather than SI: session-initiate → accept → candidates in a
    // transport-info → candidate-used → bytes over a real TCP socket.
    const body = patternBytes(140_000);
    const openOutgoing = vi.fn();

    const { client } = setup(
      () => ({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        body: streamFromBytes(body),
      }),
      (serverSession) => {
        const realAdapter = createSocks5Adapter(serverSession, {
          listen: { host: "127.0.0.1", port: 0 },
        });
        cleanups.push(() => realAdapter.release());
        const serverSocks5: Socks5Adapter = {
          ...realAdapter,
          openOutgoing: (...args) => {
            openOutgoing(...args);
            return realAdapter.openOutgoing(...args);
          },
        };
        return { preferredStreams: ["jingle"], socks5: serverSocks5 };
      },
      (clientSession) => ({ socks5: createSocks5Adapter(clientSession, {}) }),
    );

    const resp = await client.request("server@example.org", { resource: "/jingle-s5b" });
    expect(resp.statusCode).toBe(200);
    expect(await bytesFromStream(resp.body!)).toEqual(body);
    // Proof it was the negotiated socket and not a quiet IBB fallback.
    expect(openOutgoing).toHaveBeenCalledTimes(1);
  });

  it("falls back to IBB when a jingle s5b negotiation finds no reachable candidate", async () => {
    const body = patternBytes(80_000);
    const { client } = setup(
      () => ({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        body: streamFromBytes(body),
      }),
      (serverSession) => ({
        preferredStreams: ["jingle"],
        // No listener and no proxy: the adapter has nothing to offer, so the
        // negotiation must end in transport-replace and the body still arrive.
        socks5: createSocks5Adapter(serverSession, {}),
      }),
      (clientSession) => ({ socks5: createSocks5Adapter(clientSession, {}) }),
    );

    const resp = await client.request("server@example.org", { resource: "/fallback" });
    expect(resp.statusCode).toBe(200);
    expect(await bytesFromStream(resp.body!)).toEqual(body);
  });

  it("falls back to IBB when every SOCKS5 candidate is unreachable", async () => {
    // A closed local port: connections are refused immediately.
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const deadPort = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const body = patternBytes(100_000);
    const connect = vi.fn();

    const { client } = setup(
      () => ({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        body: streamFromBytes(body),
      }),
      (serverSession) => {
        // A proxy candidate we deliberately never bring up — the only
        // candidate offered, so the retriever's connect() fails on it and
        // the publisher must fall back to plain IBB on the same sid.
        const serverSocks5 = createSocks5Adapter(serverSession, {
          proxyJid: "dead.proxy.example",
          proxyHost: "127.0.0.1",
          proxyPort: deadPort,
          connectTimeoutMs: 500,
        });
        cleanups.push(() => serverSocks5.release());
        return { preferredStreams: ["sipub"], socks5: serverSocks5 };
      },
      (clientSession) => {
        const realAdapter = createSocks5Adapter(clientSession, {});
        // Spy to confirm S5B was actually attempted (and failed) rather than
        // this test passing merely because IBB was chosen from the start.
        const clientSocks5: Socks5Adapter = {
          ...realAdapter,
          connect: (...args) => {
            connect(...args);
            return realAdapter.connect(...args);
          },
        };
        return { socks5: clientSocks5 };
      },
    );

    const resp = await client.request("server@example.org", { resource: "/fallback" });
    expect(resp.statusCode).toBe(200);
    expect(await bytesFromStream(resp.body!)).toEqual(body);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
