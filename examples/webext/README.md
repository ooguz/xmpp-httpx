# httpx browser — WebExtension (Firefox + Chromium)

A minimal browser for `httpx://user@domain/path` URLs (XEP-0332: HTTP over
XMPP), built on the `xmpp-httpx` library. Manifest V3, one codebase, two
manifest variants.

## What it does

- An extension page (`browser.html`) acts as the browser chrome: address
  bar, back/forward/reload (hash-based history), connection settings.
- The **XMPP connection lives in the tab page** (WebSocket via
  `@xmpp/client`), so MV3 service-worker lifetime is a non-issue; the
  background script only routes omnibox/protocol-handler events.
- Fetched HTML is sanitized with DOMPurify (no scripts, framing, or plugins),
  relative links and images are resolved with `resolveHttpxUrl`, images are
  fetched over httpx into `blob:` URLs, and the result renders in an iframe
  sandboxed **without** `allow-scripts`. Link clicks are intercepted to
  navigate httpx URLs in place; http(s) links open in a real tab.
- **Page CSS** (`<style>` and `style=`) survives a CSSOM-based sanitizer, with
  `url()` references fetched over httpx like images.
- **Forms**: GET queries and urlencoded POST bodies, driven by the parent page
  (uploads, multipart and non-httpx actions are refused with an explanation).
- **Caching**: Cache API keyed by httpx URL, honoring `Cache-Control`/`ETag`
  with `If-None-Match` revalidation; the chrome shows `cache` / `304` /
  `network` for the current page, and the settings dialog can clear it.
- **Downloads** for content the viewport can't display, **page titles and
  favicons** from the fetched document, and error pages with working retry.

## Address-bar reality (2026)

Native `httpx://` in the URL bar is not possible in either browser. What you
get instead:

| Entry point | Firefox | Chromium |
|---|---|---|
| Extension page address bar | ✔ | ✔ |
| Omnibox keyword: `httpx server@example.org/page` ⏎ | ✔ | ✔ |
| Clickable `ext+httpx://…` links (`protocol_handlers`) | ✔ | ✖ (key unsupported) |

## Build

```sh
npm install          # also links xmpp-httpx from ../..
npm run build        # builds ../.. → vite build → dist/chromium + dist/firefox
```

## Run

- **Firefox**: `npm run dev:firefox` (web-ext with auto-reload), or load
  `dist/firefox` via about:debugging → Load Temporary Add-on.
- **Chromium**: chrome://extensions → enable Developer mode → Load unpacked
  → `dist/chromium`.

## Try it against the repo's demo site

1. Start the E2E Prosody: `cd ../.. && docker compose -f test/e2e/docker-compose.yml up -d --wait`,
   then register users: `docker compose -f test/e2e/docker-compose.yml exec prosody prosodyctl register alice localhost e2e-alice` (and `bob`).
2. Serve the demo site over httpx (from the repo root):
   `npm run build && node scripts/demo-gateway.mjs` — or any
   `HttpxServer` of your own.
3. In the extension settings: service `ws://localhost:15280/xmpp-websocket`,
   JID `alice@localhost`, password `e2e-alice`.
4. Navigate to `httpx://web@httpx.localhost/`.

## Caveats (demo-grade, on purpose)

- Credentials are stored in extension storage in **plaintext**.
- Use `wss://` in production; plain `ws://` is for the local Prosody only
  (the Firefox manifest drops `upgrade-insecure-requests` to allow it).
- No CSS from fetched pages (styles are stripped along with scripts); a
  readable default style is injected instead.
- FormData/uploads and non-UTF-8 text rendering are not implemented.
