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
import { applyEmbedded } from "./embedded.js";
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
import { buildTabStrip } from "./tab-strip.js";
import { TabSet } from "./tabs.js";

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const address = $<HTMLInputElement>("address");
const viewports = $<HTMLDivElement>("viewports");
const tabList = $<HTMLUListElement>("tabs");
const status = $<HTMLSpanElement>("status");
const settingsDialog = $<HTMLDialogElement>("settings");
const cacheChip = $<HTMLSpanElement>("cacheState");
const bookmarkBtn = $<HTMLButtonElement>("bookmark");
const backBtn = $<HTMLButtonElement>("back");
const forwardBtn = $<HTMLButtonElement>("forward");
const reloadBtn = $<HTMLButtonElement>("reload");
const drawer = $<HTMLElement>("drawer");
const drawerBtn = $<HTMLButtonElement>("drawerBtn");
const drawerList = $<HTMLUListElement>("drawerList");
const drawerEmpty = $<HTMLParagraphElement>("drawerEmpty");
const favicon = $<HTMLLinkElement>("favicon");
const DEFAULT_FAVICON = favicon.getAttribute("href") ?? "";

applyEmbedded(document, window.location.search);

const connection = new Connection();
connection.onStateChange = (state) => {
  status.dataset["state"] = state;
  status.textContent =
    state === "online" ? "online" : state === "connecting" ? "connecting…" : "offline";
};

// --- tabs -----------------------------------------------------------------------

/** Everything a tab owns beyond its URL and history (which `TabSet` holds). */
interface TabResources {
  iframe: HTMLIFrameElement;
  /** Revokes the blob URLs of the page currently rendered in this tab. */
  cleanup?: () => void;
  revokeFavicon?: () => void;
  faviconHref: string;
  cacheState: CacheState;
  /** Page title, for bookmarks and history. */
  pageTitle?: string;
  /** A load is in flight; closing must not detach the iframe yet. */
  loading: boolean;
  /** Close was requested mid-load; drop the tab once the load settles. */
  discard: boolean;
}

const tabs = new TabSet();
const resources = new Map<number, TabResources>();

/**
 * One sandboxed iframe per tab, created on demand and kept alive while the tab
 * exists — switching tabs then costs nothing, no refetch. Hidden iframes still
 * load their `srcdoc`, which is what makes a background load work.
 */
function resourcesFor(id: number): TabResources {
  const existing = resources.get(id);
  if (existing) return existing;

  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-same-origin"); // never allow-scripts
  iframe.title = "page content";
  viewports.append(iframe);

  const created: TabResources = {
    iframe,
    faviconHref: DEFAULT_FAVICON,
    cacheState: "bypass",
    loading: false,
    discard: false,
  };
  resources.set(id, created);
  return created;
}

function renderTabStrip(): void {
  const activeId = tabs.active.id;
  tabList.replaceChildren(
    buildTabStrip(
      tabs.tabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        active: tab.id === activeId,
      })),
      { onSelect: selectTab, onClose: closeTab },
    ),
  );
}

/** Pushes all per-tab state into the shared chrome. */
function syncChrome(): void {
  const tab = tabs.active;
  const res = resourcesFor(tab.id);

  for (const [id, other] of resources) other.iframe.hidden = id !== tab.id;

  address.value = tab.url;
  document.title = tab.url === "" ? "httpx browser" : `${tab.title} — httpx`;
  favicon.setAttribute("href", res.faviconHref);
  showCacheChip(res.cacheState);
  backBtn.disabled = !tabs.canGoBack();
  forwardBtn.disabled = !tabs.canGoForward();
  reloadBtn.disabled = tab.url === "";
  renderTabStrip();

  // The hash mirrors the active tab so deep links stay copyable; it is no
  // longer the source of truth (each tab owns its own back/forward stack).
  const hash = tab.url === "" ? "" : `#${tab.url}`;
  if (window.location.hash !== hash) {
    // A relative "#…" URL keeps the query string; the empty-tab branch must
    // carry it explicitly or the ?embedded flag would vanish from the URL.
    const bare = window.location.pathname + window.location.search;
    history.replaceState(null, "", hash === "" ? bare : hash);
  }
  void refreshBookmarkButton(tab.url);
}

function selectTab(id: number): void {
  tabs.activate(id);
  syncChrome();
}

function openTab(url?: string): void {
  const tab = tabs.open();
  const res = resourcesFor(tab.id);
  syncChrome();
  if (url === undefined || url === "") void renderNewTabPage(res.iframe);
  else void navigate(url);
}

