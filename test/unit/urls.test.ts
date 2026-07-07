import { describe, expect, it } from "vitest";
import {
  formatHttpxUrl,
  parseHttpxUrl,
  resolveHttpxUrl,
} from "../../src/urls.js";

describe("httpx URLs", () => {
  it("parses a full URL", () => {
    const url = parseHttpxUrl("httpx://httpServer@example.org/index.html?x=1&y=2");
    expect(url.jid).toBe("httpServer@example.org");
    expect(url.path).toBe("/index.html");
    expect(url.search).toBe("?x=1&y=2");
    expect(url.resource).toBe("/index.html?x=1&y=2");
    expect(url.href).toBe("httpx://httpServer@example.org/index.html?x=1&y=2");
  });

  it("defaults the path to / and strips fragments", () => {
    const url = parseHttpxUrl("httpx://server@example.org#section");
    expect(url.path).toBe("/");
    expect(url.resource).toBe("/");
    expect(url.href).toBe("httpx://server@example.org/");
  });

  it("handles a bare-domain JID and query without path", () => {
    const url = parseHttpxUrl("httpx://gateway.example.org?q=1");
    expect(url.jid).toBe("gateway.example.org");
    expect(url.resource).toBe("/?q=1");
  });

  it("rejects other schemes, empty authorities, and ports", () => {
    expect(() => parseHttpxUrl("https://example.org/")).toThrow(TypeError);
    expect(() => parseHttpxUrl("httpx:///path")).toThrow(TypeError);
    expect(() => parseHttpxUrl("httpx://example.org:5222/")).toThrow(TypeError);
  });

  it("formats URLs", () => {
    expect(formatHttpxUrl({ jid: "a@b.org" })).toBe("httpx://a@b.org/");
    expect(formatHttpxUrl({ jid: "a@b.org", path: "x", search: "q=1" })).toBe(
      "httpx://a@b.org/x?q=1",
    );
  });

  it("resolves references like a browser", () => {
    const base = "httpx://web@example.org/docs/page.html?x=1";
    expect(resolveHttpxUrl(base, "other.html")).toBe(
      "httpx://web@example.org/docs/other.html",
    );
    expect(resolveHttpxUrl(base, "../img/logo.png")).toBe(
      "httpx://web@example.org/img/logo.png",
    );
    expect(resolveHttpxUrl(base, "/root.html")).toBe(
      "httpx://web@example.org/root.html",
    );
    expect(resolveHttpxUrl(base, "?y=2")).toBe(
      "httpx://web@example.org/docs/page.html?y=2",
    );
    expect(resolveHttpxUrl(base, "httpx://other@x.org/a")).toBe(
      "httpx://other@x.org/a",
    );
    // Foreign schemes pass through untouched.
    expect(resolveHttpxUrl(base, "https://example.com/")).toBe(
      "https://example.com/",
    );
    // Fragments are stripped.
    expect(resolveHttpxUrl(base, "other.html#sec")).toBe(
      "httpx://web@example.org/docs/other.html",
    );
  });
});
