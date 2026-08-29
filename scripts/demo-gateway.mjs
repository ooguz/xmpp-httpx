// Serves a small demo site over httpx via the E2E Prosody's component.
// Prereq: docker compose -f test/e2e/docker-compose.yml up -d --wait
// Run:    npm run build && node scripts/demo-gateway.mjs
//
// This mirrors test/e2e/demo-site.ts, which is the *tested* twin (the
// component-gateway E2E suite asserts against it). The duplication is
// deliberate: this script is dependency-free plain JS so it runs straight from
// `dist/` with no build step for the site itself. Keep the two in step when
// adding a feature the browser needs to exercise.
import { component } from "@xmpp/component";
import { allowAll, HttpxServer } from "../dist/index.js";

const LOGO_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const LOGO_PNG = Uint8Array.from(atob(LOGO_PNG_BASE64), (c) => c.charCodeAt(0));
const REPORT_BIN = new Uint8Array(64).fill(0x2a);
// Large enough that it must stream (many stanzas), and typed octet-stream so
// it is never compressed away — the download whose transfer shows the bar.
const BIG_BIN = (() => {
  const bytes = new Uint8Array(256 * 1024);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
})();

const STYLE = `<style>
  body { max-width: 40rem; font-family: system-ui, sans-serif }
  h1 { border-bottom: 3px solid #1a56db; padding-bottom: 0.2rem }
  .badge { background-image: url(img/logo.png); background-size: cover;
           display: inline-block; width: 1rem; height: 1rem }
  form { display: flex; gap: 0.5rem; margin: 1rem 0 }
  @media (prefers-color-scheme: dark) { h1 { border-color: #7aa2f7 } }
</style>`;

const HEAD = `<head><title>httpx demo</title>
<link rel="icon" href="/img/logo.png">${STYLE}</head>`;

const PAGES = {
  "/": {
    type: "text/html; charset=utf-8",
    body: `<!doctype html><html>${HEAD}<body>
<h1>Hello from XEP-0332 <span class="badge"></span></h1>
<p>This page traveled inside XMPP stanzas — no HTTP connection anywhere.</p>
<p><a href="about.html">About (relative link)</a>
 · <a href="nice%20page.html">Encoded link</a>
 · <a href="/download/report.bin">Download</a>
 · <a href="/download/big.bin">Big download</a></p>
<img src="img/logo.png" alt="logo">
<form action="/search" method="get">
  <input name="q" placeholder="search" value="stanza">
  <button>Search (GET)</button>
</form>
<form action="/comment" method="post">
  <input name="text" placeholder="comment" value="hello">
  <button name="mood" value="happy">Post (POST)</button>
</form>
</body></html>`,
  },
  "/about.html": {
    type: "text/html; charset=utf-8",
    body: `<!doctype html><html>${HEAD.replace("<title>httpx demo</title>", "<title>About — httpx demo</title>")}<body><h1>About</h1>
<p>Served by scripts/demo-gateway.mjs over the local Prosody component.</p>
<p><a href="/">Home</a></p></body></html>`,
  },
  // Keyed decoded; the resource lookup decodes, so /nice%20page.html and a
  // raw-typed /nice page.html both land here — exercises URL encoding paths.
  "/nice page.html": {
    type: "text/html; charset=utf-8",
    body: `<!doctype html><html>${HEAD.replace("<title>httpx demo</title>", "<title>Nice page — httpx demo</title>")}<body><h1>Nice page</h1>
<p>A path with a space, reached through an encoded link.</p>
<p><a href="/">Home</a></p></body></html>`,
  },
  "/img/logo.png": { type: "image/png", body: LOGO_PNG },
};

function page(title, body) {
  return `<!doctype html><html><head><title>${title}</title>${STYLE}</head>
<body><h1>${title}</h1>${body}<p><a href="/">Home</a></p></body></html>`;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function etagFor(body) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = ((hash ^ byte) * 0x01000193) >>> 0;
  return `"${bytes.length.toString(16)}-${hash.toString(16)}"`;
}

async function readBody(req) {
  if (!req.body) return "";
  const chunks = [];
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(joined);
}

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };

const gateway = component({
  service: "xmpp://localhost:15347",
  domain: "httpx.localhost",
  password: "e2e-secret",
});
gateway.on("error", (err) => console.error("[gateway] error:", err));

const server = new HttpxServer(gateway, { authorize: allowAll() });
server.handle(async (req) => {
  console.log(`[gateway] ${req.from} ${req.method} ${req.resource}`);
  const [path = "/", query = ""] = req.resource.split("?", 2);

  if (path === "/search") {
    const q = new URLSearchParams(query).get("q") ?? "";
    return {
      status: 200,
      headers: HTML_HEADERS,
      body: page("Search results", `<p>You searched for <b>${escapeHtml(q)}</b>.</p>`),
    };
  }

  if (path === "/comment") {
    if (req.method !== "POST") {
      return { status: 405, statusMessage: "Method Not Allowed", body: "POST only" };
    }
    const fields = new URLSearchParams(await readBody(req));
    return {
      status: 200,
      headers: HTML_HEADERS,
      body: page(
        "Comment posted",
        `<p>Text: <b>${escapeHtml(fields.get("text") ?? "")}</b></p>
<p>Mood: <b>${escapeHtml(fields.get("mood") ?? "(none)")}</b></p>`,
      ),
    };
  }

  if (path === "/download/report.bin") {
    return {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="httpx-report.bin"',
      },
      body: REPORT_BIN,
    };
  }

  if (path === "/download/big.bin") {
    // The explicit Content-Length is what makes the browser's bar determinate.
    return {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="httpx-big.bin"',
        "content-length": String(BIG_BIN.length),
      },
      body: BIG_BIN,
    };
  }

  let lookup = path;
  try {
    lookup = decodeURIComponent(path);
  } catch {
    // A literal % — look up the raw path.
  }
  const found = PAGES[lookup];
  if (!found) return { status: 404, statusMessage: "Not Found", body: "not found" };

  const etag = etagFor(found.body);
  const headers = { "content-type": found.type, etag, "cache-control": "max-age=30" };
  if (req.headers.get("if-none-match") === etag) {
    return { status: 304, statusMessage: "Not Modified", headers };
  }
  return { status: 200, headers, body: found.body };
});
server.start();

await gateway.start();
console.log("[gateway] serving httpx://web@httpx.localhost/ — Ctrl-C to stop");
