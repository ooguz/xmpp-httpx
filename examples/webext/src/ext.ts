/**
 * Firefox exposes `browser`, Chromium exposes `chrome`; both are absent when
 * the page is opened as a plain tab during development, so every caller must
 * cope with `undefined` rather than assume an extension context.
 */
export function extensionApi(): WebExtApi | undefined {
  return (
    (typeof browser !== "undefined" ? browser : undefined) ??
    (typeof chrome !== "undefined" ? chrome : undefined)
  );
}

/**
 * Structured values in `storage.local`, with a `localStorage` + JSON fallback
 * so the page keeps working when opened as a plain tab. Anything unreadable or
 * of the wrong shape reads back as `fallback` rather than throwing — stored
 * state is not worth a broken UI.
 */
export async function readStored<T>(key: string, fallback: T): Promise<T> {
  const area = extensionApi()?.storage?.local;
  try {
    if (area) {
      const stored = (await area.get([key]))[key];
      return stored === undefined ? fallback : (stored as T);
    }
    const raw = localStorage.getItem(`httpx.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export async function writeStored(key: string, value: unknown): Promise<void> {
  const area = extensionApi()?.storage?.local;
  try {
    if (area) {
      await area.set({ [key]: value });
      return;
    }
    localStorage.setItem(`httpx.${key}`, JSON.stringify(value));
  } catch {
    // Quota or private mode: losing history is not worth failing a navigation.
  }
}
