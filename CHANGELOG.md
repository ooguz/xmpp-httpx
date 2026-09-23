# Changelog

## Unreleased

- **Extension elements on `<req/>` and `<resp/>`.** Children in a namespace
  other than `urn:xmpp:http` and SHIM headers ride along verbatim:
  `HttpxRequestInit.extensions` / `HttpxConnectInit.extensions` on the way
  out, `HttpxServerRequest.extensions` at the handler, and
  `HttpxHandlerResponse.extensions` back to `HttpxResponse.extensions`. The
  codec never interprets them; each must bring its own `xmlns`. An unknown
  child in the protocol's own namespace is still ignored, not an extension.
  n146's sealed envelope (hiding a request's target from the XMPP servers) is
  the first user.
- **IBB receivers tolerate redelivered blocks.** After an XEP-0198 stream
  resumption the server replays every stanza it had not acknowledged, so the
  same `<data/>` can legitimately arrive twice. A block whose `seq` is up to
  64 behind the one expected is now acknowledged and dropped (or, on the
  message-carried path, dropped) instead of failing the stream with "seq
  mismatch". A gap ahead, or a jump further behind, still fails it: a
  sender's window is far smaller than 64, so those cannot be replays. Found
  by n146's resumption test: a tunnel survived the reconnect only to die on
  the replay.
- **`xmpp-httpx/metrics` entry point.** The gateway's Prometheus registry
  (`Metrics`) and its `/metrics` + `/healthz` listener (`startMetricsServer`)
  are now importable by applications that run their own `HttpxServer` — an
  exit, a bridge — so they get the same counters, histogram and liveness
  probe without a client library. Nothing moved; the two modules were always
  free of gateway-specific dependencies and only lived under `cli/` because
  the gateway was their first user.
- **Fair IBB scheduling across streams.** Every sending IBB stream on a
  session now also draws from one shared budget of blocks in flight
  (`ibbSessionWindow`, default 16, on `HttpxClient` and `HttpxServer`), and
  when it is full, freed slots go to the waiting streams in turn, one block
  each. Before, each stream held its whole window regardless, so a large
  download's blocks queued ahead of a small page's in the one XMPP
  connection. A stream on its own at the default window is exactly as fast
  as before (the default budget is twice that window); a window configured
  above the budget is capped by it. A block the receiver leaves unanswered
  for `max(250 ms, 4 × the measured ack latency)` counts as parked at the
  receiver and gives its slot back, so a peer withholding acks — a consumer
  that is not reading — cannot hold the budget and freeze every other stream
  on the session. The grant for a slot is
  reserved for the stream it goes to and consumed in the same synchronous
  step that takes, encodes and sends the block, so ordering is untouched.
  Every path now takes at most one block from the buffer by construction;
  `close()` used to drain the whole remainder at once and stayed within a
  block only because of the order parked pumps were woken in.

## 0.9.0 — 2026-09-22

- **Windowed IBB sending.** Up to `ibbWindow` blocks (default 8) are in flight
  at once: the IQ result of block k releases block k+window, instead of every
  block waiting for its own round trip. That cap was the real limit on IBB —
  4 KiB per RTT measured 40.2 KB/s on a simulated 100 ms path, and the same
  1 MiB body now moves at 2.41 MB/s with 64 KiB blocks and a window of 8. Over
  a real Prosody, 8 MiB of IBB goes at 9.17 MB/s, which is past
  `chunkedBase64` for the first time. The acks it was paying for are all still
  there. `ibbWindow: 1` is the old sender. `ibbBlockSize` caps what a server
  sends and sets what a client sends for request bodies, where XEP-0332 gives
  the responder no way to advertise a limit; response-body block size still
  comes from the requester's `maxChunkSize`, i.e. from
  `stanzaBudgets(maxStanzaBytes)`.
  Ordering, backpressure and error reporting all had to be re-earned: taking,
  encoding and sending a block is one synchronous step (the receiver tolerates
  no `seq` gaps); `write()` still blocks once the window is full, so a
  receiver that stops reading still stops the sender; a failed block closes
  the stream with the *earliest* failure in send order, since a dead receiver
  rejects everything outstanding at once and rejection order is not send
  order; and `close()` waits for every outstanding ack before `<close/>`.
  The receiving side grew the other half of the window — its queue holds
  `(window + 1) x block-size` rather than a flat 64 KiB, without which the
  first 64 KiB block alone drives `desiredSize` to 0 and the window collapses
  back to one block per round trip — and a receiver that is deliberately
  withholding acks now suspends its own idle timer instead of timing out a
  stream that is silent on its own instructions.
