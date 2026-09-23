# Protocol notes: XEP-0332 interpretations

XEP-0332 v0.5.1 is Deferred and thin in places. Where the spec is ambiguous
or silent, this library decides unilaterally; every such decision is recorded
here so future interop work can trace behavior back to a deliberate choice
rather than an accident.

## Chunked transport (`chunkedBase64`)

- `nr` is 0-based, per the XEP's examples (`nr='0'` first).
- Chunks may arrive out of order; the receiver buffers gaps up to
  `maxBufferedBytes` (default 1 MiB) and errors beyond that.
- There is no per-chunk loss signaling; a lost chunk manifests only as
  an idle timeout (default 30 s). This is inherent to the mechanism.
- An empty body is one empty chunk with `last='true'` (the receiver needs
  a `last` marker to complete; the spec never shows an empty stream).
- Chunk messages are keyed by (bare peer JID, streamId).
- `maxChunkSize` is interpreted as decoded bytes per chunk (the spec does
  not say whether it counts raw or base64 bytes). We voluntarily cap our own
  chunks at 8192 decoded bytes so each stanza stays well under the 10 KiB
  stanza-size floor of RFC 6120 after base64 expansion (~1.37×).

## Methods and request targets

- **`CONNECT` is added to the method list**, which XEP-0332 v0.5.1 does not
  have: its `method` enumeration stops at `PATCH`, mirroring RFC 2616 minus
  `CONNECT`. A tunnel cannot be asked for without it, and a private method
  name would be a larger deviation than the name HTTP already uses. A peer
  that does not implement it answers `501`, which is what RFC 9110 §15.6.2
  prescribes for a method a server does not implement; XEP-0332 itself is
  silent on unsupported methods (a schema-validating peer would answer an IQ
  `bad-request` instead). Either way the deviation costs nothing on the wire
  against an implementation that has never heard of it, and `connect()` does
  not send it to a peer whose disco lacks the feature in the first place.
- `resource` accepts all four RFC 9112 §3.2 request-target forms, not only
  the origin-form (`/index.html?x=1`) the XEP shows: `*` as before,
  authority-form (`example.org:443`) and absolute-form
  (`https://example.org/x`). Origin-form decoding is unchanged — anything
  starting with `/` is accepted exactly as it was.
- Authority-form is refused for every method except `CONNECT`, per RFC 9112
  §3.2.3. The XEP is silent, but a `GET` whose resource is `example.org:443`
  hands a handler something that reads like a path and names a host, which is
  the one confusion a proxy cannot afford.
- Authority-form is deliberately stricter than a URL parser: no userinfo, no
  path, no query, and a port in 1–65535 is required. `evil.org:80/../admin`
  and `user@evil.org:80` are rejected rather than reinterpreted.
- `HttpxServerRequest.url` is the reconstructed `httpx://` URL for
  origin-form and `*`. For absolute-form and authority-form — which already
  name their own target — it is the `resource` verbatim.

## IBB (XEP-0047)

- We send data exclusively as IQ stanzas: the per-block IQ ack gives flow
  control (the receiver withholds acks while its consumer lags) and error
  propagation. We accept message-carried data for interop leniency.
- **Several blocks are in flight at once** (default 8): the IQ result of block
  k releases block k+window. XEP-0047 neither requires nor forbids this — it
  says the sender "SHOULD" wait for the ack before sending the next block
  under §2.2's error handling, but the sequencing rule it actually imposes is
  on `seq`, which we still assign and send in strict order. One block per
  round trip is a protocol-level bandwidth-delay cap (4 KiB / 100 ms ≈
  40 KB/s) with nothing to show for it: the acks remain exactly as
  meaningful, there are simply several outstanding. `window: 1` restores the
  old behaviour.
- The receiver's buffer is the other half of the window. It holds
  `(receiveWindowBlocks + 1) × block-size` (at least 64 KiB, at most 1 MiB)
  before it starts withholding acks, so the effective number of blocks in
  flight is the smaller of the two sides' windows — with nothing negotiated,
  because a full receiver simply stops acking.
- Both idle deadlines scale with the window. A block's IQ deadline is
  `idleTimeoutMs × window`, because it starts at dispatch and the last block of
  a window waits for the whole window to drain. A receiver withholding acks
  measures `idleTimeoutMs × (receiveWindowBlocks + 1)` instead of the plain
  one, because it is itself the reason nothing is arriving — stretched rather
  than stopped, so a consumer that walks away without cancelling is still
  reaped instead of holding the stream for the session.
