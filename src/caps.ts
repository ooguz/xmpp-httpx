import xml, { Element } from "@xmpp/xml";
import { NS_CAPS, NS_DISCO_INFO } from "./constants.js";
import { encodeBase64 } from "./util/base64.js";
import { textEncoder } from "./util/bytes.js";

/**
 * XEP-0115 Entity Capabilities: hash a disco#info identity/feature set into
 * a `ver` string so peers can cache capabilities from presence instead of
 * querying every JID.
 *
 * Only the sha-1 hash (the XEP's mandatory-to-implement algorithm) and
 * form-free input sets are supported — this library's own disco response
 * carries no extended data forms.
 */

export interface CapsIdentity {
  category: string;
  type: string;
  name?: string;
  /** xml:lang of the identity name. */
  lang?: string;
}

/** XEP-0115 §5.1 generation algorithm (identities + features, no forms). */
export async function computeCapsVer(
  identities: readonly CapsIdentity[],
  features: readonly string[],
): Promise<string> {
  const identityStrings = identities
    .map(
      (i) => `${i.category}/${i.type}/${i.lang ?? ""}/${i.name ?? ""}`,
    )
    .sort();
  const featureStrings = [...features].sort();

  let s = "";
  for (const identity of identityStrings) s += `${identity}<`;
  for (const feature of featureStrings) s += `${feature}<`;

  const digest = await globalThis.crypto.subtle.digest(
    "SHA-1",
    textEncoder.encode(s),
  );
  return encodeBase64(new Uint8Array(digest));
}

/** Builds the <c/> element to attach to outgoing presence stanzas. */
export function buildCapsElement(node: string, ver: string): Element {
  return xml("c", { xmlns: NS_CAPS, hash: "sha-1", node, ver });
}

/**
 * Recomputes the ver hash from a received disco#info result <query>, used
 * to verify a peer-announced ver before trusting it for other JIDs.
 */
export async function capsVerFromDiscoQuery(query: Element): Promise<string> {
  if (!query.is("query", NS_DISCO_INFO)) {
    throw new TypeError("expected a disco#info <query> element");
  }
  const identities: CapsIdentity[] = query.getChildren("identity").map((el) => ({
    category: el.attrs["category"] ?? "",
    type: el.attrs["type"] ?? "",
    ...(el.attrs["name"] !== undefined ? { name: el.attrs["name"] } : {}),
    ...(el.attrs["xml:lang"] !== undefined ? { lang: el.attrs["xml:lang"] } : {}),
  }));
  const features = query
    .getChildren("feature")
    .map((el) => el.attrs["var"])
    .filter((v): v is string => v !== undefined);
  return computeCapsVer(identities, features);
}
