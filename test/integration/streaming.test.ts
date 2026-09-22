import { Element } from "@xmpp/xml";
import { afterEach, describe, expect, it } from "vitest";
import { HttpxClient } from "../../src/client/client.js";
import { httpxFetch } from "../../src/client/fetch.js";
import { NS_HTTPX } from "../../src/constants.js";
import { allowAll } from "../../src/server/policy.js";
import {
  HttpxServer,
  parseContentLength,
  type HttpxHandler,
  type HttpxServerOptions,
} from "../../src/server/server.js";
import { bytesFromStream } from "../../src/util/bytes.js";
import { createSessionPair } from "../../src/testing/mock-session.js";

function patternBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

function streamOf(bytes: Uint8Array, partSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + partSize));
      offset += partSize;
    },
  });
}

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

describe("chunkedBase64 streaming", () => {
  it("streams a 1 MiB response body via chunk messages", async () => {
    const body = patternBytes(1024 * 1024);
    const { client } = setup(
      () => ({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        body: streamOf(body, 10_000),
      }),
      { preferredStreams: ["chunkedBase64"] },
      { maxBufferedBytes: 2 * 1024 * 1024 },
    );

    const resp = await client.request("server@example.org", { resource: "/big" });
    expect(resp.statusCode).toBe(200);
    expect(resp.body).not.toBeNull();
    const received = await bytesFromStream(resp.body!);
    expect(received).toEqual(body);
  });

  it("survives chunk messages arriving in reverse order", async () => {
    const body = patternBytes(64 * 1024);
    const { client, serverSession } = setup(
      () => ({ status: 200, body: streamOf(body, 8000) }),
      { preferredStreams: ["chunkedBase64"] },
    );

    // Fault injection: hold every chunk <message> until last='true' arrives,
    // then deliver the whole stream in reverse order. IQs pass through.
    const held: Array<() => void> = [];
    serverSession.deliverHook = (stanza: Element, deliver) => {
      const chunk = stanza.getChild("chunk", NS_HTTPX);
      if (!chunk) {
        queueMicrotask(deliver);
        return;
      }
      held.push(deliver);
      if (chunk.attrs["last"] === "true") {
        for (const fn of held.reverse()) fn();
        held.length = 0;
      }
    };

    const resp = await client.request("server@example.org", { resource: "/big" });
    const received = await bytesFromStream(resp.body!);
    expect(received).toEqual(body);
  });

  it("streams a request body via chunk messages", async () => {
    let receivedLength = -1;
    const body = patternBytes(300_000);
    const { client } = setup(async (req) => {
      const bytes = req.body ? await bytesFromStream(req.body) : new Uint8Array(0);
      receivedLength = bytes.length;
      expect(bytes).toEqual(body);
      return { status: 200, body: String(bytes.length) };
    });

    const resp = await client.request("server@example.org", {
      method: "PUT",
      resource: "/upload",
      body: streamOf(body, 12_345),
    });
    expect(resp.statusCode).toBe(200);
    expect(await resp.text()).toBe("300000");
    expect(receivedLength).toBe(300_000);
  });

  it("falls back to chunkedBase64 when the requester refuses IBB", async () => {
    const body = patternBytes(50_000);
    const { client } = setup(
      () => ({ status: 200, body: streamOf(body, 6000) }),
      { preferredStreams: ["ibb", "chunkedBase64"] },
      { accept: { ibb: false } },
    );
    const resp = await client.request("server@example.org", {});
    expect(await bytesFromStream(resp.body!)).toEqual(body);
  });
});

describe("IBB streaming", () => {
  it("streams a response body over IBB with IQ-acked blocks", async () => {
    const body = patternBytes(200_000);
    const { client } = setup(
      () => ({ status: 200, body: streamOf(body, 7000) }),
      { preferredStreams: ["ibb"] },
    );
    const resp = await client.request("server@example.org", { resource: "/ibb" });
    expect(resp.statusCode).toBe(200);
    expect(await bytesFromStream(resp.body!)).toEqual(body);
  });

  it("streams a request body over IBB", async () => {
    const body = patternBytes(100_000);
    const { client } = setup(
      async (req) => {
        const bytes = req.body ? await bytesFromStream(req.body) : new Uint8Array(0);
        expect(bytes).toEqual(body);
        return { status: 204 };
      },
      {},
      { preferredStreams: ["ibb"] },
    );
    const resp = await client.request("server@example.org", {
      method: "PUT",
      body: streamOf(body, 9000),
    });
    expect(resp.statusCode).toBe(204);
  });
});