- **One budget per session.** Besides its own window, every sending stream
  on a session draws from a shared budget of blocks in flight
  (`sendWindowBlocks`, default 16). When it is full, freed slots go to the
  waiting streams in turn, one block each. A block the receiver has left
  unanswered for `max(250 ms, 4 × ack latency)` is taken to be parked there
  and stops counting, so a peer that withholds acks cannot freeze the other
  streams. Nothing changes on the wire; this only decides whose block is
  next.
- A block whose IQ fails closes the stream with that block's error, latched to
  the earliest block in send order — a dead receiver rejects every
  outstanding block at once and rejection order is not send order.
- Unsolicited `<open>`s are refused with `<not-acceptable/>`, but an
  unclaimed open is parked ~5 s first (the IQ reply is withheld), because the
  announcing `<resp>`/`<req>` and the `<open>` can be dispatched in the same
  event-loop turn and race the local registration.
- A premature `<close/>` is indistinguishable from a complete one at the
  protocol level; consumers that need integrity should compare against
  `Content-Length`.
- **Idle watchdogs are per stream.** A stream carries its own idle timeout
  (or `false`); unset, it reads the manager's `idleTimeoutMs` as it always
  did. `false` turns off every timer that fires on *absence of traffic* — the
  inbound idle timer and the stretched deadline of a receiver withholding
  acks — and is the default for a duplex. The sender's per-block ack deadline
  is not an idle timer and stays: it runs only while this side has bytes
  outstanding, and a peer that holds them unanswered for `idleTimeoutMs ×
  window` is stuck, not idle. (A peer that disconnects is noticed sooner:
  its server bounces the IQs.)

### Duplex streams (CONNECT tunnels)

- One IBB session is used in **both directions**: the opener's sid, the
  opener's `block-size` for both senders, and one `seq` counter per
  direction, each starting at 0. XEP-0047 never forbids the responder sending
  `<data/>` on the sid, and its `seq` rule is per sender; nothing new goes on
  the wire. Only the opener sends `<open/>` — the acceptor adopts the sid.
- The opener registers its inbound half **before** its `<open/>` leaves, so
  the acceptor may send the moment it accepts, even before the opener has
  seen the `<open/>`'s result.
- **No half-close.** Either side's `<close/>` ends both directions: the peer's
  reader ends cleanly, its later `write()`s reject ("closed by peer"), and
  its `close()` resolves without sending a second `<close/>`. Bytes the peer
  still had in flight when ours arrived are acked and dropped. TLS never
  half-closes and SSH tolerates it (design §4.2). Cancelling the reader is an
  abort, since nobody is left to read the answer.
- **Crossing `<close/>`s.** Both sides may close at once. The side that sends
  `<close/>` keeps its inbound entry as a tombstone — finished, answering —
  until its own `<close/>` is answered; the peer's `<close/>` then gets a
  result instead of `item-not-found`, and both `close()` calls succeed. The
  peer's crossing `<close/>` always reaches us before its answer to ours, so
  "the peer closed first" is known by the time our `<close/>` settles.
- **Every teardown tells the peer.** A plain sender that fails stays silent
  until it is next written or closed, and the peer's watchdog reaps its half.
  A duplex has neither to rely on, so a refused block ends both halves at
  once and sends `<close/>`, best effort. So does an `<open/>` that timed
  out, since the peer may have accepted it. `abort()` during a draining
  `close()` stops that close's pump before its `<close/>`, so no `<data/>`
  ever follows one; a second `close()` joins the first.
- **A receiver refuses before it closes.** A duplex that finds a fatal error
  in an inbound block (a `seq` gap, bad base64) answers the block with its
  IQ error first and tears down on the next macrotask; otherwise its
  `<close/>` would overtake the refusal and the sender would take its refused
  block for an ordinary post-close discard. The sender, for its part, only
  forgives `item-not-found` after a peer `<close/>`.
- A numeric idle timeout on a duplex counts silence in both directions: acks
  for our own blocks re-arm it, so an upload with nothing coming back is not
  idle.
- **Writes are flushed.** A body sender holds a sub-block tail until the next
  write or `close()`; a duplex sends it at once. A tunnel is interactive — a
  500-byte ClientHello is followed by nothing until the ServerHello — so a
  held tail is a deadlock. Coalescing is kept where it is free: bytes written
  while the window is full leave in full blocks.
- **CONNECT is opt-in on the server** (`tunnels: true`), which also
  advertises `urn:xmpp:http:connect:0`. Without it CONNECT is answered 501
  before the handler runs — XEP-0332's answer to an unsupported method — so a
  handler written for GET and POST never sees one.
