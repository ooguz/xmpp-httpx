# XEP-0332 implementation experience — feedback for the XSF

*Draft for the standards@xmpp.org list. Context: XEP-0332 (HTTP over XMPP
Transport) has been Deferred since 2014 (v0.5.1, 2020-03-31); its own text
encourages exploratory implementations "to resume the standards process".
[xmpp-httpx](https://github.com/ooguz/xmpp-httpx) is such an implementation:
all seven data mechanisms, requester and responder sides, TypeScript,
running in Node and browsers, exercised against Prosody 13 and by a working
WebExtension browser. This is what we learned.*

## Summary

XEP-0332's core design — HTTP request/response pairs in IQ stanzas with
pluggable body mechanisms — works. We implemented the complete surface and
browse real pages with it. But the spec, as written, cannot produce
independently interoperable implementations: too many load-bearing details
are unspecified. Every item below had to be decided unilaterally (full list
in [protocol-notes.md](protocol-notes.md)); each is a place where two
honest implementations would disagree on the wire.

## Issues that block interop (should be fixed in the XEP)

1. **`chunkedBase64` sequencing is underspecified.** The `nr` attribute's
   base is only inferable from examples (we assume 0-based); nothing says
   whether chunks may arrive out of order (message routing does not
   guarantee inter-stanza order across resources — we buffer and reorder);
   there is no way to signal a lost chunk, so the only failure mode is an
   idle timeout; and the encoding of an **empty body** is undefined (we
   send one empty chunk with `last='true'` — a receiver needs *some* final
   marker). Proposal: specify 0-based `nr`, require receivers to reorder,
   define the empty-body form, and consider a lightweight cancel/error
   message for a `streamId`.

2. **`maxChunkSize` units are ambiguous.** Decoded bytes or base64
   characters? The ~1.37× difference matters against stanza-size limits.
   We chose decoded bytes and voluntarily cap at 8192 so a chunk stanza
   stays under the RFC 6120 10 KiB floor. Proposal: state the unit and add
   guidance relating chunk size to stanza-size limits.

3. **The `jingle` mechanism's semantics are unclear.** §"jingle" embeds a
   `<jingle action='session-initiate'>` inside `<data>`, but (a) the
   example embeds an RTP/ICE session, which cannot carry an HTTP body —
   presumably a copy-paste from XEP-0166; and (b) the XEP never says
   whether the embedded element replaces the normal initiate IQ or merely
   previews it, which changes the whole ack sequence. We treat the embedded
   element as *the* initiate (the httpx IQ result is its transport ack) and
   additionally ack a duplicate initiate IQ that carries a known session id.
   Proposal: specify exactly this (or the alternative), and replace the
   example with an XEP-0234 file-transfer content over a real transport
   (XEP-0261 IBB being the natural in-band choice).

4. **Request bodies have no mechanism negotiation.** The `sipub`/`ibb`/
   `jingle` attributes on `<req>` describe what the requester accepts for
   the *response*; nothing tells a requester which mechanisms the responder
   accepts for *request* bodies before it commits to one in the `<req>`.
   We advertise everything we implement in disco#info and hope. Proposal:
   define disco features per mechanism (see 6) and state that a responder
   answers an unusable request-body mechanism with a defined error.

5. **Error semantics are thin.** The XEP does not say: what a responder
   returns when the request body is too large and no stream mechanism is
   acceptable (we send HTTP 413); what happens when a `<data>` mechanism is
   unsupported (we send HTTP 501); or how a responder should reply to a
   malformed `<req>` (we send an IQ `bad-request` error — it never became
   an HTTP request, so an HTTP status would be wrong). Proposal: a short
   "error conditions" section with this mapping.

6. **Discovery is all-or-nothing.** `urn:xmpp:http` says nothing about
   which body mechanisms an entity supports. We additionally advertise the
   underlying protocol namespaces (ibb, si, sipub, jingle transports), but
   the XEP should define per-mechanism disco features (e.g.
   `urn:xmpp:http#chunkedBase64`) so peers can select transports without
   trial and error.

7. **The sipub stack is deprecated underneath the XEP.** XEP-0095/0096
   (and effectively XEP-0137) are Deprecated; a new implementation must
   revive three dead specs to implement one optional mechanism, and
   XEP-0137's own examples are internally inconsistent (the `<start>`
   element's id appears as an attribute in one example and as text in an
   error example). Proposal: drop sipub in a revised XEP, or replace it
   with a reference to Jingle file transfer, which subsumes it.

## Observations that should become normative guidance

- **Responder reply timing for streamed request bodies.** The responder can
  only produce `statusCode` after consuming the body, so the requester's IQ
  timeout must cover the whole transfer. Worth a sentence — it surprises
  every HTTP-minded implementer.
- **The IQ result and subsequent chunk messages can arrive in the same
  network flush**, so a requester that registers its stream handler "after
  the response arrives" has a race. Receivers should be told to tolerate
  briefly-early chunks (we park them in a bounded orphan buffer).
- **`Connection`-class headers**: §Security says to ignore them; it should
  also instruct gateways to *strip* the hop-by-hop set (RFC 9110 §7.6.1)
  in both directions.
- **`httpx://` URI scheme**: parsing `user@domain` authorities through
  WHATWG URL implementations is inconsistent for unknown schemes; if the
  scheme is to be kept, the XEP should define the grammar precisely
  (no port, no userinfo-vs-JID ambiguity) and register it.

## What worked well (keep)

- IQ pairing for request/response gives correlation, timeouts, and error
  channels for free; the symmetric design (any entity can be requester or
  responder) fits components/gateways naturally.
- The pluggable `<data>` mechanism set is the right shape: our IBB
  implementation became the shared data plane for sipub and Jingle with
  zero changes.
- XEP-0047 IBB's per-block IQ acks provide real end-to-end flow control —
  the receiver can withhold acks while its consumer lags. In-band transports
  are underrated for this use case.

## Offer

We are happy to contribute these as a patch to the XEP (examples included —
ours are tested against fixtures verbatim), and to serve as an interop
target: the implementation, its protocol notes, and a demo gateway are
public under AGPL-3.0.
