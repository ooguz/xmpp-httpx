# xmpp-httpx — Testing infrastructure

Three vitest projects (configured in `vitest.config.ts` via `test.projects`),
plus a manual demo path. Everything below `session.send()` is exercised by
in-memory sessions; everything including the wire is exercised by the E2E
suite against a real Prosody.

## Projects at a glance

| Project | Command | Environment | What runs |
|---|---|---|---|
| `node` | `npm test` | Node | `test/unit/**` + `test/integration/**` + `test/integration-node/**` |
| `browser` | `npm run test:browser` | headless Chromium (Playwright) | the same suites, plus `test/browser/**` |
| `e2e` | `npm run test:e2e` | Node + Docker | `test/e2e/**/*.e2e.test.ts` against live Prosody |

Two directories are single-project by nature: `test/integration-node/`
(raw TCP sockets for SOCKS5 bytestreams) runs only under `node`, and
`test/browser/` (real CSSOM, `DOMParser`, blob URLs) only under `browser`.

The `browser` project exists to *prove* the browser-safe-core rule: the full
protocol stack — codec, chunk reassembly, IBB flow control, sipub/jingle
handshakes, client↔server integration — runs in a real browser engine.
Everything the suites need is environment-agnostic; XML fixtures are loaded
via Vite `?raw` static imports so one test file serves both projects.
`@vitest/browser-playwright` peer-pins vitest **exactly** — upgrade the two
together.

## Unit tests (`test/unit/`)

- `codec.test.ts` — decodes fixtures transcribed **verbatim from XEP-0332's
  examples** (`test/fixtures/*.xml`), round-trips through serialize→parse,
  and covers every `CodecError` path including the sipub/jingle descriptor
  rules (wrong namespace → `unsupported`, missing id/sid → error).
- `base64.test.ts` — property-tested (fast-check) against the platform's
  `btoa` as reference; whitespace tolerance; invalid input.
- `chunked.test.ts` — the reassembler under **random chunk permutations**
  (fast-check), plus duplicate-nr, post-`last` chunks, invalid base64,
  buffer overflow, and idle-timeout error paths.
- `select.test.ts` — the encoding decision table, including preference
  order and per-mechanism accept flags.
- `caps.test.ts` — reproduces the XEP-0115 §5.2 worked example hash
  (`QgayPKawpkPSDYmwT/WM94uAlu0=`); order-independence; disco-result
  recomputation.
- `urls.test.ts`, `errors.test.ts` — URL codec incl. browser-style relative
  resolution; stanza-condition mapping.

## Integration harness (`test/integration/mock-session.ts`)

`createSessionPair()` returns two in-memory `XmppSession`s that mirror
@xmpp/iq semantics faithfully: async handlers, error elements → IQ errors,
thrown handlers → `internal-server-error`, no matching handler →
`service-unavailable`, `StanzaError`-shaped rejections with `.condition`,
timeout rejections with `name: "TimeoutError"`.

Two properties make it trustworthy:

- **Wire realism**: every stanza is serialized and re-parsed on send, so
  nothing survives that wouldn't survive real XML.
- **Fault injection**: `session.deliverHook = (stanza, deliver) => …` lets a
  test hold, drop, or reorder deliveries — the chunked suite delivers an
  entire chunk stream in **reverse order** this way.

Suites: `roundtrip.test.ts` (inline flows, failure mapping, component-style
addressing), `streaming.test.ts` (1 MiB chunked, reordering, IBB both
directions, `httpxFetch` bridge), `abort.test.ts` (AbortSignal / cancel /
close propagation), `sipub.test.ts` / `jingle.test.ts` (handshakes, expiry,
peer binding, decline paths, duplicate-initiate hedge), `caps.test.ts`
(presence-learned capabilities, one-query-per-ver).

## E2E against Prosody (`test/e2e/`)

