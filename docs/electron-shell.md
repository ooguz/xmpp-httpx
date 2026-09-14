# The httpx desktop shell: Electron architecture

`examples/electron/` is a browser where `httpx://` is a scheme Chromium itself
fetches, rather than a URL a page pretends to navigate. That is what the
WebExtension could not be. `protocol.handle("httpx", …)` is the whole
difference.

## What that buys, concretely

| | WebExtension | Electron shell |
|---|---|---|
| Address bar | An `<input>` in an extension page | The real one; `httpx://…` is the document's URL |
| Subresources | Every `<img>`/CSS `url()` fetched by hand into a `blob:` URL | Chromium fetches them through the same handler |
| Relative links | Resolved manually with `resolveHttpxUrl` | The URL parser's job |
| History | Hash entries, then per-tab stacks in JS | `webContents.navigationHistory` |
| Downloads | `downloads.download` + a filename sanitizer | `will-download`, Electron's dialog |
| Forms | Submit intercepted, body built by hand | Chromium submits; the handler sees a POST |

Two log lines from a real run show it:

```
[shell] httpx://web@httpx.localhost/ → 200 (46ms)
[shell] httpx://web@httpx.localhost/img/logo.png → 200 (9ms)
```

Nothing in the shell asked for that image. The page said
`background-image: url(img/logo.png)`, Chromium resolved it against the document
URL and fetched it through the protocol handler. This is the work
`examples/webext/src/render.ts` has to do by hand.

## The finding that shaped the design

A `Request` URL cannot carry credentials, so `httpx://alice@example.org/`
cannot reach a `protocol.handle` handler at all:

```js
new Request("httpx://alice@example.org/")  // TypeError: … includes credentials
new Request("http://alice@example.org/")   // the same — not scheme-specific
```

That is the Fetch standard, and `protocol.handle` hands the handler a `Request`.
So the JID's user part has to travel somewhere else. The shell encodes it into
the host:

```
typed / displayed:  httpx://alice@example.org/page
navigated:          httpx://alice--at--example.org/page
handler receives:   httpx://alice--at--example.org/page  → decoded → alice@example.org
```

`toNavigableUrl` and `toDisplayUrl` are that pair, and the address bar shows the
JID form (verified on screen). Consequences worth knowing:

- A component domain needs none of this. `httpx://web.example.org/` is an
  ordinary URL, which is why the shell is built around that shape, and it is
  what the gateway CLI serves.
- Account JIDs are best-effort. A localpart with characters a hostname cannot
  hold will not survive; hosts are also lowercased, which JID localparts
  tolerate but which the encoding relies on.
- A page's own links keep working either way: they resolve against the encoded
  host, and the decode happens on the way back in.

## Security model

The shell keeps this project's stance (an httpx page is a document, not an
application) but enforces it differently. The extension strips `<script>`
before the markup ever reaches a parser; here Chromium does the parsing, so the
protocol handler imposes a CSP instead and *overwrites* whatever the server sent,
so a page cannot loosen its own policy:

```
default-src 'self' httpx:; style-src 'self' httpx: 'unsafe-inline';
img-src 'self' httpx: data:; script-src 'none'; object-src 'none';
frame-ancestors 'none'; form-action 'self' httpx:; connect-src 'self' httpx:
```

- `script-src 'none'` by default; `allowScripts: true` relaxes it to
  `'self' httpx:` for anyone who wants to explore that, deliberately not the
  default.
- `style-src … 'unsafe-inline'` because inline CSS is how httpx pages style
  themselves. With no `<link>` chain worth having over XMPP, refusing it would
  mean refusing all styling.
- No `http(s):` anywhere. An httpx page pulling a font or a tracker off the
  web would leak the visit and defeat the point of the transport. The extension
  allows https images; the shell does not, because here it costs nothing.

Process separation follows the same logic:

- The XMPP connection and the protocol handler live in the main process.
- Page content lives in `WebContentsView`s: `sandbox: true`,
  `nodeIntegration: false`, and no preload at all.
- The chrome (tab strip, address bar) is a separate `WebContentsView` that does
  have a preload: a `contextBridge` surface of named IPC calls, nothing else.
  Page renderers and the chrome renderer never share a process.
- `setWindowOpenHandler` denies every `window.open` except `httpx://`, which
  opens a tab.

## Structure

| File | Role |
|---|---|
| `src/protocol.ts` | `Request` → `Response`: URL mapping, CSP, error pages. Electron-free, so it is unit-tested against `xmpp-httpx/testing` with no display |
| `src/main.ts` | Scheme registration, XMPP connection, tabs as `WebContentsView`s, IPC, OS-handler argv |
| `src/preload.ts` | The only bridge: named IPC calls for the chrome |
| `chrome.html/.css/.js` | The chrome UI, plain files loaded from disk |

The example is ESM throughout, like the rest of the project. Two consequences:
`__dirname` is `import.meta.dirname`, and the preload is emitted as
`preload.mjs`, because Electron decides a preload's module type from its
extension and an ESM preload must be `.mjs` (with `sandbox: false`, which the
chrome view already needs for `contextBridge`). The example began as CommonJS
and was converted when the root `tsc` refused, correctly, `export` in a file it
resolved as CJS under `verbatimModuleSyntax`; the app was re-verified after the
switch.

Keeping `protocol.ts` free of Electron is what makes that half testable: 17
cases cover the URL encoding round trip, the CSP a page cannot loosen,
method/header/body forwarding, status pass-through, the not-connected page, an
XMPP refusal mapped to 403, and error-page escaping. None of them needs a
window.

## What a real run verified, and what it corrected

Run under Xvfb against the demo gateway (Prosody + `scripts/demo-gateway.mjs`),
Electron 38.8.6:

- The demo page loads with its own CSS applied, and its image and CSS
  `background-image` are fetched through the handler.
- The address bar shows `httpx://web@httpx.localhost/`, so the decode works.
- A second launch with a URL opens a tab in the running instance
  (`second-instance`), which is the mechanism an OS-level handler uses.

Two bugs only a real run could find, both fixed:

1. The first navigation raced the XMPP connection. A URL on the command line
   loaded before `connect()` finished, so it rendered the "not connected" page
   and then sat there while the status pill said *online*. Now the shell connects
   before opening the initial tab, and any httpx tab is reloaded when a session
   comes up.
2. The losing instance of a double launch died with an unhandled rejection.
   It called `app.quit()` but then went on to register the ready handler and
   tried to build a second shell while quitting. The lock check now guards
   registration, and `whenReady()` has a rejection handler so a startup failure
   logs instead of raising a modal dialog with nothing in the log.

## Not done here

- Packaging. No `electron-builder` config, so nothing installs a `.desktop`
  entry or registry key; [os-scheme-handlers.md](os-scheme-handlers.md) covers
  what that needs. `npm start` runs it from source.
- Per-tab connections. One XMPP session serves every tab, which is right for
  one user but means no per-tab identity.
- No cache. The extension has one; here Chromium's own HTTP cache does not
  apply to a custom scheme, so pages refetch. `ETag` handling would have to live
  in the protocol handler.
- Credentials in plaintext under `app.getPath("userData")`, as in the
  extension. Demo-grade, and the settings dialog says so.
