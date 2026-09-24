# xmpp-httpx architecture

This document explains how the library is put together: the design rules,
the module map, the full request lifecycle on both sides, how each of the
seven body transports works, and the error and security models. For
*protocol-level* decisions where XEP-0332 is ambiguous, see
[protocol-notes.md](protocol-notes.md); for the test infrastructure, see
[testing.md](testing.md); for the browser, see
[browser-extension.md](browser-extension.md) and
[`examples/webext/`](../examples/webext/).

## Design rules

Five rules shape everything, and the codebase is predictable once you know
them:

1. Session injection. The library never opens XMPP connections. Every
   entry point takes an `XmppSession`, a structural interface
   (`src/session.ts`) satisfied by `@xmpp/client`, `@xmpp/component`, and
   the test mock alike: `{ jid, send, iqCaller, iqCallee,
   on/removeListener("stanza") }`. Connection lifecycle, reconnection, and
   TLS are the application's business.

2. Browser-safe core. Everything outside `src/node/` runs unmodified in
   Node ≥ 20 and evergreen browsers: `Uint8Array` (never `Buffer`),
   `TextEncoder`/`TextDecoder`, a pure lookup-table base64 codec,
   WHATWG `ReadableStream`/`Headers`/`Response`/`AbortSignal`, and
   `crypto.subtle` for hashing. ESLint enforces this (`no-restricted-globals`
   bans `Buffer`, `process`, `window`, … in core files). The whole test
   suite runs in headless Chromium to prove it.

3. One body primitive. Every body (inline, chunked, IBB, sipub, jingle)
   surfaces as a `ReadableStream<Uint8Array>`. That is the one type that
   feeds `new Response(stream)` directly, which is what a browser needs for
   progressive rendering.

4. Errors are layered. HTTP-level failures (404, 500) travel inside
   `<resp statusCode=…>` and come back as *responses*. XMPP-level failures
   (forbidden, timeout, unreachable) are thrown as `HttpxError` with an
   `httpEquivalent` hint. The library never fabricates a fake `HttpxResponse`
   from a transport failure.

