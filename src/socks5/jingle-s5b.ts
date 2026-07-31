import xml, { Element } from "@xmpp/xml";
import { NS_JINGLE_S5B } from "../constants.js";
import { CodecError } from "../errors.js";
import { computeDomain } from "./protocol.js";

/**
 * XEP-0260 (Jingle SOCKS5 Bytestreams Transport) — the wire layer and the
 * negotiation arithmetic, with no sockets and no session state, so all of it is
 * testable directly.
 *
 * The shape that distinguishes this from XEP-0065 (which the sipub transport
 * already uses): there, one side publishes streamhosts and the other picks one.
 * Here **both sides offer candidates and both try to connect**, then each
 * reports what worked with `<candidate-used/>` (or `<candidate-error/>`), and the
 * two reports are reconciled by priority. That reconciliation is `resolve()`
 * below, and it is the part worth testing exhaustively.
 */

export type CandidateType = "direct" | "assisted" | "tunnel" | "proxy";

export interface S5bCandidate {
  /** Candidate id, unique within the offering side's list. */
  cid: string;
  /** The streamhost JID: a peer's full JID, or a proxy component. */
  jid: string;
  host: string;
  port: number;
  priority: number;
  type: CandidateType;
}

export interface S5bTransport {
  /** Transport sid — distinct from the Jingle session sid. */
  sid: string;
  /** Only "tcp" is defined; "udp" exists in the schema and is refused here. */
  mode: "tcp";
  /** SHA-1(sid + initiator full JID + responder full JID), per §2.2. */
  dstaddr?: string;
  candidates: readonly S5bCandidate[];
}

/**
 * Type preferences from XEP-0260 §2.1. Direct beats everything; a proxy is a
 * last resort because it doubles the hop count and costs someone bandwidth.
 */
export const TYPE_PREFERENCE: Record<CandidateType, number> = {
  direct: 126,
  assisted: 120,
  tunnel: 110,
  proxy: 10,
};

/**
 * `priority = (2^16) * type-preference + local-preference` (§2.1). The local
 * preference orders candidates of the same type — for us, the order the adapter
 * produced them in.
 */
export function candidatePriority(
  type: CandidateType,
  localPreference: number,
): number {
  if (!Number.isInteger(localPreference) || localPreference < 0) {
    throw new RangeError(`localPreference must be a non-negative integer`);
  }
  return 2 ** 16 * TYPE_PREFERENCE[type] + localPreference;
}

/** The dstaddr both sides must use for the SOCKS5 handshake (§2.2). */
export function s5bDstAddr(
  sid: string,
  initiatorFullJid: string,
  responderFullJid: string,
): Promise<string> {
  // Same construction as XEP-0065 §5.3.1, with the Jingle roles supplying the
  // two JIDs rather than requester/target.
  return computeDomain(sid, initiatorFullJid, responderFullJid);
}

// --- wire ----------------------------------------------------------------------

export function buildTransport(transport: S5bTransport): Element {
  const element = xml("transport", {
    xmlns: NS_JINGLE_S5B,
    sid: transport.sid,
    mode: transport.mode,
    ...(transport.dstaddr !== undefined ? { dstaddr: transport.dstaddr } : {}),
  });
  for (const candidate of transport.candidates) {
    element.append(
      xml("candidate", {
        cid: candidate.cid,
        host: candidate.host,
        jid: candidate.jid,
        port: String(candidate.port),
        priority: String(candidate.priority),
        type: candidate.type,
      }),
    );
  }
  return element;
}

function requireAttr(element: Element, name: string): string {
  const value = element.attrs[name];
  if (typeof value !== "string" || value === "") {
    throw new CodecError(`<${element.getName()}> is missing ${name}`);
  }
  return value;
}

function parseCandidate(element: Element): S5bCandidate {
  const port = Number(requireAttr(element, "port"));
  const priority = Number(requireAttr(element, "priority"));
  const type = element.attrs["type"] ?? "direct";

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new CodecError(`candidate has an invalid port: ${String(port)}`);
  }
  if (!Number.isFinite(priority) || priority < 0) {
    throw new CodecError(`candidate has an invalid priority: ${String(priority)}`);
  }
  if (!(type in TYPE_PREFERENCE)) {
    throw new CodecError(`unknown candidate type: ${String(type)}`);
  }

  return {
    cid: requireAttr(element, "cid"),
    jid: requireAttr(element, "jid"),
    host: requireAttr(element, "host"),
    port,
    priority,
    type: type as CandidateType,
  };
}

export function parseTransport(element: Element): S5bTransport {
  if (element.getName() !== "transport" || element.attrs["xmlns"] !== NS_JINGLE_S5B) {
    throw new CodecError("not an s5b <transport> element");
  }
  const mode = element.attrs["mode"] ?? "tcp";
  if (mode !== "tcp") {
    // The schema allows "udp"; nothing in XEP-0260 defines how to use it, and a
    // silent downgrade to tcp would be worse than refusing.
    throw new CodecError(`unsupported s5b mode: ${String(mode)}`);
  }

  const candidates = element
    .getChildren("candidate")
    .map((child) => parseCandidate(child));

  // Duplicate cids would make candidate-used ambiguous.
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.cid)) {
      throw new CodecError(`duplicate candidate cid: ${candidate.cid}`);
    }
    seen.add(candidate.cid);
  }

  const dstaddr = element.attrs["dstaddr"];
  return {
    sid: requireAttr(element, "sid"),
    mode: "tcp",
    ...(typeof dstaddr === "string" && dstaddr !== "" ? { dstaddr } : {}),
    candidates,
  };
}