- **CONNECT on the server.** The handler decides the status. A 2xx whose
  handler result carries `tunnel` becomes `<resp statusCode='200'
  statusMessage='Connection Established'>` with `<data><ibb sid/></data>`,
  and the server opens that sid as a duplex once the reply has gone. Any
  other answer is an ordinary response (typically 403/502/504) and `tunnel`
  is never called. A `CONNECT` carrying `<data>` is answered 400 (RFC 9110
  §9.3.6: no content); one with `ibb='false'` is answered 501 before the
  handler runs, because a tunnel is one IBB stream and there is no point
  dialling a destination for a requester that refuses it. `tunnel` on any
  other method is a handler bug, answered 500. If the stream cannot be
  opened, `tunnel` is still called — with a tunnel that is already dead — so
  the handler's ordinary error path is where it closes the destination.
- **CONNECT on the client** refuses a peer whose disco lists no
  `urn:xmpp:http:connect:0` (design §4.4), before sending anything; as
  everywhere, no usable disco answer means "unknown" and it goes ahead.
- **One wire form for now** (decided 2026-09-22): `<req method='CONNECT'>`,
  as a revised XEP-0332 would carry it. The companion `<connect
  xmlns='urn:xmpp:http:connect:0' host port/>` of design §4.2 is not
  implemented: its shape is still a draft, and both the API (`connect()`,
  and a handler seeing `method` CONNECT with an authority-form `resource`)
  and the feature namespace are already wire-agnostic, so adding it later
  is a decoder plus a disco-driven choice, not a change for callers.
- **CONNECT on the client** is `HttpxClient.connect()`, not `request()`: the
  answer is a stream in both directions and `request()` can only return a
  body. It sends `sipub='false' jingle='false'` (and `ibb` at its default,
  true). A 2xx without an IBB stream is a protocol error rather than a silent
  dead pipe — and the server never sends one: a 2xx answer to `CONNECT`
  without a `tunnel` callback is a handler bug, answered 500.
- **Liveness is the application's.** With the watchdog off, an exit does not
  notice a requester that vanishes while its tunnel is idle — no traffic, no
  outstanding acks, no `<close/>`. Its server bounces the next IQ once there
  is one; until then, presence or XEP-0199 is how an exit finds out, and that
  is n146's job, not this library's (design §4.2). A tunnel with bytes in
  flight is bounded by the sender's ack deadline, `idleTimeoutMs × window`.

## sipub (XEP-0137 over XEP-0095 SI)

- Only the IBB stream method is offered and accepted; a received SI
  offer without `http://jabber.org/protocol/ibb` among its stream-method
  options is refused with `<no-valid-streams/>`.
- The sid chain is `<starting sid>` = SI `id` = XEP-0047 sid: one
  identifier from handshake to data plane.
- Each publication is one-shot and bound to the requesting peer's bare
  JID (XEP-0137 anticipates third-party/multi-consumer starts; for httpx
  that would leak response bodies). A second `<start>`, or one from another
  JID, is refused (`not-acceptable` / `forbidden`).
- Unclaimed publications expire after 60 s (`DEFAULT_OFFER_TTL_MS`).
- `<file size='0'>` when the body length is unknown; `size` is never
  trusted on receive (the IBB `<close/>` terminates the body).
- XEP-0137's own examples are internally inconsistent (start id as
  attribute vs text); we follow Example 7 (attribute) strictly.

## jingle (XEP-0166 subset)

- The `<jingle action='session-initiate'>` embedded in `<data>` is the
  session-initiate: no separate initiate IQ is sent, and it receives no
  Jingle-level ack (the httpx IQ result carries it). This deviation is
  forced by XEP-0332's design. As a hedge, a duplicate initiate IQ bearing
  a known session id is acked.
- Content is XEP-0234 `file-transfer:5` description + XEP-0261 IBB
  transport only. The description is echoed verbatim and never
  interpreted on receive (XEP-0332's own example embeds an RTP session
  that cannot carry an HTTP body). Offers with a non-IBB transport are
  declined via `session-terminate <decline/>`.
- The XEP-0261 transport sid is a plain XEP-0047 sid; the responder may
  lower `block-size` in session-accept but must echo the sid unchanged.
- XEP-0234's mandatory `<hash/>`/`<hash-used/>` is omitted (streams cannot
  be hashed up front); receivers must not require it.
- Unknown-session jingle IQs get `item-not-found` + `<unknown-session/>`;
  `session-info`/`transport-info` on known sessions are acked and ignored.

