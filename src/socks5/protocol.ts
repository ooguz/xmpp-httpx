import { HttpxError } from "../errors.js";
import { textDecoder, textEncoder } from "../util/bytes.js";

/**
 * XEP-0065 (SOCKS5 Bytestreams) wire format and adapter contract. Pure
 * byte-level helpers only — no sockets here, so this module stays universal
 * (the SHA-1 domain hash uses Web Crypto, available in both Node and
 * browsers). The actual TCP I/O lives in ../node/socks5.ts since raw sockets
 * are Node-only.
 */

export const SOCKS5_VERSION = 0x05;
export const SOCKS5_METHOD_NO_AUTH = 0x00;
export const SOCKS5_METHOD_NO_ACCEPTABLE = 0xff;
export const SOCKS5_CMD_CONNECT = 0x01;
export const SOCKS5_ATYP_DOMAIN = 0x03;

export interface StreamhostCandidate {
  /** The streamhost's JID (a proxy component, or a peer's full JID). */
  jid: string;
  host: string;
  port: number;
}

export interface Socks5NegotiationContext {
  requesterJid: string;
  targetJid: string;
}

export interface Socks5OutStream {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason: Error): Promise<void>;
}

/**
 * Both ends of an established bytestream. A SOCKS5 connection is duplex, and
 * which end a caller wants depends on its role — XEP-0065's publisher writes
 * while its retriever reads, but in an XEP-0260 negotiation either party may end
 * up on either side depending on whose candidate won. Handing back both keeps
 * the adapter role-neutral; the unused end is simply never touched.
 */
export interface Socks5Duplex {
  readable: ReadableStream<Uint8Array>;
  out: Socks5OutStream;
}

export interface Socks5ConnectResult extends Socks5Duplex {
  usedJid: string;
}

/**
 * Node-only implementation lives behind this interface so the universal
 * sipub code (src/sipub/sipub.ts) never imports `node:net` directly.
 */
export interface Socks5Adapter {
  /** Streamhosts we can offer for this sid (may be empty — we may host none). */
  candidatesFor(
    sid: string,
    ctx: Socks5NegotiationContext,
  ): Promise<StreamhostCandidate[]>;
  /**
   * A candidate *we offered* was chosen: take up the connection. For a
   * streamhost we host, that means the inbound socket the peer already opened;
   * for a proxy, it means dialling it and sending the XEP-0065 `<activate/>`.
   *
   * `activateJid` names the peer to activate the stream to, when that is not
   * `ctx.targetJid` — it differs by role in XEP-0260, while the two context JIDs
   * must stay fixed because they are what the `dstaddr` hash is built from and
   * both parties have to compute the same one.
   */
  openChosen(
    sid: string,
    usedJid: string,
    ctx: Socks5NegotiationContext & {
      candidates: readonly StreamhostCandidate[];
      activateJid?: string;
    },
  ): Promise<Socks5Duplex>;
  /** Dial the peer's candidates in order; throws if all fail. */
  connect(
    sid: string,
    candidates: readonly StreamhostCandidate[],
    ctx: Socks5NegotiationContext,
  ): Promise<Socks5ConnectResult>;
  release(): void;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-1(sid + requesterJid + targetJid) hex-encoded, per XEP-0065 §5.3.1. */
export async function computeDomain(
  sid: string,
  requesterJid: string,
  targetJid: string,
): Promise<string> {
  const input = textEncoder.encode(`${sid}${requesterJid}${targetJid}`);
  const digest = await crypto.subtle.digest("SHA-1", input);
  return bytesToHex(new Uint8Array(digest));
}

/** Client greeting: version 5, offering only the "no authentication" method. */
export function buildGreeting(): Uint8Array {
  return new Uint8Array([SOCKS5_VERSION, 1, SOCKS5_METHOD_NO_AUTH]);
}

export function parseMethodSelection(bytes: Uint8Array): {
  version: number;
  method: number;
} {
  if (bytes.length < 2) {
    throw new HttpxError(
      "protocol-error",
      "socks5 method-selection reply too short",
    );
  }
  return { version: bytes[0]!, method: bytes[1]! };
}

/** Server reply to a greeting: version 5, "no authentication" selected. */
export function buildMethodSelection(): Uint8Array {
  return new Uint8Array([SOCKS5_VERSION, SOCKS5_METHOD_NO_AUTH]);
}

/** CONNECT request naming `domain` (the hex SHA-1) as a DOMAINNAME address, port 0. */
export function buildConnectRequest(domain: string): Uint8Array {
  const domainBytes = textEncoder.encode(domain);
  if (domainBytes.length > 255) {
    throw new HttpxError("protocol-error", "socks5 domain too long");
  }
  const out = new Uint8Array(4 + 1 + domainBytes.length + 2);
  out[0] = SOCKS5_VERSION;
  out[1] = SOCKS5_CMD_CONNECT;
  out[2] = 0x00;
  out[3] = SOCKS5_ATYP_DOMAIN;
  out[4] = domainBytes.length;
  out.set(domainBytes, 5);
  out[5 + domainBytes.length] = 0;
  out[6 + domainBytes.length] = 0;
  return out;
}

export function parseConnectRequest(bytes: Uint8Array): {
  domain: string;
  port: number;
} {
  if (bytes.length < 5) {
    throw new HttpxError("protocol-error", "socks5 connect request too short");
  }
  if (bytes[0] !== SOCKS5_VERSION) {
    throw new HttpxError("protocol-error", "unsupported socks5 version");
  }
  if (bytes[1] !== SOCKS5_CMD_CONNECT) {
    throw new HttpxError("protocol-error", "unsupported socks5 command");
  }
  if (bytes[3] !== SOCKS5_ATYP_DOMAIN) {
    throw new HttpxError(
      "protocol-error",
      "socks5 connect request must use a domain-name address",
    );
  }
  const len = bytes[4]!;
  if (bytes.length < 5 + len + 2) {
    throw new HttpxError("protocol-error", "socks5 connect request truncated");
  }
  const domain = textDecoder.decode(bytes.subarray(5, 5 + len));
  const port = (bytes[5 + len]! << 8) | bytes[5 + len + 1]!;
  return { domain, port };
}

/** Server reply to a CONNECT request; `domain` is echoed back per XEP-0065. */
export function buildConnectReply(domain: string, success: boolean): Uint8Array {
  const domainBytes = textEncoder.encode(domain);
  const out = new Uint8Array(4 + 1 + domainBytes.length + 2);
  out[0] = SOCKS5_VERSION;
  out[1] = success ? 0x00 : 0x01;
  out[2] = 0x00;
  out[3] = SOCKS5_ATYP_DOMAIN;
  out[4] = domainBytes.length;
  out.set(domainBytes, 5);
  out[5 + domainBytes.length] = 0;
  out[6 + domainBytes.length] = 0;
  return out;
}

export function parseConnectReply(bytes: Uint8Array): { success: boolean } {
  if (bytes.length < 2) {
    throw new HttpxError("protocol-error", "socks5 connect reply too short");
  }
  if (bytes[0] !== SOCKS5_VERSION) {
    throw new HttpxError(
      "protocol-error",
      "unsupported socks5 version in reply",
    );
  }
  return { success: bytes[1] === 0x00 };
}
