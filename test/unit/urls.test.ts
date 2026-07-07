import { describe, expect, it } from "vitest";
import { formatHttpxUrl, parseHttpxUrl } from "../../src/urls.js";

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
});