- **`CONNECT`, and the other request-target forms.** `CONNECT` joins
  `HTTP_METHODS` (a deliberate departure from XEP-0332 v0.5.1, whose method
  list stops at `PATCH` — recorded in `docs/protocol-notes.md`), and `<req
  resource=…>` now accepts authority-form (`example.org:443`, `CONNECT` only
  per RFC 9112 §3.2.3) and absolute-form (`https://example.org/x`) alongside
  the origin-form and `*` it already took. Origin-form decodes exactly as
  before. Authority-form is checked strictly — no userinfo, no path, no
  query, a port in 1–65535 — so `evil.org:80/../admin` is rejected rather
  than reinterpreted.
- **Duplex IBB streams, and `CONNECT` tunnels on top of them.**
  `IbbManager.openDuplex()` / `expectDuplex()` give one IBB session used in
  both directions — the opener's sid, a `seq` counter per direction, the
  acceptor adopting the sid without an `<open>` of its own (n146 design §4.2).
  There is no half-close: `close()`, `abort()`, the peer's `<close/>` and a
  cancelled reader all end both directions, and two `<close/>`s that cross on
  the wire both succeed (the closing side keeps a tombstone that answers the
  peer's until its own is acked). Every failure path tells the peer, because
  a tunnel's peer has no watchdog to reap it. A duplex sends what each
  `write()` leaves over at once instead of holding a sub-block tail for the
  next write — a TLS ClientHello would otherwise never leave — while bytes
  written against a full window still coalesce into full blocks.
  `HttpxClient.connect(to, { authority })` asks for a tunnel and returns the
  `<resp>` plus the duplex; a handler answers `CONNECT` with
  `{ status: 200, tunnel: (t) => … }`, and the server opens the stream after
  the reply. The library dials nothing. A tunnel that fails to open is still
  handed to the handler, already dead, so its error path closes the
  destination socket. `request({ method: "CONNECT" })` now refuses and points
  at `connect()`.
- **Tunnels are opt-in, and discoverable.** `HttpxServer`'s `tunnels: true`
  advertises `urn:xmpp:http:connect:0` and lets CONNECT reach the handler;
  without it CONNECT is answered 501 before the handler runs. `connect()`
  refuses a peer whose disco lacks the feature (design §4.4). One wire form,
  `<req method='CONNECT'>`, until the XSF answers; the API does not depend on
  it.
- **A streamed response without Content-Length is streamed.** The server
  read the header with `Number()`, and `Number(null)` is 0: every length-less
  stream counted as "0 bytes, fits inline", so the whole stream was buffered
  before the reply — and a stream that never ends (a trickled download, an
  event stream) never got one. `parseContentLength()` takes RFC 9110's
  `1*DIGIT` (or a list of identical values) and nothing else, so `""`,
  `"0x10"` and `"1e3"` no longer pass as lengths either. The bug had hidden
  two sources that never gave a length: the static handler now sends a GET's
  `Content-Length`, and the origin proxy only drops it when fetch actually
  decompressed the body — otherwise every small page would now pay for an
  IBB session. A length-less body with no stream mechanism open to the
  requester is read up to the inline budget: inlined if it fits, 413 if not.
- **Idle watchdogs are per stream.** `expectIncoming()` takes
  `idleTimeoutMs`, and a duplex defaults to `false`: no inbound idle timer and
  no stretched ack-withholding deadline, since a tunnel is idle by nature. The
  sender's per-block ack deadline stays on for tunnels — it only runs while
  bytes are outstanding. Bodies are unchanged by default; the one visible
  difference is that `HttpxClient`/`HttpxServer`'s `idleTimeoutMs` option,
  and the per-request one, now also reach an IBB body's own watchdog, where
  before they only bounded the wait for its `<open>`.
- **`urn:xmpp:http#absolute-form` is advertised** (design §4.3), so a
  requester can find out that `resource='https://host/path'` is accepted, and
  `DiscoCache.supports(jid, feature)` answers that and any other feature
  question from the same one disco query.
- **The origin proxy refuses a target naming another origin.**
  `createOriginProxyHandler` resolved the requester's `resource` against the
  configured origin with `new URL(ref, base)`, which drops the base entirely
  for anything carrying its own authority. Absolute-form makes that spellable
  as `https://…`, but it was already reachable before this release with a
  protocol-relative `//169.254.169.254/…`, which starts with `/` and so passed
  the old origin-form check: an authorized requester could make the gateway
  fetch any host reachable from it, with `x-httpx-from` naming their
  authenticated JID to whoever answered. The handler now compares the resolved
  origin against the configured one and answers 400 on a mismatch, which
  closes both spellings. A forward proxy wanting absolute-form is a different
  handler with its own destination policy.

- **WebExtension: ready to sign.** The Firefox add-on ID is now the permanent
  `httpx-browser@ooguz.dev`. `npm run sign:firefox` wraps `web-ext sign`
  (credentials from `WEB_EXT_API_KEY`/`WEB_EXT_API_SECRET`, unlisted channel
  by default, `WEB_EXT_CHANNEL=listed` for the store), and `npm run package`
  also writes the source archive AMO asks for when code is bundled: library
  and extension sources plus a `BUILD.md` with the exact rebuild steps.
  RELEASING.md gained the AMO and Chrome Web Store walkthrough.
- **Dillo plugin packaged.** `npm run package` in `examples/dillo/` builds
  `httpx-dillo-dpi-<version>.tar.gz`: the plugin bundled into one file by
  esbuild, a launcher that finds Node 20+ at run time (PATH, `~/.nvm`, system
  places; `HTTPX_DPI_NODE` overrides), an `install.sh` that needs nothing
  outside the tarball, the example config, and `LICENSE` plus a
  `LICENSES.txt` generated from what the bundle actually contains. The
  checkout-bound `install.sh` is gone; `npm run install:dillo` packages and
  installs. The smoke test installs from the tarball and checks the launcher
  carries no path into the checkout; CI builds the package on every push.
- **Dillo plugin: `dpi:/httpx/`.** The plugin serves its own page: signed-in
  JID, configuration path, a settings form that writes `~/.dillo/httpx.json`
  (mode 600, atomic replace) and drops the session so the next page signs in
  with the new account, and a sign-out link. The form is a GET form (Dillo
  hands a plugin only a URL), so the page says plainly that the values travel
  in the URL; an empty password field keeps the stored one and `dpi:` queries
  are never logged. The smoke script asks dpid for the `httpx` service name
  as Dillo does for `dpi:` URLs and checks the page comes from the same
  process.
- **Browser suites run in Firefox too.** The vitest `browser` project now has
  a Firefox (Gecko) instance next to Chromium, so every browser-only test
  (CSS sanitizer, render pipeline, forms, cache, drawer, tabs, progress)
  runs once per engine. Gecko is what the Android app embeds, and a
  Chromium-vs-Gecko difference had already bitten the project once (PNG CRC
  strictness); the first dual-engine run passed everywhere, 886 tests.
- **`SECURITY.md`** and GitHub private vulnerability reporting, now that the
  repository is public; the reviewer dossier's reporting section points
  there.
- The XSF implementation-experience draft is kept in the owner's checkout
  only (gitignored) until it is sent; links to it were replaced with prose.
- **Dillo plugin** (`examples/dillo/`): `httpx://` in Dillo through its plugin
  interface. A *server dpi* — dpid starts it once on the first request with
  the listening socket on fd 0, and one XMPP session stays signed in across
  page loads, so a page and its images cost one IQ round-trip each rather
  than a connection. The dpip framing (`buildTag`/`parseTag`/`TagBuffer`)
  and the per-connection choreography (`auth` → `open_url` →
  `start_send_page` + an HTTP response; `DpiBye` → exit) are tested over the
  in-memory session pair; `npm run smoke:dillo` drives a real dpid and a real
  Dillo under Xvfb against the demo gateway. `install.sh` writes the launcher
  (absolute `node` path baked in — dpid inherits Dillo's PATH), the `dpidrc`
  route and an example `~/.dillo/httpx.json`. Failures render as pages with
  the status the error implies and a hint; a wrong shared secret closes the
  connection without a byte. See [docs/dillo-plugin.md](docs/dillo-plugin.md).

## 0.8.0 — 2026-09-12

- **WebExtension embedded mode**: `browser.html?embedded=1` hides the
  extension's own tab strip and URL bar, for a host app that provides its own
  browser chrome — built for the Firefox Klar fork, where the page runs as a
  GeckoView built-in extension behind the app's real toolbar. The flag is read
  once at boot (the page rewrites its visible URL while navigating), and the
  empty-tab `replaceState` now preserves the query string.
- **Embedded mode drives the host's back button**: standalone, the page's own
  per-tab stacks are the history and every URL-mirror write replaces; embedded,
  those controls are hidden, so a page-to-page navigation now *pushes* a
  session-history entry and a host back/forward traversal (arriving as
  `hashchange`) reloads the page it lands on. The boot-time upgrade of the
  empty-tab entry still replaces, so the first page stays the only entry and
  the host's back on it leaves the app rather than landing on a blank tab.
  Hardening that came out of adversarially reviewing this change (two rounds):
  - Tab URLs are canonicalized to the WHATWG-*serialized* spelling when
    visited, and the URL mirror compares that spelling — `location.hash` reads
    back percent-encoded, so a raw space or non-ASCII character in the tab URL
    used to look like a permanently pending write (embedded, that pushed
    duplicate entries on every load) and made a traversal re-enter the page
    under a different identity: duplicate stack entries, guaranteed cache
    misses, and a different wire resource than the original visit.
  - Only a real URL change pushes. A re-spelling of the current page's hash —
    hand-edited or typed `#httpx://host` landing on the canonical
    `#httpx://host/` — replaces: pushing there left a duplicate entry behind
    every typo, and let one non-canonical entry re-push the canonical one on
    every host back press, an inescapable back-button trap.
  - A load superseded by a newer one on the same tab now bails out instead of
    rendering: a slow fetch that lost the race could paint its page *after*
    the winner, leaving the iframe showing one page and the URL another. The
    cache chip takes the superseded fetch's state no more, and a tab close
    mid-load waits for *all* in-flight loads before detaching.
  - Traversals never re-save attachments. History re-entry — the host's
    back/forward, the page's own buttons — renders the file's receipt with a
    "Download" button instead of saving with no user gesture; a *fresh*
    navigation to an attachment (a URL typed into the host's toolbar arrives
    as hashchange too, distinguished by whether the spelling is one the page
    itself mirrored) still saves immediately.
  - An unparseable typed URL takes a history entry of its own (like a
    browser's error page), so walking back over it stays consistent instead
    of leaving two identical adjacent entries and a dead back press.
  - A URL typed while the boot auto-connect was still in flight is no longer
    overridden by the boot hash once the connection comes up.
- **WebExtension byte progress**: transfers are no longer a blind wait — a
  thin bar under the chrome plus a byte chip ("1.2 MB of 3.4 MB") show how
  much of the body has arrived, then the page renders once, as before. This
  is the honest half of "progressive rendering": the pipeline still sanitizes
  and paints only a *complete* document (partial markup is where mXSS lives),
  so the streaming went into feedback, not rendering. Bytes are counted where
  the network stream is actually consumed — the cache layer's miss path, or
  the raw POST/bypass read, never both for one load — reported per tab and
  discarded when a newer load supersedes the reporter. A surviving
  `Content-Length` makes the bar determinate (the library drops the header
  whenever it decompresses, so one that survives is in the counted bytes);
  it is still only a hint, and bytes outgrowing it drop the bar back to
  indeterminate. The bar sits outside the hideable chrome, so embedded mode
  (the Klar fork) keeps it — the one loading signal the host app's user gets.
  Hardening out of adversarially reviewing this change:
  - Error pages now *supersede* in-flight loads the way a newer load does:
    before, a slow fetch stayed "fresh" across an error render (an
    unparseable typed URL, a refused form), kept driving the bar over the
    error page, and then painted its page over it — leaving the address bar
    and the viewport disagreeing.
  - An indeterminate bar no longer renders as a motionless *full* bar in
    Gecko (with `appearance: none`, `::-moz-progress-bar` is laid out at
    full width when no value is set — exactly the engine the Klar fork
    embeds); both engines now hide the fill and slide a shimmer instead.
  - Forced-colors mode (Windows High Contrast) gets a system-palette bar
    (`Highlight`/`Canvas` with `forced-color-adjust: none`) — author
    backgrounds were stripped, leaving no loading signal at all.
  - Bodies the cache layer already buffered are consumed with
    `response.blob()` again rather than re-counted — the counting loop
    copied an already-in-memory body twice for nobody listening.
- **WebExtension**: a POST answered with 204/205 (and a GET landing on one)
  now renders an explicit "Nothing to show" receipt with a Back action —
  before, the empty no-content body replaced the form's page as a blank
  page. A real browser stays on the page; this model commits the navigation
  before the status is known, so the receipt is the honest version.
- **WebExtension fix**: a 304 carrying `Cache-Control: no-store` now
  *evicts* the cached entry (served once, validated, then gone) instead of
  re-storing the body the server just revoked — before, the entry could
  never be purged by revalidation, only by a full 200.
- **WebExtension fix**: a 204, 205 or 304 the cache layer rebuilt threw —
  the `Response` constructor refuses a body, even an empty `Blob`, on a
  null-body status — surfacing as a load error on any 204 a page GETs.
- **WebExtension fix**: `normalizeUrl` no longer percent-decodes every
  navigated URL — only inputs that arrive wholly encoded are decoded: the
  Firefox protocol-handler `%s` placeholder (`ext+httpx://…`) and the
  background script's omnibox deep link (`#httpx%3A%2F%2F…`). Decoding
  already-encoded URLs from links and GET forms corrupted them: `%23` in a
  form value became `#` and silently truncated the query, `%26` became `&`
  and split parameters.
- **WebExtension fix**: the history/bookmarks drawer was always visible — its
  `#drawer { display: flex }` rule outweighed the UA's `[hidden]` rule, so
  closing it never actually hid it. An explicit `#drawer[hidden]` rule restores
  the intended behavior.
- **S5B throughput benchmark** (`test/bench/s5b.bench.ts`, in `npm run bench`):
  the sipub (XEP-0065) and Jingle (XEP-0260) SOCKS5 paths measured against an
  IBB baseline, with the S5B bodies crossing a *real* loopback TCP socket (the
  server self-hosts a direct streamhost, the client dials it) — the
  measurement the roadmap said the mock pair could not provide. Every S5B
  round trip proves, inside the measured function (tinybench does not await
  the async teardown hook, so a throw there cannot fail the case), that it
  actually opened a negotiated socket — a silent IBB fallback errors the
  benchmark task instead of publishing IBB numbers under an S5B label.
  Loopback numbers: S5B delivers ~1.3–2× IBB's throughput at 64 KiB,
  ~12× at 1 MiB, ~25× at 8 MiB (the shape is the result — the digits move
  run to run) — despite the IBB baseline never touching a socket at all.
- **Wire-clocked benchmark over a real Prosody** (`npm run bench:prosody`,
  `test/e2e/transports.prosody.bench.ts`): an `@xmpp/client` user fetches
  from an `@xmpp/component` gateway with every stanza crossing the
  Dockerized server — the run the loopback benches could not provide. The
  wire's verdict: S5B is nearly size-independent (~0.1 s from 64 KiB to
  8 MiB — negotiation cost only, the body bypasses the server over direct
  TCP), while relayed transports scale with size; at 8 MiB sipub+S5B
  measured ~40× IBB and ~19× chunkedBase64, and IBB through the server is
  ~5× its mock-pair time (one client↔server↔component round trip per
  4 KiB block). chunkedBase64 still wins small bodies. The same
  no-silent-IBB integrity guard as the loopback bench, plus mode-aware
  bench hooks so connections are established during warmup and every
  measured sample rides a warm connection.
- **Demo-site fix: the logo PNG had a corrupt IDAT CRC.** Chromium's
  lenient decoder forgave it, so every Chromium-based check passed while
  Gecko (the Klar/Berrak fork) refused it with "Image corrupt or
  truncated" and showed alt text — misdiagnosed for a while as a
  GeckoView blob/CSP problem until a desktop-Firefox Playwright probe
  surfaced the decoder error. The fixture is now a valid 1×1 PNG in both
  demo twins, and `npm run smoke` asserts `naturalWidth > 0` — that the
  image actually *decoded* — instead of only checking for a `blob:` src.
- **Perf fix: stream senders are linear in body size again.** The IBB and
  chunkedBase64 senders re-copied the entire buffered remainder once per
  block whenever a body arrived as one large part — O(body²/blockSize): an
  8 MiB IBB body did ~8 GiB of copying, measured at 5.5 s per transfer over
  the in-memory pair and 0.69 s after the fix, now scaling linearly. Both
  senders cut blocks through a shared `BlockBuffer` (internal) that only
  views a part that covers the block and coalesces just when the front part
  cannot. Found by the S5B benchmark's first run.

## 0.7.0 — 2026-08-27

- **Gateway CLI**: `xmpp-httpx-gateway`, shipped as a `bin` of this package.
  Fronts an HTTP origin over XMPP in component or client mode, with a JSON
  config file, explicit `--allow`/`--allow-all` authorization (start is refused
  without one), stanza budgets, stream preference, request logging and clean
  signal shutdown. Secrets come from `XMPP_HTTPX_SECRET`/`XMPP_HTTPX_PASSWORD`.
  See [docs/gateway-cli.md](docs/gateway-cli.md).
- **Two latent SOCKS5 data-loss bugs fixed**, both found by exercising the read
  direction of a dialled connection: the handshake reader buffered bytes that
  shared a TCP segment with the CONNECT reply and then dropped them, and
  detaching that reader left the socket in flowing mode, where Node *discards*
  incoming data until the next listener attaches. Either could silently truncate
  a body on the existing XEP-0065 retriever path; the second showed up as a test
  failing one run in three.
- **`Socks5Adapter` is now role-neutral**: `connect()` and `openChosen()` (renamed
  from `openOutgoing`) both return `{ readable, out }`, so either party can read
  or write over a bytestream whichever way it was established. Breaking change
  for anyone implementing the adapter interface.
- **XEP-0260 (Jingle SOCKS5 Bytestreams)**, end to end: candidate/transport
  codec, transport-info payloads, priority arithmetic, `dstaddr`, the §2.4
  negotiation reconciliation (all exported), and the `JingleManager` wiring —
  candidates in a `transport-info` from *both* sides, `candidate-used`/
  `candidate-error`, proxy activation, and `transport-replace` to IBB when no
  candidate is usable. A sender that cannot host reaches a receiver that can, by
  dialling out. Active
  when a `Socks5Adapter` is supplied; IBB otherwise, so browser clients are
  unaffected. **Behaviour change:** a jingle offer carrying an s5b transport is
  now accepted (and falls back to IBB if necessary) rather than declined with
  `not-implemented`.
- **Desktop shell** (`examples/electron/`): `httpx://` registered as a real
  scheme via `protocol.handle`, so Chromium fetches pages *and subresources*
  itself. Not published to npm — an example, like the WebExtension.
- **`xmpp-httpx/testing`**: the in-memory session-pair harness this library's own
  integration suite runs on is now a published subpath (`createSessionPair`,
  `MockSession`, and the `deliverHook` fault-injection seam), so downstream
  handlers and clients can be tested without an XMPP server.
- **`HttpxResponse.formData()`** (urlencoded and multipart, via the platform's
  own parser), and **`parseAccept`/`negotiateContentType`** for content
  negotiation.
- **Per-request `idleTimeoutMs`** on `HttpxClient.request` and `httpxFetch`,
  overriding the client-wide default for one streamed body.
- **`npm run demo`**: Prosody, demo users and the demo site in one command.
- **`withRateLimit(handler, options)`**: per-bare-JID token bucket, exported from
  the library and wired to the CLI's `--rate`/`--burst`. Throttled requests get a
  real 429 with `Retry-After` (not a 403), and never reach the origin.
- **Static-site mode** for the gateway: `--static <dir>` serves a directory
  directly, with no HTTP origin — validators for cheap 304s, streamed bodies,
  and containment checked twice (lexically and against the real path, so a
  symlink cannot lead out of the root).
- **Gateway observability**: `--log-format json`, and `--metrics-port` serving
  Prometheus metrics plus a `/healthz` liveness endpoint (loopback-bound by
  default). Requests, denials and errors are counted; request duration is a
  histogram; `httpx_gateway_stream_up` reports XMPP connectivity.
- **Docker image** for the gateway (`Dockerfile`), plus a runnable
  three-container compose example in `examples/docker/` (nginx origin + Prosody
  + gateway). The runtime stage installs the `npm pack` tarball, so the image
  runs exactly what would be published.
- **`isStreamMechanism(value)`** exported — the guard the CLI needs to validate
  `--prefer`, useful to anyone else narrowing user input to a mechanism.

Packaging/tooling fixes —

- **`npm run build` and `npm run lint` were broken** and would have failed CI:
  `tsconfig.build.json` never saw the Node types `src/node/socks5.ts` needs
  (they reached `npm run typecheck` only via vitest's config types), and
  `scripts/memcheck.mjs` had unused imports plus globals missing from the
  eslint scripts override. Both fixed; `docs/api/` is now eslint-ignored so a
  local `npm run docs:api` doesn't make lint diverge from CI.

The bundled example browser (`examples/webext/`, not published to npm) gained
page CSS, forms, caching, downloads, and page metadata — see
[docs/ROADMAP.md](docs/ROADMAP.md) phase 10 and
[docs/browser-extension.md](docs/browser-extension.md).

## 0.6.0 — 2026-07-07

- **Content-Encoding**: transparent gzip/deflate via
  CompressionStream/DecompressionStream (browser-safe). Client advertises
  `Accept-Encoding` and decompresses responses; server compresses
  compressible responses (eagerly for byte bodies — a gzipped body often
  fits inline) and decompresses pre-encoded request bodies, with a
  post-decompression cap against zip bombs. Disable with `compress: false`
  on either side.
- **`stanzaBudgets(maxStanzaBytes)`** derives `inlineBudgetBytes` +
  `maxChunkSize` from a known server stanza limit; an explicitly advertised
  `maxChunkSize` is now honored up to the spec maximum (previously capped
  at 8192).
- **Authorization policy helpers**: `presencePolicy(session)` (allow
  currently-available JIDs) and `manualPolicy(prompt, {ttlMs})`
  (application-approved requesters with per-JID caching).
- **Origin proxy** forwards the requester's full XMPP-authenticated JID as
  `X-Httpx-From` (configurable/disable via `jidHeader`) — the httpx
  replacement for cookies/Basic auth.
- Documented sessions/reconnection/stream-lifetime semantics and the
  authentication model in `docs/architecture.md`; connection loss
  mid-stream is tested to surface as a `timeout` error.

## 0.5.0 — 2026-07-07

- **sipub transport** (XEP-0137 over XEP-0095 SI, IBB stream method only):
  one-shot publications bound to the requester's bare JID, 60 s TTL.
- **Jingle transport** (minimal XEP-0166 subset: XEP-0234 file-transfer
  description over the XEP-0261 IBB transport; the initiate embedded in
  <data> is the session-initiate — see docs/protocol-notes.md).
  All seven XEP-0332 data mechanisms are now implemented.
- **XEP-0115 entity caps**: `computeCapsVer`/`buildCapsElement`, and
  DiscoCache now learns capabilities passively from presence, verifying
  each ver hash with a single disco query.
- Client `accept` option gains `sipub`/`jingle` flags (default true);
  `preferredStreams` accepts `"sipub"`/`"jingle"` on both sides.
- BodyTransport registry is now bidirectional (offer/receive) — the
  extension point custom transports plug into.

## 0.4.0 — 2026-07-07

First feature-complete release of the v0.1–v0.4 roadmap. No published
versions precede this; earlier numbers below describe the internal
milestones folded into it.

### v0.4 — hardening
- AbortSignal now tears down streaming response bodies (chunkedBase64
  reassembly errors immediately; unread IBB bodies are cancelled and the
  peer notified with `<close/>`).
- Streamed-request-body failures are always surfaced as `HttpxError`.
- Dockerized Prosody E2E suite (`npm run test:e2e`, Docker required):
  real c2s round-trips over WebSocket and a component gateway serving a
  demo site.
- Unit + integration suites also run in headless Chromium
  (`npm run test:browser`) — the whole protocol stack is exercised in a
  real browser environment.

### v0.3 — IBB
- XEP-0047 In-Band Bytestreams, both directions, with IQ-ack flow control;
  preferred mechanism for large bodies.

### v0.2 — chunkedBase64
- Chunked message streams with out-of-order reassembly, idle timeouts,
  buffer caps, and orphan-chunk buffering.

### v0.1 — core
- XEP-0332 stanza codec (req/resp/SHIM headers/data) validated against the
  XEP's examples; inline text/xml/base64 bodies.
- `HttpxClient`, `httpxFetch()` (WHATWG Response bridge), `HttpxServer`
  with deny-by-default authorization policies, XEP-0030 discovery,
  `httpx://` URL parsing, Node reverse-proxy handler (`xmpp-httpx/node`).
