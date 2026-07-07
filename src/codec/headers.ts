import xml, { Element } from "@xmpp/xml";
import { NS_SHIM } from "../constants.js";
import { CodecError } from "../errors.js";

/**
 * HTTP headers ⇄ SHIM <headers xmlns='http://jabber.org/protocol/shim'>
 * (XEP-0131 as profiled by XEP-0332 §5).
 *
 * WHATWG Headers normalizes names to lowercase and joins duplicates with
 * ", " — semantically equivalent per RFC 9110 for everything except
 * Set-Cookie, which survives via Headers' own special-casing.
 */

/** Returns null when there are no headers to encode. */
export function encodeHeaders(headers: Headers): Element | null {
  const children: Element[] = [];
  headers.forEach((value, name) => {
    children.push(xml("header", { name }, value));
  });
  if (children.length === 0) return null;
  return xml("headers", { xmlns: NS_SHIM }, ...children);
}

/** Accepts the parent <req>/<resp> element; missing <headers> → empty set. */
export function decodeHeaders(parent: Element): Headers {
  const headers = new Headers();
  const container = parent.getChild("headers", NS_SHIM);
  if (!container) return headers;

  for (const child of container.getChildren("header")) {
    const name = child.attrs["name"];
    if (name === undefined || name === "") {
      throw new CodecError("<header> element without a name attribute");
    }
    try {
      headers.append(name, child.getText());
    } catch (err) {
      throw new CodecError(`invalid HTTP header "${name}"`, err);
    }
  }
  return headers;
}
