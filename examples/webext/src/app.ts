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
import { applyEmbedded, historyWriteMode } from "./embedded.js";
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
import {
  bufferBody,
  formatProgress,
  type LoadProgress,
  type ProgressCallback,
} from "./progress.js";
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
const loadBar = $<HTMLProgressElement>("loadProgress");
const progressBytes = $<HTMLSpanElement>("progressBytes");
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

const embedded = applyEmbedded(document, window.location.search);

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
  /** Loads in flight; closing must not detach the iframe while any remain. */
  loading: number;
  /** Byte progress of the current load, or null when nothing is loading. */
  progress: LoadProgress | null;
  /** Close was requested mid-load; drop the tab once the loads settle. */
  discard: boolean;
  /**
   * Monotonic id of the newest load started on this tab. A load that awoke
   * from an await to find a newer id bails out instead of rendering: without
   * this, a slow fetch that lost the race would paint its page into the
   * iframe *after* the winner, leaving content and URL disagreeing — reachable
   * standalone via the back/forward buttons, and embedded via two quick host
   * back presses.
   */
  loadSeq: number;
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
    loading: 0,
    progress: null,
    discard: false,
    loadSeq: 0,
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

/**
 * The exact spelling the browser's history stores for a URL placed in the
 * hash: location.hash reads back WHATWG-serialized, with spaces and non-ASCII
 * percent-encoded. Tab URLs are canonicalized to this spelling when visited,
 * so the hash, the per-tab stacks, the cache keys and the wire resource can
 * never disagree about a page's identity. Idempotent — "%" is not in the
 * fragment percent-encode set, so a serialized spelling is a fixed point.
 */
function serializedSpelling(url: string): string {
  return new URL(`#${url}`, window.location.href).hash.slice(1);
}

/**
 * The active tab's URL at the previous chrome sync — how syncChrome tells a
 * real navigation (push-worthy when embedded) from a mere re-spelling of the
 * current page's hash, which must replace: pushing a spelling correction lets
 * one non-canonical hash re-push the canonical entry on every host back press,
 * trapping the traversal forever.
 */
let lastSyncedUrl = "";

/**
 * Every hash spelling this page has itself mirrored into the session history.
 * The hashchange listener uses it to tell a traversal (re-entering an entry we
 * wrote — a revisit) from a fresh navigation arriving through the hash (a URL
 * typed into the host app's toolbar, a hand-edited deep link) — a distinction
 * that matters for attachments: a fresh navigation saves the file, a revisit
 * renders the receipt only.
 */
const mirroredHashes = new Set<string>();

