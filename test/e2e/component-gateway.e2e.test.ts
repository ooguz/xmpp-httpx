import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpxFetch } from "../../src/client/fetch.js";
import { allowAll } from "../../src/server/policy.js";
import { HttpxServer } from "../../src/server/server.js";
import { connectComponent, connectUser, type E2eClient } from "./e2e-env.js";
import { demoSiteHandler, LOGO_PNG, REPORT_BIN } from "./demo-site.js";

describe("component gateway serving the demo site", () => {
  let alice: E2eClient;
  let gateway: E2eClient;
  let server: HttpxServer;

  beforeAll(async () => {
    alice = await connectUser("alice", "e2e-alice", "fetcher");
    gateway = await connectComponent();
    server = new HttpxServer(gateway.session, {
      authorize: allowAll(),
      onError: (err) => console.error("[e2e] gateway error:", err),
    });
    server.handle(demoSiteHandler);
    server.start();
  });

  afterAll(async () => {
    server?.stop();
    await gateway?.stop();
    await alice?.stop();
  });

  it("fetches the home page through the component", async () => {
    const response = await httpxFetch("httpx://web@httpx.localhost/", {
      session: alice.session,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Hello from XEP-0332");
    expect(html).toContain('href="about.html"');
  });

  it("fetches a relative page and the image", async () => {
    const about = await httpxFetch("httpx://web@httpx.localhost/about.html", {
      session: alice.session,
    });
    expect(await about.text()).toContain("<h1>About</h1>");

    const logo = await httpxFetch("httpx://web@httpx.localhost/img/logo.png", {
      session: alice.session,
    });
    expect(logo.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await logo.arrayBuffer())).toEqual(LOGO_PNG);
  });

  it("404s unknown paths", async () => {
    const response = await httpxFetch("httpx://web@httpx.localhost/nope", {
      session: alice.session,
    });
    expect(response.status).toBe(404);
  });

  it("serves a GET form submission over the wire", async () => {
    const response = await httpxFetch(
      "httpx://web@httpx.localhost/search?q=hello+world",
      { session: alice.session },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("You searched for <b>hello world</b>");
  });

  it("serves a urlencoded POST form submission over the wire", async () => {
    const response = await httpxFetch("httpx://web@httpx.localhost/comment", {
      session: alice.session,
      method: "POST",
      body: new URLSearchParams({ text: "über & out", mood: "happy" }),
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Text: <b>über &amp; out</b>");
    expect(html).toContain("Mood: <b>happy</b>");
  });

  it("serves an attachment the browser would save", async () => {
    const response = await httpxFetch(
      "httpx://web@httpx.localhost/download/report.bin",
      { session: alice.session },
    );
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain(
      'filename="httpx-report.bin"',
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(REPORT_BIN);
  });
});
