/**
 * Minimal typings for the WebExtension APIs this app touches. The root
 * tsconfig includes this file so `test/browser/` can exercise extension
 * sources; keep it free of `declare module` blocks (see xmpp-client.d.ts).
 */
interface WebExtStorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

interface WebExtDownloads {
  download(options: {
    url: string;
    filename?: string;
    saveAs?: boolean;
  }): Promise<number>;
}

interface WebExtApi {
  storage?: { local: WebExtStorageArea };
  runtime?: { getURL(path: string): string };
  downloads?: WebExtDownloads;
}

// Firefox exposes `browser`, Chromium exposes `chrome` (Promise-based in MV3).
declare const browser: WebExtApi | undefined;
declare const chrome: WebExtApi | undefined;
