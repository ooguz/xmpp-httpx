import xml, { Element } from "@xmpp/xml";
import { capsVerFromDiscoQuery, type CapsIdentity } from "./caps.js";
import {
  NS_CAPS,
  NS_DISCO_INFO,
  NS_HTTPX,
  NS_HTTPX_ABSOLUTE_FORM,
  NS_IBB,
  NS_JINGLE,
  NS_JINGLE_FT,
  NS_JINGLE_IBB,
  NS_SHIM,
  NS_SI,
  NS_SIPUB,
  NS_SI_FT,
} from "./constants.js";
import { bareJid, type XmppSession } from "./session.js";

export const DEFAULT_IDENTITY: CapsIdentity = {
  category: "component",
  type: "generic",
  name: "xmpp-httpx",
};

/** The feature set this library implements/advertises. */
export function httpxFeatures(extra: readonly string[] = []): string[] {
  return [
    NS_DISCO_INFO,
    NS_CAPS,
    NS_HTTPX,
    // decodeReq() accepts absolute-form on every entity, so every entity may
    // say so; what a *handler* does with the URL is the application's call.
    NS_HTTPX_ABSOLUTE_FORM,
    NS_SHIM,
    NS_IBB,
    NS_SIPUB,
    NS_SI,
    NS_SI_FT,
    NS_JINGLE,
    NS_JINGLE_FT,
    NS_JINGLE_IBB,
    ...extra,
  ];
}

/**
 * Minimal XEP-0030 service discovery: enough to advertise urn:xmpp:http and
 * to check a peer for it. Use `computeCapsVer(identities, features)` from
 * ./caps.js with the same inputs to build a matching XEP-0115 <c/> element
 * for the presence stanzas the application sends.
 *
 * Note: this registers the session's only disco#info get-handler (@xmpp/iq
 * routes each namespace/tag pair to one handler). If the application already
 * answers disco#info itself, skip advertiseHttpx() and add httpxFeatures()
 * to the application's own response instead.
 */
export function advertiseHttpx(
  session: XmppSession,
  options?: {
    identity?: CapsIdentity;
    extraFeatures?: readonly string[];
  },
): { identities: CapsIdentity[]; features: string[] } {
  const identity = options?.identity ?? DEFAULT_IDENTITY;
  const features = httpxFeatures(options?.extraFeatures);

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

  return { identities: [identity], features };
}

export type DiscoSupport = "yes" | "no" | "unknown";

/**
 * Per-JID cache of a peer's disco#info features — "does it advertise
 * urn:xmpp:http?", and any other feature a caller needs to check first
 * (absolute-form, a tunnel extension).
 *
 * Two layers:
 * - Passive XEP-0115: presence stanzas carrying <c hash='sha-1' ver=…> map
 *   JIDs to a ver; each distinct ver is resolved with ONE disco query and,
 *   if the response's recomputed hash matches, the verdict is shared by
 *   every JID announcing that ver.
 * - Active fallback: a plain disco#info query per JID.
 *
 * Errors and timeouts yield "unknown" — many deployments answer disco
 * poorly, so callers proceed optimistically on "unknown" and refuse only on
 * an explicit feature list lacking the namespace.
 */
export class DiscoCache {
  readonly #session: XmppSession;
  readonly #timeoutMs: number;
  /** JID → its feature list, or null when disco gave no answer. */
  readonly #cache = new Map<string, ReadonlySet<string> | null>();
  /** bare JID → announced caps ver. */
  readonly #jidVer = new Map<string, string>();
  /** verified ver → its feature list. */
  readonly #verFeatures = new Map<string, ReadonlySet<string>>();
  readonly #onStanza = (stanza: Element) => this.#handlePresence(stanza);
  #disposed = false;

  constructor(
    session: XmppSession,
    options?: { timeoutMs?: number; trackPresence?: boolean },
  ) {
    this.#session = session;
    this.#timeoutMs = options?.timeoutMs ?? 10_000;
    if (options?.trackPresence !== false) {
      session.on("stanza", this.#onStanza);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#session.removeListener("stanza", this.#onStanza);
  }

  supportsHttpx(jid: string, from?: string): Promise<DiscoSupport> {
    return this.supports(jid, NS_HTTPX, from);
  }

  /** Whether `jid` advertises `feature`; one disco query serves every feature. */
  async supports(jid: string, feature: string, from?: string): Promise<DiscoSupport> {
    const features = await this.#features(jid, from);
    if (features === null) return "unknown";
    return features.has(feature) ? "yes" : "no";
  }

  async #features(jid: string, from: string | undefined): Promise<ReadonlySet<string> | null> {
    const ver = this.#jidVer.get(bareJid(jid));
    if (ver !== undefined) {
      const known = this.#verFeatures.get(ver);
      if (known !== undefined) return known;
    }

    const cached = this.#cache.get(jid);
    if (cached !== undefined) return cached;

    let result: ReadonlySet<string> | null = null;
    try {
      const attrs: Record<string, string> =
        from !== undefined
          ? { type: "get", to: jid, from }
          : { type: "get", to: jid };
      const iq = xml("iq", attrs, xml("query", { xmlns: NS_DISCO_INFO }));
      const reply = await this.#session.iqCaller.request(iq, this.#timeoutMs);
      const query = reply.getChild("query", NS_DISCO_INFO);
      if (query) {
        const features = new Set(
          query
            .getChildren("feature")
            .map((f) => f.attrs["var"])
            .filter((v): v is string => v !== undefined),
        );
        result = features;

        // XEP-0115: a verified hash lets every JID with this ver share the
        // verdict without further queries.
        if (ver !== undefined) {
          try {
            if ((await capsVerFromDiscoQuery(query)) === ver) {
              this.#verFeatures.set(ver, features);
            }
          } catch {
            // Unverifiable response; fall back to per-JID caching.
          }
        }
      }
    } catch {
      result = null;
    }

    this.#cache.set(jid, result);
    return result;
  }

  invalidate(jid?: string): void {
    if (jid === undefined) {
      this.#cache.clear();
      this.#jidVer.clear();
      this.#verFeatures.clear();
    } else {
      this.#cache.delete(jid);
      this.#jidVer.delete(bareJid(jid));
    }
  }

  #handlePresence(stanza: Element): void {
    if (stanza.getName() !== "presence") return;
    const from = stanza.attrs["from"];
    if (!from) return;
    const type = stanza.attrs["type"];

    if (type === "unavailable") {
      this.#jidVer.delete(bareJid(from));
      return;
    }
    if (type !== undefined && type !== "") return; // subscriptions, errors…

    const c = stanza.getChild("c", NS_CAPS);
    const ver = c?.attrs["ver"];
    if (!c || c.attrs["hash"] !== "sha-1" || !ver) return;

    const bare = bareJid(from);
    if (this.#jidVer.get(bare) !== ver) {
      this.#jidVer.set(bare, ver);
      // The entity's capabilities changed; drop stale per-JID verdicts.
      this.#cache.delete(from);
      this.#cache.delete(bare);
    }
  }
}
