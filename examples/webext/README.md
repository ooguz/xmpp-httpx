# httpx browser: WebExtension (Firefox + Chromium)

A minimal browser for `httpx://user@domain/path` URLs (XEP-0332: HTTP over
XMPP), built on the `xmpp-httpx` library. Manifest V3, one codebase, two
manifest variants.

## What it does

- An extension page (`browser.html`) acts as the browser chrome: tab strip,
  address bar, back/forward/reload (per-tab history), connection settings.
- The XMPP connection lives in the tab page (WebSocket via
  `@xmpp/client`), so MV3 service-worker lifetime is a non-issue; the
  background script only routes omnibox/protocol-handler events.
- Fetched HTML is sanitized with DOMPurify (no scripts, framing, or plugins),
  relative links and images are resolved with `resolveHttpxUrl`, images are
  fetched over httpx into `blob:` URLs, and the result renders in an iframe
  sandboxed without `allow-scripts`. Link clicks are intercepted to
  navigate httpx URLs in place; http(s) links open in a real tab.
- Page CSS (`<style>` and `style=`) survives a CSSOM-based sanitizer, with
  `url()` references fetched over httpx like images.
- Forms: GET queries and urlencoded POST bodies, driven by the parent page
  (uploads, multipart and non-httpx actions are refused with an explanation).
- Caching: Cache API keyed by httpx URL and partitioned per account,
  honoring `Cache-Control`/`ETag` with `If-None-Match` revalidation; the chrome
  shows `cache` / `304` / `network` for the current page, and the settings
  dialog can clear it.
- Downloads for content the viewport can't display, page titles and
  favicons from the fetched document, and error pages with working retry.
- History and bookmarks in a drawer (☰), backed by `storage.local`, with a
  bookmark star (☆/★) in the chrome.
- Tabs: one live iframe per tab, so switching never refetches; each tab has
  its own back/forward stack.

After the demo-site steps below, `npm run smoke` (from the repo root) drives all
of this in real Chromium and reports what works.

## Address-bar reality (2026)

Native `httpx://` in the URL bar is not possible in either browser. What you
get instead:

| Entry point | Firefox | Chromium |
|---|---|---|
| Extension page address bar | ✔ | ✔ |
| Omnibox keyword: `httpx server@example.org/page` ⏎ | ✔ | ✔ |
| Clickable `ext+httpx://…` links (`protocol_handlers`) | ✔ | ✖ (key unsupported) |

A host app that gives the page a *real* address bar (the Firefox Klar fork
runs it as a GeckoView built-in extension behind the app's toolbar) can load
`browser.html?embedded=1`: the extension's own tab strip and URL bar are
hidden and the host chrome is the only chrome. Navigation still flows through
the `#fragment`, which the page keeps updated for the host to mirror. In
embedded mode each page-to-page move *pushes* a session-history entry instead
of replacing it, so the host's own back/forward buttons walk httpx pages
(traversals come back in as `hashchange` events, which the page follows).

## Build

```sh
npm install          # also links xmpp-httpx from ../..
npm run build        # builds ../.. → vite build → dist/chromium + dist/firefox
```

## Run

- Firefox: `npm run dev:firefox` (web-ext with auto-reload), or load
  `dist/firefox` via about:debugging → Load Temporary Add-on.
- Chromium: chrome://extensions → enable Developer mode → Load unpacked
  → `dist/chromium`.

## Try it against the repo's demo site

1. Start the E2E Prosody: `cd ../.. && docker compose -f test/e2e/docker-compose.yml up -d --wait`,
   then register users: `docker compose -f test/e2e/docker-compose.yml exec prosody prosodyctl register alice localhost e2e-alice` (and `bob`).
2. Serve the demo site over httpx (from the repo root):
   `npm run build && node scripts/demo-gateway.mjs`, or any
   `HttpxServer` of your own.
3. In the extension settings: service `ws://localhost:15280/xmpp-websocket`,
   JID `alice@localhost`, password `e2e-alice`.
4. Navigate to `httpx://web@httpx.localhost/`.

## Signing and the stores

`npm run package` writes three files into `dist/artifacts/`: the Firefox
zip, the Chromium zip, and `httpx-browser-source-<version>.tar.gz`, the
source archive AMO asks for when it cannot read bundled code (with a
`BUILD.md` of exact rebuild steps). `npm run sign:firefox` hands the
Firefox build to Mozilla's signing service; it reads `WEB_EXT_API_KEY` and
`WEB_EXT_API_SECRET` from the environment and defaults to the unlisted
channel (`WEB_EXT_CHANNEL=listed` for the store). The add-on ID,
`httpx-browser@ooguz.dev`, is permanent once signed. Chrome signs on upload
to the Web Store. The owner's steps are in
[RELEASING.md](../../RELEASING.md).

## Caveats (demo-grade, on purpose)

- Credentials are stored in extension storage in plaintext.
- Use `wss://` in production; plain `ws://` is for the local Prosody only
  (the Firefox manifest drops `upgrade-insecure-requests` to allow it).
- Page CSS goes through an allow-list sanitizer (see
  [docs/browser-extension.md](../../docs/browser-extension.md) §CSS): `@import`
  and `expression()` are refused, so some pages render plainer than in a full
  browser.
- FormData/uploads and non-UTF-8 text rendering are not implemented.