/** `<transport><candidate-used cid=…/></transport>` for a transport-info. */
export function buildCandidateUsed(sid: string, cid: string): Element {
  return xml(
    "transport",
    { xmlns: NS_JINGLE_S5B, sid },
    xml("candidate-used", { cid }),
  );
}

export function buildCandidateError(sid: string): Element {
  return xml("transport", { xmlns: NS_JINGLE_S5B, sid }, xml("candidate-error"));
}

/** Sent by the side that offered a *proxy* candidate, once it has activated it. */
export function buildActivated(sid: string, cid: string): Element {
  return xml("transport", { xmlns: NS_JINGLE_S5B, sid }, xml("activated", { cid }));
}

export function buildProxyError(sid: string): Element {
  return xml("transport", { xmlns: NS_JINGLE_S5B, sid }, xml("proxy-error"));
}

export type S5bInfo =
  | { kind: "candidate-used"; sid: string; cid: string }
  | { kind: "candidate-error"; sid: string }
  | { kind: "activated"; sid: string; cid: string }
  | { kind: "proxy-error"; sid: string };

/** Reads whichever transport-info payload an s5b `<transport>` carries. */
export function parseInfo(element: Element): S5bInfo {
  if (element.getName() !== "transport" || element.attrs["xmlns"] !== NS_JINGLE_S5B) {
    throw new CodecError("not an s5b <transport> element");
  }
  const sid = requireAttr(element, "sid");

  const used = element.getChild("candidate-used");
  if (used) return { kind: "candidate-used", sid, cid: requireAttr(used, "cid") };

  const activated = element.getChild("activated");
  if (activated) {
    return { kind: "activated", sid, cid: requireAttr(activated, "cid") };
  }
  if (element.getChild("candidate-error")) return { kind: "candidate-error", sid };
  if (element.getChild("proxy-error")) return { kind: "proxy-error", sid };

  throw new CodecError("s5b <transport> carries no recognized transport-info");
}

// --- negotiation ----------------------------------------------------------------

/** What one side reports after trying the peer's candidates. */
export type S5bReport =
  | { kind: "used"; candidate: S5bCandidate }
  | { kind: "error" };

export type S5bOutcome =
  /** Use `candidate`; `offeredBy` says whose it is, i.e. who must activate it. */
  | { kind: "use"; candidate: S5bCandidate; offeredBy: "local" | "remote" }
  /** Neither side could connect: fall back (transport-replace to IBB). */
  | { kind: "fallback" };

export interface ResolveInput {
  /** What we managed to connect to among the *peer's* candidates. */
  local: S5bReport;
  /** What the peer reported connecting to among *our* candidates. */
  remote: S5bReport;
  /** Are we the Jingle initiator? Decides ties. */
  isInitiator: boolean;
}

/**
 * Reconciles the two reports into one decision, per XEP-0260 §2.4.
 *
 * The rules, and one interpretation this project has to pin down:
 *
 * - One side reports a candidate and the other an error → the candidate wins.
 * - Both report → the **higher priority** candidate wins.
 * - Equal priority → the XEP says "the candidate offered by the initiator is
 *   used". A side always reports a candidate from its *peer's* list, so the
 *   initiator-offered candidate is the one the **responder** reported. That is
 *   the reading implemented here, and it is recorded in
 *   docs/protocol-notes.md — the wording is ambiguous enough that an
 *   implementation could plausibly do the opposite and deadlock on ties.
 * - Both error → no bytestream; the caller falls back.
 */
export function resolve(input: ResolveInput): S5bOutcome {
  const { local, remote, isInitiator } = input;

  // Cased on both reports at once rather than eliminating errors first: the
  // compiler cannot correlate two unions across a compound condition, and
  // writing it this way is both type-safe and easier to check against §2.4.
  if (local.kind === "used" && remote.kind === "used") {
    if (local.candidate.priority > remote.candidate.priority) {
      return { kind: "use", candidate: local.candidate, offeredBy: "remote" };
    }
    if (remote.candidate.priority > local.candidate.priority) {
      return { kind: "use", candidate: remote.candidate, offeredBy: "local" };
    }
    // Tie: the initiator-offered candidate wins, which is whichever report came
    // from the responder.
    return isInitiator
      ? { kind: "use", candidate: remote.candidate, offeredBy: "local" }
      : { kind: "use", candidate: local.candidate, offeredBy: "remote" };
  }

  // We connected to one of theirs; they could not connect to any of ours.
  if (local.kind === "used") {
    return { kind: "use", candidate: local.candidate, offeredBy: "remote" };
  }
  // The peer connected to one of ours; we could not connect to any of theirs.
  if (remote.kind === "used") {
    return { kind: "use", candidate: remote.candidate, offeredBy: "local" };
  }

  return { kind: "fallback" };
}

/**
 * Candidates sorted the way they should be tried: highest priority first, with
 * cid breaking ties so both peers try them in the same order.
 */
export function sortCandidates(
  candidates: readonly S5bCandidate[],
): S5bCandidate[] {
  return [...candidates].sort(
    (a, b) => b.priority - a.priority || (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0),
  );
}
