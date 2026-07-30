import { describe, expect, it } from "vitest";
import { MAX_TAB_HISTORY, TabSet } from "../../examples/webext/src/tabs.js";

const A = "httpx://site@example.org/a";
const B = "httpx://site@example.org/b";
const C = "httpx://site@example.org/c";

describe("TabSet", () => {
  it("starts with one empty active tab", () => {
    const tabs = new TabSet();
    expect(tabs.tabs.length).toBe(1);
    expect(tabs.active.url).toBe("");
    expect(tabs.active.title).toBe("New tab");
    expect(tabs.active.index).toBe(-1);
    expect(tabs.canGoBack()).toBe(false);
    expect(tabs.canGoForward()).toBe(false);
  });

  it("opens tabs, optionally pre-addressed, and activates them", () => {
    const tabs = new TabSet();
    const first = tabs.active.id;
    const second = tabs.open(A);
    expect(tabs.tabs.length).toBe(2);
    expect(tabs.active.id).toBe(second.id);
    expect(tabs.active.url).toBe(A);
    expect(tabs.tabs.find((t) => t.id === first)!.url).toBe("");
  });

  it("switches between tabs without touching their state", () => {
    const tabs = new TabSet();
    const first = tabs.active.id;
    tabs.visit(A);
    const second = tabs.open(B).id;
    expect(tabs.active.url).toBe(B);
    tabs.activate(first);
    expect(tabs.active.url).toBe(A);
    tabs.activate(second);
    expect(tabs.active.url).toBe(B);
  });

  it("ignores activating a tab that does not exist", () => {
    const tabs = new TabSet();
    const only = tabs.active.id;
    expect(tabs.activate(9999).id).toBe(only);
  });
});

describe("TabSet — per-tab history", () => {
  it("walks back and forward within one tab", () => {
    const tabs = new TabSet();
    tabs.visit(A);
    tabs.visit(B);
    expect(tabs.canGoBack()).toBe(true);
    expect(tabs.canGoForward()).toBe(false);

    expect(tabs.back()).toBe(A);
    expect(tabs.active.url).toBe(A);
    expect(tabs.canGoForward()).toBe(true);
    expect(tabs.forward()).toBe(B);
    expect(tabs.back()).toBe(A);
    expect(tabs.back()).toBeUndefined(); // already at the bottom
    expect(tabs.active.url).toBe(A);
  });

  it("keeps each tab's stack independent — the point of the exercise", () => {
    const tabs = new TabSet();
    const first = tabs.active.id;
    tabs.visit(A);
    tabs.visit(B);

    const second = tabs.open(C).id;
    expect(tabs.canGoBack()).toBe(false); // fresh tab, nothing behind it
    expect(tabs.back()).toBeUndefined();

    tabs.activate(first);
    expect(tabs.canGoBack()).toBe(true);
    expect(tabs.back()).toBe(A);

    tabs.activate(second);
    expect(tabs.active.url).toBe(C);
    expect(tabs.canGoBack()).toBe(false);
  });

  it("discards forward entries when navigating from mid-stack", () => {
    const tabs = new TabSet();
    tabs.visit(A);
    tabs.visit(B);
    tabs.back();
    tabs.visit(C);
    expect(tabs.active.history).toEqual([A, C]);
    expect(tabs.canGoForward()).toBe(false);
    expect(tabs.back()).toBe(A);
  });

  it("adds no entry for revisiting the current URL (a reload)", () => {
    const tabs = new TabSet();
    tabs.visit(A);
    tabs.visit(A);
    tabs.visit(A);
    expect(tabs.active.history).toEqual([A]);
    expect(tabs.canGoBack()).toBe(false);
  });

  it("drops the oldest entry past the depth cap", () => {
    const tabs = new TabSet();
    for (let i = 0; i < MAX_TAB_HISTORY + 3; i++) {
      tabs.visit(`httpx://site@example.org/p${i}`);
    }
    const { history, index } = tabs.active;
    expect(history.length).toBe(MAX_TAB_HISTORY);
    expect(index).toBe(MAX_TAB_HISTORY - 1);
    expect(history[0]).toBe("httpx://site@example.org/p3");
  });
});

describe("TabSet — closing", () => {
  it("activates the tab that slides into the slot", () => {
    const tabs = new TabSet();
    const first = tabs.active.id;
    const second = tabs.open(A).id;
    const third = tabs.open(B).id;
    tabs.activate(second);

    expect(tabs.close(second).id).toBe(third);
    expect(tabs.tabs.map((t) => t.id)).toEqual([first, third]);
  });

  it("falls back to the last tab when closing the rightmost", () => {
    const tabs = new TabSet();
    const first = tabs.active.id;
    const second = tabs.open(A).id;
    expect(tabs.close(second).id).toBe(first);
  });

  it("keeps the active tab when closing a different one", () => {
    const tabs = new TabSet();
    const first = tabs.active.id;
    const second = tabs.open(A).id;
    tabs.close(first);
    expect(tabs.active.id).toBe(second);
    expect(tabs.active.url).toBe(A);
  });

  it("leaves a fresh empty tab when the last one closes", () => {
    const tabs = new TabSet();
    tabs.visit(A);
    const only = tabs.active.id;
    const next = tabs.close(only);
    expect(tabs.tabs.length).toBe(1);
    expect(next.id).not.toBe(only);
    expect(next.url).toBe("");
    expect(next.title).toBe("New tab");
  });

  it("ignores closing a tab that does not exist", () => {
    const tabs = new TabSet();
    tabs.visit(A);
    expect(tabs.close(9999).url).toBe(A);
    expect(tabs.tabs.length).toBe(1);
  });
});

describe("TabSet — titles", () => {
  it("uses the page title when there is one", () => {
    const tabs = new TabSet();
    tabs.visit(A);
    tabs.setTitle(tabs.active.id, "Page A");
    expect(tabs.active.title).toBe("Page A");
  });

  it("falls back to the URL, then to New tab", () => {
    const tabs = new TabSet();
    tabs.visit(A);
    tabs.setTitle(tabs.active.id, "   ");
    expect(tabs.active.title).toBe(A);

    const blank = tabs.open();
    tabs.setTitle(blank.id, undefined);
    expect(tabs.active.title).toBe("New tab");
  });

  it("titles the tab it was told to, not the active one", () => {
    const tabs = new TabSet();
    const background = tabs.active.id;
    tabs.visit(A);
    const foreground = tabs.open(B).id;
    tabs.setTitle(background, "Background page");
    expect(tabs.tabs.find((t) => t.id === background)!.title).toBe("Background page");
    expect(tabs.tabs.find((t) => t.id === foreground)!.title).toBe(B);
  });
});
