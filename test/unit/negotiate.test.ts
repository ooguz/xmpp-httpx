import { describe, expect, it } from "vitest";
import { negotiateContentType, parseAccept } from "../../src/server/negotiate.js";

describe("parseAccept", () => {
  it("orders by q, keeping the client's order on ties", () => {
    expect(parseAccept("text/html, application/json;q=0.9, text/plain;q=0.8")).toEqual([
      { type: "text/html", q: 1 },
      { type: "application/json", q: 0.9 },
      { type: "text/plain", q: 0.8 },
    ]);
    expect(parseAccept("application/json, text/html").map((e) => e.type)).toEqual([
      "application/json",
      "text/html",
    ]);
  });

  it("lowercases, trims, and tolerates junk parameters", () => {
    expect(parseAccept(" TEXT/HTML ;charset=utf-8; q=0.5 ")).toEqual([
      { type: "text/html", q: 0.5 },
    ]);
    expect(parseAccept("text/html;q=nonsense")).toEqual([{ type: "text/html", q: 1 }]);
    expect(parseAccept("text/html;q=9")).toEqual([{ type: "text/html", q: 1 }]);
    expect(parseAccept("text/html;q=-1")).toEqual([{ type: "text/html", q: 0 }]);
  });

  it("returns nothing for an absent or empty header", () => {
    expect(parseAccept(null)).toEqual([]);
    expect(parseAccept(undefined)).toEqual([]);
    expect(parseAccept("")).toEqual([]);
    expect(parseAccept(" , ,")).toEqual([]);
  });
});

describe("negotiateContentType", () => {
  const offered = ["text/html", "application/json"];

  it("honors an explicit preference", () => {
    expect(negotiateContentType("application/json", offered)).toBe("application/json");
    expect(negotiateContentType("text/html", offered)).toBe("text/html");
  });

  it("compares q values", () => {
    expect(negotiateContentType("text/html;q=0.4, application/json;q=0.9", offered)).toBe(
      "application/json",
    );
  });

  it("breaks ties by the server's own order", () => {
    expect(negotiateContentType("application/json, text/html", offered)).toBe("text/html");
    expect(negotiateContentType("*/*", offered)).toBe("text/html");
    expect(negotiateContentType("application/json, text/html", ["application/json", "text/html"])).toBe(
      "application/json",
    );
  });

  it("answers anything when the client says nothing", () => {
    expect(negotiateContentType(null, offered)).toBe("text/html");
    expect(negotiateContentType("", offered)).toBe("text/html");
  });

  it("matches subtype wildcards", () => {
    expect(negotiateContentType("text/*", offered)).toBe("text/html");
    expect(negotiateContentType("image/*", offered)).toBeUndefined();
  });

  it("lets the most specific pattern govern, not the loudest", () => {
    // */*;q=0.1 must not drag text/html down to 0.1 (RFC 9110 §12.5.1).
    expect(negotiateContentType("text/html, */*;q=0.1", offered)).toBe("text/html");
    expect(negotiateContentType("*/*;q=0.9, application/json;q=0.2", offered)).toBe(
      "text/html",
    );
  });

  it("treats q=0 as a refusal", () => {
    expect(negotiateContentType("text/html;q=0, application/json", offered)).toBe(
      "application/json",
    );
    expect(negotiateContentType("*/*;q=0", offered)).toBeUndefined();
    expect(negotiateContentType("text/html;q=0, application/json;q=0", offered)).toBeUndefined();
  });

  it("signals 406 territory by returning undefined", () => {
    expect(negotiateContentType("application/xml", offered)).toBeUndefined();
    expect(negotiateContentType("*/*", [])).toBeUndefined();
  });

  it("ignores parameters on the offered types when matching", () => {
    expect(negotiateContentType("text/html", ["text/html; charset=utf-8"])).toBe(
      "text/html; charset=utf-8",
    );
  });
});