/** Pushes all per-tab state into the shared chrome. */
function syncChrome(): void {
  const tab = tabs.active;
  const res = resourcesFor(tab.id);

  for (const [id, other] of resources) other.iframe.hidden = id !== tab.id;

  address.value = tab.url;
  document.title = tab.url === "" ? "httpx browser" : `${tab.title} — httpx`;
  favicon.setAttribute("href", res.faviconHref);
  showCacheChip(res.cacheState);
  showProgress(res.progress);
  backBtn.disabled = !tabs.canGoBack();
  forwardBtn.disabled = !tabs.canGoForward();
  reloadBtn.disabled = tab.url === "";
  renderTabStrip();

  // The hash mirrors the active tab so deep links stay copyable; it is no
  // longer the source of truth (each tab owns its own back/forward stack).
  // Embedded, the mirror doubles as the session history the host app's back
  // button walks, so page-to-page moves push — see historyWriteMode.
  //
  // Compare (and write) what the browser will *store*: location.hash reads
  // back WHATWG-serialized. Tab URLs are canonicalized to that spelling on
  // visit, and serializedSpelling is idempotent, so this is normally a plain
  // equality — the serialization here only defends entries that predate the
  // canonicalization (old drawer data), where a raw-vs-serialized mismatch
  // would otherwise look like a permanently pending write.
  const hash = tab.url === "" ? "" : `#${serializedSpelling(tab.url)}`;
  const current = window.location.hash.slice(1);
  // A write that merely corrects the spelling of the entry we are on (a typed
  // "#httpx://host" landing on the canonical "httpx://host/") replaces even
  // though the tab URL changed: the entry is the same page, not a move, and
  // pushing it would leave a duplicate entry behind every typo.
  let respelling = false;
  if (current !== "" && `#${current}` !== hash) {
    try {
      respelling =
        serializedSpelling(parseHttpxUrl(normalizeUrl(current)).href) === tab.url;
    } catch {
      respelling = false;
    }
  }
  const navigated = tab.url !== lastSyncedUrl && !respelling;
  lastSyncedUrl = tab.url;
  if (window.location.hash !== hash) {
    // A relative "#…" URL keeps the query string; the empty-tab branch must
    // carry it explicitly or the ?embedded flag would vanish from the URL.
    const bare = window.location.pathname + window.location.search;
    if (historyWriteMode(embedded, navigated, window.location.hash, hash) === "push") {
      history.pushState(null, "", hash);
    } else {
      history.replaceState(null, "", hash === "" ? bare : hash);
    }
  }
  if (hash !== "") mirroredHashes.add(hash.slice(1));
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
  // Two inputs arrive wholly percent-encoded and are decoded: the Firefox
  // protocol handler's %s placeholder ("ext+httpx://…", possibly itself
  // encoded), and the background script's omnibox deep link, which builds
  // "browser.html#" + encodeURIComponent(url) — an encoded scheme separator
  // ("httpx%3A") never occurs in a real URL, so the test cannot misfire.
  // Everything else — links, forms, the drawer, history traversals — is
  // already correctly encoded; decoding those corrupts the request (%23 in a
  // form value becomes "#" and truncates the query at the fragment, %26
  // becomes "&" and splits parameters).
  if (/^(ext\+|ext%2b)httpx|^httpx%3a/i.test(url)) {
    try {
      url = decodeURIComponent(url).trim();
    } catch {
      // A literal % in the path — use the raw value.
    }
    if (url.toLowerCase().startsWith("ext+httpx://")) {
      url = `httpx://${url.slice("ext+httpx://".length)}`;
    }
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
 * the URL they targeted, the way browsers treat unsafe methods. Returns the
 * cache state instead of storing it: the caller applies it only if its load is
 * still current, so a superseded fetch cannot mislabel the winner's chip.
 */
async function fetchThroughCache(
  href: string,
  init: { method?: "GET" | "POST"; body?: URLSearchParams; reload?: boolean },
  onProgress?: ProgressCallback,
): Promise<{ response: Response; state: CacheState }> {
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
    return { response, state: "bypass" };
  }

  return cachedFetch(href, request, {
    ...(init.reload ? { reload: true } : {}),
    ...(onProgress ? { onProgress } : {}),
  });
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

/**
 * The thin bar under the chrome (visible in embedded mode too — the host app
 * has no window onto this page's transfers) plus a byte chip next to the cache
 * chip. Indeterminate until a usable Content-Length arrives with the response.
 */
function showProgress(progress: LoadProgress | null): void {
  if (progress === null) {
    loadBar.hidden = true;
    progressBytes.hidden = true;
    return;
  }
  if (progress.total !== null && progress.total > 0) {
    loadBar.max = progress.total;
    loadBar.value = progress.received;
  } else {
    // A <progress> with no value attribute renders indeterminate; assigning
    // .value sets the attribute, so switching back means removing it.
    loadBar.removeAttribute("value");
  }
  const label = formatProgress(progress);
  loadBar.title = label;
  loadBar.setAttribute("aria-label", `Loading: ${label}`);
  progressBytes.textContent = label;
  loadBar.hidden = false;
  progressBytes.hidden = false;
}

/**
 * Navigates the active tab, recording the move in that tab's history.
 * `revisit` marks a navigation that re-enters a URL from history (a host
 * back/forward traversal, a hand-edited hash) rather than a fresh activation —
 * an attachment reached that way renders its receipt without saving again.
 */
async function navigate(
  rawUrl: string,
  opts: { revisit?: boolean } = {},
): Promise<void> {
  const url = normalizeUrl(rawUrl);
  if (url === "") return;

  let href: string;
  try {
    href = serializedSpelling(parseHttpxUrl(url).href);
  } catch (err) {
    // The typo still takes an entry — like a browser's error page — so a host
    // back/forward walks over it consistently instead of finding the hash and
    // the rendered page disagreeing about where it is.
    tabs.visit(serializedSpelling(url));
    await showError(tabs.active.id, `Not an httpx URL: ${url}`, err);
    return;
  }

  tabs.visit(href);
  syncChrome();
  await load(href, opts.revisit ? { revisit: true } : {});
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
    revisit?: boolean;
  } = {},
): Promise<void> {
  const tab = tabs.active;
  const res = resourcesFor(tab.id);
  const isActive = () => tabs.active.id === tab.id;
  const seq = ++res.loadSeq;
  // Checked after every await that can outlast a newer load on this tab; the
  // remaining unguarded window (inside a render, single-digit ms) is accepted.
  const fresh = () => res.loadSeq === seq;

  releasePage(res);
  res.loading += 1;
  // Progress belongs to this load; a superseded load must not drive the
  // winner's bar, so every report re-checks freshness.
  const onProgress: ProgressCallback = (progress) => {
    if (!fresh()) return;
    res.progress = progress;
    if (isActive()) showProgress(progress);
  };
  onProgress({ received: 0, total: null });

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

    const { response, state } = await fetchThroughCache(href, init, onProgress);
    if (!fresh()) return;
    res.cacheState = state;
    const contentType = response.headers.get("content-type") ?? "";
    const disposition = response.headers.get("content-disposition");
    // Where the wait happens decides who reports: the cache layer buffers (and
    // reports) every response it touches, so consuming those again is instant
    // and must stay silent — replaying the count would snap the bar back to
    // zero. Only a "bypass" response (POST, degraded no-Cache-API mode) is
    // still the live network stream when it reaches the reads below.
    const report = state === "bypass" ? onProgress : undefined;

    if (response.status === 204 || response.status === 205) {
      // No content to paint. A mainstream browser stays on the page when a
      // form POST answers 204, but this model commits the navigation before
      // the status is known — so an explicit receipt beats rendering the
      // empty body as a blank page. Not recorded as a visit: not a page.
      res.pageTitle = undefined;
      tabs.setTitle(tab.id, `(${response.status}) ${href}`);
      await renderError(
        res.iframe,
        {
          icon: "✓",
          heading: "Nothing to show",
          detail: `The server accepted the request and answered ${response.status} — there is no content to display.\n${href}`,
          actions: [{ id: "back", label: "Back" }],
        },
        () => {
          const url = tabs.back();
          syncChrome();
          if (url) void load(url, { revisit: true });
        },
      );
      if (isActive()) syncChrome();
      return;
    }

    if (isAttachment(disposition) || !isRenderableType(contentType)) {
      // A saved file is not a page: no title, no drawer entry. A revisit gets
      // the receipt only, never a save; its unread body is cancelled, which
      // skips the transfer on the cache-bypass path (a Cache-API-backed fetch
      // may already have buffered it). The receipt's button re-loads fresh.
      let blob: Blob | null = null;
      if (init.revisit) {
        void response.body?.cancel().catch(() => {});
      } else {
        blob = await bufferBody(response, report);
        if (!fresh()) return;
      }
      await download(href, tab.id, res, blob, contentType, disposition);
      if (isActive()) syncChrome();
      return;
    }

    if (contentType.includes("text/html")) {
      const html = await (await bufferBody(response, report)).text();
      if (!fresh()) return;
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
      const blob = await bufferBody(response, report);
      if (!fresh()) return;
      res.cleanup = await renderPlain(contentType, blob, {
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
    if (fresh()) {
      await showError(tab.id, `Failed to load ${href}`, err);
    } else {
      // A superseded load's failure must not overwrite the winner's page.
      console.warn("[httpx] superseded load failed:", href, err);
    }
  } finally {
    res.loading -= 1;
    // Cleared only while still the newest load: a superseded load settling
    // late must not take down the bar its successor is driving.
    if (fresh()) {
      res.progress = null;
      if (isActive()) showProgress(null);
    }
    if (res.discard && res.loading === 0) {
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
    supersedeLoads(res);
    showProgress(null); // res is the active tab's by construction
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
  const target = serializedSpelling(submission.url);
  tabs.visit(target);
  syncChrome();
  await load(target, { method: "POST", body: submission.body });
}

/**
 * Content the viewport can't show is saved instead, with a receipt page.
 * A null blob renders the receipt without saving (a revisit via history
 * traversal must not re-save a file with no user gesture); the receipt's
 * button then loads fresh and saves.
 */
async function download(
  href: string,
  id: number,
  res: TabResources,
  blob: Blob | null,
  contentType: string,
  disposition: string | null,
): Promise<void> {
  const filename = filenameFor(href, disposition);
  if (blob) res.cleanup = saveBlob(blob, filename);
  res.pageTitle = filename;
  tabs.setTitle(id, filename);
  await renderError(
    res.iframe,
    {
      icon: "⤓",
      heading: blob ? `Downloading ${filename}` : filename,
      detail: `${href}\n${contentType || "unknown type"}`,
      actions: [{ id: "again", label: blob ? "Download again" : "Download" }],
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

/**
 * Takes a tab over for an error page: any load still in flight on it is
 * superseded exactly as a newer load would supersede it — otherwise its bar
 * keeps advancing over the error page and, worse, its render later paints
 * over it, leaving the address bar and the viewport disagreeing.
 */
function supersedeLoads(res: TabResources): void {
  res.loadSeq += 1;
  res.progress = null;
}

async function showError(id: number, message: string, err: unknown): Promise<void> {
  console.error("[httpx]", message, err);
  const res = resourcesFor(id);
  supersedeLoads(res);
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
// The in-page history buttons are traversals too: an attachment entry crossed
// this way renders its receipt without re-saving the file (see download).
backBtn.addEventListener("click", () => {
  const url = tabs.back();
  syncChrome();
  if (url) void load(url, { revisit: true });
});
forwardBtn.addEventListener("click", () => {
  const url = tabs.forward();
  syncChrome();
  if (url) void load(url, { revisit: true });
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

// A deep link, a hand-edited hash, or — embedded — the host app's back and
// forward buttons traversing the entries syncChrome pushed. Our own updates
// use replaceState/pushState, which fire no hashchange, so this cannot loop;
// and because a traversal lands here with the location already updated, the
// navigate below re-syncs without writing a duplicate history entry.
window.addEventListener("hashchange", () => {
  const wanted = window.location.hash.slice(1);
  if (wanted !== "" && wanted !== tabs.active.url) {
    // A spelling this page itself mirrored into the history is a traversal
    // re-entering an existing entry — a revisit. Anything else (a URL typed
    // into the host app's toolbar, a hand-edited deep link) is a fresh
    // navigation: the difference decides whether an attachment saves.
    void navigate(wanted, { revisit: mirroredHashes.has(wanted) });
  }
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
  // The user may have navigated while the auto-connect was in flight (the
  // hashchange listener is already live); that choice wins over the boot
  // hash, and re-navigating it retries the load now that the session is up.
  const target = tabs.active.url || initial;
  if (target) {
    void navigate(target);
  } else {
    void renderNewTabPage(resourcesFor(tabs.active.id).iframe);
    if (connection.state !== "online") settingsDialog.showModal();
  }
})();
