import type { HttpxHandler, HttpxServerRequest } from "../../src/server/server.js";
import { decodeBase64 } from "../../src/util/base64.js";

/**
 * A tiny multi-page site served over httpx — used by the component-gateway
 * E2E suite and by the WebExtension demo. Between them the pages exercise the
 * browser's whole surface: relative links, an image subresource, a CSS
 * background fetched over XMPP, a GET form, a urlencoded POST form, and a
 * download. External stylesheets are deliberately absent — the browser strips
 * `<link>`, so page CSS has to arrive in a `<style>` block.
 */

// 1x1 red PNG.
export const LOGO_PNG = decodeBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
);

/** Sent as an attachment, so the browser saves it instead of showing it. */
export const REPORT_BIN = new Uint8Array(64).fill(0x2a);

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

const PAGES: Record<string, { type: string; body: string | Uint8Array }> = {
  "/": {
    type: "text/html; charset=utf-8",
    body: `<!doctype html><html>${HEAD}<body>
<h1>Hello from XEP-0332 <span class="badge"></span></h1>
<p>This page traveled inside an XMPP stanza.</p>
<p><a href="about.html">About (relative link)</a> · <a href="/img/logo.png">Logo</a>
 · <a href="/download/report.bin">Download</a></p>
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
    body: `<!doctype html><html>${HEAD}<body><h1>About</h1>
<p>Served by a XEP-0114 component over XEP-0332.</p>
<p><a href="/">Home</a></p></body></html>`,
  },
  "/img/logo.png": { type: "image/png", body: LOGO_PNG },
};

function page(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title>${STYLE}</head>
<body><h1>${title}</h1>${body}<p><a href="/">Home</a></p></body></html>`;
}

/** Echoed form input is escaped — the demo site is a server like any other. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function readBody(req: HttpxServerRequest): Promise<string> {
  if (!req.body) return "";
  const chunks: Uint8Array[] = [];
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

/**
 * A weak-but-stable validator over the body, so the demo exercises the
 * browser's `If-None-Match` → 304 path for real.
 */
export function etagFor(body: string | Uint8Array): string {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash = ((hash ^ byte) * 0x01000193) >>> 0;
  }
  return `"${bytes.length.toString(16)}-${hash.toString(16)}"`;
}

export const demoSiteHandler: HttpxHandler = async (req) => {
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

  const found = PAGES[path];
  if (!found) {
    return { status: 404, statusMessage: "Not Found", body: "not found" };
  }

  // Static pages carry validators, so a browser cache can revalidate them.
  const etag = etagFor(found.body);
  const headers = {
    "content-type": found.type,
    etag,
    "cache-control": "max-age=30",
  };
  if (req.headers.get("if-none-match") === etag) {
    return { status: 304, statusMessage: "Not Modified", headers };
  }
  return { status: 200, headers, body: found.body };
};
