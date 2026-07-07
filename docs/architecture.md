# xmpp-httpx — Architecture

This document explains how the library is put together: the design rules,
the module map, the full request lifecycle on both sides, how each of the
seven body transports works, and the error and security models. For
*protocol-level* decisions where XEP-0332 is ambiguous, see
[protocol-notes.md](protocol-notes.md); for the test infrastructure, see
[testing.md](testing.md); for the browser, see
[browser-extension.md](browser-extension.md) and
[`examples/webext/`](../examples/webext/).

## Design rules

Five rules shape everything; knowing them makes the codebase predictable:

1. **Session injection.** The library never opens XMPP connections. Every
   entry point takes an `XmppSession` — a structural interface
   (`src/session.ts`) satisfied by `@xmpp/client`, `@xmpp/component`, and
   the test mock alike: `{ jid, send, iqCaller, iqCallee,
   on/removeListener("stanza") }`. Connection lifecycle, reconnection, and
   TLS are the application's business.

2. **Browser-safe core.** Everything outside `src/node/` runs unmodified in
   Node ≥ 20 and evergreen browsers: `Uint8Array` (never `Buffer`),
   `TextEncoder`/`TextDecoder`, a pure lookup-table base64 codec,
   WHATWG `ReadableStream`/`Headers`/`Response`/`AbortSignal`, and
   `crypto.subtle` for hashing. ESLint enforces this (`no-restricted-globals`
   bans `Buffer`, `process`, `window`, … in core files). The whole test
   suite runs in headless Chromium to prove it.

3. **One body primitive.** Every body — inline, chunked, IBB, sipub, jingle —
   surfaces as a `ReadableStream<Uint8Array>`. That is the one type that
   feeds `new Response(stream)` directly, which is what a browser needs for
   progressive rendering.

4. **Errors are layered.** HTTP-level failures (404, 500) travel inside
   `<resp statusCode=…>` and come back as *responses*. XMPP-level failures
   (forbidden, timeout, unreachable) are thrown as `HttpxError` with an
   `httpEquivalent` hint. The library never fabricates a fake `HttpxResponse`
   from a transport failure.

5. **One handler per (namespace, tag) per session.** `@xmpp/iq` routes each
   IQ child to the *first* registered handler and offers no unregistration.
   Consequences: every protocol engine that owns IQ handlers is a
   **per-session singleton** acquired by reference count
   (`IbbManager.acquire(session)`, `SipubManager`, `JingleManager`,
   `ChunkRouter` — all follow the same pattern: `WeakMap` keyed by session,
   `#refs` counting, deactivate-by-state on final `release()`), and you can
   run at most **one `HttpxServer` per session** (use another resource or a
   component for a second endpoint).

## Module map

