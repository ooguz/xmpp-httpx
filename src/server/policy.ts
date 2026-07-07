import { bareJid, jidDomain } from "../session.js";

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
