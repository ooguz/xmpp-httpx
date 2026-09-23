import type { Element } from "@xmpp/xml";
import { NS_HTTPX, NS_SHIM } from "../constants.js";

/**
 * Children of a <req/> or <resp/> that belong to neither this protocol nor
 * SHIM headers: room for other namespaces to ride along — n146's sealed
 * envelope is the first. They are carried verbatim and never interpreted
 * here; an element in `urn:xmpp:http` that this codec does not know is not an
 * extension, it is ignored as before.
 */
export function extensionChildren(el: Element): Element[] {
  return el
    .getChildElements()
    .filter((child) => !child.is("headers", NS_SHIM) && !child.is("data", NS_HTTPX) && child.getNS() !== NS_HTTPX);
}
