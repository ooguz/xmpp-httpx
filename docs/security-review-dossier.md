# Security review dossier

A briefing for an external security reviewer. Everything here is
self-review; the point of handing it to you is that the author's blind
spots ship with the author. The deepest documents behind it are
[browser-extension.md](browser-extension.md) (the rendering pipeline's
reasoning, layer by layer) and [architecture.md](architecture.md)
(§Security model); this file is the map, the threat model, and the
specific requests.

## What this is

xmpp-httpx implements XEP-0332: HTTP requests and responses carried
inside XMPP stanzas, with seven body transports (inline text/base64,
chunked messages, IBB, sipub/SI with an optional SOCKS5 bytestream, jingle
with IBB or SOCKS5 transports). On top of it sits a browser: a
WebExtension (`examples/webext/`) that fetches `httpx://` pages over a
WebSocket XMPP session and renders them. The same page also runs as a
GeckoView built-in inside an Android fork (Berrak,
github.com/ooguz/klar-httpx), and the scheme runs natively in an Electron
shell (`examples/electron/`, `protocol.handle`). A gateway CLI
(`xmpp-httpx-gateway`) fronts ordinary HTTP origins over XMPP.

Two trust boundaries, reviewed differently:

1. Protocol boundary (`src/`): hostile *stanzas* from any XMPP entity.
2. Content boundary (`examples/webext/src/`): hostile *documents* from
   an httpx server the user chose to visit. This is the classic browser
   problem, answered here with sanitization instead of a process sandbox.

## Threat model

Adversaries, strongest claim first:

- **A1**, the page author. Whoever answers an httpx request controls the
  HTML, CSS, headers, body bytes, sizes and timing of everything the
  browser renders. The load-bearing claim: *nothing a page author sends
  can execute script, touch the extension origin's privileges, or reach
  another account's data.*
- **A2**, any XMPP entity. Can send arbitrary stanzas: malformed codecs,
  chunk floods for unknown streams, unsolicited IBB opens, sid collisions,
  seq desync, withheld acks, oversized blocks, hostile SI/jingle
  negotiation moves. The claim: every such input costs bounded memory and
  ends in a protocol error, never a crash or a hang
  (`test/integration/adversarial.test.ts`, `test/unit/fuzz.test.ts`).
- **A3**, a network attacker on S5B. SOCKS5 bytestreams move bodies over
  raw TCP (Node only). Streams are matched by the XEP-0065 dstaddr hash
  (SHA-1 of sid+requester+target); candidates the peer never offered are
  refused (`src/node/socks5.ts`, `src/socks5/protocol.ts`). Note what is
  *not* claimed: S5B payloads are not encrypted, as in upstream XEP-0065.
- **A4**, the XMPP server. Trusted for `from` authenticity (SASL) and
  routing. A hostile server owns the session; that is XMPP's trust model
  and not something this library can fix. Gateways forward the
  authenticated JID as `X-Httpx-From`; origins must accept it only from
  the gateway.
- **A5**, a second account on the same profile. Responses are authorized
  per requester JID, so the HTTP cache is partitioned per bare JID
  (`httpx-v1:<bare JID>`, `examples/webext/src/cache.ts`). The partition
  exists because self-review found the shared cache leaking across
  accounts.

Assets: the extension origin's privileges (storage with XMPP credentials,
`downloads`, the XMPP session itself), the no-script invariant inside the
rendered document, per-account cache isolation, the user's download
directory, and (in the Berrak embedding) the host app's chrome.

## Where we most want hostile eyes

Ranked. Items 1 to 3 are the reason an external review exists.

1. **The mXSS surface of the render pipeline**
   (`examples/webext/src/render.ts`). The chain: DOMPurify
   `WHOLE_DOCUMENT` sanitize, then `DOMParser`, then DOM mutations (URL
   resolution, blob substitution, form preparation, style injection), then
   `doc.documentElement.outerHTML` into `iframe.srcdoc` with
   `sandbox="allow-same-origin"` and no `allow-scripts`, under the
   extension page's `script-src 'self'` CSP. The claim is
   defense-in-depth: even a sanitizer bypass should be stopped by the
   sandbox, and vice versa. Attack the *re-serialization*: mutations after
   sanitization, parser/serializer round-trip differentials (foreign
   content, raw-text elements, attribute quoting), and anything that makes
   `outerHTML → srcdoc` parse differently than the sanitized DOM.
2. **The CSS sanitizer** (`examples/webext/src/sanitize-css.ts`). CSSOM
   allow-list re-serialization; every `url()` through a resolver admitting
   `httpx:`/`https:`/`data:`/`blob:`; `</style` re-escaped as `\3c /style`
   on the way out. Attack: resolver bypass via CSS escapes or
   `image-set()`/`src()`-style functional notations, smuggling through
   custom properties and `var()`, allow-listed at-rules containing
   something unexpected (`@font-face src`, `@keyframes` with url()), and
   engine differentials. The sanitizer runs wherever the page runs; since
   2026-09-15 the browser suites run in both Chromium and Firefox (Gecko,
   the engine Berrak embeds) and pass in both, but a Gecko-vs-Chromium
   difference already bit this project once (strict PNG CRC handling), so
   the sanitizer still deserves suspicion beyond what the suites pin.
