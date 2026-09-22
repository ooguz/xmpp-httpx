import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpxClient } from "../../src/client/client.js";
import { allowAll } from "../../src/server/policy.js";
import { HttpxServer } from "../../src/server/server.js";
import { bytesFromStream, concatBytes } from "../../src/util/bytes.js";
import { connectUser, type E2eClient } from "./e2e-env.js";

function patternBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

const TUNNEL_UP = 250_000;
const TUNNEL_DOWN = 300_000;
let exitReceived: Uint8Array | undefined;

describe("c2s round-trips over a real Prosody", () => {
  let alice: E2eClient;
  let bob: E2eClient;
  let server: HttpxServer;
  let client: HttpxClient;

  beforeAll(async () => {
    alice = await connectUser("alice", "e2e-alice", "browser");
    bob = await connectUser("bob", "e2e-bob", "web");

    server = new HttpxServer(bob.session, {
      authorize: allowAll(),
      preferredStreams: ["ibb", "chunkedBase64"],
      tunnels: true,
      onError: (err) => console.error("[e2e] server error:", err),
    });
    server.handle(async (req) => {
      if (req.method === "CONNECT") {
        // A stand-in destination: sends TUNNEL_DOWN while it reads
        // TUNNEL_UP, concurrently, then waits for the client to close.
        return {
          status: 200,
          tunnel: async (tunnel) => {
            const reader = tunnel.readable.getReader();
            const sending = (async () => {
              const down = patternBytes(TUNNEL_DOWN);
              for (let o = 0; o < down.length; o += 10_000) {
                await tunnel.write(down.subarray(o, o + 10_000));
              }
            })();
            const parts: Uint8Array[] = [];
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              parts.push(value);
            }
            await sending.catch(() => {});
            exitReceived = concatBytes(parts);
          },
        };
      }
      if (req.resource === "/hello") {
        return {
          status: 200,
          headers: { "content-type": "text/plain" },
          body: `hello ${req.from.split("/")[0]}`,
        };
      }
      if (req.resource.startsWith("/bytes/")) {
        const size = Number(req.resource.slice("/bytes/".length));
        return {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
          body: patternBytes(size),
        };
      }
      if (req.resource === "/echo-length" && req.body) {
        const bytes = await bytesFromStream(req.body);
        return { status: 200, body: String(bytes.length) };
      }
      return { status: 404 };
    });
    server.start();

    client = new HttpxClient(alice.session);
  });

  afterAll(async () => {
    await client?.close();
    server?.stop();
    await alice?.stop();
    await bob?.stop();
  });

  it("inline text round-trip", async () => {
    const resp = await client.request(bob.jid, { resource: "/hello" });
    expect(resp.statusCode).toBe(200);
    expect(await resp.text()).toBe("hello alice@localhost");
  });

  it("large response body over IBB", async () => {
    const resp = await client.request(bob.jid, { resource: "/bytes/200000" });
    expect(resp.statusCode).toBe(200);
    expect(await bytesFromStream(resp.body!)).toEqual(patternBytes(200_000));
  });

  it("large response body over chunkedBase64 when IBB is refused", async () => {
    const noIbb = new HttpxClient(alice.session, { accept: { ibb: false } });
    try {
      const resp = await noIbb.request(bob.jid, { resource: "/bytes/150000" });
      expect(await bytesFromStream(resp.body!)).toEqual(patternBytes(150_000));
    } finally {
      await noIbb.close();
    }
  });

  it("streamed request body (IBB) reaches the handler intact", async () => {
    const body = patternBytes(120_000);
    const resp = await client.request(bob.jid, {
      method: "PUT",
      resource: "/echo-length",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
    });
    expect(await resp.text()).toBe("120000");
  });

  it("a CONNECT tunnel carries bytes both ways at once over one IBB sid", async () => {
    const { response, tunnel } = await client.connect(bob.jid, {
      authority: "example.org:443",
    });
    expect(response.statusCode).toBe(200);
    const reader = tunnel!.readable.getReader();
    const up = patternBytes(TUNNEL_UP).map((b) => b ^ 0x5a);
    const [, down] = await Promise.all([
      (async () => {
        for (let o = 0; o < up.length; o += 7_000) {
          await tunnel!.write(up.subarray(o, o + 7_000));
        }
      })(),
      (async () => {
        const parts: Uint8Array[] = [];
        let n = 0;
        while (n < TUNNEL_DOWN) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          n += value.length;
        }
        return concatBytes(parts);
      })(),
    ]);
    expect(down).toEqual(patternBytes(TUNNEL_DOWN));
    await tunnel!.close();
    // The exit's reader ends on our <close/>, having seen every byte.
    for (let i = 0; i < 100 && exitReceived === undefined; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(exitReceived).toEqual(up);
  });

  it("HTTP 404 passes through as a response", async () => {
    const resp = await client.request(bob.jid, { resource: "/missing" });
    expect(resp.statusCode).toBe(404);
  });

  // One iqCallee handler per session → a server with a different stream
  // preference needs its own session; a second resource of bob provides one.
  for (const mechanism of ["sipub", "jingle"] as const) {
    it(`large response body over ${mechanism}`, async () => {
      const bob2 = await connectUser("bob", "e2e-bob", `web-${mechanism}`);
      const server2 = new HttpxServer(bob2.session, {
        authorize: allowAll(),
        preferredStreams: [mechanism],
        onError: (err) => console.error(`[e2e] ${mechanism} server error:`, err),
      });
      server2.handle(() => ({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        body: patternBytes(120_000),
      }));
      server2.start();
      try {
        const resp = await client.request(bob2.jid, { resource: "/stream" });
        expect(resp.statusCode).toBe(200);
        expect(await bytesFromStream(resp.body!)).toEqual(patternBytes(120_000));
      } finally {
        server2.stop();
        await bob2.stop();
      }
    });
  }
});
