import { describe, expect, it } from "vitest";
import { extractPageMeta } from "../../examples/webext/src/page-meta.js";

const BASE = "httpx://site@example.org/dir/page.html";

describe("extractPageMeta", () => {
  it("reads the title, trimmed", () => {
    expect(extractPageMeta("<title>  Hello  </title>", BASE).title).toBe("Hello");
  });

  it("treats title markup as text, not markup", () => {
    const meta = extractPageMeta(
      "<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>",
      BASE,
    );
    expect(meta.title).toBe("<script>alert(1)</script>");
  });

  it("omits an empty or absent title", () => {
    expect(extractPageMeta("<title>   </title><p>x</p>", BASE).title).toBeUndefined();
    expect(extractPageMeta("<p>x</p>", BASE).title).toBeUndefined();
  });

  it("caps absurd titles", () => {
    const meta = extractPageMeta(`<title>${"t".repeat(500)}</title>`, BASE);
    expect(meta.title!.length).toBe(200);
  });

  it("resolves a relative icon against the page URL", () => {
    const meta = extractPageMeta('<link rel="icon" href="fav.png">', BASE);
    expect(meta.iconUrl).toBe("httpx://site@example.org/dir/fav.png");
  });

  it("accepts shortcut icon and apple-touch-icon spellings of rel~=icon", () => {
    expect(
      extractPageMeta('<link rel="shortcut icon" href="/f.ico">', BASE).iconUrl,
    ).toBe("httpx://site@example.org/f.ico");
    expect(
      extractPageMeta('<link rel="icon" type="image/png" href="/f.png">', BASE)
        .iconUrl,
    ).toBe("httpx://site@example.org/f.png");
  });

  it("lets the last declared icon win, as browsers do", () => {
    const meta = extractPageMeta(
      '<link rel="icon" href="first.png"><link rel="icon" href="second.png">',
      BASE,
    );
    expect(meta.iconUrl).toBe("httpx://site@example.org/dir/second.png");
  });

  it("keeps https icons and refuses other schemes", () => {
    expect(
      extractPageMeta('<link rel="icon" href="https://cdn.example/f.png">', BASE)
        .iconUrl,
    ).toBe("https://cdn.example/f.png");
    for (const href of ["javascript:alert(1)", "ftp://example.org/f.ico"]) {
      expect(
        extractPageMeta(`<link rel="icon" href="${href}">`, BASE).iconUrl,
      ).toBeUndefined();
    }
  });

  it("skips a bad icon and falls back to an earlier usable one", () => {
    const meta = extractPageMeta(
      '<link rel="icon" href="/good.png"><link rel="icon" href="javascript:x">',
      BASE,
    );
    expect(meta.iconUrl).toBe("httpx://site@example.org/good.png");
  });

  it("ignores non-icon link relations", () => {
    const meta = extractPageMeta(
      '<link rel="stylesheet" href="/x.css"><link rel="preconnect" href="/y">',
      BASE,
    );
    expect(meta.iconUrl).toBeUndefined();
  });
});
