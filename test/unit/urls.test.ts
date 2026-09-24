import { describe, expect, it } from "vitest";
import {
  canonicalUrl,
  formatHttpxUrl,
  parseHttpxUrl,
  resolveHttpxUrl,
  resolveUrl,
  resourceForm,
} from "../../src/urls.js";

describe("canonicalUrl (page identity across both schemes)", () => {
  it("is parseHttpxUrl's href for an httpx URL", () => {
    for (const url of ["httpx://web@example.org", "httpx://web@example.org/a?b=1#c"]) {
      expect(canonicalUrl(url)).toBe(parseHttpxUrl(url).href);
    }
  });

  it("serializes an http(s) URL the WHATWG way and drops the fragment", () => {
    expect(canonicalUrl("HTTPS://Example.org")).toBe("https://example.org/");
    expect(canonicalUrl("http://example.org/a b?q=1#frag")).toBe("http://example.org/a%20b?q=1");
  });

  it("throws a TypeError for anything else", () => {
    for (const url of ["mailto:a@b", "ftp://x/", "example.org", ""]) {
      expect(() => canonicalUrl(url)).toThrow(TypeError);
    }
  });
});

describe("resolveUrl (scheme-agnostic, for proxy mode)", () => {
  it("resolves against an httpx:// base exactly as resolveHttpxUrl does", () => {
    const base = "httpx://web@example.org/dir/page.html";
    for (const ref of ["other.html", "../img/logo.png", "/abs?x=1", "httpx://other@x.org/y", "https://x.org/z", "mailto:a@b"]) {
      expect(resolveUrl(base, ref)).toBe(resolveHttpxUrl(base, ref));
    }
  });

  it("resolves relative refs against an http(s):// base with WHATWG rules", () => {
    const base = "https://example.org/dir/page.html?a=1";
    expect(resolveUrl(base, "other.html")).toBe("https://example.org/dir/other.html");
    expect(resolveUrl(base, "../img/logo.png")).toBe("https://example.org/img/logo.png");
    expect(resolveUrl(base, "/abs?x=1")).toBe("https://example.org/abs?x=1");
    expect(resolveUrl(base, "//cdn.example.net/x.js")).toBe("https://cdn.example.net/x.js");
  });

  it("returns an already-absolute ref unchanged, whatever its scheme", () => {
    const base = "http://example.org/p";
    expect(resolveUrl(base, "https://other.org/y")).toBe("https://other.org/y");
    expect(resolveUrl(base, "httpx://web@x.org/z")).toBe("httpx://web@x.org/z");
    expect(resolveUrl(base, "data:text/plain,hi")).toBe("data:text/plain,hi");
  });

  it("drops the fragment, like the httpx resolver", () => {
    expect(resolveUrl("https://example.org/p", "q#frag")).toBe("https://example.org/q");
  });
});

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

describe("request-target forms", () => {
  it("classifies the four RFC 9112 forms", () => {
    expect(resourceForm("/index.html?x=1")).toBe("origin");
    expect(resourceForm("/")).toBe("origin");
    expect(resourceForm("*")).toBe("asterisk");
    expect(resourceForm("example.org:443")).toBe("authority");
    expect(resourceForm("[2001:db8::1]:8443")).toBe("authority");
    expect(resourceForm("https://example.org/a/b?c=1")).toBe("absolute");
    expect(resourceForm("http://example.org")).toBe("absolute");
  });

  it("rejects targets that only look like an authority", () => {
    // A bare host is not authority-form: without a port there is nothing to
    // connect to, and it would shadow a relative path.
    expect(resourceForm("example.org")).toBeUndefined();
    expect(resourceForm("example.org:")).toBeUndefined();
    expect(resourceForm("example.org:0")).toBeUndefined();
    expect(resourceForm("example.org:99999")).toBeUndefined();
    expect(resourceForm("example.org:443x")).toBeUndefined();
    // Userinfo, a path or a query would smuggle a second target past a
    // proxy that only looked at the host part.
    expect(resourceForm("user@example.org:443")).toBeUndefined();
    expect(resourceForm("example.org:443/admin")).toBeUndefined();
    expect(resourceForm("example.org:443?x=1")).toBeUndefined();
    expect(resourceForm("[2001:db8::1")).toBeUndefined();
    expect(resourceForm("")).toBeUndefined();
    expect(resourceForm("no-slash")).toBeUndefined();
  });

  it("rejects absolute targets with no host or a fragment", () => {
    // A non-special scheme really can have an empty authority.
    expect(resourceForm("foo://")).toBeUndefined();
    expect(resourceForm("https://example.org/a#frag")).toBeUndefined();
  });

  it("agrees with WHATWG on an authority a URL parser would normalize", () => {
    // WHATWG's "special authority ignore slashes" state eats the extra slash,
    // so this names the host `a`, not an empty one. We classify it the way a
    // downstream `new URL(resource)` would resolve it — the two must not
    // disagree about what the target is.
    expect(resourceForm("https:///a")).toBe("absolute");
    expect(new URL("https:///a").hostname).toBe("a");
  });
});