function closeTab(id: number): void {
  const res = resources.get(id);
  if (res) {
    res.cleanup?.();
    res.cleanup = undefined;
    res.revokeFavicon?.();
    res.revokeFavicon = undefined;
    if (res.loading) {
      // Detaching now would strand the pending load: a removed iframe never
      // fires `load`, so its promise would never settle and its blob URLs
      // would never be revoked. Let the load finish, then drop the tab.
      res.discard = true;
    } else {
      res.iframe.remove();
      resources.delete(id);
    }
  }

  tabs.close(id);
  const active = tabs.active;
  const activeRes = resourcesFor(active.id);
  syncChrome();
  if (active.url === "" && activeRes.iframe.srcdoc === "") {
    void renderNewTabPage(activeRes.iframe);
  }
}

function renderNewTabPage(iframe: HTMLIFrameElement): Promise<void> {
  return renderError(iframe, {
    icon: "",
    heading: "New tab",
    detail: "Type an httpx:// address above, or open a page from the drawer (☰).",
  });
}

// --- fetching -------------------------------------------------------------------

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
  res: TabResources,
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
    res.cacheState = "bypass";
    return response;
  }

  const { response, state } = await cachedFetch(href, request, {
    ...(init.reload ? { reload: true } : {}),
  });
  res.cacheState = state;
  return response;
}

const CACHE_LABELS: Record<CacheState, string> = {
  hit: "cache",
  revalidated: "304",
  miss: "network",
  bypass: "",
};

