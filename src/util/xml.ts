import { Element } from "@xmpp/xml";

/** Deep-copies an element (ltx's Element has no instance clone method). */
export function cloneElement(el: Element): Element {
  const attrs: Record<string, string> = {};
  for (const [name, value] of Object.entries(el.attrs)) {
    if (value !== undefined) attrs[name] = value;
  }
  const copy = new Element(el.name, attrs);
  for (const child of el.children) {
    copy.append(typeof child === "string" ? child : cloneElement(child));
  }
  return copy;
}
