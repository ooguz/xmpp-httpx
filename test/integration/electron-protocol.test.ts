import { describe, expect, it } from "vitest";
import {
  createHttpxProtocolHandler,
  renderErrorPage,
  decodeJidFromHost,
  encodeJidForHost,
  httpxUrlFromRequest,
  toDisplayUrl,
  toNavigableUrl,
} from "../../examples/electron/src/protocol.js";
import { allowList } from "../../src/server/policy.js";
import { HttpxServer } from "../../src/server/server.js";
import { createSessionPair } from "../../src/testing/mock-session.js";
import type { XmppSession } from "../../src/session.js";

/**
 * The Electron shell's protocol handler, tested with no Electron and no display:
 * it is a `Request` → `Response` function by design, so the in-memory session
 * pair is all it needs. (The shell's windowed behavior is a separate matter —
 * see docs/electron-shell.md.)
 */

function serve(
  handler: Parameters<HttpxServer["handle"]>[0],
  allowed: string[] = ["alice@example.org"],
): { session: XmppSession; stop: () => void } {
  const [clientSession, serverSession] = createSessionPair(
    "alice@example.org/desktop",
    "web@example.org",
  );
  const server = new HttpxServer(serverSession, { authorize: allowList(allowed) });
  server.handle(handler);
  server.start();
  return { session: clientSession, stop: () => server.stop() };
}

const get = (url: string, init?: RequestInit) => new Request(url, init);

describe("JID ↔ host encoding", () => {
  it("exists because Fetch forbids credentials in a Request URL", () => {
    // Not a quirk of this scheme: http is refused identically. This is why the
    // user part cannot ride in the authority's userinfo.
    expect(() => new Request("httpx://alice@example.org/")).toThrow(/credentials/);
    expect(() => new Request("http://alice@example.org/")).toThrow(/credentials/);
    // The encoded form is a perfectly ordinary URL.
    expect(() => new Request("httpx://alice--at--example.org/")).not.toThrow();
  });

  it("round-trips an account JID through a hostname", () => {
    expect(encodeJidForHost("alice@example.org")).toBe("alice--at--example.org");
    expect(decodeJidFromHost("alice--at--example.org")).toBe("alice@example.org");
    expect(toDisplayUrl(toNavigableUrl("httpx://alice@example.org/a/b?c=1"))).toBe(
      "httpx://alice@example.org/a/b?c=1",
    );
  });

  it("leaves a component domain completely alone", () => {
    expect(encodeJidForHost("web.example.org")).toBe("web.example.org");
    expect(decodeJidFromHost("web.example.org")).toBe("web.example.org");
    expect(toNavigableUrl("httpx://web.example.org/x")).toBe("httpx://web.example.org/x");
    expect(toDisplayUrl("httpx://web.example.org/x")).toBe("httpx://web.example.org/x");
  });
});

describe("httpxUrlFromRequest", () => {
  it("decodes an encoded account JID back out of the host", () => {
    expect(httpxUrlFromRequest("httpx://alice--at--example.org/page.html")).toBe(
      "httpx://alice@example.org/page.html",
    );
  });

  it("treats a bare authority as a component domain — the gateway case", () => {
    expect(httpxUrlFromRequest("httpx://web.example.org/")).toBe(
      "httpx://web.example.org/",
    );
  });

  it("carries the query and drops nothing else", () => {
    expect(httpxUrlFromRequest("httpx://alice--at--example.org/search?q=a+b&n=2")).toBe(
      "httpx://alice@example.org/search?q=a+b&n=2",
    );
  });
});

