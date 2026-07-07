import xml from "@xmpp/xml";
import { describe, expect, it } from "vitest";
import { resolveChunkSize, selectEncoding } from "../../src/transport/select.js";

const BASE = {
  accept: { ibb: true, chunked: true, sipub: true, jingle: true },
  inlineBudgetBytes: 4096,
  preferredStreams: ["ibb", "chunkedBase64"] as const,
};

describe("selectEncoding", () => {
  it("empty body → none", () => {
    expect(selectEncoding({ ...BASE, body: { kind: "empty" } })).toEqual({
      mode: "none",
    });
  });

  it("small textual body → text", () => {
    const bytes = new TextEncoder().encode('{"hello":"world"}');
    const decision = selectEncoding({
      ...BASE,
      body: { kind: "bytes", bytes },
      contentType: "application/json",
    });
    expect(decision).toEqual({ mode: "text", text: '{"hello":"world"}' });
  });

  it("binary body in budget → base64", () => {
    const bytes = new Uint8Array([0, 159, 146, 150]);
    const decision = selectEncoding({
      ...BASE,
      body: { kind: "bytes", bytes },
      contentType: "image/png",
    });
    expect(decision.mode).toBe("base64");
  });

  it("textual bytes with control characters fall back to base64", () => {
    const bytes = new Uint8Array([104, 105, 0]); // "hi\0"
    const decision = selectEncoding({
      ...BASE,
      body: { kind: "bytes", bytes },
      contentType: "text/plain",
    });
    expect(decision.mode).toBe("base64");
  });

  it("small XML element → xml", () => {
    const decision = selectEncoding({
      ...BASE,
      body: { kind: "element", element: xml("ok", { xmlns: "urn:test" }) },
    });
    expect(decision.mode).toBe("xml");
  });

  it("oversized body → first acceptable stream, honoring preference", () => {
    const bytes = new Uint8Array(100_000);
    expect(
      selectEncoding({ ...BASE, body: { kind: "bytes", bytes } }).mode,
    ).toBe("ibb");
    expect(
      selectEncoding({
        ...BASE,
        body: { kind: "bytes", bytes },
        accept: { ...BASE.accept, ibb: false },
      }).mode,
    ).toBe("chunkedBase64");
    expect(
      selectEncoding({
        ...BASE,
        body: { kind: "bytes", bytes },
        preferredStreams: ["chunkedBase64", "ibb"],
      }).mode,
    ).toBe("chunkedBase64");
  });

  it("streams always pick a stream mechanism", () => {
    expect(selectEncoding({ ...BASE, body: { kind: "stream" } }).mode).toBe("ibb");
  });

  it("no acceptable mechanism → too-large", () => {
    const decision = selectEncoding({
      ...BASE,
      body: { kind: "stream" },
      accept: { ibb: false, chunked: false, sipub: false, jingle: false },
    });
    expect(decision).toEqual({ mode: "too-large" });
  });

  it("falls through to sipub/jingle when preferred", () => {
    const bytes = new Uint8Array(100_000);
    expect(
      selectEncoding({
        ...BASE,
        body: { kind: "bytes", bytes },
        preferredStreams: ["sipub", "jingle"],
      }).mode,
    ).toBe("sipub");
    expect(
      selectEncoding({
        ...BASE,
        body: { kind: "bytes", bytes },
        accept: { ...BASE.accept, sipub: false },
        preferredStreams: ["sipub", "jingle"],
      }).mode,
    ).toBe("jingle");
  });

  it("resolveChunkSize honors the requester cap and library bounds", () => {
    expect(resolveChunkSize(undefined)).toBe(4096);
    expect(resolveChunkSize(1024)).toBe(1024);
    // An explicit advertisement is honored up to the spec maximum.
    expect(resolveChunkSize(65536)).toBe(65536);
    expect(resolveChunkSize(999_999)).toBe(65536);
    expect(resolveChunkSize(10)).toBe(256);
  });

  it("stanzaBudgets derives budgets from a stanza-size limit", async () => {
    const { stanzaBudgets } = await import("../../src/transport/select.js");
    const small = stanzaBudgets(10 * 1024); // the RFC 6120 floor
    expect(small.inlineBudgetBytes).toBe(10 * 1024 - 2048);
    expect(small.maxChunkSize).toBeLessThan(10 * 1024);
    const big = stanzaBudgets(256 * 1024);
    expect(big.inlineBudgetBytes).toBe(256 * 1024 - 2048);
    expect(big.maxChunkSize).toBe(65536); // spec ceiling
  });
});