### S5B candidate negotiation (XEP-0260)

`src/socks5/jingle-s5b.ts` holds the wire format and the negotiation arithmetic;
`src/jingle/s5b-negotiation.ts` holds the per-session waiting; `JingleManager`
drives both. It runs when the caller supplies a `Socks5Adapter` (Node only) and
falls back to IBB otherwise. Deviations and interpretations, in the order they
bite:

- The initiate carries no candidates. XEP-0332 embeds the session-initiate
  in `<data>`, and that element is built synchronously while gathering
  candidates (and hashing `dstaddr`) is asynchronous. So the initiate offers a
  bare `<transport sid mode='tcp'/>` and the candidates follow in a
  `transport-info`, which §2.3 provides for. A peer that expects candidates in
  the initiate will simply see none and report `<candidate-error/>`, which is
  handled.
- `dstaddr` is informational here. It is sent with the candidates when
  known, and its absence is not fatal: both parties can derive
  SHA-1(sid + initiator + responder) themselves, and the SOCKS5 adapter does
  exactly that rather than trusting the wire value.
- The negotiation is symmetric. Both parties offer whatever streamhosts
  their adapter can produce, both dial the other's, and `resolve()` arbitrates,
  so a sender that cannot host (behind NAT) can still deliver a body by dialling
  out to a candidate the receiver hosts. That direction needs both ends of a
  SOCKS5 connection, which is why `Socks5Adapter` hands back a duplex from both
  `connect()` and `openChosen()` rather than a single direction each.
- Whoever offered the winning candidate takes it up (`openChosen`) and, for a
  proxy, activates it and sends `<activated cid=…/>`; the dialling side waits for
  that before using the stream. The XEP-0065 `<activate/>` names the party that
  dialled the proxy, which flips with the role, so it is passed separately from
  the two context JIDs. Those must stay fixed because they are what `dstaddr` is
  hashed from and both sides have to agree on it.
- The losing connection is closed. Both peers may dial each other before the
  winner is known; the duplex that lost is aborted and cancelled rather than left
  open.
- A winning proxy candidate is activated by its offerer, which is always the
  initiator here: the adapter's `openOutgoing` sends the XEP-0065 `<activate/>`
  IQ to the proxy, and the initiator then sends `<activated cid=…/>` so the
  responder knows it may read. The responder waits for that before handing the
  body stream to its caller, because a proxy relays nothing until activated.
- Fallback is `transport-replace` with an IBB transport, and the two sides
  hand over carefully: the responder arms its IBB receiver before answering
  with `transport-accept`, and the initiator does not write a byte until that
  accept arrives. Otherwise the first block would land on nothing.
- A receiver with no adapter at all (a browser) accepts an s5b offer, reports
  `<candidate-error/>` immediately, and receives the body over the replacement
  IBB transport. Refusing the session outright would have been the easier path
  and the worse one.

The interpretations the protocol layer commits to, which an interoperating
implementation has to agree with:

- Tie-breaking is the ambiguity that matters. §2.4 says that when both
  parties send `<candidate-used/>` with equal priority, "the candidate offered by
  the initiator is used". A party always reports a candidate from its peer's
  list, so the initiator-offered candidate is the one the responder reported.
  That is the reading implemented, and both viewpoints of the same negotiation
  provably pick the same candidate (there is a test asserting exactly that). Read
  the other way, the two sides would each pick the other's candidate and the
  transfer would deadlock, which is why this is written down rather than left to
  the reader.
- `mode='udp'` is refused, not downgraded. The schema allows it; nothing in
  XEP-0260 says how to use it, and silently treating it as `tcp` would be a
  worse failure than a clear one.
- Duplicate candidate `cid`s are refused at parse time: `<candidate-used/>`
  names a cid, so duplicates would make the report ambiguous.
- A missing `type` defaults to `direct`, matching the schema's default, and
  an unknown type is refused rather than assigned a priority.
- Priority is `2^16 × type-preference + local-preference` with the XEP's
  recommended preferences (direct 126, assisted 120, tunnel 110, proxy 10), so a
  proxy can never outrank a direct candidate no matter the local preference.
- `dstaddr` is SHA-1(sid + initiator full JID + responder full JID): the
  XEP-0065 §5.3.1 construction with the Jingle roles supplying the JIDs, which is
  why the existing `computeDomain()` is reused.

## Response bodies of unknown length

