# Protocol notes — XEP-0332 interpretations

XEP-0332 v0.5.1 is Deferred and thin in places. Where the spec is ambiguous
or silent, this library decides unilaterally; every such decision is recorded
here so future interop work can trace behavior back to a choice, not an
accident.

## Chunked transport (`chunkedBase64`)

- **`nr` is 0-based**, per the XEP's examples (`nr='0'` first).
- Chunks may arrive out of order; the receiver buffers gaps up to
  `maxBufferedBytes` (default 1 MiB) and errors beyond that.
- There is **no per-chunk loss signaling** — a lost chunk manifests only as
  an idle timeout (default 30 s). This is inherent to the mechanism.
- An **empty body** is one empty chunk with `last='true'` (the receiver needs
  a `last` marker to complete; the spec never shows an empty stream).
- Chunk messages are keyed by **(bare peer JID, streamId)**.
- `maxChunkSize` is interpreted as **decoded bytes per chunk** (the spec does
  not say whether it counts raw or base64 bytes). We voluntarily cap our own
  chunks at 8192 decoded bytes so each stanza stays well under the 10 KiB
  stanza-size floor of RFC 6120 after base64 expansion (~1.37×).

## IBB (XEP-0047)

- We **send** data exclusively as IQ stanzas: the per-block IQ ack gives flow
  control (the receiver withholds acks while its consumer lags) and error
  propagation. We **accept** message-carried data for interop leniency.
- Unsolicited `<open>`s are refused with `<not-acceptable/>`, but an
  unclaimed open is parked ~5 s first (the IQ reply is withheld), because the
  announcing `<resp>`/`<req>` and the `<open>` can be dispatched in the same
  event-loop turn and race the local registration.
- A premature `<close/>` is indistinguishable from a complete one at the
  protocol level; consumers that need integrity should compare against
  `Content-Length`.

## sipub (XEP-0137 over XEP-0095 SI)

- Only the **IBB stream method** is offered and accepted; a received SI
  offer without `http://jabber.org/protocol/ibb` among its stream-method
  options is refused with `<no-valid-streams/>`.
- The sid chain is `<starting sid>` = SI `id` = XEP-0047 sid — one
  identifier from handshake to data plane.
- Each publication is **one-shot** and bound to the requesting peer's bare
  JID (XEP-0137 anticipates third-party/multi-consumer starts; for httpx
  that would leak response bodies). A second `<start>`, or one from another
  JID, is refused (`not-acceptable` / `forbidden`).
- Unclaimed publications expire after 60 s (`DEFAULT_OFFER_TTL_MS`).
- `<file size='0'>` when the body length is unknown; `size` is never
  trusted on receive (the IBB `<close/>` terminates the body).
- XEP-0137's own examples are internally inconsistent (start id as
  attribute vs text); we follow Example 7 (attribute) strictly.

## jingle (XEP-0166 subset)

- The `<jingle action='session-initiate'>` embedded in `<data>` **is** the
  session-initiate — no separate initiate IQ is sent, and it receives no
  Jingle-level ack (the httpx IQ result carries it). This deviation is
  forced by XEP-0332's design. As a hedge, a duplicate initiate IQ bearing
  a known session id is acked.
- Content is XEP-0234 `file-transfer:5` description + **XEP-0261 IBB
  transport only** — the description is echoed verbatim and never
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

- **The initiate carries no candidates.** XEP-0332 embeds the session-initiate
  in `<data>`, and that element is built *synchronously* while gathering
  candidates (and hashing `dstaddr`) is asynchronous. So the initiate offers a
  bare `<transport sid mode='tcp'/>` and the candidates follow in a
  `transport-info`, which §2.3 provides for. A peer that expects candidates in
  the initiate will simply see none and report `<candidate-error/>`, which is
  handled.
- **`dstaddr` is informational here.** It is sent with the candidates when
  known, and its absence is not fatal: both parties can derive
  SHA-1(sid + initiator + responder) themselves, and the SOCKS5 adapter does
  exactly that rather than trusting the wire value.
- **The negotiation is symmetric.** Both parties offer whatever streamhosts
  their adapter can produce, both dial the other's, and `resolve()` arbitrates —
  so a sender that cannot host (behind NAT) can still deliver a body by dialling
  *out* to a candidate the receiver hosts. That direction needs both ends of a
  SOCKS5 connection, which is why `Socks5Adapter` hands back a duplex from both
  `connect()` and `openChosen()` rather than a single direction each.