5. One handler per (namespace, tag) per session. `@xmpp/iq` routes each
   IQ child to the *first* registered handler and offers no unregistration.
   Two consequences follow. Every protocol engine that owns IQ handlers is a
   per-session singleton acquired by reference count
   (`IbbManager.acquire(session)`, `SipubManager`, `JingleManager` and
   `ChunkRouter` all follow the same pattern: a `WeakMap` keyed by session,
   `#refs` counting, deactivate-by-state on final `release()`), and you can
   run at most one `HttpxServer` per session (use another resource or a
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
| `src/transport/select.ts` | `selectEncoding`, the one decision table both sides use |
| `src/transport/registry.ts` | `BodyTransport`/`BodyOffer` interfaces + `TransportRegistry` (handshake-driven transports plug in here) |
| `src/transport/default-registry.ts` | Builds the registry with `SipubTransport` + `JingleTransport` |
| `src/ibb/ibb.ts` | Complete XEP-0047 implementation, both directions; the shared data plane |
| `src/sipub/sipub.ts` | XEP-0137 + minimal XEP-0095/0020 control plane over IBB |
| `src/jingle/jingle.ts` | Minimal XEP-0166 + XEP-0234/0261 control plane over IBB |
| `src/discovery.ts` | XEP-0030 advertise/query, `DiscoCache` with XEP-0115 presence learning |
| `src/caps.ts` | XEP-0115 ver hashing (`computeCapsVer`, `buildCapsElement`, `capsVerFromDiscoQuery`) |
| `src/client/` | `HttpxClient`, `HttpxResponse`, `httpxFetch` (WHATWG bridge) |
| `src/server/` | `HttpxServer`, authorization policies (`allowAll`/`allowList`/`denyAll`) |
| `src/node/` | Node-only: `createOriginProxyHandler` reverse proxy (subpath export `xmpp-httpx/node`) |

Subpath exports: `xmpp-httpx`, `./codec`, `./client`, `./server`, `./node`.
ESM only, built with plain `tsc` into `dist/`.

## Request lifecycle

### Client (`HttpxClient.request`, `src/client/client.ts`)

1. Discovery (default on): `DiscoCache.supportsHttpx(to)` is answered
   from the XEP-0115 ver cache when the peer announced caps in presence,
   else by one disco#info query. Only an explicit feature list *without*
   `urn:xmpp:http` refuses; errors and timeouts proceed optimistically.
2. Body normalization: `string | Uint8Array | Element |
   ReadableStream` → a `BodySource`; strings default to
   `text/plain; charset=utf-8`.
3. Encoding selection: `selectEncoding` (see below) with
   `preferredStreams` (default `["ibb", "chunkedBase64"]`).
4. `<req>` construction: method/resource/version, `maxChunkSize`,
   `sipub`/`ibb`/`jingle` accept attributes (only emitted when `false`,
   since the wire default is true), SHIM headers, `<data>` descriptor.
5. Send + body streaming: the IQ goes out first; for chunked/IBB request
   bodies the client then streams the body and awaits the IQ result *after*
   (the responder replies only once it has consumed the body, so the IQ
   timeout must cover the transfer). sipub/jingle request bodies need no
   post-IQ sending: the server calls back.
6. Response body: the IQ result's `<resp>` decodes into an
   `HttpxResponse`; the body stream is wired per descriptor kind
   (see transports). `AbortSignal` covers the whole chain: pre-flight,
   disco, body upload, result wait, and streaming response bodies.

### Server (`HttpxServer.#onReq`, `src/server/server.ts`)

1. Decode `<req>`; a malformed one gets an IQ `bad-request` error (it never
   became an HTTP request).
2. Authorize (`options.authorize`, default deny-all-with-warning) *before*
   the body is consumed; denial gets an IQ `forbidden` error.
3. Request body materialization: inline bodies become bytes; chunked/IBB/
   sipub/jingle bodies become a lazy `ReadableStream` (the transport
   handshake runs on first read), wrapped in
   `limitStream(maxRequestBodyBytes)`.
4. Handler dispatch: the handler gets `{ from, to, method, resource,
   url, headers, body, accept }` and may return a plain object
   (`{ status, statusMessage, headers, body }`) or a WHATWG `Response`
   (which makes reverse-proxying `return fetch(...)`). A handler that throws
   produces a 500. An unconsumed request body is cancelled after the handler
   returns.
5. Response encoding: `selectEncoding` against the requester's accept
   flags and `maxChunkSize`. Small streamed bodies with a known
   `Content-Length` are buffered so they can still be inlined.
6. Reply + streaming: the `<resp>` IQ result is returned to the callee
   middleware; chunked/IBB body sends are scheduled on a macrotask (so they
   hit the wire *after* the reply), sipub/jingle just wait for the peer's
   handshake, expiring after `ttlMs` (60 s) if unclaimed.

## Body transports

In `selectEncoding` (`src/transport/select.ts`) the first match wins:

| # | Condition | Encoding |
|---|---|---|
| 1 | empty body | no `<data>` |
| 2 | XML `Element`, serialized ≤ inline budget | `<xml>` |
| 3 | textual content-type, UTF-8-clean, no XML-illegal control chars, escaped length ≤ budget | `<text>` |
| 4 | base64 length ≤ budget | `<base64>` |
| 5 | first entry of `preferredStreams` the peer's accept flags allow | `<ibb>` / `<chunkedBase64>` / `<sipub>` / `<jingle>` |
| 6 | nothing allowed | HTTP 413 |

Inline budget: 4096 encoded bytes (`inlineBudgetBytes`). Chunk/block size:
`clamp(min(peer maxChunkSize ?? 4096, 8192), 256, 65536)` *decoded* bytes,
so that after base64 expansion a stanza stays under the 10 KiB floor RFC
6120 guarantees.

### chunkedBase64 (`src/transport/chunked.ts`)

Body arrives in `<message><chunk xmlns='urn:xmpp:http' streamId nr
last?>base64</chunk></message>` stanzas. `ChunkReassembler` buffers
out-of-order chunks (`nr` is 0-based), releases them sequentially, and
errors on duplicates, buffer overflow (1 MiB), or idle timeout (30 s).
`ChunkRouter` is the shared per-session stanza listener routing by
*(bare peer JID, streamId)*; chunks arriving before the expectation is
registered (same-flush races) are parked in a bounded orphan buffer
(512 KiB / 10 s). There are no acks; pacing is socket backpressure only.

### IBB, XEP-0047 (`src/ibb/ibb.ts`)

The shared data plane. Sending uses IQ-carried `<data seq=…>` exclusively:
each block is acknowledged by an IQ result, which gives real flow control
(the receiver *withholds the ack* while its consumer lags, `desiredSize ≤ 0`)
and error propagation (a failed block rejects the writer). Receiving also
tolerates message-carried data (bounded, no pushback). Unsolicited `<open>`s
are refused, but an unclaimed open is parked ~5 s first because the
announcing stanza and the `<open>` can race the local registration.
Consumer-side cancel sends `<close/>` to the peer.

#### The send window

`window` blocks (default `DEFAULT_IBB_WINDOW` = 8) are in flight at once: the
IQ result of block k is what releases block k+window. Without it the ack is
not just flow control, it is a bandwidth-delay cap — one block per round trip,
4 KiB / 100 ms ≈ 40 KB/s, no matter how fat the pipe.

Four things hold it together, and each has a test that fails without it
(`test/integration/ibb-window.test.ts`):

- **Ordering by construction.** Taking a block from the buffer, base64-ing it,
  assigning its `seq` and handing it to `iqCaller` is one synchronous step.
  Both `@xmpp/connection` and `MockSession` reach their socket write
  synchronously from `request()`, so call order is wire order. The receiver
  tolerates no gaps — a `seq` jump kills the stream — so an `await` inserted
  anywhere in that step would corrupt the body, not merely slow it.
- **Backpressure survives.** `write()` still blocks; it just yields after
  `window` blocks instead of one. A receiver that stops reading stops acking,
  and the sender stops for good rather than after a timeout.
- **Failure is deterministic.** Every in-flight block gets its rejection
  handler at dispatch (nothing is awaiting the other `window-1` promises, and
  an unhandled rejection is fatal on Node ≥ 20), and the failure is latched to
  the *earliest* block in send order: a dead receiver rejects every
  outstanding block at once and each carries its own timeout, so rejection
  order is not send order. `close()` waits for every outstanding ack before it
  sends `<close/>`, so awaiting it still means "delivered".
- **The receiver has the other half of the window.** Its queue holds
  `(receiveWindowBlocks + 1) × block-size`, floored at 64 KiB and capped at
  `DEFAULT_MAX_BUFFERED_BYTES`. One block short of that and the first 64 KiB
  block alone drives `desiredSize` to 0, every ack waits for a consumer read,
  and the sender's window collapses back to one block per round trip. The
  effective in-flight count is the smaller of the two sides' windows, with
  nothing negotiated.

Both idle deadlines had to learn about the window, in opposite directions. A
block's IQ deadline starts when it is *dispatched*, so the last block of a
window has already waited for the whole window to drain before its own ack is
due — it gets `idleTimeoutMs × window`, which is the patience the old sender
gave each block in turn. On the receiving side, a stream withholding acks is
silent on its own instructions, so the ordinary deadline would be measuring
its own decision; but switching the clock off entirely means a consumer that
walks away without cancelling keeps its buffered bytes and every parked
handler for the life of the session. The clock is stretched instead:
`idleTimeoutMs × (receiveWindowBlocks + 1)` while an ack is withheld.

#### The session scheduler

A window per stream makes a single transfer fast and makes many transfers
unfair: every stream holds `window` blocks at once, they all land in the one
XMPP connection's send queue, and a small page's first block waits behind
every large download's full window. So the manager — one per session — also
keeps a budget for all its streams together, `sendWindowBlocks`
(`DEFAULT_IBB_SESSION_WINDOW` = 16, twice a stream's default window, so a
stream alone at the default window runs exactly as fast as before; a stream
configured with a window above the budget is capped by it). A block needs a
slot in both.

When the budget is full, a stream that wants to send joins a queue. A settled
block (acked or failed) frees its slot, and the slot is *granted* to the
stream at the head of the queue: reserved for it, counted as in use, and
consumed by that stream's pump when it next runs — so no other stream can
take it in between, and the grant, the take, the encoding and the send stay
separate from one another only by the wait for the pump, never by an `await`
inside the synchronous step. A stream that wants more asks again and goes to
the back. That is the whole round-robin: one block per stream per turn. A
stream that no longer wants its turn (drained, failed, closed, its own window
full) is dropped from the queue and woken anyway, so a pump parked on it
re-evaluates rather than waiting forever; grants a pump will not use are
given back when it exits. Fairness is by blocks, not bytes: streams on one
session normally share a block size (it comes from the same stanza budget),
and byte-fair deficit round-robin is the next step if they stop doing so.

A slot is *not* held until the ack. The budget bounds what waits in the
connection's send queue, and a block the receiver is deliberately not acking
(its consumer is not reading) is not waiting there. The first version counted
it anyway, and review found the result: two stalled streams at the default
window held all 16 slots, and every other stream on the session — on a
server, every other client — froze until those blocks' IQ deadlines, minutes
later. So a block that has gone unanswered for `max(parkFloorMs, 4 × smoothed
ack latency)` (floor 250 ms; latency smoothed as TCP smooths RTT, from acks
of blocks that were still counted) is *parked*: it stops counting, and its
stream's own window is what still holds it. On a congested link every ack is
slow, the threshold grows with them, and nothing is parked; with a stalled
consumer only that stream's blocks age past it. While streams wait, a timer
fires when the oldest counted block would turn parked, since nothing else
would free a slot. Nothing is parked before the session has timed one ack,
so a link slower than the floor does not start with a burst.
Tests: `test/integration/ibb-fair.test.ts`.

Block size is the requester's call, since it is the requester's stanza limit
that has to carry the base64: it comes from `<req maxChunkSize=…>`, which
`stanzaBudgets(maxStanzaBytes)` derives from a known server limit. 64 KiB
blocks need `maxStanzaBytes ≈ 88 KiB` (base64 is 4/3, plus envelope), which
the Prosody used in the e2e suite allows at 256 KiB per c2s stanza.
`ibbBlockSize` on the server only ever lowers what was asked for; on the
client it is the size used for *request* bodies, where XEP-0332 gives the
responder no way to advertise a limit at all.

#### Throughput

`test/bench/ibb-window.bench.ts` (mock pair, `deliverHook` holding each
stanza for RTT/2) and `npm run bench:prosody` (real server, loopback).

First the latency question, since that is what the window is for. A 1 MiB
body throughout, so every row is the same work (mean of the bench's samples;
`window 1` is the pre-window sender, measured on the commit before this one):

| Path | Block | Window | Time | Throughput | vs. baseline |
|---|---|---|---|---|---|
| 100 ms RTT | 4 KiB | 1 | 26 060 ms | **40.2 KB/s** | 1× (the baseline) |
| 100 ms RTT | 64 KiB | 1 | 1 887 ms | 555 KB/s | 13.8× |
| 100 ms RTT | 64 KiB | 8 | 435 ms | **2.41 MB/s** | **59.9×** |
| 100 ms RTT | 64 KiB | 16 | 334 ms | 3.14 MB/s | 78.1× |
| loopback | 4 KiB | 1 | 24.3 ms | 43.1 MB/s | — |
| loopback | 4 KiB | 8 | 23.9 ms | 43.9 MB/s | — |
| loopback | 64 KiB | 1 | 25.5 ms | 41.1 MB/s | — |
| loopback | 64 KiB | 8 | 22.3 ms | 47.0 MB/s | — |

At 8 MiB, where the three fixed round trips (request, `<open>`, `<close>`) no
longer dominate, the 100 ms path reaches 4.40 MB/s at window 8 and 7.75 MB/s at
window 16. There is no window-1 row for that size: it would need ~3.5 minutes
for a single sample.

The 40.2 KB/s baseline is not a coincidence — it is 4096 bytes per 100 ms round
trip, which is what "one block, one RTT" means arithmetically.

The shape to read off it: at loopback latency neither knob matters much —
everything is within noise of ~45 MB/s, because base64 and framing are the
cost and there are no round trips to save. At 100 ms the window is nearly
everything, because round trips, not bytes, are the budget. Which is the
point: the old sender's ceiling had nothing to do with the link.

Over a real Prosody (`npm run bench:prosody`, everything crossing the server,
both endpoints on loopback so latency is sub-millisecond), with the defaults —
window 8, and the block size the requester's `maxChunkSize` allows:

| Body | `ibb` via server | `chunkedBase64` via server | sipub + SOCKS5 (direct TCP) |
|---|---|---|---|
| 64 KiB | 0.50 MB/s | 1.45 MB/s | 0.76 MB/s |
| 1 MiB | 4.36 MB/s | 11.7 MB/s | 12.2 MB/s |
| 8 MiB | **9.17 MB/s** | 7.65 MB/s | 92.4 MB/s |

IBB now overtakes `chunkedBase64` at 8 MiB, which it never did before: the
acks used to cost a round trip each, and at loopback latency that was still
enough to lose to a mechanism with no acks at all. It stays behind on small
bodies, where the `<open>`/`<close>` handshake is most of the transfer, and far
behind the SOCKS5 paths, which is the whole point of XEP-0065 — those bytes
never touch the server.

One interaction worth knowing about on a real connection: `@xmpp/client`
enables XEP-0198 stream management, which retains every outbound stanza until
the server acks it and resets its 250 ms ack-request debounce on each new
stanza. A saturated sender therefore never pauses long enough to ask for an
ack, and the retained queue grows with the transfer rather than with the
window. That is not new — an unwindowed sender at loopback latency sends far
more often than every 250 ms — but a large window makes it easier to reach.

### sipub, XEP-0137 over XEP-0095 SI (`src/sipub/sipub.ts`)

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

#### SOCKS5 Bytestreams, XEP-0065 (`src/socks5/protocol.ts`, `src/node/socks5.ts`)

An optional, Node-only stream-method *inside* sipub's SI negotiation. It is
invisible at the `DataDescriptor` level (still `{kind: "sipub", id}`) and
only enabled when a `Socks5Adapter` is passed as `socks5` to `HttpxClient`/
`HttpxServer`. Raw TCP sockets mean this can never run in a browser, so the
adapter lives behind the `xmpp-httpx/node` subpath export
(`createSocks5Adapter`); `src/sipub/sipub.ts` only depends on the universal
`Socks5Adapter` interface.

Role mapping onto sipub's existing split: publisher = Sender = XEP-0065
"Requester" (offers streamhost candidates, writes bytes once established,
sends `<activate>` to a proxy candidate); retriever = Receiver = "Target"
(tries candidates in order as a SOCKS5 client, replies `streamhost-used`,
reads bytes). A candidate is either an external SOCKS5 proxy component
(caller-configured `proxyJid`/`proxyHost`/`proxyPort`, needed for NAT
traversal) or the publisher itself, self-hosting a streamhost via a local
`net.Server` (`listen`).

```
publisher (Requester)                       retriever (Target)
   │  SI offer: stream-method [bytestreams, ibb]   │
   │◄————————— accept: chooses bytestreams ————————│  arms IBB expectIncoming
   │                                                │  AND a bytestreams-query
   │                                                │  listener, same sid
   │────— IQ-set <query><streamhost…/></query> ———►│  tries each candidate
   │◄————————— result <streamhost-used/> ——————————│
   │ (if proxy) IQ-set <activate> to the proxy      │
   │═══════════ raw TCP, SOCKS5-framed ════════════►│
```

The IBB fallback is keyed by the shared sid. If the candidate query IQ
comes back as an error (every candidate connection failed) or the local
connection/activation attempt throws, the publisher catches it and falls
straight through to the *same* `IbbManager.openOutgoing(to, {sid, ...})`
call already used for the plain-IBB case. No renegotiation is needed: the
retriever already armed an `ibb.expectIncoming(from, sid)` in parallel with
the bytestreams attempt (before replying to the SI offer), so whichever
transport the publisher actually drives wins the race.

XEP-0260 (Jingle SOCKS5 Bytestreams) is deliberately out of scope this
round. It needs real transport candidate negotiation
(`transport-info`/`candidate-used`/`candidate-error`/`transport-replace`)
that the current minimal `JingleManager` doesn't support: it skips
candidate exchange entirely and jumps straight to a single embedded
session-initiate. Jingle bodies still use IBB only; see
[ROADMAP.md](ROADMAP.md).

### jingle, XEP-0166 subset (`src/jingle/jingle.ts`)

The `<jingle action='session-initiate'>` embedded in `<data>` *is* the
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

By default, sipub/jingle are *opt-in for sending* (list them in
`preferredStreams`) but *always accepted on receive*. `["ibb",
"chunkedBase64"]` remains the sending default because those are the
mechanisms other exploratory implementations are most likely to have.

## Discovery & entity caps

`advertiseHttpx(session)` registers the session's disco#info responder
(identity + `httpxFeatures()`, the full namespace list including SI and
Jingle). It returns `{ identities, features }` so an application can compute
a matching XEP-0115 `ver` with `computeCapsVer` and attach
`buildCapsElement(node, ver)` to its own presence; the library never sends
presence itself.

`DiscoCache` resolves "does this peer speak httpx?" in two layers: a passive
XEP-0115 layer (presence `<c hash='sha-1' ver=…>` maps bare JIDs to a ver;
each distinct ver is verified with *one* disco query whose recomputed hash
must match, then the verdict is shared by every JID announcing it) and an
active per-JID disco query fallback. Errors and timeouts count as "unknown"
and the client proceeds; only an explicit feature list lacking
`urn:xmpp:http` refuses.

## Error model

| Failure | Surface |
|---|---|
| HTTP-level error (404, 500, …) | `HttpxResponse` with that `statusCode`, never an exception |
| IQ error `forbidden` / `not-authorized` | `HttpxError("forbidden")`, httpEquivalent 403 |
| IQ error `service-unavailable`, unreachable | `HttpxError("unavailable")`, 502 |
| IQ timeout, stream idle timeout | `HttpxError("timeout")`, 504 |
| Body too large (either direction) | server answers HTTP 413; client throws `payload-too-large` |
| Unsupported `<data>` mechanism | HTTP 501 (server) / `not-implemented` throw (client) |
| Malformed stanza | `CodecError`; server answers IQ `bad-request` |
| Abort | `HttpxError("aborted")`; live streaming bodies error immediately |

The full stanza-condition table lives in `src/errors.ts` (`fromXmppError`).

## Security model

- Deny-all by default: a server without an `authorize` option refuses
  every request (with a one-time console warning). `allowAll()`,
  `allowList(["user@dom", "*@dom"])`, or any custom
  `(from, {method, resource, to}) => boolean` plug in. Authorization runs
  *before* the request body is consumed.
- DoS bounds (all configurable): request body cap 8 MiB
  (`maxRequestBodyBytes`, enforced on inline and streamed bodies), chunk
  reassembly buffer 1 MiB, orphan buffer 512 KiB, IBB message-mode overflow
  cap, idle timeouts 30 s, offer TTL 60 s.
- IBB opens must be pre-announced: an `<open>` whose sid was never
  advertised in a descriptor is refused; sipub starts are one-shot and
  bare-JID-bound; jingle sessions are keyed by (bare peer, sid).
- Connection-management headers are stripped by the origin proxy per
  XEP-0332 §9; XMPP has no persistent-connection semantics.
- Policy helpers cover the XEP's modes without the library owning presence:
  `allowAll`/`allowList` (public/private), `presencePolicy(session)` (allow
  currently-available JIDs; roster-driven in practice, since availability
  implies subscription), and `manualPolicy(prompt)` (application-supplied
  approval with per-JID TTL caching). "Provisioned" (XEP-0324) remains out
  of scope.

### Authentication

httpx needs no cookies or Basic auth: the `from` JID is the identity,
authenticated by the XMPP server via SASL before any stanza is routed. The
`authorize` hook receives it; gateways forward it to the origin as the
`X-Httpx-From` header (full JID; configurable via the origin proxy's
`jidHeader` option) alongside `X-Forwarded-For` (bare JID). An origin
behind the gateway can trust these the way it would trust a reverse proxy's
auth headers, provided it only accepts them from the gateway. XEP-0348
("Signing Forms") was evaluated and does not map onto httpx request
authentication; per-request signatures would need a new profile (raised in
the implementation-experience report for the XSF).

### Content-Encoding

Bodies pay a 33% base64 tax, so compression matters more than on plain
HTTP: a gzipped HTML page routinely turns a multi-stanza chunked stream
into a single inline `<resp>`. The client advertises
`Accept-Encoding: gzip, deflate` (disable with `compress: false`) and
transparently decompresses responses, consuming the `Content-Encoding`
header; unknown codings (e.g. `br` set by a handler) pass through untouched.
The server compresses compressible content types when the requester
advertised support: byte bodies eagerly (keeping the result only if
smaller, and skipping bodies under 256 bytes), streams lazily. It
symmetrically decompresses pre-encoded *request* bodies for the handler,
with a post-decompression size cap against zip bombs. Requests are never
auto-compressed (the XEP gives no channel to learn the responder's support
first); callers may pre-compress and set `Content-Encoding` themselves.

## Sessions, reconnection, and stream lifetimes

The library deliberately does not manage connections, so its behavior under
connection loss follows from the session abstraction:

- In-flight IQs (requests, IBB blocks) reject via timeout when the
  transport dies; `fromXmppError` maps them to `HttpxError("timeout")`.
- In-flight streaming bodies are killed by their idle watchdogs
  (default 30 s, tunable per client/server via `idleTimeoutMs`), so a dead
  link mid-chunk-stream surfaces as a `timeout` error on the body stream,
  never as a silent truncation (tested in `test/integration/abort.test.ts`).
- @xmpp/client auto-reconnect reuses the same entity object, so the
  per-session singletons (routers, managers) and their registered handlers
  survive a reconnect; new requests work immediately. Bodies that were
  mid-flight at the drop are *not* resumed: HTTP semantics offer no way to
  splice a half-transferred body, so they error and the caller retries.
- XEP-0198 stream resumption is transparent when the XMPP library
  performs it (same session object, stanzas replayed by the server); a
  *new* login (new resource) is a new session, so construct fresh
  `HttpxClient`/`HttpxServer` instances for it and `close()`/`stop()` the
  old ones to release listeners.
- Budgets can be adapted to a server's real stanza-size limit (the 10 KiB
  default is only the RFC 6120 floor): spread
  `stanzaBudgets(maxStanzaBytes)` into client/server options, or let
  `applyStreamLimits(entity, clientOrServer)` do it from the XEP-0478
  stream-limits advertisement: it watches the stream features (install it
  before `entity.start()`) and calls `setStanzaBudgets()` on every
  announcement, since the limit may change after authentication and on a
  reconnect.

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
| `DEFAULT_IBB_WINDOW` / `MAX_IBB_WINDOW` | 8 / 256 | IBB blocks in flight, each way |
| `DEFAULT_IBB_ACCEPT_TIMEOUT_MS` | 5 000 | parked-open/parked-offer window |
| `DEFAULT_OFFER_TTL_MS` | 60 000 | unclaimed sipub/jingle offer expiry |
| `DEFAULT_SOCKS5_CONNECT_TIMEOUT_MS` | 10 000 | SOCKS5 candidate connect attempt |

`HttpxClientOptions`: `defaultTimeoutMs`, `maxChunkSize`, `accept: { ibb?,
sipub?, jingle? }` (all default true), `discover` (true), `inlineBudgetBytes`,
`preferredStreams`, `maxBufferedBytes`, `idleTimeoutMs`, `ibbWindow` (8),
`ibbSessionWindow` (16, all streams on the session together),
`ibbBlockSize` (request bodies only), `from` (required for components),
`socks5` (Node-only, see `createSocks5Adapter` in `xmpp-httpx/node`).

`HttpxServerOptions`: `authorize`, `inlineBudgetBytes`, `preferredStreams`,
`maxRequestBodyBytes`, `idleTimeoutMs`, `ibbWindow` (8), `ibbSessionWindow`
(16), `ibbBlockSize` (a cap on what the requester asked for), `advertise`
(true), `tunnels` (false; CONNECT and `urn:xmpp:http:connect:0`), `onError`, `socks5`
(same as above).
