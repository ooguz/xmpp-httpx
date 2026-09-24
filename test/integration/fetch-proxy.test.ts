import { afterEach, describe, expect, it } from "vitest";
import { httpxFetch } from "../../src/client/fetch.js";
import { allowAll } from "../../src/server/policy.js";
import { HttpxServer, type HttpxServerRequest } from "../../src/server/server.js";
import { createSessionPair } from "../../src/testing/mock-session.js";

/**
 * httpxFetch's `exit` option (design §4.3): an ordinary http(s):// URL is sent
 * to the exit JID in absolute-form, which is how a proxy uses XEP-0332. An
 * httpx:// URL keeps addressing its own JID; an ordinary URL with no exit is
 * an error. What the exit receives is asserted, not just the round trip.
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function setup(handler: (req: HttpxServerRequest) => { status: number; body?: string }) {
  const [clientSession, serverSession] = createSessionPair("alice@example.org/x", "exit.example.org");
  const seen: HttpxServerRequest[] = [];
  const server = new HttpxServer(serverSession, { authorize: allowAll() });
  server.handle((req) => {
    seen.push(req);
    return handler(req);
  });
  server.start();
  cleanups.push(() => server.stop());
  return { session: clientSession, seen };
}

describe("httpxFetch through an exit", () => {
  it("sends an ordinary URL to the exit in absolute-form, verbatim", async () => {
    const { session, seen } = setup(() => ({ status: 200, body: "via the exit" }));
    const res = await httpxFetch("https://example.org/a/b?q=1&x=2", {
      session,
      exit: "exit.example.org",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("via the exit");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.to).toBe("exit.example.org");
    expect(seen[0]!.resource).toBe("https://example.org/a/b?q=1&x=2");
    // The absolute-form target carries its own host; the reconstructed url is it.
    expect(seen[0]!.url).toBe("https://example.org/a/b?q=1&x=2");
  });

  it("drops only the fragment, keeping the resource otherwise verbatim", async () => {
    const { session, seen } = setup(() => ({ status: 200 }));
    await httpxFetch("http://example.org/p?y=1#section", { session, exit: "exit.example.org" });
    expect(seen[0]!.resource).toBe("http://example.org/p?y=1");
  });

  it("still addresses an httpx:// URL's own JID, ignoring any exit", async () => {
    const { session, seen } = setup(() => ({ status: 200, body: "native" }));
    const res = await httpxFetch("httpx://web@example.org/index.html", {
      session,
      exit: "exit.example.org",
    });
    expect(await res.text()).toBe("native");
    expect(seen[0]!.to).toBe("web@example.org");
    expect(seen[0]!.resource).toBe("/index.html");
  });

  it("refuses an ordinary URL with no exit", async () => {
    const { session } = setup(() => ({ status: 200 }));
    await expect(httpxFetch("https://example.org/", { session })).rejects.toThrow(/needs an exit/);
  });

  it("refuses a scheme that is neither httpx nor http(s)", async () => {
    const { session } = setup(() => ({ status: 200 }));
    await expect(httpxFetch("ftp://example.org/", { session, exit: "exit.example.org" })).rejects.toThrow(
      /not an httpx URL/,
    );
  });
});