| Path | Responsibility |
|---|---|
| `src/constants.ts` | Every namespace and tunable default (see [Configuration](#configuration-reference)) |
| `src/types.ts` | `HttpMethod`, `HttpxRequestInit`, `StreamAccept`, body-init types |
| `src/errors.ts` | `HttpxError`, `CodecError`, `fromXmppError` (stanza-condition → HTTP-equivalent map) |
| `src/session.ts` | `XmppSession` / `IqContext` interfaces, `bareJid`, `jidDomain`, `generateId` |
| `src/urls.ts` | `httpx://` codec: `parseHttpxUrl`, `formatHttpxUrl`, `resolveHttpxUrl` (browser-style relative resolution) |
| `src/util/` | base64 (pure, whitespace-tolerant), byte/stream helpers (`bytesFromStream`, `limitStream`, `deferredStream`, `iterateStream`), `cloneElement` |
| `src/codec/` | Pure `Element ⇄ struct` functions for `<req>`, `<resp>`, SHIM `<headers>`, `<data>` (the `DataDescriptor` union). Zero I/O; throws `CodecError` on malformed input |
| `src/transport/chunked.ts` | `ChunkedSender`, `ChunkReassembler` (out-of-order buffering), `ChunkRouter` (shared stanza listener with orphan buffering) |
| `src/transport/select.ts` | `selectEncoding` — the one decision table both sides use |
| `src/transport/registry.ts` | `BodyTransport`/`BodyOffer` interfaces + `TransportRegistry` (handshake-driven transports plug in here) |
| `src/transport/default-registry.ts` | Builds the registry with `SipubTransport` + `JingleTransport` |
| `src/ibb/ibb.ts` | Complete XEP-0047 implementation, both directions — the shared data plane |
| `src/sipub/sipub.ts` | XEP-0137 + minimal XEP-0095/0020 control plane over IBB |
| `src/jingle/jingle.ts` | Minimal XEP-0166 + XEP-0234/0261 control plane over IBB |
| `src/discovery.ts` | XEP-0030 advertise/query, `DiscoCache` with XEP-0115 presence learning |
| `src/caps.ts` | XEP-0115 ver hashing (`computeCapsVer`, `buildCapsElement`, `capsVerFromDiscoQuery`) |
| `src/client/` | `HttpxClient`, `HttpxResponse`, `httpxFetch` (WHATWG bridge) |
| `src/server/` | `HttpxServer`, authorization policies (`allowAll`/`allowList`/`denyAll`) |
| `src/node/` | Node-only: `createOriginProxyHandler` reverse proxy (subpath export `xmpp-httpx/node`) |

Subpath exports: `xmpp-httpx`, `./codec`, `./client`, `./server`, `./node` —
ESM only, built with plain `tsc` into `dist/`.

## Request lifecycle

### Client (`HttpxClient.request`, `src/client/client.ts`)

1. **Discovery** (default on): `DiscoCache.supportsHttpx(to)` — answered
   from the XEP-0115 ver cache when the peer announced caps in presence,
   else one disco#info query. Only an explicit feature list *without*
   `urn:xmpp:http` refuses; errors/timeouts proceed optimistically.
2. **Body normalization**: `string | Uint8Array | Element |
   ReadableStream` → a `BodySource`; strings default to
   `text/plain; charset=utf-8`.
3. **Encoding selection**: `selectEncoding` (see below) with
   `preferredStreams` (default `["ibb", "chunkedBase64"]`).
4. **`<req>` construction**: method/resource/version, `maxChunkSize`,
   `sipub`/`ibb`/`jingle` accept attributes (only emitted when `false` —
   the wire default is true), SHIM headers, `<data>` descriptor.
5. **Send + body streaming**: the IQ goes out first; for chunked/IBB request
   bodies the client then streams the body and awaits the IQ result *after*
   (the responder replies only once it has consumed the body — the IQ
   timeout must cover the transfer). sipub/jingle request bodies need no
   post-IQ sending: the server calls back.
6. **Response body**: the IQ result's `<resp>` decodes into an
   `HttpxResponse`; the body stream is wired per descriptor kind
   (see transports). `AbortSignal` covers the whole chain: pre-flight,
   disco, body upload, result wait, and streaming response bodies.

### Server (`HttpxServer.#onReq`, `src/server/server.ts`)

1. **Decode** `<req>`; malformed → IQ `bad-request` error (it never became
   an HTTP request).
2. **Authorize** (`options.authorize`, default deny-all-with-warning) —
   *before* the body is consumed; denial → IQ `forbidden` error.
3. **Request body materialization**: inline → bytes; chunked/IBB/sipub/
   jingle → a lazy `ReadableStream` (the transport handshake runs on first
   read), wrapped in `limitStream(maxRequestBodyBytes)`.
4. **Handler dispatch**: the handler gets `{ from, to, method, resource,
   url, headers, body, accept }` and may return a plain object
   (`{ status, statusMessage, headers, body }`) or a **WHATWG `Response`**
   (which makes reverse-proxying `return fetch(...)`). Thrown handlers → 500.
   An unconsumed request body is cancelled after the handler returns.
5. **Response encoding**: `selectEncoding` against the requester's accept
   flags and `maxChunkSize`. Small streamed bodies with a known
   `Content-Length` are buffered so they can still be inlined.
6. **Reply + streaming**: the `<resp>` IQ result is returned to the callee
   middleware; chunked/IBB body sends are scheduled on a macrotask (so they
   hit the wire *after* the reply), sipub/jingle just wait for the peer's
   handshake, expiring after `ttlMs` (60 s) if unclaimed.

## Body transports

`selectEncoding` (`src/transport/select.ts`) — first match wins:

| # | Condition | Encoding |
|---|---|---|
| 1 | empty body | no `<data>` |
| 2 | XML `Element`, serialized ≤ inline budget | `<xml>` |
| 3 | textual content-type, UTF-8-clean, no XML-illegal control chars, escaped length ≤ budget | `<text>` |
| 4 | base64 length ≤ budget | `<base64>` |
| 5 | first entry of `preferredStreams` the peer's accept flags allow | `<ibb>` / `<chunkedBase64>` / `<sipub>` / `<jingle>` |
| 6 | nothing allowed | HTTP 413 |

Inline budget: 4096 encoded bytes (`inlineBudgetBytes`). Chunk/block size:
`clamp(min(peer maxChunkSize ?? 4096, 8192), 256, 65536)` **decoded** bytes —
after base64 expansion a stanza stays under the 10 KiB floor RFC 6120
guarantees.

### chunkedBase64 (`src/transport/chunked.ts`)

Body arrives in `<message><chunk xmlns='urn:xmpp:http' streamId nr
last?>base64</chunk></message>` stanzas. `ChunkReassembler` buffers
out-of-order chunks (`nr` is 0-based), releases them sequentially, and
errors on duplicates, buffer overflow (1 MiB), or idle timeout (30 s).
`ChunkRouter` is the shared per-session stanza listener routing by
*(bare peer JID, streamId)*; chunks arriving before the expectation is
registered (same-flush races) are parked in a bounded orphan buffer
(512 KiB / 10 s). No acks — pacing is socket backpressure only.

### IBB — XEP-0047 (`src/ibb/ibb.ts`)

The shared data plane. Sending uses IQ-carried `<data seq=…>` exclusively:
each block is acknowledged by an IQ result, giving real flow control — the
receiver *withholds the ack* while its consumer lags (`desiredSize ≤ 0`) —
and error propagation (a failed block rejects the writer). Receiving also
tolerates message-carried data (bounded, no pushback). Unsolicited `<open>`s
are refused, but an unclaimed open is parked ~5 s first because the
announcing stanza and the `<open>` can race the local registration.
Consumer-side cancel sends `<close/>` to the peer.

### sipub — XEP-0137 over XEP-0095 SI (`src/sipub/sipub.ts`)

Control plane only; the sid chain `starting sid = SI id = IBB sid` hands the
data over to `IbbManager` untouched:

```
publisher                                   retriever
   │  <resp><data><sipub id/></data></resp>     │   (inside the httpx IQ)
   │◄———————— IQ-get <start id> ————————————────│
   │────————— result <starting sid> ——————————►│
   │────————— IQ-set SI offer (IBB only) ─————►│   retriever arms
   │◄———————— result (submit form: IBB) ———————│   ibb.expectIncoming first
   │═══════════ plain XEP-0047 IBB ═══════════►│
```

Publications are one-shot, bound to the requesting peer's bare JID, and
expire unclaimed after 60 s.

### jingle — XEP-0166 subset (`src/jingle/jingle.ts`)

The `<jingle action='session-initiate'>` embedded in `<data>` **is** the
initiate (XEP-0332 forces this; a duplicate initiate IQ for a known session
is acked as a hedge). Content = XEP-0234 file-transfer description (echoed
verbatim, never interpreted) + XEP-0261 IBB transport whose sid is again a
plain XEP-0047 sid:

```
initiator                                   responder
   │  <resp><data><jingle session-initiate…>     │  (inside the httpx IQ)
   │◄———— IQ-set jingle session-accept ——————────│  responder arms IBB first,
   │────— result (ack) ————————————————————————►│  may lower block-size
   │═══════════ plain XEP-0047 IBB ════════════►│
   │────— IQ-set session-terminate <success/> —►│
```

A single `iqCallee` handler dispatches on `action`; unknown sessions get
`item-not-found` + `<unknown-session/>`; non-IBB transports are declined.

**Defaults:** sipub/jingle are *opt-in for sending* (list them in
`preferredStreams`) but *always accepted on receive* — `["ibb",
"chunkedBase64"]` remains the sending default because those are the
mechanisms other exploratory implementations are most likely to have.

## Discovery & entity caps

`advertiseHttpx(session)` registers the session's disco#info responder
(identity + `httpxFeatures()` — the full namespace list including SI and
Jingle). It returns `{ identities, features }` so an application can compute
a matching XEP-0115 `ver` with `computeCapsVer` and attach
`buildCapsElement(node, ver)` to its own presence — the library never sends
presence itself.

`DiscoCache` resolves "does this peer speak httpx?" in two layers: a passive
XEP-0115 layer (presence `<c hash='sha-1' ver=…>` maps bare JIDs to a ver;
each distinct ver is verified with **one** disco query whose recomputed hash
must match, then the verdict is shared by every JID announcing it) and an
active per-JID disco query fallback. Errors/timeouts are "unknown" and the
client proceeds — only an explicit feature list lacking `urn:xmpp:http`
refuses.

## Error model

| Failure | Surface |
|---|---|
| HTTP-level error (404, 500, …) | `HttpxResponse` with that `statusCode` — never an exception |
| IQ error `forbidden` / `not-authorized` | `HttpxError("forbidden")`, httpEquivalent 403 |
| IQ error `service-unavailable`, unreachable | `HttpxError("unavailable")`, 502 |
| IQ timeout, stream idle timeout | `HttpxError("timeout")`, 504 |
| Body too large (either direction) | server answers HTTP 413; client throws `payload-too-large` |
| Unsupported `<data>` mechanism | HTTP 501 (server) / `not-implemented` throw (client) |
| Malformed stanza | `CodecError`; server answers IQ `bad-request` |
| Abort | `HttpxError("aborted")`; live streaming bodies error immediately |

The full stanza-condition table lives in `src/errors.ts` (`fromXmppError`).

## Security model

- **Deny-all by default**: a server without an `authorize` option refuses
  every request (with a one-time console warning). `allowAll()`,
  `allowList(["user@dom", "*@dom"])`, or any custom
  `(from, {method, resource, to}) => boolean` plug in. Authorization runs
  *before* the request body is consumed.
- **DoS bounds** (all configurable): request body cap 8 MiB
  (`maxRequestBodyBytes`, enforced on inline and streamed bodies), chunk
  reassembly buffer 1 MiB, orphan buffer 512 KiB, IBB message-mode overflow
  cap, idle timeouts 30 s, offer TTL 60 s.
- **IBB opens must be pre-announced** — an `<open>` whose sid was never
  advertised in a descriptor is refused; sipub starts are one-shot and
  bare-JID-bound; jingle sessions are keyed by (bare peer, sid).
- Connection-management headers are stripped by the origin proxy per
  XEP-0332 §9; XMPP has no persistent-connection semantics.
- Roster-subscription policies (the XEP's "manual"/"provisioned" modes)
  are the application's business — it owns presence.

## Configuration reference

All defaults live in `src/constants.ts`:

| Constant | Value | Meaning |
|---|---|---|
| `DEFAULT_INLINE_BUDGET` | 4096 | max encoded bytes inlined in the IQ |
| `DEFAULT_CHUNK_SIZE` / `SAFE_CHUNK_SIZE_CAP` | 4096 / 8192 | decoded chunk/block bytes |
| `MIN_CHUNK_SIZE` / `MAX_CHUNK_SIZE` | 256 / 65536 | `maxChunkSize` clamp per the XEP |
| `DEFAULT_IQ_TIMEOUT_MS` | 60 000 | request timeout (covers streamed request bodies) |
| `DEFAULT_IDLE_TIMEOUT_MS` | 30 000 | streaming-body idle watchdog |
| `DEFAULT_MAX_BUFFERED_BYTES` | 1 MiB | out-of-order chunk buffer |
| `DEFAULT_MAX_REQUEST_BODY_BYTES` | 8 MiB | server-side body cap |
| `DEFAULT_IBB_BLOCK_SIZE` | 4096 | IBB block size |
| `DEFAULT_IBB_ACCEPT_TIMEOUT_MS` | 5 000 | parked-open/parked-offer window |
| `DEFAULT_OFFER_TTL_MS` | 60 000 | unclaimed sipub/jingle offer expiry |

`HttpxClientOptions`: `defaultTimeoutMs`, `maxChunkSize`, `accept: { ibb?,
sipub?, jingle? }` (all default true), `discover` (true), `inlineBudgetBytes`,
`preferredStreams`, `maxBufferedBytes`, `idleTimeoutMs`, `from` (required for
components).

`HttpxServerOptions`: `authorize`, `inlineBudgetBytes`, `preferredStreams`,
`maxRequestBodyBytes`, `idleTimeoutMs`, `advertise` (true), `onError`.
