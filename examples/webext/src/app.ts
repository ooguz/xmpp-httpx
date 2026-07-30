import { httpxFetch, parseHttpxUrl } from "xmpp-httpx";
import {
  cachedFetch,
  clearCache,
  invalidate,
  setCacheScope,
  type CacheState,
} from "./cache.js";
import { Connection } from "./connection.js";
import { buildDrawerList, type DrawerEntry } from "./drawer.js";
import { filenameFor, isAttachment, isRenderableType, saveBlob } from "./download.js";
import type { FormRefusal, FormSubmission } from "./forms.js";
import {
  clearHistory,
  isBookmarked,
  listBookmarks,
  listHistory,
  recordVisit,
  removeBookmark,
  removeVisit,
  toggleBookmark,
} from "./history.js";
import { extractPageMeta, type PageMeta } from "./page-meta.js";
import { renderError, renderHtml, renderPlain } from "./render.js";
import { loadSettings, saveSettings, type ConnectionSettings } from "./settings.js";

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const address = $<HTMLInputElement>("address");
const viewport = $<HTMLIFrameElement>("viewport");
const status = $<HTMLSpanElement>("status");
const settingsDialog = $<HTMLDialogElement>("settings");
const cacheChip = $<HTMLSpanElement>("cacheState");
const bookmarkBtn = $<HTMLButtonElement>("bookmark");
const drawer = $<HTMLElement>("drawer");
const drawerBtn = $<HTMLButtonElement>("drawerBtn");
const drawerList = $<HTMLUListElement>("drawerList");
const drawerEmpty = $<HTMLParagraphElement>("drawerEmpty");
const favicon = $<HTMLLinkElement>("favicon");
const DEFAULT_FAVICON = favicon.getAttribute("href") ?? "";

const connection = new Connection();
connection.onStateChange = (state) => {
  status.dataset["state"] = state;
  status.textContent =
    state === "online" ? "online" : state === "connecting" ? "connecting…" : "offline";
};

let cleanupPage: (() => void) | undefined;
let revokeFavicon: (() => void) | undefined;
/** Title of the page on screen, for history and bookmarks. */
let pageTitle: string | undefined;

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

