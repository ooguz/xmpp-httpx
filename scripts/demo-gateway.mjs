// Serves a small demo site over httpx via the E2E Prosody's component.
// Prereq: docker compose -f test/e2e/docker-compose.yml up -d --wait
// Run:    npm run build && node scripts/demo-gateway.mjs
import { component } from "@xmpp/component";
import { allowAll, HttpxServer } from "../dist/index.js";

const LOGO_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const PAGES = {
  "/": {
    type: "text/html; charset=utf-8",
    body: `<!doctype html><html><head><title>httpx demo</title></head><body>
<h1>Hello from XEP-0332</h1>
<p>This page traveled inside XMPP stanzas — no HTTP connection anywhere.</p>
<p><a href="about.html">About (relative link)</a></p>
<img src="img/logo.png" alt="logo">
</body></html>`,
  },
  "/about.html": {
    type: "text/html; charset=utf-8",
    body: `<!doctype html><html><body><h1>About</h1>
<p>Served by scripts/demo-gateway.mjs over the local Prosody component.</p>
<p><a href="/">Home</a></p></body></html>`,
  },
  "/img/logo.png": {
    type: "image/png",
    body: Uint8Array.from(atob(LOGO_PNG_BASE64), (c) => c.charCodeAt(0)),
  },
};

const gateway = component({
  service: "xmpp://localhost:15347",
  domain: "httpx.localhost",
  password: "e2e-secret",
});
gateway.on("error", (err) => console.error("[gateway] error:", err));

const server = new HttpxServer(gateway, { authorize: allowAll() });
server.handle((req) => {
  console.log(`[gateway] ${req.from} ${req.method} ${req.resource}`);
  const page = PAGES[req.resource.split("?")[0] ?? "/"];
  if (!page) return { status: 404, statusMessage: "Not Found", body: "not found" };
  return { status: 200, headers: { "content-type": page.type }, body: page.body };
});
server.start();

await gateway.start();
console.log("[gateway] serving httpx://web@httpx.localhost/ — Ctrl-C to stop");
