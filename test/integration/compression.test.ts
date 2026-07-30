import { Element } from "@xmpp/xml";
import { afterEach, describe, expect, it } from "vitest";
import { HttpxClient } from "../../src/client/client.js";
import { NS_HTTPX } from "../../src/constants.js";
import { allowAll } from "../../src/server/policy.js";
import {
  HttpxServer,
  type HttpxHandler,
  type HttpxServerOptions,
} from "../../src/server/server.js";
import { compressStream } from "../../src/util/compression.js";
import {
  bytesFromStream,
  streamFromBytes,
  textEncoder,
} from "../../src/util/bytes.js";
import { createSessionPair, type MockSession } from "../../src/testing/mock-session.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function setup(
  handler: HttpxHandler,
  serverOptions: HttpxServerOptions = {},
  clientOptions: ConstructorParameters<typeof HttpxClient>[1] = {},
) {
  const [clientSession, serverSession] = createSessionPair();
  const server = new HttpxServer(serverSession, {
    authorize: allowAll(),
    ...serverOptions,
  });
  server.handle(handler);
  server.start();
  const client = new HttpxClient(clientSession, clientOptions);
  cleanups.push(async () => {
    await client.close();
    server.stop();
  });
  return { client, clientSession, serverSession };
}

/** Counts <chunk> messages leaving a session — wire-level observation. */
function countChunks(session: MockSession): { count: () => number } {
  let n = 0;
  const original = session.deliverHook;
  session.deliverHook = (stanza: Element, deliver) => {
    if (stanza.getChild("chunk", NS_HTTPX)) n++;
    if (original) original(stanza, deliver);
    else queueMicrotask(deliver);
  };
  return { count: () => n };
}

const REDUNDANT_TEXT = "All work and no play makes httpx a dull proto. ".repeat(
  6000,
); // ~288 KB, compresses to ~1 KB

describe("Content-Encoding", () => {
  it("compresses a large text response into a single inline stanza", async () => {
    const { client, serverSession } = setup(
      () => ({
        status: 200,
        headers: { "content-type": "text/plain" },
        body: REDUNDANT_TEXT,
      }),
      { preferredStreams: ["chunkedBase64"] },
    );
    const chunks = countChunks(serverSession);

    const resp = await client.request("server@example.org", { resource: "/big" });
    expect(await resp.text()).toBe(REDUNDANT_TEXT);
    // Decompression is transparent: the coding header is consumed.
    expect(resp.headers.get("content-encoding")).toBeNull();
    // The ~288 KB body compressed under the inline budget: zero chunk
    // messages on the wire proves compression actually happened.
    expect(chunks.count()).toBe(0);
  });

  it("compresses streamed responses of unknown length", async () => {
    const { client } = setup(
      () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: streamFromBytes(textEncoder.encode(REDUNDANT_TEXT)),
      }),
      { preferredStreams: ["ibb"] },
    );
    const resp = await client.request("server@example.org", {});
    expect(await resp.text()).toBe(REDUNDANT_TEXT);
    expect(resp.headers.get("content-encoding")).toBeNull();
    expect(resp.headers.get("content-length")).toBeNull();
  });

  it("does not compress non-compressible content types", async () => {
    const { client, serverSession } = setup(
      () => ({
        status: 200,
        headers: { "content-type": "image/png" },
        body: textEncoder.encode(REDUNDANT_TEXT), // pretend-binary
      }),
      { preferredStreams: ["chunkedBase64"] },
    );
    const chunks = countChunks(serverSession);
    const resp = await client.request("server@example.org", {});
    expect((await resp.bytes()).length).toBe(REDUNDANT_TEXT.length);
    expect(chunks.count()).toBeGreaterThan(0); // stayed uncompressed → streamed
  });

  it("does not compress when the client refuses (compress: false)", async () => {
    let seenAcceptEncoding: string | null = "sentinel";
    const { client, serverSession } = setup(
      (req) => {
        seenAcceptEncoding = req.headers.get("accept-encoding");
        return {
          status: 200,
          headers: { "content-type": "text/plain" },
          body: REDUNDANT_TEXT,
        };
      },
      { preferredStreams: ["chunkedBase64"] },
      { compress: false },
    );
    const chunks = countChunks(serverSession);
    const resp = await client.request("server@example.org", {});
    expect(seenAcceptEncoding).toBeNull();
    expect(await resp.text()).toBe(REDUNDANT_TEXT);
    expect(chunks.count()).toBeGreaterThan(0);
  });

  it("skips bodies too small to benefit", async () => {
    const { client } = setup(() => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "tiny",
    }));
    const resp = await client.request("server@example.org", {});
    expect(await resp.text()).toBe("tiny");
    expect(resp.headers.get("content-encoding")).toBeNull();
  });

  it("decompresses pre-compressed request bodies for the handler", async () => {
    let handlerSaw: { text: string; coding: string | null } | undefined;
    const { client } = setup(async (req) => {
      handlerSaw = {
        text: new TextDecoder().decode(
          req.body ? await bytesFromStream(req.body) : new Uint8Array(0),
        ),
        coding: req.headers.get("content-encoding"),
      };
      return { status: 204 };
    });

    const compressed = await bytesFromStream(
      compressStream(streamFromBytes(textEncoder.encode(REDUNDANT_TEXT)), "gzip"),
    );
    expect(compressed.length).toBeLessThan(REDUNDANT_TEXT.length / 50);

    const resp = await client.request("server@example.org", {
      method: "PUT",
      headers: { "content-encoding": "gzip", "content-type": "text/plain" },
      body: compressed,
    });
    expect(resp.statusCode).toBe(204);
    expect(handlerSaw?.text).toBe(REDUNDANT_TEXT);
    expect(handlerSaw?.coding).toBeNull(); // header consumed with the coding
  });

  it("leaves unknown codings untouched for the caller", async () => {
    const { client } = setup(() => ({
      status: 200,
      headers: {
        "content-type": "text/plain",
        "content-encoding": "br", // pre-encoded by the handler; we don't speak br
      },
      body: new Uint8Array([1, 2, 3]),
    }));
    const resp = await client.request("server@example.org", {});
    expect(resp.headers.get("content-encoding")).toBe("br");
    expect(await resp.bytes()).toEqual(new Uint8Array([1, 2, 3]));
  });
});