describe("createHttpxProtocolHandler", () => {
  it("serves a page as a real Response", async () => {
    const { session, stop } = serve(() => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<h1>hello</h1>",
    }));
    const handler = createHttpxProtocolHandler({ session: () => session });

    const response = await handler(get("httpx://web.example.org/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe("<h1>hello</h1>");
    stop();
  });

  it("imposes a script-free CSP that a page cannot loosen", async () => {
    const { session, stop } = serve(() => ({
      status: 200,
      headers: {
        "content-type": "text/html",
        // A hostile page trying to grant itself scripts.
        "content-security-policy": "script-src 'unsafe-inline' *",
      },
      body: "<h1>hi</h1>",
    }));
    const handler = createHttpxProtocolHandler({ session: () => session });

    const csp = (await handler(get("httpx://web.example.org/"))).headers.get(
      "content-security-policy",
    )!;
    expect(csp).toContain("script-src 'none'");
    expect(csp).not.toContain("unsafe-inline *");
    expect(csp).toContain("object-src 'none'");
    // Styles and images must still work, or nothing renders.
    expect(csp).toContain("style-src 'self' httpx: 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' httpx: data:");
    stop();
  });

  it("allows scripts only when the shell opts in", async () => {
    const { session, stop } = serve(() => ({ status: 200, body: "x" }));
    const handler = createHttpxProtocolHandler({
      session: () => session,
      allowScripts: true,
    });
    const csp = (await handler(get("httpx://web.example.org/"))).headers.get(
      "content-security-policy",
    )!;
    expect(csp).toContain("script-src 'self' httpx:");
    expect(csp).not.toContain("script-src 'none'");
    stop();
  });

  it("forwards method, headers and body", async () => {
    const seen: { method: string; resource: string; contentType: string | null; body: string }[] =
      [];
    const { session, stop } = serve(async (req) => {
      seen.push({
        method: req.method,
        resource: req.resource,
        contentType: req.headers.get("content-type"),
        body: req.body === null ? "" : await new Response(req.body).text(),
      });
      return { status: 204 };
    });
    const handler = createHttpxProtocolHandler({ session: () => session });

    await handler(
      get("httpx://web.example.org/comment", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "text=hello",
      }),
    );
    expect(seen[0]).toEqual({
      method: "POST",
      resource: "/comment",
      contentType: "application/x-www-form-urlencoded",
      body: "text=hello",
    });
    stop();
  });

  it("passes the origin's status through, including errors", async () => {
    const { session, stop } = serve(() => ({
      status: 404,
      headers: { "content-type": "text/plain" },
      body: "nope",
    }));
    const handler = createHttpxProtocolHandler({ session: () => session });
    const response = await handler(get("httpx://web.example.org/missing"));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("nope");
    stop();
  });

  it("renders a page, not a net error, when the session is not connected", async () => {
    const handler = createHttpxProtocolHandler({ session: () => null });
    const response = await handler(get("httpx://web.example.org/"));
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Not connected to XMPP");
    expect(body).toContain("connection settings");
  });

  it("turns an XMPP-level refusal into a page with the mapped status", async () => {
    // alice is not on the allowlist, so the server refuses her.
    const { session, stop } = serve(() => ({ status: 200, body: "secret" }), [
      "someone-else@example.org",
    ]);
    const handler = createHttpxProtocolHandler({ session: () => session });

    const response = await handler(get("httpx://web.example.org/"));
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toContain("Could not load");
    expect(body).toContain("may not allow your JID");
    expect(body).not.toContain("secret");
    stop();
  });

  it("never turns a hostile path into markup", async () => {
    // A URL keeps its path percent-encoded, so there is nothing to unescape —
    // worth pinning, because it is why the address itself is not a vector.
    const { session, stop } = serve(() => ({ status: 200, body: "x" }), []);
    const handler = createHttpxProtocolHandler({ session: () => session });
    const body = await (
      await handler(get("httpx://web.example.org/%3Cscript%3Ealert(1)%3C/script%3E"))
    ).text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("%3Cscript%3E");
    stop();
  });

  it("reports each request to the shell", async () => {
    const seen: { url: string; status: number }[] = [];
    const { session, stop } = serve(() => ({ status: 200, body: "x" }));
    const handler = createHttpxProtocolHandler({
      session: () => session,
      onRequest: ({ url, status }) => seen.push({ url, status }),
    });
    await handler(get("httpx://web.example.org/a"));
    expect(seen).toEqual([{ url: "httpx://web.example.org/a", status: 200 }]);
    stop();
  });
});

describe("renderErrorPage", () => {
  it("escapes everything a server could put in an error message", () => {
    // The realistic vector: a stanza error whose text contains markup.
    const page = renderErrorPage(
      "Could not load <b>x</b>",
      "<script>alert(1)</script>",
      "hint & more <img src=x>",
    );
    expect(page).not.toContain("<script>");
    expect(page).not.toContain("<img");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(page).toContain("hint &amp; more &lt;img src=x&gt;");
  });

  it("omits the hint paragraph when there is none", () => {
    expect(renderErrorPage("t", "d")).not.toContain('class="hint"');
    expect(renderErrorPage("t", "d", "h")).toContain('class="hint"');
  });
});
