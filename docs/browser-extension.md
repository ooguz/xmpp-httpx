# The httpx browser — WebExtension architecture

`examples/webext/` is the project's end goal made real: a browser for
`httpx://user@domain/path` URLs, shipped as one Manifest V3 codebase with
two manifest variants (Firefox and Chromium). This document covers the
architecture and the reasoning; the hands-on build/run guide is in
[`examples/webext/README.md`](../examples/webext/README.md).

## The one decision that shapes everything

**The XMPP connection lives in the extension's tab page (`browser.html`),
not in the background script.** MV3 backgrounds are ephemeral: Chrome runs
a service worker with a ~30 s idle timeout (WebSocket traffic extends it,
but an idle XMPP connection would need keep-alive hacks), and Firefox runs
an event page instead — two different lifetime models. Putting the
connection in the page makes both problems vanish: the connection exists
exactly as long as the user is browsing httpx content, per tab, with normal
page lifetime semantics. The background script
(`public/background.js`, a plain no-import script that works as both a
Chrome SW and a Firefox event page) is a stateless router: omnibox and
protocol-handler events → open/focus `browser.html#<url>`.

## Component map

| File | Role |
|---|---|
| `browser.html` + `src/style.css` | Browser chrome: address bar, back/forward/reload, connection status pill, settings dialog, content iframe |
| `src/app.ts` | Navigation state machine: URL normalization (`ext+httpx://` → `httpx://`), hash-based history, fetch-and-render orchestration, settings wiring |
| `src/connection.ts` | `Connection` class owning the `@xmpp/client` WebSocket session; exposes it as the library's `XmppSession` |
| `src/settings.ts` | Credentials in `storage.local` (localStorage fallback so the page also works as a plain tab during development) |
| `src/render.ts` | The sanitized rendering pipeline (below) |
| `public/background.js` | Omnibox/action/protocol-handler routing only |
| `manifest.base.json` + `scripts/make-manifests.mjs` | Shared manifest + per-target patches → `dist/chromium/`, `dist/firefox/` |

Navigation is **hash-based**: the current httpx URL lives in
`browser.html#httpx://…`, so the platform's own history/back/forward works,
deep links are copyable, and no background round-trip is involved.

## Address-bar reality (verified 2026)

A native `httpx://` scheme in the URL bar is impossible in both browsers.
The layered UX, most-portable first:

1. **Extension-page address bar** — the primary UX, identical everywhere.
2. **Omnibox keyword** (`httpx server@example.org/page` ⏎) — the real
   address-bar entry point, supported by both browsers.
3. **`protocol_handlers` (Firefox only)** — clickable `ext+httpx://…` links
   anywhere in Firefox route to `/browser.html#%s`. Chromium has no
   equivalent manifest key; `navigator.registerProtocolHandler("web+httpx")`
   from extension pages is unreliable there and deliberately skipped.

## Rendering pipeline (`src/render.ts`)

Fetched HTML is hostile input. The pipeline:

```
httpxFetch(url) → DOMPurify.sanitize        (WHOLE_DOCUMENT; FORBID: script,
                                             style, link, form, iframe, object,
                                             embed, base, meta …; custom
                                             ALLOWED_URI_REGEXP admitting httpx:)
   → DOMParser → resolve <a href>/<img src> with resolveHttpxUrl(base, ref)
   → fetch httpx images via httpxFetch → blob: URLs (revoked on navigation)
   → srcdoc into <iframe sandbox="allow-same-origin">   ← NO allow-scripts
   → parent intercepts clicks in iframe.contentDocument:
        httpx:// → in-place navigation; http(s):// → real new tab
```

Security reasoning, layer by layer:

- **No `allow-scripts`** on the sandbox: nothing in the fetched document can
  execute. `allow-same-origin` alone is safe when scripts can't run, and it
  is what lets the parent page reach `contentDocument` to intercept link
  clicks — no code is ever injected into the untrusted document.
- The extension page's CSP (`script-src 'self'`) is inherited by `srcdoc`
  as a second layer against inline script.
- Styles are stripped along with scripts (CSS `url()` is an exfiltration
  channel); a readable default style is injected instead. Sanitized-CSS
  support is a roadmap item.
- `blob:` image URLs are minted by the parent and revoked on every
  navigation.

Non-HTML responses render directly: images via blob URL, text in a `<pre>`.

## Manifest strategy

One `manifest.base.json`; `scripts/make-manifests.mjs` writes the two real
manifests because the divergences are structural, not cosmetic:

| Key | Chromium | Firefox |
|---|---|---|
| `background` | `service_worker` | `scripts` (event page) |
| `browser_specific_settings.gecko` | — | required (`id`, `strict_min_version: 128.0`) |
| `protocol_handlers` | unsupported | `ext+httpx` → `/browser.html#%s` |
| `content_security_policy` | default | explicit, to **drop `upgrade-insecure-requests`** (Firefox's MV3 default would rewrite dev-time `ws://localhost` to `wss://`) |

Shared: MV3, `permissions: ["storage"]` (WebSocket connections from
extension pages need no host permissions), `omnibox`, `action`.

## Build & verification

Vite 8 builds `browser.html` (`base: "./"` for extension-root relative
assets) into `dist/app/`; the manifest script assembles `dist/chromium/` and
`dist/firefox/`. The library is consumed via `"xmpp-httpx": "file:../.."`,
so `npm run build` in the example builds the root `dist/` first. Verified:
the produced bundle contains **zero** Node built-ins (xmpp.js's `browser`
fields stub `dns` etc.), and `web-ext lint` reports 0 errors.

The full stack the extension drives — ws:// connection to Prosody,
`httpxFetch` for pages/images/404s, `resolveHttpxUrl` for relative links —
is exercised headlessly against `scripts/demo-gateway.mjs` (see
[testing.md](testing.md)); interactive testing in real browser windows is
manual by nature.

## Known limitations (deliberate, demo-grade)

- Credentials in extension storage in plaintext; `ws://` only for the local
  dev Prosody — production must be `wss://`.
- No CSS from fetched pages; no forms/uploads; no favicon/title from
  `<meta>`; one page per tab (no in-extension tab strip).
- `web-ext lint` flags Firefox's upcoming data-consent manifest key and the
  (sanitized) `srcdoc` assignment as warnings — both acknowledged.
