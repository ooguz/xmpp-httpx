import type { HttpxHandler } from "../../src/server/server.js";
import { decodeBase64 } from "../../src/util/base64.js";

/**
 * A tiny multi-page site served over httpx — used by the component-gateway
 * E2E suite and by the WebExtension demo (relative links + an image exercise
 * the browser's URL resolution and subresource pipeline).
 */

// 1x1 red PNG.
export const LOGO_PNG = decodeBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
);

const PAGES: Record<string, { type: string; body: string | Uint8Array }> = {
  "/": {
    type: "text/html; charset=utf-8",
    body: `<!doctype html><html><head><title>httpx demo</title></head><body>
<h1>Hello from XEP-0332</h1>
<p>This page traveled inside an XMPP stanza.</p>
<p><a href="about.html">About (relative link)</a> · <a href="/img/logo.png">Logo</a></p>
<img src="img/logo.png" alt="logo">
</body></html>`,
  },
  "/about.html": {
    type: "text/html; charset=utf-8",
    body: `<!doctype html><html><body><h1>About</h1><p><a href="/">Home</a></p></body></html>`,
  },
  "/img/logo.png": { type: "image/png", body: LOGO_PNG },
};

export const demoSiteHandler: HttpxHandler = (req) => {
  const path = req.resource.split("?")[0] ?? "/";
  const page = PAGES[path];
  if (!page) {
    return { status: 404, statusMessage: "Not Found", body: "not found" };
  }
  return {
    status: 200,
    headers: { "content-type": page.type },
    body: page.body,
  };
};
