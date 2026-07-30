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
| `src/render.ts` | The sanitized rendering pipeline (below), plus scriptless error pages |
| `src/sanitize-css.ts` | CSSOM-based CSS sanitizer for `<style>` blocks and `style=` attributes |
| `src/page-meta.ts` | Title + favicon read from the raw document (pre-sanitization, since `<link>` is stripped) |
| `src/download.ts` | Renderable-vs-downloadable content types, `Content-Disposition` filenames, `downloads.download` |
| `src/ext.ts` | `browser`/`chrome`/absent API lookup shared by the modules that need it |
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
                                             link, form, iframe, object,
                                             embed, base, meta …; custom
                                             ALLOWED_URI_REGEXP admitting httpx:)
   → DOMParser
   → CSS pass 1: sanitize <style>/style= , resolve every url() to absolute,
                 collect the httpx references they need
   → resolve <a href>/<img src> with resolveHttpxUrl(base, ref)
   → fetch httpx images + CSS references via httpxFetch → blob: URLs
     (one fetch per URL, revoked on navigation)
   → CSS pass 2: swap httpx url() for its blob: URL, drop the declaration
                 when the resource never arrived
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
- `blob:` image URLs are minted by the parent and revoked on every
  navigation.

### CSS (`src/sanitize-css.ts`)

Page CSS is allowed, but DOMPurify does not parse CSS, so it is re-sanitized
separately — on **CSSOM** (`new CSSStyleSheet().replaceSync(css)`) rather than
a bundled CSS parser, so the browser's own parser normalizes hostile input and
constructed sheets refuse `@import` by spec.

- **Allow-list on the way out.** Only style, `@font-face`, `@keyframes`,
  `@media` and `@supports` rules are re-serialized; everything else
  (`@namespace`, `@page`, `@counter-style`, anything unknown) is simply not
  emitted. Output is built from kept rules instead of calling `deleteRule`
  because CSSOM *refuses* to delete an `@namespace` rule while other rules
  exist — an unremovable rule must never become a kept rule.
- **Every `url()` goes through a resolver.** References are resolved against
  the page URL, then admitted only for `httpx:`/`https:`/`data:`/`blob:`;
  anything else (including `javascript:`) drops the whole declaration. That
  is deliberately the same trust set the pipeline already applies to `<img>`.
- **httpx references are fetched, not passed through** — nothing inside the
  scriptless iframe can speak XMPP, so a surviving `httpx:` URL would just be
  a broken image. Hence the two passes: pass 1 discovers them, pass 2
  substitutes the parent-minted `blob:` URL. Which is why the sanitizer is
  idempotent: running it over its own output changes nothing but resolver
  substitutions.
- `expression()`, `behavior`, `-moz-binding` are dropped explicitly — dead
  vectors in modern engines, cheap to keep refusing.
- A CSS *string value* may contain `</style`, which CSSOM serializes with the
  `<` unescaped; re-serializing the document into `srcdoc` would then close
  the raw-text element early and inject real markup. The serializer re-escapes
  it as `\3c /style`. (A literal `</style>` in the source HTML is a non-issue:
  the HTML parser closes the element before the sanitizer ever sees it.)
- Input is capped (512 KiB per block) to bound parser work, and the injected
  default style is **prepended** so page CSS wins on equal specificity.

Residual risk, accepted: CSS can hit third-party `https:` origins (fonts,
background images), which pings that origin on page load. This is exactly what
an `<img src="https://…">` in the same document already does; anyone wanting
zero third-party traffic should restrict the resolver to `httpx:` only.

### Page metadata and downloads

- **Title and favicon** come from `src/page-meta.ts`, which parses the *raw*
  response before DOMPurify — sanitization removes `<link>`, taking any icon
  reference with it. Parsing hostile HTML there is inert (`DOMParser` executes
  no scripts and fetches no subresources) and everything extracted is used as
  text or re-resolved as a URL, never as markup. The title is trimmed and
  capped; the icon must resolve to `httpx:` (fetched over XMPP into a `blob:`
  URL, revoked on navigation) or `https:`, and the last declared icon wins.
- **Non-renderable responses are saved, not shown**: anything that is not
  text, an image, or structured text (`+json`/`+xml`), and anything sent with
  `Content-Disposition: attachment`, goes to `downloads.download` (permission
  `downloads`; falls back to a synthetic `<a download>` click when the page
  runs as a plain tab). Filenames come from `filename*`/`filename` or the
  URL's last segment, always reduced to a **basename** with control characters
  and leading dots stripped — a hostile server cannot steer the write out of
  the download directory.
- **Error pages** (`renderError`) are ordinary scriptless documents; their
  buttons are anchors whose clicks the parent intercepts, the same mechanism
  as page links. Failed loads offer *Retry*, and a disconnected session offers
  *Connection settings* alongside it instead of only popping the dialog.

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

Shared: MV3, `permissions: ["storage", "downloads"]` (WebSocket connections
from extension pages need no host permissions), `omnibox`, `action`.

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

The rendering pipeline itself — sanitization, CSS, subresource fetching, blob
lifetime, click interception — is unit-tested in real Chromium under the
`browser` vitest project (`test/browser/`, see [testing.md](testing.md)).

## Known limitations (deliberate, demo-grade)

- Credentials in extension storage in plaintext; `ws://` only for the local
  dev Prosody — production must be `wss://`.
- No forms/uploads; one page per tab (no in-extension tab strip); no response
  caching, so every navigation re-fetches.
- `web-ext lint` flags Firefox's upcoming data-consent manifest key and the
  (sanitized) `srcdoc` assignment as warnings — both acknowledged.
