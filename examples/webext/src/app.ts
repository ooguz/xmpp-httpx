import { httpxFetch, parseHttpxUrl } from "xmpp-httpx";
import { Connection } from "./connection.js";
import { renderHtml, renderPlain } from "./render.js";
import { loadSettings, saveSettings, type ConnectionSettings } from "./settings.js";

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const address = $<HTMLInputElement>("address");
const viewport = $<HTMLIFrameElement>("viewport");
const status = $<HTMLSpanElement>("status");
const settingsDialog = $<HTMLDialogElement>("settings");

const connection = new Connection();
connection.onStateChange = (state) => {
  status.dataset["state"] = state;
  status.textContent =
    state === "online" ? "online" : state === "connecting" ? "connecting…" : "offline";
};

let cleanupPage: (() => void) | undefined;

/** "ext+httpx://…" (Firefox protocol handler) → "httpx://…". */
function normalizeUrl(raw: string): string {
  let url = raw.trim();
  try {
    url = decodeURIComponent(url).trim();
  } catch {
    // A literal % in the path — use the raw value.
  }
  if (url.toLowerCase().startsWith("ext+httpx://")) {
    url = `httpx://${url.slice("ext+httpx://".length)}`;
  }
  if (url !== "" && !url.includes("://")) {
    url = `httpx://${url}`;
  }
  return url;
}

async function navigate(rawUrl: string): Promise<void> {
  const url = normalizeUrl(rawUrl);
  if (url === "") return;

  let href: string;
  try {
    href = parseHttpxUrl(url).href;
  } catch (err) {
    showError(`Not an httpx URL: ${url}`, err);
    return;
  }

  address.value = href;
  if (`#${href}` !== window.location.hash) {
    window.location.hash = href; // history entry; hashchange re-enters below
    return;
  }

  if (connection.state !== "online") {
    settingsDialog.showModal();
    return;
  }

  cleanupPage?.();
  cleanupPage = undefined;
  document.title = `${href} — httpx`;

  try {
    const response = await httpxFetch(href, { session: connection.session });
    const contentType = response.headers.get("content-type") ?? "";

    if (contentType.includes("text/html")) {
      cleanupPage = await renderHtml(await response.text(), href, {
        iframe: viewport,
        fetchResource: async (resourceUrl) => {
          const r = await httpxFetch(resourceUrl, { session: connection.session });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.blob();
        },
        onNavigate: (nextUrl) => void navigate(nextUrl),
      });
    } else {
      cleanupPage = await renderPlain(contentType, await response.blob(), {
        iframe: viewport,
      });
    }

    if (!response.ok) {
      document.title = `(${response.status}) ${href} — httpx`;
    }
  } catch (err) {
    showError(`Failed to load ${href}`, err);
  }
}

function showError(message: string, err: unknown): void {
  console.error("[httpx]", message, err);
  const detail = err instanceof Error ? err.message : String(err);
  viewport.srcdoc = `<body style="font-family: system-ui"><h2>⚠ ${escapeHtml(
    message,
  )}</h2><pre>${escapeHtml(detail)}</pre></body>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- chrome wiring ----------------------------------------------------------

$<HTMLFormElement>("nav").addEventListener("submit", (event) => {
  event.preventDefault();
  void navigate(address.value);
});
$<HTMLButtonElement>("back").addEventListener("click", () => history.back());
$<HTMLButtonElement>("forward").addEventListener("click", () => history.forward());
$<HTMLButtonElement>("reload").addEventListener("click", () => {
  void navigate(window.location.hash.slice(1));
});
$<HTMLButtonElement>("settingsBtn").addEventListener("click", () => {
  settingsDialog.showModal();
});

window.addEventListener("hashchange", () => {
  void navigate(window.location.hash.slice(1));
});

// --- settings ----------------------------------------------------------------

const serviceInput = $<HTMLInputElement>("service");
const jidInput = $<HTMLInputElement>("jid");
const passwordInput = $<HTMLInputElement>("password");

$<HTMLFormElement>("settingsForm").addEventListener("submit", (event) => {
  const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== "connect") return;
  const settings: ConnectionSettings = {
    service: serviceInput.value.trim(),
    jid: jidInput.value.trim(),
    password: passwordInput.value,
  };
  void (async () => {
    await saveSettings(settings);
    try {
      await connection.connect(settings);
      const pending = window.location.hash.slice(1);
      if (pending) void navigate(pending);
    } catch (err) {
      showError("XMPP connection failed", err);
    }
  })();
});

// --- boot ---------------------------------------------------------------------

void (async () => {
  const saved = await loadSettings();
  if (saved.service) serviceInput.value = saved.service;
  if (saved.jid) jidInput.value = saved.jid;
  if (saved.password) passwordInput.value = saved.password;

  const initial = window.location.hash.slice(1);
  if (saved.service && saved.jid) {
    try {
      await connection.connect(saved as ConnectionSettings);
    } catch (err) {
      console.warn("[httpx] auto-connect failed:", err);
    }
  }
  if (initial) {
    void navigate(initial);
  } else if (connection.state !== "online") {
    settingsDialog.showModal();
  }
})();