Gated behind `E2E=1` (the vitest project isn't even constructed without it).
`global-setup.ts` runs `docker compose up -d --wait`, registers `alice` and
`bob` via `prosodyctl register`, and tears everything down after
(`E2E_KEEP=1` keeps the container for debugging).

| Piece | Value |
|---|---|
| Image | `prosodyim/prosody:13.0` |
| Host ports | 15222 (c2s), **15280 (websocket — the tested transport)**, 15347 (component) |
| Users | `alice` / `e2e-alice`, `bob` / `e2e-bob` on `localhost` |
| Component | `httpx.localhost`, secret `e2e-secret` |

Config quirks captured in `prosody/prosody.cfg.lua` (both were found the
hard way): `pidfile` must be set or the `prosodyctl status` healthcheck
fails, and `http_interfaces = { "*", "::" }` is required or the websocket
listener binds loopback-only inside the container. Clients connect over
`ws://localhost:15280/xmpp-websocket` — no TLS, which sidesteps xmpp.js's
self-signed-STARTTLS pain *and* exercises the same transport the
WebExtension uses.

Suites: `c2s-roundtrip.e2e.test.ts` (inline/IBB/chunked/sipub/jingle bodies
between two real users — the sipub/jingle cases connect extra `bob`
resources because one session supports one `HttpxServer`) and
`component-gateway.e2e.test.ts` (`httpxFetch` → XEP-0114 component serving
`demo-site.ts`: pages, an image, a 404, a GET form query, a urlencoded POST
body with non-ASCII text, an attachment, and an `If-None-Match` → **304**
round trip — the whole surface the WebExtension drives).

## Browser-only suites (`test/browser/`)

The WebExtension's rendering pipeline is security-critical and pure
browser-API code, so it is tested in real Chromium rather than by hand:

- `sanitize-css.test.ts` — the CSSOM sanitizer: at-rule allow-listing,
  `url()` resolution and rejection, `expression()`/`behavior` removal,
  `!important` preservation, `</style>` re-escaping, idempotence, and the
  resolver contract the render pipeline depends on.
- `render.test.ts` — `renderHtml`/`renderPlain`/`renderError` against a real
  sandboxed iframe: scripts/framing/handlers stripped, page CSS surviving,
  httpx images and CSS references fetched into `blob:` URLs (deduplicated,
  revoked on cleanup), unavailable resources degrading instead of throwing,
  relative links resolved, click interception reporting only `httpx:`
  navigation, form submission intercepted from control clicks and the Enter
  key (this is where the "no submit event under sandbox" behavior is pinned
  down), and error-page actions reported back to the host.
- `download.test.ts` — renderable-vs-downloadable content types and
  `Content-Disposition` filename parsing, including the traversal/control-char
  cases a hostile server would send.
- `page-meta.test.ts` — title/favicon extraction from raw HTML: trimming and
  capping, `rel~="icon"` spellings, last-icon-wins, scheme refusal.
- `forms.test.ts` — action resolution, the three refusal cases, submitter
  overrides stripped, GET query construction, urlencoded POST bodies, and
  which controls submit (`<button>` yes, `type=button`/`reset` no).
- `cache.test.ts` — the HTTP cache against a scripted server: freshness
  arithmetic (`max-age` + `Age`, `Expires`, `no-cache`), storability rules,
  `If-None-Match`/`If-Modified-Since` revalidation returning a 304 and the
  cached body, lifetime refreshed from the 304's headers, body replacement,
  invalidation, and recovery from a 304 with nothing cached.

These import `examples/webext/src/*` directly; `vitest.config.ts` aliases the
`xmpp-httpx` package specifier (the example consumes the library by name) to
`src/index.ts`, and `tsconfig.json` mirrors that with `paths`, so neither a
built `dist/` nor an install inside the example is required.

## Fuzzing & adversarial testing

- **`test/unit/fuzz.test.ts`** (fast-check) asserts the decoder contract:
  for arbitrary parser-producible elements, `decodeReq`/`decodeResp`/
  `decodeData`/`decodeHeaders` either return a value or throw
  `CodecError`/`TypeError` — never an internal `TypeError`/`RangeError`,
  never a hang. Also fuzzes base64 (only `SyntaxError` escapes), the URL
  parser (only `TypeError`), and `ChunkReassembler` under random push
  sequences.
- **`test/integration/adversarial.test.ts`** points a hostile peer at every
  bound in the security model — malformed `<req>`, chunk floods for unknown
  streams, oversized streamed request bodies, unsolicited/absurd/duplicate
  IBB opens, `<data>` for unknown sids, seq desync, and a peer that stops
  acking — and asserts each attack yields a protocol error (or is silently
  dropped), the victim survives, and a legitimate request still succeeds.
  This suite drove one fix: IBB block sends are now bounded by the idle
  timeout, not the session's full IQ timeout.

## Benchmarks & memory

- **`npm run bench`** (vitest bench, `test/bench/transports.bench.ts`)
  measures per-transport round-trip throughput over the mock pair at 64 KiB
  and 1 MiB. Numbers are comparative, not absolute (microtask delivery, no
  real socket) — useful for spotting framing-overhead regressions and
  tuning chunk/block sizes. As expected the transports cluster closely; IBB
  and sipub pay a small per-block IQ-round-trip cost that the
  fire-and-forget chunked/message transports avoid.
- **`node --expose-gc scripts/memcheck.mjs`** (after `npm run build`) proves
  IBB streaming is **O(block), not O(body)**: it streams 1 MiB and 16 MiB
  bodies while sampling *live* (post-GC) heap, and fails if retention scales
  with body size. IBB is the memory-bounded transport by design — its
  per-block acks apply real backpressure — so it is what the audit
  exercises; chunkedBase64 has no protocol acks and is bounded instead by
  the receiver's `maxBufferedBytes` cap.

## Manual demo path

`scripts/demo-gateway.mjs` connects to the E2E Prosody's component and
serves a small multi-page site (pages, relative links, a PNG) over httpx —
browsable with the WebExtension, or scriptable with `httpxFetch`. See
[`examples/webext/README.md`](../examples/webext/README.md) for the
step-by-step.

## CI (`.github/workflows/ci.yml`)

| Job | Trigger | Runs |
|---|---|---|
| `check` | push/PR | lint, typecheck, build |
| `test` | push/PR | node project on Node 20 / 22 / 24 |
| `browser` | push/PR | Playwright Chromium, browser project |
| `e2e` | nightly cron, manual dispatch, pushes to main | Prosody compose + e2e project |
| `bench` | manual dispatch | `npm run bench` + `scripts/memcheck.mjs` (informational) |
