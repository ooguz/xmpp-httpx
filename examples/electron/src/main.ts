import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  app,
  BaseWindow,
  ipcMain,
  protocol,
  session as electronSession,
  WebContentsView,
} from "electron";
import { client } from "@xmpp/client";
import type { XmppSession } from "xmpp-httpx";
import {
  createHttpxProtocolHandler,
  toDisplayUrl,
  toNavigableUrl,
} from "./protocol.js";

/**
 * The main process: it owns the XMPP connection *and* the `httpx` scheme, which
 * is the whole architectural difference from the WebExtension. There, the
 * connection had to live in a tab page and every subresource was rewritten to a
 * blob URL by hand. Here Chromium fetches `httpx://` itself, so pages, images,
 * stylesheets, forms, downloads and history all work the way they do for http.
 *
 * Content lives in `WebContentsView`s — one per tab, sandboxed, no Node, no
 * preload — while the chrome (address bar, tab strip) is a separate view that
 * does have a preload. The two never share a renderer.
 */

const NEW_TAB_URL = "about:blank";

/**
 * The URL an OS handler would pass us. A `.desktop` entry or Windows registry
 * key launches this binary with the URL as an argument, and a second launch
 * while we are already running arrives via `second-instance` — so both paths
 * feed the same function.
 */
function httpxUrlFromArgv(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.toLowerCase().startsWith("httpx://"));
}

interface Settings {
  service: string;
  jid: string;
  password: string;
}

interface Tab {
  id: number;
  view: WebContentsView;
}

const CHROME_HEIGHT = 88;

let connection: ReturnType<typeof client> | null = null;
let xmppSession: XmppSession | null = null;
let connectionState: "offline" | "connecting" | "online" = "offline";

const tabs: Tab[] = [];
let activeTabId = 0;
let nextTabId = 1;
let window: BaseWindow | undefined;
let chromeView: WebContentsView | undefined;

// --- settings ------------------------------------------------------------------

const settingsPath = (): string => join(app.getPath("userData"), "settings.json");

async function loadSettings(): Promise<Partial<Settings>> {
  try {
    return JSON.parse(await readFile(settingsPath(), "utf8")) as Partial<Settings>;
  } catch {
    return {};
  }
}

async function saveSettings(settings: Settings): Promise<void> {
  // Plaintext, like the extension's storage.local — demo-grade, and said so in
  // the README rather than pretended otherwise.
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
}

// --- XMPP ----------------------------------------------------------------------

async function connect(settings: Settings): Promise<void> {
  await disconnect();

  const [username = "", domain = ""] = settings.jid.split("@", 2);
  const entity = client({
    service: settings.service,
    domain,
    username,
    password: settings.password,
    resource: "httpx-shell",
  });
  entity.on("error", (err: unknown) => console.error("[shell] stream error:", err));
  entity.on("offline", () => {
    connectionState = "offline";
    publishState();
  });
  entity.on("online", () => {
    connectionState = "online";
    publishState();
    reloadHttpxTabs();
  });

  connectionState = "connecting";
  publishState();
  connection = entity;
  await entity.start();
  xmppSession = entity as unknown as XmppSession;
  connectionState = "online";
  publishState();
}

async function disconnect(): Promise<void> {
  const entity = connection;
  connection = null;
  xmppSession = null;
  connectionState = "offline";
  if (entity) await entity.stop().catch(() => undefined);
}

// --- tabs ----------------------------------------------------------------------

function layout(): void {
  if (!window || !chromeView) return;
  const { width, height } = window.getContentBounds();
  chromeView.setBounds({ x: 0, y: 0, width, height: CHROME_HEIGHT });
  for (const tab of tabs) {
    tab.view.setBounds({
      x: 0,
      y: CHROME_HEIGHT,
      width,
      height: Math.max(0, height - CHROME_HEIGHT),
    });
    tab.view.setVisible(tab.id === activeTabId);
  }
}

function tabState(): unknown {
  const active = tabs.find((tab) => tab.id === activeTabId);
  return {
    connection: connectionState,
    activeId: activeTabId,
    // The address bar shows the JID, not the host encoding it travelled in.
    url: active ? toDisplayUrl(active.view.webContents.getURL()) : "",
    canGoBack: active?.view.webContents.navigationHistory.canGoBack() ?? false,
    canGoForward: active?.view.webContents.navigationHistory.canGoForward() ?? false,
    tabs: tabs.map((tab) => ({
      id: tab.id,
      title: tab.view.webContents.getTitle() || toDisplayUrl(tab.view.webContents.getURL()),
      url: toDisplayUrl(tab.view.webContents.getURL()),
      active: tab.id === activeTabId,
    })),
  };
}

function publishState(): void {
  chromeView?.webContents.send("httpx:state", tabState());
}

/**
 * Reloads httpx tabs once a session exists. Without this, anything opened before
 * the connection finished keeps showing the "not connected" page even though it
 * would load fine now — which is exactly what happened the first time the shell
 * was launched with a URL on the command line.
 */
function reloadHttpxTabs(): void {
  for (const tab of tabs) {
    if (tab.view.webContents.getURL().startsWith("httpx://")) {
      tab.view.webContents.reload();
    }
  }
}

