/** Minimal typings for the WebExtension APIs this app touches. */
interface WebExtStorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

interface WebExtApi {
  storage?: { local: WebExtStorageArea };
  runtime?: { getURL(path: string): string };
}

// Firefox exposes `browser`, Chromium exposes `chrome` (Promise-based in MV3).
declare const browser: WebExtApi | undefined;
declare const chrome: WebExtApi | undefined;

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
