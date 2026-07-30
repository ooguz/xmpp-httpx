import xml from "@xmpp/xml";
import { afterEach, describe, expect, it } from "vitest";
import { HttpxClient } from "../../src/client/client.js";
import { NS_JINGLE } from "../../src/constants.js";
import { HttpxError } from "../../src/errors.js";
import { JingleManager } from "../../src/jingle/jingle.js";
import { allowAll } from "../../src/server/policy.js";
import {
  HttpxServer,
  type HttpxHandler,
  type HttpxServerOptions,
} from "../../src/server/server.js";
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

describe("jingle transport (XEP-0166/0234 over XEP-0261 IBB)", () => {
  it("streams a response body via a jingle session", async () => {
    const body = patternBytes(180_000);
    const { client } = setup(
      () => ({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        body: streamFromBytes(body),
      }),
      { preferredStreams: ["jingle"] },
    );

    const resp = await client.request("server@example.org", { resource: "/j" });
    expect(resp.statusCode).toBe(200);
    expect(await bytesFromStream(resp.body!)).toEqual(body);
  });

  it("streams a request body via a jingle session", async () => {
    const body = patternBytes(90_000);
    const { client } = setup(
      async (req) => {
        const bytes = req.body ? await bytesFromStream(req.body) : new Uint8Array(0);
        expect(bytes).toEqual(body);
        return { status: 204 };
      },
      {},
      { preferredStreams: ["jingle"] },
    );

    const resp = await client.request("server@example.org", {
      method: "PUT",
      body: streamFromBytes(body),
    });
    expect(resp.statusCode).toBe(204);
  });

  it("declines offers whose transport is not in-band bytestreams", async () => {
    const [a, b] = createSessionPair();
    const receiver = JingleManager.acquire(a);
    const initiatorSide = JingleManager.acquire(b); // answers the terminate
    cleanups.push(() => {
      receiver.release();
      initiatorSide.release();
    });

    const initiate = xml(
      "jingle",
      { xmlns: NS_JINGLE, action: "session-initiate", initiator: "server@example.org", sid: "s1" },
      xml(
        "content",
        { creator: "initiator", name: "http-body", senders: "initiator" },
        xml("transport", {
          xmlns: "urn:xmpp:jingle:transports:s5b:1",
          sid: "t1",
        }),
      ),
    );

    const err = await bytesFromStream(
      receiver.receive("server@example.org", initiate),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpxError);
    expect((err as HttpxError).code).toBe("not-implemented");
  });

  it("answers unknown-session jingle IQs with item-not-found", async () => {
    const [a, b] = createSessionPair();
    const manager = JingleManager.acquire(b);
    cleanups.push(() => manager.release());

    const err = await a.iqCaller
      .request(
        xml(
          "iq",
          { type: "set", to: "server@example.org" },
          xml("jingle", {
            xmlns: NS_JINGLE,
            action: "session-terminate",
            sid: "no-such-session",
          }),
        ),
        1000,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { condition?: string }).condition).toBe("item-not-found");
  });

  it("acks a duplicate session-initiate IQ for a known session", async () => {
    const [a, b] = createSessionPair();
    const receiver = JingleManager.acquire(a);
    const initiator = JingleManager.acquire(b);
    cleanups.push(() => {
      receiver.release();
      initiator.release();
    });

    const body = patternBytes(30_000);
    const offer = initiator.offer("client@example.org", {
      open: () => streamFromBytes(body),
    });

    // The embedded initiate reaches the receiver (as it would inside <data>);
    // reading drives session-accept and the IBB transfer.
    const received = bytesFromStream(
      receiver.receive("server@example.org", offer.element),
    );

    // Hedge path: a stack that ALSO sends the initiate as its own IQ gets an
    // ack for the known session instead of an error.
    const dup = await b.iqCaller.request(
      xml(
        "iq",
        { type: "set", to: "client@example.org/browser" },
        xml(
          "jingle",
          { xmlns: NS_JINGLE, action: "session-initiate", sid: offer.sessionId },
          xml("content", { creator: "initiator", name: "http-body" }),
        ),
      ),
      1000,
    );
    expect(dup.attrs["type"]).toBe("result");

    expect(await received).toEqual(body);
  });
});
