import type { Element } from "@xmpp/xml";

/**
 * The middleware context passed to iqCallee handlers by @xmpp/middleware.
 * Only the fields this library uses are modeled.
 */
export interface IqContext {
  stanza: Element;
  /** The single child element of the IQ. */
  element: Element;
  from: { toString(): string } | null;
  to: { toString(): string } | null;
  type: string;
  id: string;
}

export type IqHandler = (
  ctx: IqContext,
) => Element | boolean | Promise<Element | boolean>;

/**
 * Structural interface satisfied by @xmpp/client, @xmpp/component, and the
 * test mock alike. This library never opens connections — hand it a session.
 *
 * Component note: a component receives stanzas addressed to any JID at its
 * domain, so 'from' must be set explicitly on outbound stanzas and streams
 * must be keyed by (to, from) pairs — both handled internally.
 */
export interface XmppSession {
  jid?: { toString(): string } | null;
  send(stanza: Element): Promise<unknown>;
  iqCaller: {
    request(iq: Element, timeoutMs?: number): Promise<Element>;
  };
  iqCallee: {
    get(ns: string, name: string, handler: IqHandler): void;
    set(ns: string, name: string, handler: IqHandler): void;
  };
  on(event: "stanza", listener: (stanza: Element) => void): unknown;
  removeListener(
    event: "stanza",
    listener: (stanza: Element) => void,
  ): unknown;
}

/** "user@domain/resource" → "user@domain". */
export function bareJid(jid: string): string {
  const slash = jid.indexOf("/");
  return slash === -1 ? jid : jid.slice(0, slash);
}

/** Domain part of a JID ("user@domain/resource" → "domain"). */
export function jidDomain(jid: string): string {
  const bare = bareJid(jid);
  const at = bare.lastIndexOf("@");
  return at === -1 ? bare : bare.slice(at + 1);
}

/** Random id for stream/session identifiers; crypto is global on all targets. */
export function generateId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}