describe("streamed bodies without a Content-Length", () => {
  // Number(null) is 0, so a length-less stream used to read as "0 bytes,
  // fits inline": the server drained the whole stream before answering, and
  // a stream that never ends never got an answer at all.
  for (const form of ["handler object", "Response"] as const) {
    it(`a never-ending stream is answered at once and flows (${form})`, async () => {
      let pushed: ReadableStreamDefaultController<Uint8Array> | undefined;
      const endless = () =>
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            pushed = controller;
            controller.enqueue(patternBytes(8192)); // two whole IBB blocks
          },
        });
      const { client } = setup(() =>
        form === "Response"
          ? new Response(endless(), { status: 200 })
          : { status: 200, body: endless() },
      );
      const resp = await client.request("server@example.org", { timeoutMs: 2_000 });
      expect(resp.statusCode).toBe(200);
      expect(resp.headers.has("content-length")).toBe(false);
      const reader = resp.body!.getReader();
      let got = 0;
      while (got < 8192) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
      }
      expect(got).toBe(8192);
      pushed?.close();
      await reader.cancel();
    });
  }

  it("a small length-less stream is still delivered whole", async () => {
    const body = patternBytes(1000);
    const { client } = setup(() => ({ status: 200, body: streamOf(body, 100) }));
    const resp = await client.request("server@example.org");
    expect(await bytesFromStream(resp.body!)).toEqual(body);
  });

  it("with no stream mechanism in common, a small length-less body still goes inline", async () => {
    // Streaming it is impossible here, so the only way to send it is to find
    // out it fits: read up to the budget, no further.
    const { client } = setup(
      () => ({ status: 200, headers: { "content-type": "text/plain" }, body: streamOf(new TextEncoder().encode("hello"), 2) }),
      { preferredStreams: ["jingle"] },
      { accept: { jingle: false } },
    );
    const resp = await client.request("server@example.org");
    expect(resp.statusCode).toBe(200);
    expect(await resp.text()).toBe("hello");
  });

  it("with no stream mechanism in common, a large length-less body is 413, promptly", async () => {
    let pulls = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulls++;
        controller.enqueue(patternBytes(1024));
      },
      cancel: () => {
        cancelled = true;
      },
    });
    const { client } = setup(
      () => ({ status: 200, body: endless }),
      { preferredStreams: ["jingle"] },
      { accept: { jingle: false } },
    );
    const resp = await client.request("server@example.org", { timeoutMs: 2_000 });
    expect(resp.statusCode).toBe(413);
    // Read up to the budget and stopped: not drained, not held open.
    expect(pulls).toBeLessThan(20);
    expect(cancelled).toBe(true);
  });

  it("a declared length that fits is still inlined", async () => {
    const body = patternBytes(1000);
    const { client } = setup(() => ({
      status: 200,
      headers: { "content-length": "1000" },
      body: streamOf(body, 100),
    }));
    const resp = await client.request("server@example.org");
    expect(await bytesFromStream(resp.body!)).toEqual(body);
  });
});

describe("parseContentLength", () => {
  it("accepts 1*DIGIT and a list of identical values (RFC 9110 §8.6)", () => {
    expect(parseContentLength("0")).toBe(0);
    expect(parseContentLength("1234")).toBe(1234);
    expect(parseContentLength(" 42 ")).toBe(42);
    expect(parseContentLength("5, 5")).toBe(5);
  });

  it("gives no length for anything Number() would have guessed at", () => {
    for (const bad of [null, "", " ", "0x10", "1e3", "-1", "1.5", "12abc", "5, 6", "99999999999999999999"]) {
      expect(parseContentLength(bad), String(bad)).toBeUndefined();
    }
  });
});

describe("httpxFetch bridge", () => {
  it("fetches an httpx:// URL into a real Response", async () => {
    let seenHost: string | null = null;
    const { clientSession } = setup((req) => {
      seenHost = req.headers.get("host");
      return {
        status: 200,
        headers: { "content-type": "text/html" },
        body: `<html><body>${req.resource}</body></html>`,
      };
    });

    const response = await httpxFetch("httpx://server@example.org/page?x=1", {
      session: clientSession,
    });
    expect(response).toBeInstanceOf(Response);
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(await response.text()).toBe("<html><body>/page?x=1</body></html>");
    expect(seenHost).toBe("example.org");
  });

  it("posts a body and streams the reply", async () => {
    const big = patternBytes(150_000);
    const { clientSession } = setup(
      async (req) => {
        const bytes = req.body ? await bytesFromStream(req.body) : new Uint8Array(0);
        return new Response(streamOf(big, 8000), {
          status: 200,
          headers: { "x-request-bytes": String(bytes.length) },
        });
      },
      { preferredStreams: ["ibb"] },
    );

    const response = await httpxFetch("httpx://server@example.org/mirror", {
      session: clientSession,
      method: "POST",
      body: "hello",
    });
    expect(response.headers.get("x-request-bytes")).toBe("5");
    const received = new Uint8Array(await response.arrayBuffer());
    expect(received).toEqual(big);
  });
});
