/**
 * Minimal ambient types for @xmpp/client (no upstream types), scoped to the
 * extension. Kept apart from webext-api.d.ts because the root tsconfig pulls
 * *that* file in for `test/browser/` and already declares this module itself —
 * two declarations of one module in one program collide.
 */
declare module "@xmpp/client" {
  export interface XmppEntity {
    jid?: { toString(): string } | null;
    status: string;
    start(): Promise<unknown>;
    stop(): Promise<unknown>;
    send(stanza: unknown): Promise<unknown>;
    iqCaller: { request(iq: unknown, timeoutMs?: number): Promise<unknown> };
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
}
