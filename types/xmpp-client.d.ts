/**
 * Minimal ambient types for @xmpp/client and @xmpp/component (no upstream
 * types). Only the surface used by the E2E suite is modeled; the returned
 * entities structurally satisfy this library's XmppSession interface.
 */
declare module "@xmpp/client" {
  import { Element } from "@xmpp/xml";

  export interface XmppEntity {
    jid?: { toString(): string } | null;
    status: string;
    start(): Promise<unknown>;
    stop(): Promise<unknown>;
    send(stanza: Element): Promise<unknown>;
    iqCaller: {
      request(iq: Element, timeoutMs?: number): Promise<Element>;
    };
    iqCallee: {
      get(ns: string, name: string, handler: unknown): void;
      set(ns: string, name: string, handler: unknown): void;
    };
    on(event: string, listener: (arg: never) => void): unknown;
    removeListener(event: string, listener: (arg: never) => void): unknown;
  }

  export function client(options: {
    service: string;
    domain?: string;
    resource?: string;
    username?: string;
    password?: string;
  }): XmppEntity;

  export { default as xml } from "@xmpp/xml";
}

declare module "@xmpp/component" {
  import type { XmppEntity } from "@xmpp/client";

  export function component(options: {
    service: string;
    domain: string;
    password: string;
  }): XmppEntity;
}
