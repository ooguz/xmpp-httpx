import type { Element } from "@xmpp/xml";
import { bareJid, jidDomain, type XmppSession } from "../session.js";

/**
 * Authorization hook run for every <req> before the body is consumed.
 * XEP-0332 §9 describes roster policies (public/manual/private/provisioned);
 * these helpers cover the stateless ones. Roster-subscription-driven
 * policies belong to the application, which owns presence handling.
 */
export type AuthorizeFn = (
  from: string,
  req: { method: string; resource: string; to: string },
) => boolean | Promise<boolean>;

/** The XEP's "public" policy: anyone may request. */
export function allowAll(): AuthorizeFn {
  return () => true;
}

/** The XEP's "private" policy with an explicit allow list. Entries may be
 * bare JIDs ("user@example.org"), full JIDs, or domains ("example.org",
 * "*@example.org") which admit every user of that domain. */
export function allowList(entries: Iterable<string>): AuthorizeFn {
  const jids = new Set<string>();
  const domains = new Set<string>();
  for (const raw of entries) {
    const entry = raw.trim();
    if (entry === "") continue;
    if (entry.startsWith("*@")) domains.add(entry.slice(2));
    else if (!entry.includes("@")) domains.add(entry);
    else jids.add(bareJid(entry));
  }
  return (from) => jids.has(bareJid(from)) || domains.has(jidDomain(from));
}

export function denyAll(): AuthorizeFn {
  return () => false;
}

/**
 * The XEP's roster-driven ("manual"-adjacent) policy without the library
 * owning presence: allow bare JIDs the server currently sees as available —
 * which, for a client session, means JIDs with a presence subscription.
 * Call `.dispose()` when the server stops.
 */
export function presencePolicy(
  session: XmppSession,
): AuthorizeFn & { dispose(): void } {
  const available = new Set<string>();
  const onStanza = (stanza: Element) => {
    if (stanza.getName() !== "presence") return;
    const from = stanza.attrs["from"];
    if (!from) return;
    const type = stanza.attrs["type"];
    if (type === undefined || type === "") available.add(bareJid(from));
    else if (type === "unavailable") available.delete(bareJid(from));
  };
  session.on("stanza", onStanza);

  const policy: AuthorizeFn = (from) => available.has(bareJid(from));
  return Object.assign(policy, {
    dispose: () => void session.removeListener("stanza", onStanza),
  });
}

/**
 * The XEP's "manual" policy: unknown requesters are put to an
 * application-supplied prompt (UI dialog, admin queue, …); the decision is
 * cached per bare JID for `ttlMs` (default 5 minutes). Concurrent requests
 * from the same JID share one pending prompt; a throwing prompt denies.
 */
export function manualPolicy(
  prompt: (
    from: string,
    req: { method: string; resource: string; to: string },
  ) => boolean | Promise<boolean>,
  options?: { ttlMs?: number },
): AuthorizeFn {
  const ttlMs = options?.ttlMs ?? 5 * 60_000;
  const decisions = new Map<string, { value: Promise<boolean>; at: number }>();
  return (from, req) => {
    const key = bareJid(from);
    const cached = decisions.get(key);
    const now = Date.now();
    if (cached && now - cached.at < ttlMs) return cached.value;
    const value = Promise.resolve()
      .then(() => prompt(from, req))
      .catch(() => false);
    decisions.set(key, { value, at: now });
    return value;
  };
}

let warned = false;

/** Default policy: deny everything, warning once about the missing config. */
export const denyAllWithWarning: AuthorizeFn = () => {
  if (!warned) {
    warned = true;
    console.warn(
      "[xmpp-httpx] HttpxServer has no authorize option configured; " +
        "denying all requests. Pass allowAll()/allowList(...) or your own policy.",
    );
  }
  return false;
};
