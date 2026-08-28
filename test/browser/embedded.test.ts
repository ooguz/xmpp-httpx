import { afterEach, describe, expect, it } from "vitest";
import { applyEmbedded, isEmbedded } from "../../examples/webext/src/embedded.js";

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
