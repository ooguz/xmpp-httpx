/**
 * Tab bookkeeping: which tabs exist, which is active, and each tab's own
 * back/forward stack. Deliberately free of DOM and of httpx knowledge so it can
 * be tested directly — `app.ts` owns the iframes and page resources keyed by
 * tab id.
 *
 * Per-tab history is the reason this exists at all. The single-tab browser used
 * the *platform's* history via `location.hash`, which cannot represent "each tab
 * has its own back stack": one shared entry list would send Back in tab B to a
 * page that was open in tab A. So the stacks live here, the in-page back/forward
 * buttons drive them, and the hash becomes a mirror of the active tab's URL for
 * deep links rather than the source of truth.
 */

/** Per-tab back/forward depth. Beyond this, the oldest entry is dropped. */
export const MAX_TAB_HISTORY = 50;

export interface TabState {
  readonly id: number;
  /** Current URL; `""` for a fresh tab that has not loaded anything. */
  url: string;
  /** Display label — the page title when known, else the URL. */
  title: string;
  /** This tab's back/forward stack. */
  history: string[];
  /** Position in `history`; `-1` while the tab is empty. */
  index: number;
}

export class TabSet {
  private readonly items: TabState[] = [];
  private nextId = 1;
  private activeId = 0;

  /** A window always has at least one tab. */
  constructor() {
    this.open();
  }

  get tabs(): readonly TabState[] {
    return this.items;
  }

  get active(): TabState {
    return this.items.find((tab) => tab.id === this.activeId) ?? this.items[0]!;
  }

  /** Opens a tab (optionally pre-addressed) and makes it active. */
  open(url = ""): TabState {
    const tab: TabState = {
      id: this.nextId++,
      url: "",
      title: "New tab",
      history: [],
      index: -1,
    };
    this.items.push(tab);
    this.activeId = tab.id;
    if (url !== "") this.visit(url);
    return tab;
  }

  activate(id: number): TabState {
    if (this.items.some((tab) => tab.id === id)) this.activeId = id;
    return this.active;
  }

  /**
   * Closes a tab and returns the one active afterwards. Closing the last tab
   * leaves a fresh empty one — a window with zero tabs has no address bar to
   * type into.
   */
  close(id: number): TabState {
    const position = this.items.findIndex((tab) => tab.id === id);
    if (position === -1) return this.active;
    this.items.splice(position, 1);

    if (this.items.length === 0) return this.open();
    if (id === this.activeId) {
      // The tab that slid into this slot, else the new last one.
      const next = this.items[position] ?? this.items[this.items.length - 1]!;
      this.activeId = next.id;
    }
    return this.active;
  }

  /**
   * Records a navigation in the active tab. Re-visiting the current URL (a
   * reload) adds no entry; navigating away from a position mid-stack discards
   * the forward entries, as browsers do.
   */
  visit(url: string): TabState {
    const tab = this.active;
    if (tab.url === url) return tab;

    tab.history.splice(tab.index + 1);
    tab.history.push(url);
    if (tab.history.length > MAX_TAB_HISTORY) tab.history.shift();
    tab.index = tab.history.length - 1;
    tab.url = url;
    tab.title = url;
    return tab;
  }

  canGoBack(): boolean {
    return this.active.index > 0;
  }

  canGoForward(): boolean {
    return this.active.index < this.active.history.length - 1;
  }

  /** Moves the active tab back and returns the URL to load, if any. */
  back(): string | undefined {
    if (!this.canGoBack()) return undefined;
    const tab = this.active;
    tab.index -= 1;
    tab.url = tab.history[tab.index]!;
    return tab.url;
  }

  forward(): string | undefined {
    if (!this.canGoForward()) return undefined;
    const tab = this.active;
    tab.index += 1;
    tab.url = tab.history[tab.index]!;
    return tab.url;
  }

  /** Titles come from pages; empty ones fall back to the URL. */
  setTitle(id: number, title: string | undefined): void {
    const tab = this.items.find((item) => item.id === id);
    if (!tab) return;
    const trimmed = (title ?? "").trim();
    tab.title = trimmed === "" ? tab.url || "New tab" : trimmed;
  }
}