- **Whoever offered the winning candidate takes it up** (`openChosen`) and, for a
  proxy, activates it and sends `<activated cid=…/>`; the dialling side waits for
  that before using the stream. The XEP-0065 `<activate/>` names the party that
  dialled the proxy, which flips with the role — so it is passed separately from
  the two context JIDs, which must stay fixed because they are what `dstaddr` is
  hashed from and both sides have to agree on it.
- **The losing connection is closed.** Both peers may dial each other before the
  winner is known; the duplex that lost is aborted and cancelled rather than left
  open.
- **A winning proxy candidate is activated by its offerer**, which is always the
  initiator here: the adapter's `openOutgoing` sends the XEP-0065 `<activate/>`
  IQ to the proxy, and the initiator then sends `<activated cid=…/>` so the
  responder knows it may read. The responder waits for that before handing the
  body stream to its caller, because a proxy relays nothing until activated.
- **Fallback is `transport-replace` with an IBB transport**, and the two sides
  hand over carefully: the responder arms its IBB receiver *before* answering
  with `transport-accept`, and the initiator does not write a byte until that
  accept arrives. Otherwise the first block would land on nothing.
- A receiver with **no adapter at all** (a browser) accepts an s5b offer, reports
  `<candidate-error/>` immediately, and receives the body over the replacement
  IBB transport. Refusing the session outright would have been the easier path
  and the worse one.

The interpretations the protocol layer commits to, which an interoperating
implementation has to agree with:

- **Tie-breaking is the ambiguity that matters.** §2.4 says that when both
  parties send `<candidate-used/>` with equal priority, "the candidate offered by
  the initiator is used". A party always reports a candidate from its *peer's*
  list, so the initiator-offered candidate is the one the **responder** reported
  — that is the reading implemented, and both viewpoints of the same negotiation
  provably pick the same candidate (there is a test asserting exactly that). Read
  the other way, the two sides would each pick the other's candidate and the
  transfer would deadlock, which is why this is written down rather than left to
  the reader.
- **`mode='udp'` is refused**, not downgraded. The schema allows it; nothing in
  XEP-0260 says how to use it, and silently treating it as `tcp` would be a
  worse failure than a clear one.
- **Duplicate candidate `cid`s are refused** at parse time: `<candidate-used/>`
  names a cid, so duplicates would make the report ambiguous.
- **A missing `type` defaults to `direct`**, matching the schema's default, and
  an *unknown* type is refused rather than assigned a priority.
- Priority is `2^16 × type-preference + local-preference` with the XEP's
  recommended preferences (direct 126, assisted 120, tunnel 110, proxy 10), so a
  proxy can never outrank a direct candidate no matter the local preference.
- `dstaddr` is SHA-1(sid + initiator full JID + responder full JID) — the
  XEP-0065 §5.3.1 construction with the Jingle roles supplying the JIDs, which is
  why the existing `computeDomain()` is reused.

## Request bodies

- The `sipub`/`ibb`/`jingle` attributes of `<req>` describe what the
  **requester accepts for the response**. The XEP provides no negotiation for
  *request* bodies; we send small bodies inline and stream large ones via
  IBB (default preference) or chunked messages — sipub/jingle are opt-in
  for sending (`preferredStreams`) but always accepted on receive.
- The responder replies to the `<req>` IQ **after** consuming a streamed
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
- Malformed `<req>` stanzas get an IQ `bad-request` error, not an HTTP 400 —
  they never became an HTTP request.

## Headers

- WHATWG `Headers` normalizes names to lowercase and joins duplicates with
  `", "`. Semantically equivalent per RFC 9110; the XEP's "preserve original
  format" is interpreted as *no semantic transformation*.
- Connection-management headers (`Connection`, `Keep-Alive`, `TE`,
  `Upgrade`, …) are stripped by the origin proxy per XEP-0332 §9 — XMPP has
  no persistent-connection semantics to manage.

## Discovery

- `HttpxClient` disco-checks a peer before the first request (cached per
  JID). A peer that answers disco **without** `urn:xmpp:http` is refused;
  errors and timeouts are treated as *unknown* and the request proceeds —
  many deployments answer disco poorly, and a hard failure would make the
  library unusable against them. Disable with `discover: false`.
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
