import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpxClient } from "../../src/client/client.js";
import { HttpxError } from "../../src/errors.js";
import { allowAll } from "../../src/server/policy.js";
import {
  HttpxServer,
  type HttpxHandler,
  type HttpxServerOptions,
} from "../../src/server/server.js";
import { SipubManager } from "../../src/sipub/sipub.js";
import { bytesFromStream, streamFromBytes } from "../../src/util/bytes.js";
import { createSessionPair } from "../../src/testing/mock-session.js";

function patternBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
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

describe("sipub transport (XEP-0137 over SI + IBB)", () => {
  it("streams a response body via sipub", async () => {
    const body = patternBytes(150_000);
    const { client } = setup(
      () => ({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        body: streamFromBytes(body),
      }),
      { preferredStreams: ["sipub"] },
    );

    const resp = await client.request("server@example.org", { resource: "/pub" });
    expect(resp.statusCode).toBe(200);
    expect(await bytesFromStream(resp.body!)).toEqual(body);
  });

  it("streams a request body via sipub when preferred", async () => {
    const body = patternBytes(80_000);
    const { client } = setup(
      async (req) => {
        const bytes = req.body ? await bytesFromStream(req.body) : new Uint8Array(0);
        expect(bytes).toEqual(body);
        return { status: 200, body: String(bytes.length) };
      },
      {},
      { preferredStreams: ["sipub"] },
    );

    const resp = await client.request("server@example.org", {
      method: "PUT",
      body: streamFromBytes(body),
    });
    expect(resp.statusCode).toBe(200);
    expect(await resp.text()).toBe("80000");
  });

  it("expired publications refuse late <start>s", async () => {
    const [a, b] = createSessionPair();
    const publisher = SipubManager.acquire(b);
    const retriever = SipubManager.acquire(a);
    cleanups.push(() => {
      publisher.release();
      retriever.release();
    });

    const publication = publisher.publish("client@example.org", {
      open: () => streamFromBytes(patternBytes(10)),
      ttlMs: 20,
    });
    await new Promise((r) => setTimeout(r, 50));

    const stream = retriever.retrieve("server@example.org", {
      id: publication.id,
    });
    const err = await bytesFromStream(stream).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpxError);
  });

  it("publications are bound to the requesting peer's bare JID", async () => {
    const [a, b] = createSessionPair("mallory@evil.example/x", "server@example.org");
    const publisher = SipubManager.acquire(b);
    const retriever = SipubManager.acquire(a);
    cleanups.push(() => {
      publisher.release();
      retriever.release();
    });

    // Published for alice — mallory's start must be refused.
    const publication = publisher.publish("alice@example.org", {
      open: () => streamFromBytes(patternBytes(10)),
    });
    const err = await bytesFromStream(
      retriever.retrieve("server@example.org", { id: publication.id }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpxError);
    expect((err as HttpxError).code).toBe("forbidden");
  });

  it("unclaimed sipub bodies simply expire without crashing", async () => {
    const onError = vi.fn();
    const { client } = setup(
      () => ({ status: 200, body: streamFromBytes(patternBytes(50_000)) }),
      { preferredStreams: ["sipub"], onError },
    );
    const resp = await client.request("server@example.org", {});
    expect(resp.statusCode).toBe(200);
    // Never read resp.body → no <start> is ever sent; the publication just
    // sits until its TTL. Nothing should throw meanwhile.
    await new Promise((r) => setTimeout(r, 30));
    expect(onError).not.toHaveBeenCalled();
  });
});
