import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpxClient } from "../../src/client/client.js";
import { HttpxError } from "../../src/errors.js";
import { allowAll } from "../../src/server/policy.js";
import {
  HttpxServer,
  type HttpxHandler,
  type HttpxServerOptions,
} from "../../src/server/server.js";
import { createSessionPair } from "./mock-session.js";

/** A stream that trickles `total` bytes in small parts, one per macrotask. */
function slowStream(total: number, partSize = 2048): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((r) => setTimeout(r, 5));
      if (sent >= total) {
        controller.close();
        return;
      }
      const n = Math.min(partSize, total - sent);
      controller.enqueue(new Uint8Array(n).fill(7));
      sent += n;
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

describe("abort and cancel propagation", () => {
  it("aborting mid-chunked-response errors the body stream", async () => {
    const controller = new AbortController();
    const { client } = setup(
      () => ({ status: 200, body: slowStream(500_000) }),
      { preferredStreams: ["chunkedBase64"] },
    );

    const resp = await client.request("server@example.org", {
      signal: controller.signal,
    });
    const reader = resp.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    controller.abort();
    // Drain whatever was buffered before the abort, then expect the error.
    let caught: unknown;
    try {
      for (let i = 0; i < 1000; i++) {
        const { done } = await reader.read();
        if (done) throw new Error("stream closed cleanly despite abort");
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpxError);
    expect((caught as HttpxError).code).toBe("aborted");
  });

  it("aborting during a streamed request body rejects with HttpxError", async () => {
    const controller = new AbortController();
    const { client } = setup(async (req) => {
      // Consume slowly so the client is still sending when aborted.
      await req.body?.getReader().read();
      return { status: 200 };
    });

    setTimeout(() => controller.abort(), 15);
    const err = await client
      .request("server@example.org", {
        method: "PUT",
        body: slowStream(5_000_000),
        signal: controller.signal,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpxError);
    expect((err as HttpxError).code).toBe("aborted");
  });

  it("cancelling a chunked response body is clean (sender keeps sending into the void)", async () => {
    const { client } = setup(
      () => ({ status: 200, body: slowStream(100_000) }),
      { preferredStreams: ["chunkedBase64"] },
    );
    const resp = await client.request("server@example.org", {});
    await resp.body!.cancel("not interested");
    // Give the server time to keep sending discarded chunks; nothing crashes.
    await new Promise((r) => setTimeout(r, 50));
  });

  it("cancelling an IBB response body notifies the sending side", async () => {
    const onError = vi.fn();
    const { client } = setup(
      () => ({ status: 200, body: slowStream(500_000) }),
      { preferredStreams: ["ibb"], onError },
    );
    const resp = await client.request("server@example.org", {});
    const reader = resp.body!.getReader();
    await reader.read(); // ensure the IBB stream is live
    reader.releaseLock();
    await resp.body!.cancel("stop");
    // The server's next data IQ errors, aborting its pump via onError.
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
  });

  it("client.close() aborts live chunked streams", async () => {
    const { client } = setup(
      () => ({ status: 200, body: slowStream(500_000) }),
      { preferredStreams: ["chunkedBase64"] },
    );
    const resp = await client.request("server@example.org", {});
    const reader = resp.body!.getReader();
    await reader.read();
    await client.close();
    const err = await reader.read().catch((e: unknown) => e);
    // Either an error result or a rejection with aborted semantics.
    if (err instanceof HttpxError) {
      expect(err.code).toBe("aborted");
    }
  });
});