function showCacheChip(state: CacheState): void {
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

/** Navigates the active tab, recording the move in that tab's history. */
async function navigate(rawUrl: string): Promise<void> {
  const url = normalizeUrl(rawUrl);
  if (url === "") return;

  let href: string;
  try {
    href = parseHttpxUrl(url).href;
  } catch (err) {
    await showError(tabs.active.id, `Not an httpx URL: ${url}`, err);
    return;
  }

  tabs.visit(href);
  syncChrome();
  await load(href);
}

/**
 * Fetches and displays one URL in one tab. Separate from `navigate` so back,
 * forward, reload and POST submissions can reuse it without touching the tab's
 * history stack.
 */
async function load(
  href: string,
  init: {
    method?: "GET" | "POST";
    body?: URLSearchParams;
    reload?: boolean;
  } = {},
): Promise<void> {
  const tab = tabs.active;
  const res = resourcesFor(tab.id);
  const isActive = () => tabs.active.id === tab.id;

  releasePage(res);
  res.loading = true;

  try {
    if (connection.state !== "online") {
      await renderError(
        res.iframe,
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
          else void load(href);
        },
      );
      settingsDialog.showModal();
      return;
    }

    const response = await fetchThroughCache(href, res, init);
    const contentType = response.headers.get("content-type") ?? "";
    const disposition = response.headers.get("content-disposition");

    if (isAttachment(disposition) || !isRenderableType(contentType)) {
      // A saved file is not a page: no title, no history entry.
      await download(href, tab.id, res, response, disposition);
      if (isActive()) syncChrome();
      return;
    }

    if (contentType.includes("text/html")) {
      const html = await response.text();
      const meta = extractPageMeta(html, href);
      res.cleanup = await renderHtml(html, href, {
        iframe: res.iframe,
        fetchResource,
        onNavigate: (nextUrl) => {
          tabs.activate(tab.id);
          void navigate(nextUrl);
        },
        onSubmit: (submission, reason) => {
          tabs.activate(tab.id);
          void submitForm(submission, reason);
        },
      });
      applyPageMeta(tab.id, res, href, meta);
    } else {
      res.cleanup = await renderPlain(contentType, await response.blob(), {
        iframe: res.iframe,
      });
      res.pageTitle = undefined;
      tabs.setTitle(tab.id, href);
    }

    if (!response.ok) {
      tabs.setTitle(tab.id, `(${response.status}) ${tab.title}`);
    }

    // POST results are not addressable, so they are not history either.
    if (init.method !== "POST" && response.ok) {
      await recordVisit(href, res.pageTitle);
      if (isDrawerOpen()) await renderDrawer();
    }
    if (isActive()) syncChrome();
  } catch (err) {
    await showError(tab.id, `Failed to load ${href}`, err);
  } finally {
    res.loading = false;
    if (res.discard) {
      res.cleanup?.();
      res.iframe.remove();
      resources.delete(tab.id);
    }
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
  const res = resourcesFor(tabs.active.id);
  if (!submission) {
    const current = tabs.active.url;
    await renderError(
      res.iframe,
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
  // A POST result *is* the tab's current page, so it takes the tab's URL and a
  // stack entry — otherwise the address bar would revert to the form's page on
  // the next chrome sync. It stays out of the persistent visit history (the
  // drawer) because it is not something to reopen later. Back/forward onto it
  // re-issues a plain GET; the body is not replayed.
  tabs.visit(submission.url);
  syncChrome();
  await load(submission.url, { method: "POST", body: submission.body });
}

/** Content the viewport can't show is saved instead, with a receipt page. */
async function download(
  href: string,
  id: number,
  res: TabResources,
  response: Response,
  disposition: string | null,
): Promise<void> {
  const filename = filenameFor(href, disposition);
  res.cleanup = saveBlob(await response.blob(), filename);
  res.pageTitle = filename;
  tabs.setTitle(id, filename);
  await renderError(
    res.iframe,
    {
      icon: "⤓",
      heading: `Downloading ${filename}`,
      detail: `${href}\n${response.headers.get("content-type") ?? "unknown type"}`,
      actions: [{ id: "again", label: "Download again" }],
    },
    () => void load(href),
  );
}

/** Drops the resources of whatever this tab was showing. */
function releasePage(res: TabResources): void {
  res.cleanup?.();
  res.cleanup = undefined;
  res.revokeFavicon?.();
  res.revokeFavicon = undefined;
  res.faviconHref = DEFAULT_FAVICON;
  res.pageTitle = undefined;
}

function applyPageMeta(
  id: number,
  res: TabResources,
  href: string,
  meta: PageMeta,
): void {
  res.pageTitle = meta.title;
  tabs.setTitle(id, meta.title ?? href);
  if (meta.iconUrl) void loadFavicon(id, res, meta.iconUrl);
}

/**
 * Page-declared icons are always httpx (see page-meta.ts) and are fetched over
 * the session into a blob URL: the extension page itself never issues a remote
 * request on a page's behalf.
 */
async function loadFavicon(
  id: number,
  res: TabResources,
  iconUrl: string,
): Promise<void> {
  try {
    const blob = await fetchResource(iconUrl);
    const url = URL.createObjectURL(blob);
    res.revokeFavicon = () => URL.revokeObjectURL(url);
    res.faviconHref = url;
    if (tabs.active.id === id) favicon.setAttribute("href", url);
  } catch {
    // A missing favicon is not worth reporting.
  }
}

async function showError(id: number, message: string, err: unknown): Promise<void> {
  console.error("[httpx]", message, err);
  const res = resourcesFor(id);
  releasePage(res);
  tabs.setTitle(id, message);
  if (tabs.active.id === id) syncChrome();
  await renderError(
    res.iframe,
    {
      heading: message,
      detail: err instanceof Error ? err.message : String(err),
      actions: [{ id: "retry", label: "Retry" }],
    },
    () => {
      const url = tabs.tabs.find((tab) => tab.id === id)?.url;
      if (url) void load(url);
    },
  );
}

// --- history & bookmarks drawer ------------------------------------------------

type DrawerPanel = "history" | "bookmarks";
let panel: DrawerPanel = "history";

async function refreshBookmarkButton(href: string): Promise<void> {
  const marked = href !== "" && (await isBookmarked(href));
  bookmarkBtn.textContent = marked ? "★" : "☆";
  bookmarkBtn.setAttribute("aria-pressed", String(marked));
  bookmarkBtn.disabled = href === "";
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
          await refreshBookmarkButton(tabs.active.url);
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

// --- chrome wiring ----------------------------------------------------------

$<HTMLFormElement>("nav").addEventListener("submit", (event) => {
  event.preventDefault();
  void navigate(address.value);
});
backBtn.addEventListener("click", () => {
  const url = tabs.back();
  syncChrome();
  if (url) void load(url);
});
forwardBtn.addEventListener("click", () => {
  const url = tabs.forward();
  syncChrome();
  if (url) void load(url);
});
reloadBtn.addEventListener("click", () => {
  // Reload skips the freshness check but still revalidates: an unchanged page
  // costs one 304 instead of a whole body.
  const { url } = tabs.active;
  if (url !== "") void load(url, { reload: true });
});
$<HTMLButtonElement>("newTab").addEventListener("click", () => openTab());
$<HTMLButtonElement>("clearCache").addEventListener("click", () => {
  void clearCache().then(() => {
    for (const res of resources.values()) res.cacheState = "bypass";
    showCacheChip("bypass");
  });
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
    await refreshBookmarkButton(tabs.active.url);
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
    const { url, id } = tabs.active;
    if (url === "") return;
    await toggleBookmark(url, resourcesFor(id).pageTitle);
    await refreshBookmarkButton(url);
    if (isDrawerOpen() && panel === "bookmarks") await renderDrawer();
  })();
});

// A deep link or a hand-edited hash: load it into the active tab. Our own
// updates use replaceState, which fires no hashchange, so this cannot loop.
window.addEventListener("hashchange", () => {
  const wanted = window.location.hash.slice(1);
  if (wanted !== "" && wanted !== tabs.active.url) void navigate(wanted);
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
      const pending = tabs.active.url || window.location.hash.slice(1);
      if (pending) void navigate(pending);
    } catch (err) {
      void showError(tabs.active.id, "XMPP connection failed", err);
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

  syncChrome();
  if (initial) {
    void navigate(initial);
  } else {
    void renderNewTabPage(resourcesFor(tabs.active.id).iframe);
    if (connection.state !== "online") settingsDialog.showModal();
  }
})();
