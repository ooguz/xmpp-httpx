import { describe, expect, it } from "vitest";
import { HttpxClient } from "../../src/client/client.js";
import { allowAll } from "../../src/server/policy.js";
import { HttpxServer } from "../../src/server/server.js";
import { createSessionPair, MockSession } from "../../src/testing/index.js";

/**
 * The `xmpp-httpx/testing` subpath, exercised the way a downstream user would:
 * spin up a session pair, put a server on one side and a client on the other,
 * and assert their own handler without an XMPP server anywhere.
 *
 * This is deliberately written against the *public* entry point (index.ts), not
 * the module file, so an export dropped from the subpath fails here.
 */
describe("xmpp-httpx/testing", () => {
  it("gives a downstream user a working client/server pair", async () => {
    const [clientSession, serverSession] = createSessionPair(
      "alice@example.org/laptop",
      "web@example.org",
    );

    const server = new HttpxServer(serverSession, { authorize: allowAll() });
    server.handle((req) => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: `hello ${req.from} — you asked for ${req.resource}`,
    }));
    server.start();

    const client = new HttpxClient(clientSession, { discover: false });
    const response = await client.request("web@example.org", {
      resource: "/greeting",
    });

    expect(response.statusCode).toBe(200);
    expect(await response.text()).toBe(
      "hello alice@example.org/laptop — you asked for /greeting",
    );
    server.stop();
  });

  it("exposes the fault-injection hook that makes it worth publishing", async () => {
    const [clientSession, serverSession] = createSessionPair(
      "alice@example.org/laptop",
      "web@example.org",
    );
    expect(clientSession).toBeInstanceOf(MockSession);

    const server = new HttpxServer(serverSession, { authorize: allowAll() });
    server.handle(() => ({ status: 204 }));
    server.start();

    // Drop the first stanza the client sends, so the request must time out —
    // the sort of thing a downstream user cannot test against a real server.
    let dropped = false;
    clientSession.deliverHook = (_stanza, deliver) => {
      if (dropped) {
        deliver();
        return;
      }
      dropped = true; // swallowed
    };

    const client = new HttpxClient(clientSession, { discover: false });
    await expect(
      client.request("web@example.org", { resource: "/", timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(dropped).toBe(true);
    server.stop();
  });
});