function openTab(url?: string): Tab {
  const view = new WebContentsView({
    webPreferences: {
      // Page content gets nothing: no Node, no preload, its own sandbox.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  const tab: Tab = { id: nextTabId++, view };
  tabs.push(tab);
  activeTabId = tab.id;
  window?.contentView.addChildView(view);

  // Registered one by one, not in a loop: Electron types `on()` per event name,
  // so a union of names is (correctly) not assignable.
  const contents = view.webContents;
  const refresh = (): void => publishState();
  contents.on("did-navigate", refresh);
  contents.on("did-navigate-in-page", refresh);
  contents.on("page-title-updated", refresh);
  contents.on("did-finish-load", refresh);
  contents.on("did-fail-load", refresh);
  // An httpx page must not be able to open http(s) windows.
  contents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith("httpx://")) {
      openTab(target);
      layout();
      publishState();
    }
    return { action: "deny" };
  });

  void contents.loadURL(url === undefined ? NEW_TAB_URL : url);
  layout();
  publishState();
  return tab;
}

function closeTab(id: number): void {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return;
  const [tab] = tabs.splice(index, 1);
  if (tab) {
    window?.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
  }
  if (tabs.length === 0) {
    openTab();
    return;
  }
  if (id === activeTabId) {
    activeTabId = (tabs[index] ?? tabs[tabs.length - 1]!).id;
  }
  layout();
  publishState();
}

function activeContents(): WebContentsView["webContents"] | undefined {
  return tabs.find((tab) => tab.id === activeTabId)?.view.webContents;
}

// --- app -----------------------------------------------------------------------

// Must run before `ready`. `standard` is what makes relative URLs, origins and
// subresource loading behave; without it httpx URLs would be opaque.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "httpx",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

async function startShell(): Promise<void> {
  protocol.handle(
    "httpx",
    createHttpxProtocolHandler({
      session: () => xmppSession,
      onRequest: ({ url, status, durationMs }) =>
        console.log(`[shell] ${url} → ${status} (${durationMs}ms)`),
    }),
  );

  // Downloads are Electron's business, not ours — this is one of the things the
  // shell gets for free that the extension had to implement.
  electronSession.defaultSession.on("will-download", (_event, item) => {
    console.log(`[shell] downloading ${item.getFilename()}`);
  });

  window = new BaseWindow({ width: 1100, height: 800, title: "httpx" });
  chromeView = new WebContentsView({
    webPreferences: {
      preload: join(import.meta.dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // the preload needs ipcRenderer
    },
  });
  window.contentView.addChildView(chromeView);
  await chromeView.webContents.loadFile(join(import.meta.dirname, "../chrome.html"));

  window.on("resize", layout);

  // Connect first: a URL from the command line (or an OS handler) should load
  // the page, not the "not connected" placeholder.
  const saved = await loadSettings();
  chromeView.webContents.send("httpx:settings", saved);
  if (saved.service && saved.jid) {
    try {
      await connect(saved as Settings);
    } catch (err) {
      console.error("[shell] auto-connect failed:", err);
      connectionState = "offline";
      publishState();
    }
  }

  const initial = httpxUrlFromArgv(process.argv);
  openTab(initial === undefined ? undefined : toNavigableUrl(initial));
  layout();
  publishState();
}

function openFromHandler(url: string): void {
  if (!url.toLowerCase().startsWith("httpx://")) return;
  openTab(toNavigableUrl(url));
  layout();
  publishState();
}

// A second launch (an OS handler firing while we run) should open a tab in the
// instance that already holds the XMPP connection, not start a rival process.
//
// The early `return` matters: without it the losing instance went on to register
// the ready handler, tried to build a whole second shell while quitting, and
// died with an unhandled rejection — which is exactly what the first real
// double-launch produced.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const url = httpxUrlFromArgv(argv);
    if (url !== undefined) openFromHandler(url);
  });
  // macOS delivers handler URLs this way rather than in argv.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    openFromHandler(url);
  });

  app.on("window-all-closed", () => {
    void disconnect().then(() => app.quit());
  });

  app.whenReady().then(startShell, (err: unknown) => {
    // Never leave a startup failure as an unhandled rejection: Electron would
    // show a modal dialog and print nothing useful.
    console.error("[shell] failed to start:", err);
    app.quit();
  });
}

// --- IPC from the chrome -------------------------------------------------------

ipcMain.handle("httpx:navigate", (_event, typed: string) => {
  const contents = activeContents();
  if (!contents) return;
  const url = normalizeTyped(typed);
  if (url === null) return;
  void contents.loadURL(url);
});

ipcMain.handle("httpx:new-tab", () => {
  openTab();
});
ipcMain.handle("httpx:select-tab", (_event, id: number) => {
  activeTabId = id;
  layout();
  publishState();
});
ipcMain.handle("httpx:close-tab", (_event, id: number) => closeTab(id));
ipcMain.handle("httpx:back", () => activeContents()?.navigationHistory.goBack());
ipcMain.handle("httpx:forward", () => activeContents()?.navigationHistory.goForward());
ipcMain.handle("httpx:reload", () => activeContents()?.reload());
ipcMain.handle("httpx:state", () => tabState());

ipcMain.handle("httpx:connect", async (_event, settings: Settings) => {
  await saveSettings(settings);
  try {
    await connect(settings);
    return { ok: true };
  } catch (err) {
    connectionState = "offline";
    publishState();
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

/** What the user typed → something Chromium can load, or null. */
function normalizeTyped(typed: string): string | null {
  const trimmed = typed.trim();
  if (trimmed === "") return null;
  const withScheme = trimmed.includes("://") ? trimmed : `httpx://${trimmed}`;
  if (!withScheme.toLowerCase().startsWith("httpx://")) return null;
  try {
    return toNavigableUrl(withScheme);
  } catch {
    return null;
  }
}
