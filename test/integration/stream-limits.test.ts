import type { Element } from "@xmpp/xml";
import { afterEach, describe, expect, it } from "vitest";
import { HttpxClient } from "../../src/client/client.js";
import { allowAll } from "../../src/server/policy.js";
import { HttpxServer, type HttpxHandler } from "../../src/server/server.js";
import { stanzaBudgets } from "../../src/transport/select.js";
import { bytesFromStream } from "../../src/util/bytes.js";
import { createSessionPair, type MockSession } from "../../src/testing/mock-session.js";

const IBB_NS = "http://jabber.org/protocol/ibb";

function patternBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function setup(handler: HttpxHandler) {
  const [clientSession, serverSession] = createSessionPair();
  const server = new HttpxServer(serverSession, { authorize: allowAll() });
  server.handle(handler);
  server.start();
  const client = new HttpxClient(clientSession);
  cleanups.push(async () => {
    await client.close();
    server.stop();
  });
  return { client, server, clientSession, serverSession };
}

/** Counts the IBB streams `session` opens from now on. */
function countOpens(session: MockSession): { readonly value: number } {
  let value = 0;
  session.deliverHook = (stanza: Element, deliver) => {
    if (stanza.getChild("open", IBB_NS)) value++;
    deliver();
  };
  return {
    get value() {
      return value;
    },
  };
}

// 3000 bytes: inside the default 4096-byte inline budget, outside the budget
// a 2048-byte stanza limit leaves (stanzaBudgets floors inline at 1024).
const BODY = patternBytes(3000);
const SMALL_LIMIT = stanzaBudgets(2048);

describe("setStanzaBudgets (XEP-0478 limits applied after construction)", () => {
  it("moves a response body from inline to a stream once the server's budget shrinks", async () => {
    // A bytes body has a known length, so the server inlines it when it fits;
    // a Response body is a stream of unknown length and would always stream.
    const { client, server, serverSession } = setup(() => ({ status: 200, body: BODY }));
    const to = serverSession.jid.toString();
    const opens = countOpens(serverSession);

    const inline = await client.request(to, { resource: "/" });
    expect(await bytesFromStream(inline.body!)).toEqual(BODY);
    expect(opens.value).toBe(0);

    server.setStanzaBudgets(SMALL_LIMIT);
    const streamed = await client.request(to, { resource: "/" });
    expect(await bytesFromStream(streamed.body!)).toEqual(BODY);
    expect(opens.value).toBe(1);
  });

  it("moves a request body from inline to a stream once the client's budget shrinks", async () => {
    const { client, clientSession, serverSession } = setup(async (req) => {
      const received = await bytesFromStream(req.body!);
      return new Response(String(received.length));
    });
    const to = serverSession.jid.toString();
    const opens = countOpens(clientSession);

    const inline = await client.request(to, { method: "POST", resource: "/", body: BODY });
    expect(await inline.text()).toBe("3000");
    expect(opens.value).toBe(0);

    client.setStanzaBudgets(SMALL_LIMIT);
    const streamed = await client.request(to, { method: "POST", resource: "/", body: BODY });
    expect(await streamed.text()).toBe("3000");
    expect(opens.value).toBe(1);
  });

  it("sends a bytes or string request body past the inline budget as a stream, not just a ReadableStream", async () => {
    // Regression: the announced IBB stream was only ever opened for a
    // ReadableStream body; bytes past the budget were announced, then never
    // sent, and the request timed out.
    const { client, clientSession, serverSession } = setup(async (req) => {
      const received = await bytesFromStream(req.body!);
      return new Response(String(received.length));
    });
    const to = serverSession.jid.toString();
    const opens = countOpens(clientSession);
    const big = patternBytes(10_000);

    const fromBytes = await client.request(to, { method: "POST", resource: "/", body: big });
    expect(await fromBytes.text()).toBe("10000");
    expect(opens.value).toBe(1);

    const fromString = await client.request(to, { method: "POST", resource: "/", body: "x".repeat(10_000) });
    expect(await fromString.text()).toBe("10000");
    expect(opens.value).toBe(2);
  });

  it("leaves the caller's options object alone", () => {
    const [clientSession, serverSession] = createSessionPair();
    const clientOptions = { inlineBudgetBytes: 4096 };
    const serverOptions = { inlineBudgetBytes: 4096 };
    const client = new HttpxClient(clientSession, clientOptions);
    const server = new HttpxServer(serverSession, serverOptions);
    cleanups.push(async () => {
      await client.close();
      server.stop();
    });
    client.setStanzaBudgets(SMALL_LIMIT);
    server.setStanzaBudgets(SMALL_LIMIT);
    expect(clientOptions).toEqual({ inlineBudgetBytes: 4096 });
    expect(serverOptions).toEqual({ inlineBudgetBytes: 4096 });
  });
});
