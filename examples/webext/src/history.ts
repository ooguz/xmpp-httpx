import { parseHttpxUrl } from "xmpp-httpx";
import { readStored, writeStored } from "./ext.js";

/**
 * Visit history and bookmarks in `storage.local`.
 *
 * Titles come from fetched pages, i.e. from hostile input, and they are the
 * only page-supplied strings this project renders in the *extension* page
 * rather than inside the sandboxed iframe. They are stored as data and must be
 * displayed with `textContent` — never assembled into markup. They are also
 * normalized here (whitespace collapsed, length capped) so a page cannot
 * distort the drawer with control characters or a novel-length title.
 */

const HISTORY_KEY = "history";
const BOOKMARKS_KEY = "bookmarks";
/** Beyond this, the oldest visits are dropped. */
export const MAX_HISTORY = 500;
const MAX_TITLE_LENGTH = 200;

export interface HistoryEntry {
  url: string;
  title: string;
  /** Epoch ms of the most recent visit. */
  visitedAt: number;
  visits: number;
}

export interface Bookmark {
  url: string;
  title: string;
  addedAt: number;
}

/** Collapses whitespace and caps length; falls back to the URL. */
export function normalizeTitle(title: string | undefined, url: string): string {
  const cleaned = (title ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH);
  return cleaned === "" ? url : cleaned;
}

/** Accepts only entries we could have written, so corrupt state self-heals. */
function isEntry(value: unknown): value is HistoryEntry {
  const entry = value as Partial<HistoryEntry> | null;
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof entry.url === "string" &&
    typeof entry.title === "string" &&
    Number.isFinite(entry.visitedAt) &&
    Number.isFinite(entry.visits)
  );
}

function isBookmark(value: unknown): value is Bookmark {
  const mark = value as Partial<Bookmark> | null;
  return (
    typeof mark === "object" &&
    mark !== null &&
    typeof mark.url === "string" &&
    typeof mark.title === "string" &&
    Number.isFinite(mark.addedAt)
  );
}

/** Most recent first. */
export async function listHistory(): Promise<HistoryEntry[]> {
  const stored = await readStored<unknown[]>(HISTORY_KEY, []);
  return (Array.isArray(stored) ? stored : []).filter(isEntry);
}

export async function listBookmarks(): Promise<Bookmark[]> {
  const stored = await readStored<unknown[]>(BOOKMARKS_KEY, []);
  return (Array.isArray(stored) ? stored : []).filter(isBookmark);
}

/**
 * Records one visit. Revisiting a URL updates its title and timestamp and
 * moves it to the front rather than adding a duplicate row — the drawer is a
 * list of pages, not of page views.
 */
export async function recordVisit(
  url: string,
  title: string | undefined,
  now = Date.now(),
): Promise<HistoryEntry[]> {
  let href: string;
  try {
    href = parseHttpxUrl(url).href; // never record something we can't revisit
  } catch {
    return listHistory();
  }

  const existing = await listHistory();
  const previous = existing.find((entry) => entry.url === href);
  const entry: HistoryEntry = {
    url: href,
    title: normalizeTitle(title, href),
    visitedAt: now,
    visits: (previous?.visits ?? 0) + 1,
  };
  const next = [entry, ...existing.filter((e) => e.url !== href)].slice(0, MAX_HISTORY);
  await writeStored(HISTORY_KEY, next);
  return next;
}

export async function removeVisit(url: string): Promise<HistoryEntry[]> {
  const next = (await listHistory()).filter((entry) => entry.url !== url);
  await writeStored(HISTORY_KEY, next);
  return next;
}

export async function clearHistory(): Promise<void> {
  await writeStored(HISTORY_KEY, []);
}

export async function isBookmarked(url: string): Promise<boolean> {
  return (await listBookmarks()).some((mark) => mark.url === url);
}

/** Adds or removes the bookmark; resolves to whether it is bookmarked now. */
export async function toggleBookmark(
  url: string,
  title: string | undefined,
  now = Date.now(),
): Promise<boolean> {
  let href: string;
  try {
    href = parseHttpxUrl(url).href;
  } catch {
    return false;
  }

  const marks = await listBookmarks();
  const without = marks.filter((mark) => mark.url !== href);
  if (without.length !== marks.length) {
    await writeStored(BOOKMARKS_KEY, without);
    return false;
  }
  await writeStored(BOOKMARKS_KEY, [
    { url: href, title: normalizeTitle(title, href), addedAt: now },
    ...marks,
  ]);
  return true;
}

export async function removeBookmark(url: string): Promise<Bookmark[]> {
  const next = (await listBookmarks()).filter((mark) => mark.url !== url);
  await writeStored(BOOKMARKS_KEY, next);
  return next;
}
