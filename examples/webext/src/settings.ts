import { extensionApi } from "./ext.js";

export interface ConnectionSettings {
  service: string;
  jid: string;
  password: string;
}

const KEYS = ["service", "jid", "password"];

function extensionStorage() {
  return extensionApi()?.storage?.local;
}

/** Extension storage.local, with a localStorage fallback so the page also
 * works when previewed as a plain tab during development. */
export async function loadSettings(): Promise<Partial<ConnectionSettings>> {
  const area = extensionStorage();
  if (area) {
    return (await area.get(KEYS)) as Partial<ConnectionSettings>;
  }
  const out: Partial<ConnectionSettings> = {};
  for (const key of KEYS) {
    const value = localStorage.getItem(`httpx.${key}`);
    if (value !== null) out[key as keyof ConnectionSettings] = value;
  }
  return out;
}

export async function saveSettings(settings: ConnectionSettings): Promise<void> {
  const area = extensionStorage();
  if (area) {
    await area.set({ ...settings });
    return;
  }
  for (const key of KEYS) {
    localStorage.setItem(`httpx.${key}`, settings[key as keyof ConnectionSettings]);
  }
}
