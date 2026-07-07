import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpxClient } from "../../src/client/client.js";
import { allowAll } from "../../src/server/policy.js";
import { HttpxServer } from "../../src/server/server.js";
import { bytesFromStream } from "../../src/util/bytes.js";
import { connectUser, type E2eClient } from "./e2e-env.js";

function patternBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

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
      onError: (err) => console.error("[e2e] server error:", err),
    });
    server.handle(async (req) => {
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
