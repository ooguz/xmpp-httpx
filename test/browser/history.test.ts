import { beforeEach, describe, expect, it } from "vitest";
import {
  clearHistory,
  isBookmarked,
  listBookmarks,
  listHistory,
  MAX_HISTORY,
  normalizeTitle,
  recordVisit,
  removeBookmark,
  removeVisit,
  toggleBookmark,
} from "../../examples/webext/src/history.js";

const A = "httpx://site@example.org/a.html";
const B = "httpx://site@example.org/b.html";

// No extension APIs in the test browser, so this exercises the localStorage
// fallback path — the same one the page uses when opened as a plain tab.
beforeEach(() => {
  localStorage.clear();
});

describe("normalizeTitle", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeTitle("  Hello   \n  world ", A)).toBe("Hello world");
  });

  it("falls back to the URL when there is no usable title", () => {
    expect(normalizeTitle(undefined, A)).toBe(A);
    expect(normalizeTitle("", A)).toBe(A);
    expect(normalizeTitle("   \t\n ", A)).toBe(A);
  });

  it("caps absurd titles", () => {
    expect(normalizeTitle("t".repeat(500), A).length).toBe(200);
  });

  it("keeps markup as literal text — it is displayed, never parsed", () => {
    expect(normalizeTitle("<img src=x onerror=alert(1)>", A)).toBe(
      "<img src=x onerror=alert(1)>",
    );
  });
});

describe("history", () => {
  it("starts empty and records a visit", async () => {
    expect(await listHistory()).toEqual([]);
    await recordVisit(A, "Page A", 1000);
    expect(await listHistory()).toEqual([
      { url: A, title: "Page A", visitedAt: 1000, visits: 1 },
    ]);
  });

  it("records proxied web pages under their canonical spelling, and nothing else", async () => {
    await recordVisit("HTTPS://Example.org/p#frag", "Web", 1000);
    await recordVisit("mailto:a@b.c", "Nope", 2000);
    expect((await listHistory()).map((e) => e.url)).toEqual(["https://example.org/p"]);
  });

  it("puts the most recent visit first", async () => {
    await recordVisit(A, "Page A", 1000);
    await recordVisit(B, "Page B", 2000);
    expect((await listHistory()).map((e) => e.url)).toEqual([B, A]);
  });

  it("counts revisits instead of duplicating the row", async () => {
    await recordVisit(A, "Page A", 1000);
    await recordVisit(B, "Page B", 2000);
    await recordVisit(A, "Page A renamed", 3000);
    const entries = await listHistory();
    expect(entries.map((e) => e.url)).toEqual([A, B]);
    expect(entries[0]).toEqual({
      url: A,
      title: "Page A renamed",
      visitedAt: 3000,
      visits: 2,
    });
  });

  it("normalizes the URL it stores", async () => {
    await recordVisit("httpx://site@example.org/a.html#frag", "A", 1000);
    expect((await listHistory())[0]!.url).toBe(A); // fragment stripped
  });

  it("refuses to record something it could not revisit", async () => {
    await recordVisit("mailto:a@example.org", "not a page", 1000);
    await recordVisit("garbage", "nope", 1000);
    expect(await listHistory()).toEqual([]);
  });

  it("drops the oldest entries past the cap", async () => {
    for (let i = 0; i < MAX_HISTORY + 5; i++) {
      await recordVisit(`httpx://site@example.org/p${i}`, `Page ${i}`, 1000 + i);
    }
    const entries = await listHistory();
    expect(entries.length).toBe(MAX_HISTORY);
    expect(entries[0]!.url).toBe(`httpx://site@example.org/p${MAX_HISTORY + 4}`);
    expect(entries.some((e) => e.url.endsWith("/p0"))).toBe(false);
  });

  it("forgets one page, and all of them", async () => {
    await recordVisit(A, "A", 1000);
    await recordVisit(B, "B", 2000);
    expect((await removeVisit(A)).map((e) => e.url)).toEqual([B]);
    await clearHistory();
    expect(await listHistory()).toEqual([]);
  });

  it("self-heals from corrupt stored state", async () => {
    localStorage.setItem("httpx.history", "not json at all");
    expect(await listHistory()).toEqual([]);
    localStorage.setItem(
      "httpx.history",
      JSON.stringify([{ url: A, title: "ok", visitedAt: 1, visits: 1 }, { bogus: true }, 42]),
    );
    expect((await listHistory()).map((e) => e.url)).toEqual([A]);
  });
});

describe("bookmarks", () => {
  it("toggles on and off", async () => {
    expect(await isBookmarked(A)).toBe(false);
    expect(await toggleBookmark(A, "Page A", 1000)).toBe(true);
    expect(await isBookmarked(A)).toBe(true);
    expect(await listBookmarks()).toEqual([
      { url: A, title: "Page A", addedAt: 1000 },
    ]);

    expect(await toggleBookmark(A, "Page A", 2000)).toBe(false);
    expect(await isBookmarked(A)).toBe(false);
    expect(await listBookmarks()).toEqual([]);
  });

  it("keeps bookmarks independent of history", async () => {
    await toggleBookmark(A, "Page A", 1000);
    await recordVisit(B, "Page B", 2000);
    await clearHistory();
    expect((await listBookmarks()).map((m) => m.url)).toEqual([A]);
  });

  it("newest bookmark first, and removable", async () => {
    await toggleBookmark(A, "A", 1000);
    await toggleBookmark(B, "B", 2000);
    expect((await listBookmarks()).map((m) => m.url)).toEqual([B, A]);
    expect((await removeBookmark(B)).map((m) => m.url)).toEqual([A]);
  });

  it("refuses URLs it cannot load", async () => {
    expect(await toggleBookmark("mailto:a@example.org", "x", 1000)).toBe(false);
    expect(await listBookmarks()).toEqual([]);
  });

  it("bookmarks proxied web pages under their canonical spelling", async () => {
    expect(await toggleBookmark("HTTPS://Example.org/p#frag", "Web", 1000)).toBe(true);
    expect((await listBookmarks()).map((m) => m.url)).toEqual(["https://example.org/p"]);
  });
});
