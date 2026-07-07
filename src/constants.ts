/** XEP-0332: HTTP over XMPP Transport. */
export const NS_HTTPX = "urn:xmpp:http";
/** XEP-0131: Stanza Headers and Internet Metadata (SHIM). */
export const NS_SHIM = "http://jabber.org/protocol/shim";
/** XEP-0047: In-Band Bytestreams. */
export const NS_IBB = "http://jabber.org/protocol/ibb";
/** XEP-0030: Service Discovery. */
export const NS_DISCO_INFO = "http://jabber.org/protocol/disco#info";
/** RFC 6120 stanza error conditions. */
export const NS_STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";

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
