import { describe, expect, it } from "vitest";
import {
  allowSafeSchemes,
  sanitizeDocumentStyles,
  sanitizeInlineStyle,
  sanitizeStylesheet,
} from "../../examples/webext/src/sanitize-css.js";

const BASE = "httpx://site@example.org/dir/page.html";

/** Normalizes CSSOM serialization differences (spacing, quoting) for asserts. */
const squash = (css: string) => css.replace(/\s+/g, " ").trim();

describe("sanitizeStylesheet", () => {
  it("keeps ordinary declarations", () => {
    const css = sanitizeStylesheet("h1 { color: red; font-weight: bold }", BASE);
    expect(squash(css)).toBe("h1 { color: red; font-weight: bold; }");
  });

  it("drops @import (constructed sheets refuse it) and unknown at-rules", () => {
    const css = sanitizeStylesheet(
      `@import url("httpx://site@example.org/other.css");
       @namespace svg url(http://www.w3.org/2000/svg);
       @page { margin: 0 }
       body { color: blue }`,
      BASE,
    );
    expect(css).not.toMatch(/@import|@namespace|@page/);
    expect(squash(css)).toBe("body { color: blue; }");
  });

  it("keeps media and supports blocks, sanitizing inside them", () => {
    const css = sanitizeStylesheet(
      `@media (min-width: 40em) {
         p { background-image: url("http://insecure.example/x.png"); color: green }
       }`,
      BASE,
    );
    expect(squash(css)).toContain("color: green");
    expect(css).not.toContain("insecure.example");
    expect(css).toContain("@media");
  });

  it("sanitizes @font-face and @keyframes declarations", () => {
    const css = sanitizeStylesheet(
      `@font-face { font-family: f; src: url("http://insecure.example/f.woff2") }
       @keyframes spin { to { transform: rotate(1turn); background: url(http://insecure.example/k.png) } }`,
      BASE,
    );
    expect(css).not.toContain("insecure.example");
    expect(css).toContain("rotate(1turn)");
  });

  it("resolves relative url() against the httpx base", () => {
    const css = sanitizeStylesheet("div { background-image: url(pic.png) }", BASE);
    expect(css).toContain('url("httpx://site@example.org/dir/pic.png")');
  });

  it("drops declarations whose url() points somewhere untrusted", () => {
    for (const value of [
      "url(http://insecure.example/x.png)",
      "url('ftp://example.org/x.png')",
      "url(javascript:alert(1))",
    ]) {
      const css = sanitizeStylesheet(`div { background-image: ${value} }`, BASE);
      expect(squash(css)).toBe("div { }");
    }
  });

  it("keeps https, data and blob references, and fragment-only url()", () => {
    const css = sanitizeStylesheet(
      `a { background-image: url(https://cdn.example/x.png) }
       b { background-image: url("data:image/gif;base64,R0lGOD") }
       c { background-image: url(blob:abc-123) }
       d { filter: url(#blur) }`,
      BASE,
    );
    expect(css).toContain("https://cdn.example/x.png");
    expect(css).toContain("data:image/gif;base64,R0lGOD");
    expect(css).toContain("blob:abc-123");
    expect(css).toContain('url("#blur")'); // CSSOM quotes it; same reference
  });

  it("keeps a url() whose path contains a closing paren", () => {
    const css = sanitizeStylesheet(
      `div { background-image: url("image (1).png") }`,
      BASE,
    );
    expect(css).toContain("httpx://site@example.org/dir/image%20(1).png");
  });

  it("still rejects an untrusted url() that contains a paren", () => {
    const css = sanitizeStylesheet(
      `div { background-image: url("http://insecure.example/a)b.png") }`,
      BASE,
    );
    expect(css).not.toContain("insecure.example");
  });

  it("rewrites several url() tokens in one value", () => {
    const css = sanitizeStylesheet(
      `div { background-image: url(a.png), url("https://cdn.example/b.png") }`,
      BASE,
    );
    expect(css).toContain("httpx://site@example.org/dir/a.png");
    expect(css).toContain("https://cdn.example/b.png");
  });

  it("drops the declaration when any one of several url() is untrusted", () => {
    const css = sanitizeStylesheet(
      `div { background-image: url(a.png), url(http://insecure.example/b.png) }`,
      BASE,
    );
    expect(squash(css)).toBe("div { }");
  });

  it("drops legacy script vectors", () => {
    const css = sanitizeStylesheet(
      `div { width: expression(alert(1)); behavior: url(#default#time2);
             -moz-binding: url(httpx://site@example.org/x.xml) }`,
      BASE,
    );
    expect(squash(css)).toBe("div { }");
  });

  it("neutralizes </style> inside string values", () => {
    const css = sanitizeStylesheet(
      `p::after { content: "</style><img src=x>" }`,
      BASE,
    );
    expect(css).not.toContain("</style");
    expect(css).toContain("\\3c /style");
  });

  it("returns empty string for unparseable or oversized input", () => {
    expect(sanitizeStylesheet("x".repeat(600 * 1024), BASE)).toBe("");
    expect(sanitizeStylesheet("}}}} not css {{{{", BASE)).toBe("");
  });

  it("is idempotent apart from resolver substitution", () => {
    const source = `div { background-image: url(pic.png); color: red }
                    @media print { p { background: url(https://cdn.example/y.png) } }`;
    const once = sanitizeStylesheet(source, BASE);
    expect(sanitizeStylesheet(once, BASE)).toBe(once);
  });

  it("substitutes url() through a custom resolver", () => {
    const resolve = (url: string) =>
      url === "httpx://site@example.org/dir/pic.png" ? "blob:swapped" : allowSafeSchemes(url);
    const css = sanitizeStylesheet(
      "div { background-image: url(pic.png) }",
      BASE,
      resolve,
    );
    expect(css).toContain('url("blob:swapped")');
  });

  it("drops the declaration when the resolver rejects the url", () => {
    const css = sanitizeStylesheet(
      "div { background-image: url(pic.png); color: red }",
      BASE,
      () => null,
    );
    expect(squash(css)).toBe("div { color: red; }");
  });

  it("preserves !important on rewritten declarations", () => {
    const css = sanitizeStylesheet(
      "div { background-image: url(pic.png) !important }",
      BASE,
    );
    expect(css).toContain("!important");
  });
});