3. **Privileged-origin egress and injection.** The extension page itself
   loads nothing remote by design. Favicons are accepted over `httpx:`
   only (a self-review finding: `https:` icons let any page make the
   privileged origin issue cross-origin requests). Page titles are the one
   hostile string in the extension's own DOM, normalized and rendered via
   `textContent` only (`src/page-meta.ts`, `src/history.ts`,
   `src/drawer.ts`, pinned by `test/browser/drawer.test.ts`). Find a
   page-controlled string that becomes markup, a URL load, or a storage
   write in the privileged document.
4. **Forms** (`examples/webext/src/forms.ts`): submission is parent-driven
   (the sandbox has no `allow-forms`); non-httpx actions are refused and
   the `action` attribute removed; `formaction`/`formmethod`/
   `formenctype`/`formtarget`/`target` are stripped. Attack the refusal
   completeness and the FormData-based submission construction.
5. **Cache correctness as a security property**
   (`examples/webext/src/cache.ts`): synthetic keys are
   `https://httpx.invalid/<encodeURIComponent(url)>`; try key collisions
   between distinct httpx URLs. Also freshness forgery (`x-httpx-stored-at`
   is always overwritten locally and `Age` is clamped; verify both), the
   304 metadata-refresh path, and POST invalidation.
6. **Downloads** (`examples/webext/src/download.ts`):
   `Content-Disposition` parsing (`filename*`/`filename`), reduction to a
   sanitized basename, the renderable-vs-download decision table.
7. **Protocol state machines** beyond what the adversarial suite pins:
   SI offer TTL and one-shot binding, jingle session keying
   (bare peer, sid), S5B candidate reconciliation and proxy activation
   (`src/jingle/s5b-negotiation.ts`, `src/socks5/`), IBB seq wraparound at
   65536, decompression caps on pre-encoded request bodies
   (`src/server/`, zip-bomb guard), and the gateway CLI's static-site mode
   containment (double check: percent-decoding then real-path
   containment, `src/cli/`).
8. **The Android embedding** (`ooguz/klar-httpx`,
   `focus-android/app/src/main/java/org/mozilla/focus/httpx/`): a
   top-level `httpx://` load is rewritten to
   `moz-extension://<uuid>/browser.html?embedded=1#<url>`; subframe
   requests are deliberately not rewritten so web content cannot embed the
   privileged page. Attack the rewrite's URL handling (encoding, userinfo)
   and the embedded-mode `hashchange` re-entry path
   (`examples/webext/src/embedded.ts`, `src/app.ts`).

## Prior findings (all fixed; look for siblings)

Self-review and adversarial-workflow rounds produced these. Each suggests
a class the reviewer may find more members of:

- Page-declared favicons were honored over `https:`, which let a page make
  the privileged origin issue cross-origin requests (now httpx-only).
- The response cache was shared across accounts despite per-JID
  authorization (now partitioned).
- IBB block sends were bounded by the session IQ timeout rather than the
  idle timeout, so a withholding peer parked memory for minutes
  (adversarial suite; fixed).
- `normalizeUrl` percent-decoded every navigated URL, corrupting
  querystrings (`%23` decoded to `#`, truncating the query); now only
  wholly-encoded inputs are decoded.
- URL canonicalization and history: non-canonical hash spellings could
  duplicate history entries and create a back-button trap in embedded
  mode, and superseded loads could paint over a newer page (all fixed, see
  CHANGELOG "embedded mode drives the host's back button").
- Both stream senders re-copied the buffered tail per block, an O(body²)
  memcpy. A DoS-adjacent perf bug, found by a benchmark.
- In the Android fork: a crash screen offered "send crash report to
  Mozilla" while the pipeline behind it sent nothing (dead consent UI).

## What is already machine-checked

- `test/unit/fuzz.test.ts`: fast-check arbitrary-XML fuzzing of the
  codecs; only typed errors escape, never crashes.
- `test/integration/adversarial.test.ts`: the hostile-peer suite. Every
  bound in §Security model is asserted, the victim survives, and
  legitimate traffic continues.
- `test/browser/`: the sanitizer, CSS, forms, drawer and blob-lifetime
  pins in real Chromium (not Gecko; see item 2 above).
- `npm run smoke`: the built extension driven end-to-end in Chromium
  against a real Prosody + demo gateway.
- `scripts/memcheck.mjs`: streaming stays O(block), not O(body).

## Accepted risks (known; do not re-report, argue if wrong)

- Credentials sit in extension storage in plaintext, and the dev Prosody
  is reached over `ws://`. Both are demo-grade by declaration; production
  means `wss://`.
- CSS may reference third-party `https:` resources (fonts, images) from
  inside the iframe. This is the same exposure as `<img src="https://…">`,
  documented with the "restrict the resolver to httpx: for zero
  third-party traffic" escape hatch.
- S5B bodies are cleartext TCP, as in upstream XEP-0065.
- In Berrak: Focus's "erase" does not wipe XMPP credentials
  (extension-profile storage), and engine-global "Block JavaScript" kills
  the extension page too. Both are documented in the fork's README.

## Running it

```sh
npm ci && npm run demo        # Prosody (Docker) + demo gateway + site
npm test && npm run test:browser
npm run smoke                 # built extension, real Chromium, real XMPP
npm run test:e2e              # protocol suites against Prosody
```

The demo site (`scripts/demo-gateway.mjs`) serves pages, CSS-over-XMPP,
forms, downloads and slow/large bodies, which makes it a convenient
hostile-server puppet: edit it to serve whatever attack document you
need.

## Reporting

Findings go through GitHub's private vulnerability reporting on
`ooguz/xmpp-httpx` (see `SECURITY.md`). Please do not open regular issues
for security findings.
