/** XEP-0332: HTTP over XMPP Transport. */
export const NS_HTTPX = "urn:xmpp:http";
/** XEP-0131: Stanza Headers and Internet Metadata (SHIM). */
export const NS_SHIM = "http://jabber.org/protocol/shim";
/** XEP-0047: In-Band Bytestreams. */
export const NS_IBB = "http://jabber.org/protocol/ibb";
/** XEP-0030: Service Discovery. */
export const NS_DISCO_INFO = "http://jabber.org/protocol/disco#info";
/** XEP-0115: Entity Capabilities. */
export const NS_CAPS = "http://jabber.org/protocol/caps";
/** RFC 6120 stanza error conditions. */
export const NS_STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
/** XEP-0137: Publishing Stream Initiation Requests. */
export const NS_SIPUB = "http://jabber.org/protocol/sipub";
/** XEP-0095: Stream Initiation. */
export const NS_SI = "http://jabber.org/protocol/si";
/** XEP-0096: SI File Transfer profile. */
export const NS_SI_FT = "http://jabber.org/protocol/si/profile/file-transfer";
/** XEP-0020: Feature Negotiation. */
export const NS_FEATURE_NEG = "http://jabber.org/protocol/feature-neg";
/** XEP-0004: Data Forms. */
export const NS_XDATA = "jabber:x:data";
/** XEP-0166: Jingle. */
export const NS_JINGLE = "urn:xmpp:jingle:1";
export const NS_JINGLE_ERRORS = "urn:xmpp:jingle:errors:1";
/** XEP-0234: Jingle File Transfer. */
export const NS_JINGLE_FT = "urn:xmpp:jingle:apps:file-transfer:5";
/** XEP-0261: Jingle In-Band Bytestreams transport. */
export const NS_JINGLE_IBB = "urn:xmpp:jingle:transports:ibb:1";
/** XEP-0065: SOCKS5 Bytestreams. */
export const NS_BYTESTREAMS = "http://jabber.org/protocol/bytestreams";

export const HTTP_VERSION = "1.1";

/** Bounds for <req maxChunkSize=…> per XEP-0332 §"chunkedBase64". */
export const MIN_CHUNK_SIZE = 256;
export const MAX_CHUNK_SIZE = 65536;
/**
 * Default decoded-byte chunk/block size. 4096 bytes become ~5.5 KiB of
 * base64, keeping each stanza comfortably under the 10 KiB floor RFC 6120
 * requires servers to accept.
 */
export const DEFAULT_CHUNK_SIZE = 4096;
/** Largest decoded chunk we voluntarily send even if the peer allows more. */
export const SAFE_CHUNK_SIZE_CAP = 8192;

/** Max encoded bytes of a body we inline into the IQ itself. */
export const DEFAULT_INLINE_BUDGET = 4096;

export const DEFAULT_IQ_TIMEOUT_MS = 60_000;
/** A chunked/IBB stream with no traffic for this long is considered dead. */
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
/** Cap on out-of-order chunks buffered while waiting for a gap to fill. */
export const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

export const DEFAULT_IBB_BLOCK_SIZE = 4096;
/** How long an unclaimed incoming IBB <open> is held before being refused. */
export const DEFAULT_IBB_ACCEPT_TIMEOUT_MS = 5_000;
/** Unclaimed sipub publications / jingle offers expire after this. */
export const DEFAULT_OFFER_TTL_MS = 60_000;

/** How long a SOCKS5 (XEP-0065) candidate connection attempt gets before
 * moving on to the next candidate / giving up. */
export const DEFAULT_SOCKS5_CONNECT_TIMEOUT_MS = 10_000;
