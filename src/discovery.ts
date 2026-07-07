import xml from "@xmpp/xml";
import { NS_DISCO_INFO, NS_HTTPX, NS_IBB, NS_SHIM } from "./constants.js";
import type { XmppSession } from "./session.js";

/**
 * Minimal XEP-0030 service discovery: enough to advertise urn:xmpp:http and
 * to check a peer for it. Entity-caps hashing (XEP-0115) is a later phase.
 *
 * Note: this registers the session's only disco#info get-handler (@xmpp/iq
 * routes each namespace/tag pair to one handler). If the application already
 * answers disco#info itself, skip advertiseHttpx() and add the features to
 * the application's own response instead.
 */
export function advertiseHttpx(
  session: XmppSession,
  options?: {
    identity?: { category: string; type: string; name?: string };
    extraFeatures?: readonly string[];
  },
): void {
  const identity = options?.identity ?? {
    category: "component",
    type: "generic",
    name: "xmpp-httpx",
  };
  const features = [
    NS_DISCO_INFO,
    NS_HTTPX,
    NS_SHIM,
    NS_IBB,
    ...(options?.extraFeatures ?? []),
  ];

  session.iqCallee.get(NS_DISCO_INFO, "query", (ctx) => {
    const query = xml("query", { xmlns: NS_DISCO_INFO });
    const identityAttrs: Record<string, string> = {
      category: identity.category,
      type: identity.type,
    };
    if (identity.name !== undefined) identityAttrs["name"] = identity.name;
    query.append(xml("identity", identityAttrs));
    const node = ctx.element.attrs["node"];
    if (node !== undefined) query.attrs["node"] = node;
    for (const feature of features) {
      query.append(xml("feature", { var: feature }));
    }
    return query;
  });
}

export type DiscoSupport = "yes" | "no" | "unknown";

/**
 * Per-JID cache of "does this peer advertise urn:xmpp:http?". Errors and
 * timeouts yield "unknown" — many deployments answer disco poorly, so the
 * client proceeds optimistically on "unknown" and refuses only on an
 * explicit feature list that lacks the namespace.
 */
export class DiscoCache {
  readonly #session: XmppSession;
  readonly #timeoutMs: number;
  readonly #cache = new Map<string, DiscoSupport>();

  constructor(session: XmppSession, options?: { timeoutMs?: number }) {
    this.#session = session;
    this.#timeoutMs = options?.timeoutMs ?? 10_000;
  }

  async supportsHttpx(jid: string, from?: string): Promise<DiscoSupport> {
    const cached = this.#cache.get(jid);
    if (cached !== undefined) return cached;

    let result: DiscoSupport;
    try {
      const attrs: Record<string, string> =
        from !== undefined
          ? { type: "get", to: jid, from }
          : { type: "get", to: jid };
      const iq = xml("iq", attrs, xml("query", { xmlns: NS_DISCO_INFO }));
      const reply = await this.#session.iqCaller.request(iq, this.#timeoutMs);
      const query = reply.getChild("query", NS_DISCO_INFO);
      if (!query) {
        result = "unknown";
      } else {
        const supported = query
          .getChildren("feature")
          .some((f) => f.attrs["var"] === NS_HTTPX);
        result = supported ? "yes" : "no";
      }
    } catch {
      result = "unknown";
    }

    this.#cache.set(jid, result);
    return result;
  }

  invalidate(jid?: string): void {
    if (jid === undefined) this.#cache.clear();
    else this.#cache.delete(jid);
  }
}