const fetchResource = async (resourceUrl: string): Promise<Blob> => {
  const { response } = await cachedFetch(resourceUrl, (headers) =>
    httpxFetch(resourceUrl, {
      session: connection.session,
      ...(headers ? { headers } : {}),
    }),
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.blob();
};

/**
 * GETs go through the HTTP cache; POSTs bypass it and invalidate the entry for
 * the URL they targeted, the way browsers treat unsafe methods.
 */
async function fetchThroughCache(
  href: string,
  init: { method?: "GET" | "POST"; body?: URLSearchParams; reload?: boolean },
): Promise<Response> {
  const request = (headers?: Record<string, string>): Promise<Response> =>
    httpxFetch(href, {
      session: connection.session,
      ...(init.method ? { method: init.method } : {}),
      ...(init.body ? { body: init.body } : {}),
      ...(headers ? { headers } : {}),
    });

  if (init.method === "POST") {
    const response = await request();
    await invalidate(href);
    showCacheState("bypass");
    return response;
  }

  const { response, state } = await cachedFetch(href, request, {
    ...(init.reload ? { reload: true } : {}),
  });
  showCacheState(state);
  return response;
}

const CACHE_LABELS: Record<CacheState, string> = {
  hit: "cache",
  revalidated: "304",
  miss: "network",
  bypass: "",
};

function showCacheState(state: CacheState): void {
  const label = CACHE_LABELS[state];
  cacheChip.textContent = label;
  cacheChip.dataset["state"] = state;
  cacheChip.hidden = label === "";
  cacheChip.title =
    state === "hit"
      ? "Served from the local cache without contacting the server"
      : state === "revalidated"
        ? "Server confirmed the cached copy with a 304"
        : "Fetched over XMPP";
}

async function navigate(rawUrl: string): Promise<void> {
  const url = normalizeUrl(rawUrl);
  if (url === "") return;

  let href: string;
  try {
    href = parseHttpxUrl(url).href;
  } catch (err) {
    await showError(`Not an httpx URL: ${url}`, err);
    return;
  }

  address.value = href;
  if (`#${href}` !== window.location.hash) {
    window.location.hash = href; // history entry; hashchange re-enters below
    return;
  }

  if (connection.state !== "online") {
    await renderError(
      viewport,
      {
        heading: "Not connected",
        detail: `Connect to an XMPP account to load ${href}.`,
        actions: [
          { id: "connect", label: "Connection settings" },
          { id: "retry", label: "Retry" },
        ],
      },
      (action) => {
        if (action === "connect") settingsDialog.showModal();
        else void navigate(href);
      },
    );
    settingsDialog.showModal();
    return;
  }

  await load(href);
}

/**
 * Fetches and displays one httpx URL. Split out of `navigate` so a POST
 * submission can reuse the whole render/download path without touching the
 * hash — POST results are not bookmarkable, so they get no history entry.
 */
async function load(
  href: string,
  init: {
    method?: "GET" | "POST";
    body?: URLSearchParams;
    reload?: boolean;
  } = {},
): Promise<void> {
  resetPage(href);
  address.value = href;

  try {
    const response = await fetchThroughCache(href, init);
    const contentType = response.headers.get("content-type") ?? "";
    const disposition = response.headers.get("content-disposition");

    if (isAttachment(disposition) || !isRenderableType(contentType)) {
      await download(href, response, disposition);
      return; // a saved file is not a page in history
    }

    if (contentType.includes("text/html")) {
      const html = await response.text();
      const meta = extractPageMeta(html, href);
      cleanupPage = await renderHtml(html, href, {
        iframe: viewport,
        fetchResource,
        onNavigate: (nextUrl) => void navigate(nextUrl),
        onSubmit: (submission, reason) => void submitForm(submission, reason),
      });
      applyPageMeta(href, meta);
      pageTitle = meta.title;
    } else {
      cleanupPage = await renderPlain(contentType, await response.blob(), {
        iframe: viewport,
      });
      pageTitle = undefined;
    }

    if (!response.ok) {
      document.title = `(${response.status}) ${document.title}`;
    }

    // POST results are not addressable, so they are not history either.
    if (init.method !== "POST" && response.ok) {
      await recordVisit(href, pageTitle);
      if (isDrawerOpen()) await renderDrawer();
    }
    await refreshBookmarkButton(href);
  } catch (err) {
    await showError(`Failed to load ${href}`, err);
  }
}

const REFUSAL_REASONS: Record<FormRefusal, string> = {
  "external-action": "This form posts to a non-httpx address, which this browser cannot submit.",
  "file-upload": "File uploads are not supported over httpx.",
  multipart: "This form uses multipart/form-data; only urlencoded forms are supported.",
};

/** GET submissions navigate; POST submissions render in place. */
async function submitForm(
  submission: FormSubmission | null,
  reason: FormRefusal | null,
): Promise<void> {
  if (!submission) {
    const current = address.value;
    await renderError(
      viewport,
      {
        heading: "Form not submitted",
        detail: reason ? REFUSAL_REASONS[reason] : "Unsupported form.",
        actions: [{ id: "back", label: "Back to the page" }],
      },
      () => void load(current),
    );
    return;
  }
  if (submission.method === "GET") {
    await navigate(submission.url);
    return;
  }
  await load(submission.url, { method: "POST", body: submission.body });
}

/** Content the viewport can't show is saved instead, with a receipt page. */
async function download(
  href: string,
  response: Response,
  disposition: string | null,
): Promise<void> {
  const filename = filenameFor(href, disposition);
  const revoke = saveBlob(await response.blob(), filename);
  cleanupPage = revoke;
  document.title = `${filename} — httpx`;
  await renderError(
    viewport,
    {
      heading: `Downloading ${filename}`,
      detail: `${href}\n${response.headers.get("content-type") ?? "unknown type"}`,
      actions: [{ id: "again", label: "Download again" }],
    },
    () => void navigate(href),
  );
}

/** Clears the previous page's resources and resets per-page chrome. */
function resetPage(href: string): void {
  cleanupPage?.();
  cleanupPage = undefined;
  revokeFavicon?.();
  revokeFavicon = undefined;
  favicon.setAttribute("href", DEFAULT_FAVICON);
  document.title = `${href} — httpx`;
}

function applyPageMeta(href: string, meta: PageMeta): void {
  document.title = meta.title ? `${meta.title} — httpx` : `${href} — httpx`;
  if (meta.iconUrl) void loadFavicon(meta.iconUrl);
}

/**
 * Page-declared icons are always httpx (see page-meta.ts) and are fetched over
 * the session into a blob URL: the extension page itself never issues a remote
 * request on a page's behalf.
 */
async function loadFavicon(iconUrl: string): Promise<void> {
  try {
    const blob = await fetchResource(iconUrl);
    const url = URL.createObjectURL(blob);
    revokeFavicon = () => URL.revokeObjectURL(url);
    favicon.setAttribute("href", url);
  } catch {
    // A missing favicon is not worth reporting.
  }
}

// --- history & bookmarks drawer ------------------------------------------------

type DrawerPanel = "history" | "bookmarks";
let panel: DrawerPanel = "history";

async function refreshBookmarkButton(href: string): Promise<void> {
  const marked = await isBookmarked(href);
  bookmarkBtn.textContent = marked ? "★" : "☆";
  bookmarkBtn.setAttribute("aria-pressed", String(marked));
  bookmarkBtn.title = marked ? "Remove bookmark" : "Bookmark this page";
}

async function renderDrawer(): Promise<void> {
  const entries: DrawerEntry[] =
    panel === "history"
      ? (await listHistory()).map((e) => ({ url: e.url, title: e.title }))
      : (await listBookmarks()).map((m) => ({ url: m.url, title: m.title }));

  drawerList.replaceChildren(
    buildDrawerList(entries, {
      onOpen: (url) => void navigate(url),
      onRemove: (url) =>
        void (async () => {
          if (panel === "history") await removeVisit(url);
          else await removeBookmark(url);
          await renderDrawer();
          await refreshBookmarkButton(address.value);
        })(),
      removeLabel: panel === "history" ? "Forget this page" : "Remove bookmark",
    }),
  );
  drawerEmpty.hidden = entries.length > 0;
  drawerEmpty.textContent =
    panel === "history" ? "No pages visited yet." : "No bookmarks yet.";
}

/** `hidden` is typed `boolean | "until-found"`, so compare rather than negate. */
function isDrawerOpen(): boolean {
  return drawer.hidden === false;
}

function setDrawerOpen(open: boolean): void {
  drawer.hidden = !open;
  drawerBtn.setAttribute("aria-expanded", String(open));
  if (open) void renderDrawer();
}

async function showError(message: string, err: unknown): Promise<void> {
  console.error("[httpx]", message, err);
  resetPage(address.value || message);
  document.title = `${message} — httpx`;
  await renderError(
    viewport,
    {
      heading: message,
      detail: err instanceof Error ? err.message : String(err),
      actions: [{ id: "retry", label: "Retry" }],
    },
    () => void navigate(address.value),
  );
}

// --- chrome wiring ----------------------------------------------------------

$<HTMLFormElement>("nav").addEventListener("submit", (event) => {
  event.preventDefault();
  void navigate(address.value);
});
$<HTMLButtonElement>("back").addEventListener("click", () => history.back());
$<HTMLButtonElement>("forward").addEventListener("click", () => history.forward());
$<HTMLButtonElement>("reload").addEventListener("click", () => {
  // Reload skips the freshness check but still revalidates: an unchanged page
  // costs one 304 instead of a whole body.
  const current = window.location.hash.slice(1);
  if (current) void load(parseHttpxUrl(normalizeUrl(current)).href, { reload: true });
});
$<HTMLButtonElement>("clearCache").addEventListener("click", () => {
  void clearCache().then(() => showCacheState("bypass"));
});
$<HTMLButtonElement>("settingsBtn").addEventListener("click", () => {
  settingsDialog.showModal();
});

drawerBtn.addEventListener("click", () => setDrawerOpen(!isDrawerOpen()));
$<HTMLButtonElement>("drawerClose").addEventListener("click", () =>
  setDrawerOpen(false),
);
$<HTMLButtonElement>("drawerClear").addEventListener("click", () => {
  void (async () => {
    if (panel === "history") await clearHistory();
    else for (const mark of await listBookmarks()) await removeBookmark(mark.url);
    await renderDrawer();
    await refreshBookmarkButton(address.value);
  })();
});
for (const tab of $<HTMLDivElement>("drawerTabs").querySelectorAll("[data-panel]")) {
  tab.addEventListener("click", () => {
    panel = tab.getAttribute("data-panel") === "bookmarks" ? "bookmarks" : "history";
    for (const other of $<HTMLDivElement>("drawerTabs").querySelectorAll("[data-panel]")) {
      other.setAttribute("aria-selected", String(other === tab));
    }
    $<HTMLButtonElement>("drawerClear").title =
      panel === "history" ? "Clear history" : "Remove all bookmarks";
    void renderDrawer();
  });
}

bookmarkBtn.addEventListener("click", () => {
  void (async () => {
    const href = address.value;
    if (href === "") return;
    await toggleBookmark(href, pageTitle);
    await refreshBookmarkButton(href);
    if (isDrawerOpen() && panel === "bookmarks") await renderDrawer();
  })();
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
      setCacheScope(settings.jid);
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
      setCacheScope(saved.jid);
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