describe("sanitizeInlineStyle", () => {
  it("keeps safe declarations and resolves url()", () => {
    const value = sanitizeInlineStyle(
      "color: red; background-image: url(pic.png)",
      BASE,
    );
    expect(value).toContain("color: red");
    expect(value).toContain("httpx://site@example.org/dir/pic.png");
  });

  it("drops untrusted url() and script vectors", () => {
    // Dropping one longhand of a shorthand leaves its siblings at `initial`,
    // which is inert — what matters is that no reference survives.
    const dropped = sanitizeInlineStyle(
      "background: url(http://insecure.example/x.png)",
      BASE,
    );
    expect(dropped).not.toContain("insecure.example");
    expect(dropped).not.toContain("background-image");
    expect(sanitizeInlineStyle("width: expression(alert(1))", BASE)).toBe("");
  });

  it("ignores selectors and at-rules smuggled into an attribute", () => {
    // The CSS parser refuses these outright in a declaration-list context.
    expect(sanitizeInlineStyle("} body { color: red }", BASE)).toBe("");
  });
});

describe("sanitizeDocumentStyles", () => {
  const parse = (html: string) =>
    new DOMParser().parseFromString(html, "text/html");

  it("rewrites style elements and attributes in place", () => {
    const doc = parse(
      `<style>p { background-image: url(a.png) }</style>
       <div style="color: red; background-image: url(b.png)">x</div>`,
    );
    sanitizeDocumentStyles(doc, BASE);
    expect(doc.querySelector("style")!.textContent).toContain(
      "httpx://site@example.org/dir/a.png",
    );
    expect(doc.querySelector("div")!.getAttribute("style")).toContain(
      "httpx://site@example.org/dir/b.png",
    );
  });

  it("removes style elements and attributes left empty", () => {
    const doc = parse(
      `<style>@import url(x.css);</style><div style="behavior: url(#x)">y</div>`,
    );
    sanitizeDocumentStyles(doc, BASE);
    expect(doc.querySelector("style")).toBeNull();
    expect(doc.querySelector("div")!.hasAttribute("style")).toBe(false);
  });
});
