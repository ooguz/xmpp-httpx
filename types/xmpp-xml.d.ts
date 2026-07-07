/**
 * Ambient type declarations for @xmpp/xml (which ships no types).
 * Element is re-exported from ltx; only the surface this library uses is typed.
 */
declare module "@xmpp/xml" {
  type Node = Element | string;

  export class Element {
    name: string;
    attrs: Record<string, string | undefined>;
    children: Node[];
    parent: Element | null;
    constructor(name: string, attrs?: Record<string, string>);
    is(name: string, xmlns?: string): boolean;
    getName(): string;
    getNS(): string | undefined;
    getAttr(name: string, xmlns?: string): string | undefined;
    getChild(name: string, xmlns?: string): Element | undefined;
    getChildren(name: string, xmlns?: string): Element[];
    getChildElements(): Element[];
    getText(): string;
    getChildText(name: string, xmlns?: string): string | null;
    append(...nodes: Node[]): Element;
    remove(el: Element | string, xmlns?: string): Element;
    text(val?: string): string;
    attr(name: string, val?: string): string | undefined;
    toString(): string;
  }

  export class XMLError extends Error {}

  export function createElement(
    name: string,
    attrs?: Record<string, string | number | boolean | undefined> | null,
    ...children: unknown[]
  ): Element;

  export function escapeXML(s: string): string;
  export function unescapeXML(s: string): string;

  export default function xml(
    name: string,
    attrs?: Record<string, string | number | boolean | undefined> | null,
    ...children: unknown[]
  ): Element;
}

declare module "@xmpp/xml/lib/parse.js" {
  import { Element } from "@xmpp/xml";
  /** Parses a single XML document/stanza; throws XMLError on malformed input. */
  export default function parse(data: string): Element;
}
