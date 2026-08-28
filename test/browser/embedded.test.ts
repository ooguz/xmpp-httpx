import { afterEach, describe, expect, it } from "vitest";
import {
  applyEmbedded,
  historyWriteMode,
  isEmbedded,
} from "../../examples/webext/src/embedded.js";

afterEach(() => {
  delete document.body.dataset["embedded"];
});

describe("isEmbedded", () => {
  it("recognizes the flag with and without a value", () => {
    expect(isEmbedded("?embedded=1")).toBe(true);
    expect(isEmbedded("?embedded")).toBe(true);
    expect(isEmbedded("?foo=1&embedded=1")).toBe(true);
  });

  it("is off by default and not fooled by lookalikes", () => {
    expect(isEmbedded("")).toBe(false);
    expect(isEmbedded("?foo=1")).toBe(false);
    expect(isEmbedded("?notembedded=1")).toBe(false);
    expect(isEmbedded("#embedded")).toBe(false);
  });
});

describe("applyEmbedded", () => {
  it("marks the body so the stylesheet can hide the chrome", () => {
    expect(applyEmbedded(document, "?embedded=1")).toBe(true);
    expect(document.body.dataset["embedded"]).toBe("true");
  });

  it("leaves the body untouched when the flag is absent", () => {
    expect(applyEmbedded(document, "")).toBe(false);
    expect(document.body.dataset["embedded"]).toBeUndefined();
  });
});

describe("historyWriteMode", () => {
  it("pushes a page-to-page move when embedded — the host's back must walk it", () => {
    expect(historyWriteMode(true, true, "#httpx://a/", "#httpx://b/")).toBe("push");
  });

  it("replaces a re-spelling of the current page's hash", () => {
    // The tab URL did not change: correcting "#httpx://a" to "#httpx://a/"
    // with a push would re-push on every back press landing there — a trap.
    expect(historyWriteMode(true, false, "#httpx://a", "#httpx://a/")).toBe(
      "replace",
    );
  });

  it("replaces the boot-time upgrade of the empty-tab entry", () => {
    // Otherwise a blank entry would sit behind the first page and the host's
    // back button would land on it instead of leaving.
    expect(historyWriteMode(true, true, "", "#httpx://a/")).toBe("replace");
  });

  it("replaces a return to the empty-tab state", () => {
    expect(historyWriteMode(true, true, "#httpx://a/", "")).toBe("replace");
  });

  it("always replaces when standalone — per-tab stacks own the history", () => {
    expect(historyWriteMode(false, true, "#httpx://a/", "#httpx://b/")).toBe(
      "replace",
    );
    expect(historyWriteMode(false, true, "", "#httpx://a/")).toBe("replace");
  });
});