- A handler body with a valid `Content-Length` (RFC 9110 `1*DIGIT`, or a list
  of identical values) that fits the inline budget is buffered and inlined;
  anything else is streamed as it arrives. With no length it is *not* read
  ahead: an endless or trickled body starts flowing at once.
- If no stream mechanism is open to the requester (its accept flags and our
  `preferredStreams` share nothing), a length-less body is read up to the
  inline budget and no further: inlined if it ended by then, otherwise
  cancelled and answered 413.
- A streamed body of unknown length is offered over sipub/jingle with
  `size='0'`, as those notes already say. The origin proxy and the static
  handler both pass a length when they have one, so this is rare in practice.

## Request bodies

- The `sipub`/`ibb`/`jingle` attributes of `<req>` describe what the
  requester accepts for the response. The XEP provides no negotiation for
  request bodies; we send small bodies inline and stream large ones via
  IBB (default preference) or chunked messages. The sipub and jingle
  mechanisms are opt-in for sending (`preferredStreams`) but always accepted
  on receive.
- The responder replies to the `<req>` IQ after consuming a streamed
  request body, so the client's IQ timeout must cover the entire body
  transfer (default 60 s; override per request).

## Errors

- HTTP-level failures travel as `statusCode` in `<resp>` (a 404 is a
  response, not an exception). XMPP-level failures (IQ error, timeout) are
  thrown as `HttpxError` with an `httpEquivalent` hint (forbidden→403,
  service-unavailable→502, timeout→504…), never synthesized into fake
  responses.
- A request whose body doesn't fit inline when the requester accepts no
  stream mechanism is answered `413 Payload Too Large` (spec is silent).
- Unimplemented data mechanisms (sipub, jingle) are answered
  `501 Not Implemented` (spec is silent).
- Malformed `<req>` stanzas get an IQ `bad-request` error, not an HTTP 400,
  because they never became an HTTP request.

## Headers

- WHATWG `Headers` normalizes names to lowercase and joins duplicates with
  `", "`. Semantically equivalent per RFC 9110; the XEP's "preserve original
  format" is interpreted as no semantic transformation.
- Connection-management headers (`Connection`, `Keep-Alive`, `TE`,
  `Upgrade`, …) are stripped by the origin proxy per XEP-0332 §9, since XMPP
  has no persistent-connection semantics to manage.

## Extension elements

- A `<req>` or `<resp>` may carry children in other namespaces; the codec
  hands them through verbatim (`extensions` on the request init, the server
  request, the handler response and the client response) and never reads
  them. Only children outside `urn:xmpp:http` and outside the SHIM `headers`
  count; an unknown child in the protocol's own namespace is ignored as
  before, so a future XEP-0332 element cannot be mistaken for an
  application's. XEP-0332 v0.5.1 is silent on foreign children; XMPP's usual
  rule (ignore what you do not understand) makes carrying them harmless to
  a peer that has never heard of them.

## Discovery

- `HttpxClient` disco-checks a peer before the first request (cached per
  JID). A peer that answers disco without `urn:xmpp:http` is refused;
  errors and timeouts are treated as unknown and the request proceeds,
  because many deployments answer disco poorly and a hard failure would make
  the library unusable against them. Disable with `discover: false`.
- `urn:xmpp:http:connect:0` is advertised by a server with `tunnels: true`
  and checked by `HttpxClient.connect()`; see the duplex notes above. An
  application answering disco itself (`advertise: false`) must add it —
  `httpxFeatures([NS_HTTPX_CONNECT])` — or `connect()` refuses the server.
- `urn:xmpp:http#absolute-form` is advertised alongside `urn:xmpp:http`
  (n146 design §4.3): v0.5.1 defines `resource` as a path, so a requester
  may send absolute-form only to a peer that says it takes it. Every entity
  using this library decodes it, so every entity advertises it; what a
  handler does with the URL is the application's concern.
  `DiscoCache.supports(jid, feature)` checks this, or any feature, from the
  same cached disco answer that `supportsHttpx()` uses.
- `advertiseHttpx()` / `HttpxServer` register the session's only disco#info
  responder. Applications with their own disco should set
  `advertise: false` and add `urn:xmpp:http` to their own feature list.

## Sessions

- One `IbbManager` and one `ChunkRouter` exist per session (@xmpp/iq routes
  each namespace/tag to the first registered handler), acquired/released by
  reference count. Consequence: the application must not register its own
  IBB IQ handlers on a session used by this library.
- @xmpp/middleware offers no handler removal, so `stop()`/`close()`
  deactivate by state; the handlers answer `service-unavailable` when
  stopped.
