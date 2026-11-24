import { afterEach, describe, expect, it } from "vitest";
import type {
  FormRefusal,
  FormSubmission,
} from "../../examples/webext/src/forms.js";
import {
  hasContent,
  renderError,
  renderHtml,
  renderPlain,
  writeFrame,
} from "../../examples/webext/src/render.js";

const BASE = "httpx://site@example.org/dir/page.html";
const PNG = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], {
  type: "image/png",
});

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.querySelectorAll("iframe.render-test").forEach((f) => f.remove());
});

interface Harness {
  doc: Document;
  iframe: HTMLIFrameElement;
  fetched: string[];
  navigations: string[];
  submissions: {
    submission: FormSubmission | null;
    reason: FormRefusal | null;
  }[];
}

/** Renders `html` into a real same-origin iframe and returns what happened. */
async function render(
  html: string,
  options: {
    available?: (url: string) => boolean;
    /** The body served for a URL; a PNG by default. */
    respond?: (url: string) => Blob | undefined;
    proxied?: boolean;
  } = {},
): Promise<Harness> {
  const iframe = document.createElement("iframe");
  iframe.className = "render-test";
  // Matches browser.html: sandboxed, no allow-scripts.
  iframe.setAttribute("sandbox", "allow-same-origin");
  document.body.append(iframe);

  const fetched: string[] = [];
  const navigations: string[] = [];
  const submissions: Harness["submissions"] = [];
  const available = options.available ?? (() => true);

  const cleanup = await renderHtml(html, BASE, {
    iframe,
    fetchResource: async (url) => {
      fetched.push(url);
      if (!available(url)) throw new Error("404");
      return options.respond?.(url) ?? PNG;
    },
    proxied: options.proxied ?? false,
    onNavigate: (url) => navigations.push(url),
    onSubmit: (submission, reason) => submissions.push({ submission, reason }),
  });
  cleanups.push(cleanup);

  return { doc: iframe.contentDocument!, iframe, fetched, navigations, submissions };
}

describe("renderHtml — sanitization", () => {
  it("strips scripts, framing, and event handlers", async () => {
    const { doc } = await render(
      `<p onclick="alert(1)">hi</p><script>alert(2)</script>
       <iframe src="https://evil.example"></iframe><object data="x"></object>
       <embed src="x"><base href="https://evil.example/"><link rel="stylesheet" href="x.css">`,
    );
    const html = doc.documentElement.outerHTML;
    expect(html).not.toMatch(/<script|onclick|<iframe|<object|<embed|<base|<link/i);
    expect(doc.body.textContent).toContain("hi");
  });

  it("keeps page CSS but drops what the CSS sanitizer refuses", async () => {
    const { doc } = await render(
      `<style>
         @import url("httpx://site@example.org/theme.css");
         h1 { color: rgb(1, 2, 3) }
         p { background-image: url(http://insecure.example/x.png) }
       </style><h1>t</h1>`,
    );
    const css = [...doc.querySelectorAll("style")].map((s) => s.textContent).join("");
    expect(css).toContain("rgb(1, 2, 3)");
    expect(css).not.toContain("@import");
    expect(css).not.toContain("insecure.example");
  });

  it("gives an unstyled page the reading style", async () => {
    const { doc } = await render('<p style="color: red">x</p>');
    const styles = [...doc.querySelectorAll("style")];
    expect(styles).toHaveLength(1);
    expect(styles[0]!.textContent).toContain("max-width: 46rem");
    expect(doc.defaultView!.getComputedStyle(doc.body).maxWidth).not.toBe("none");
  });

  it("leaves a page with its own stylesheet to that stylesheet", async () => {
    const { doc } = await render("<style>header { color: rgb(1, 2, 3) }</style><p>x</p>");
    const css = [...doc.querySelectorAll("style")].map((s) => s.textContent).join("");
    expect(css).not.toContain("46rem");
    expect(doc.defaultView!.getComputedStyle(doc.body).maxWidth).toBe("none");
  });

  it("counts a stylesheet the sanitizer emptied as no stylesheet", async () => {
    const { doc } = await render(
      "<style>@import url(httpx://site@example.org/t.css);</style><p>x</p>",
    );
    expect(doc.querySelector("style")!.textContent).toContain("46rem");
  });

  it("re-escapes </style> smuggled through a CSS escape", async () => {
    // A literal </style> in the source would simply close the element (normal
    // HTML parsing). The hazard is CSS-escaped: it survives the CSS parse as a
    // string value, and CSSOM serializes "<" unescaped — so re-serializing the
    // document into srcdoc would close <style> early and inject real markup.
    const { doc } = await render(
      `<style>p::after { content: "\\3c /style\\3e \\3c img src=https://evil.example/x\\3e " }</style><p>x</p>`,
    );
    const css = doc.querySelector("style:last-of-type")!.textContent!;
    expect(css).not.toContain("</style");
    expect(css).toContain("\\3c /style");
    expect(doc.querySelector('img[src*="evil.example"]')).toBeNull();
  });
});

describe("renderHtml — httpx subresources", () => {
  it("fetches httpx images into blob: URLs", async () => {
    const { doc, fetched } = await render(`<img src="cat.png" alt="cat">`);
    expect(fetched).toEqual(["httpx://site@example.org/dir/cat.png"]);
    expect(doc.querySelector("img")!.getAttribute("src")).toMatch(/^blob:/);
  });

  it("leaves https images to the iframe and drops srcset", async () => {
    const { doc, fetched } = await render(
      `<img src="https://cdn.example/x.png" srcset="https://cdn.example/2x.png 2x">`,
    );
    expect(fetched).toEqual([]);
    const img = doc.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://cdn.example/x.png");
    expect(img.hasAttribute("srcset")).toBe(false);
  });

  it("substitutes httpx url() in CSS with the fetched blob", async () => {
    const { doc, fetched } = await render(
      `<style>body { background-image: url(bg.png) }</style>
       <div style="background-image: url(inline.png)">x</div>`,
    );
    expect(fetched).toEqual(
      expect.arrayContaining([
        "httpx://site@example.org/dir/bg.png",
        "httpx://site@example.org/dir/inline.png",
      ]),
    );
    const css = doc.querySelector("style:last-of-type")!.textContent!;
    expect(css).toMatch(/url\("blob:/);
    expect(css).not.toContain("httpx://");
    expect(doc.querySelector("div")!.getAttribute("style")).toMatch(/url\("blob:/);
  });

  it("fetches a URL shared by CSS and an image only once", async () => {
    const { fetched } = await render(
      `<style>body { background-image: url(shared.png) }</style>
       <img src="shared.png">`,
    );
    expect(fetched).toEqual(["httpx://site@example.org/dir/shared.png"]);
  });

  it("drops CSS declarations whose resource is unavailable", async () => {
    const { doc } = await render(
      `<style>body { background-image: url(gone.png); color: rgb(4, 5, 6) }</style>`,
      { available: () => false },
    );
    const css = doc.querySelector("style:last-of-type")!.textContent!;
    expect(css).toContain("rgb(4, 5, 6)");
    expect(css).not.toContain("gone.png");
    expect(css).not.toMatch(/url\(/);
  });

  it("marks unavailable images instead of failing the render", async () => {
    const { doc } = await render(`<img src="gone.png">`, {
      available: () => false,
    });
    const img = doc.querySelector("img")!;
    expect(img.hasAttribute("src")).toBe(false);
    expect(img.getAttribute("alt")).toBe("(unavailable)");
  });

  it("revokes every minted blob URL on cleanup", async () => {
    const { doc } = await render(
      `<style>body { background-image: url(bg.png) }</style><img src="cat.png">`,
    );
    const url = doc.querySelector("img")!.getAttribute("src")!;
    await expect(fetch(url)).resolves.toBeTruthy();
    for (const cleanup of cleanups.splice(0)) cleanup();
    await expect(fetch(url)).rejects.toThrow();
  });
});

describe("renderHtml — navigation", () => {
  it("resolves relative links and reports httpx clicks to the host", async () => {
    const { doc, navigations } = await render(`<a href="next.html">n</a>`);
    const anchor = doc.querySelector("a")!;
    expect(anchor.getAttribute("href")).toBe(
      "httpx://site@example.org/dir/next.html",
    );
    anchor.click();
    expect(navigations).toEqual(["httpx://site@example.org/dir/next.html"]);
  });

  it("does not report non-httpx clicks as in-place navigation", async () => {
    const { doc, navigations } = await render(
      `<a href="mailto:someone@example.org">m</a>`,
    );
    doc.querySelector("a")!.click();
    expect(navigations).toEqual([]);
  });
});

describe("renderPlain", () => {
  it("renders images through a blob URL and revokes it", async () => {
    const iframe = document.createElement("iframe");
    iframe.className = "render-test";
    document.body.append(iframe);
    const cleanup = await renderPlain("image/png", PNG, { iframe });
    const src = iframe.contentDocument!.querySelector("img")!.getAttribute("src")!;
    expect(src).toMatch(/^blob:/);
    cleanup();
    await expect(fetch(src)).rejects.toThrow();
  });

  it("renders text in a pre without interpreting it as markup", async () => {
    const iframe = document.createElement("iframe");
    iframe.className = "render-test";
    document.body.append(iframe);
    cleanups.push(
      await renderPlain("text/plain", new Blob(["<b>not bold</b>"]), { iframe }),
    );
    const doc = iframe.contentDocument!;
    expect(doc.querySelector("b")).toBeNull();
    expect(doc.querySelector("pre")!.textContent).toBe("<b>not bold</b>");
  });
});

describe("renderError", () => {
  const errorFrame = () => {
    const iframe = document.createElement("iframe");
    iframe.className = "render-test";
    iframe.setAttribute("sandbox", "allow-same-origin");
    document.body.append(iframe);
    return iframe;
  };

  it("shows the heading and detail as text, never as markup", async () => {
    const iframe = errorFrame();
    await renderError(iframe, {
      heading: "Failed to load httpx://a@b/c",
      detail: "<img src=x> & <b>timeout</b>",
    });
    const doc = iframe.contentDocument!;
    expect(doc.body.textContent).toContain("Failed to load httpx://a@b/c");
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.querySelector("pre")!.textContent).toBe("<img src=x> & <b>timeout</b>");
  });

  it("reports action clicks to the host", async () => {
    const iframe = errorFrame();
    const clicked: string[] = [];
    await renderError(
      iframe,
      {
        heading: "Not connected",
        actions: [
          { id: "connect", label: "Connection settings" },
          { id: "retry", label: "Retry" },
        ],
      },
      (id) => clicked.push(id),
    );
    const doc = iframe.contentDocument!;
    const links = [...doc.querySelectorAll("a[data-action]")];
    expect(links.map((a) => a.textContent)).toEqual([
      "Connection settings",
      "Retry",
    ]);
    (links[1] as HTMLElement).click();
    (links[0] as HTMLElement).click();
    expect(clicked).toEqual(["retry", "connect"]);
  });

  it("renders without actions", async () => {
    const iframe = errorFrame();
    await renderError(iframe, { heading: "Gone" });
    expect(iframe.contentDocument!.querySelector("a")).toBeNull();
  });

  it("can drop the warning glyph (the new-tab page uses this)", async () => {
    const iframe = errorFrame();
    await renderError(iframe, { icon: "", heading: "New tab" });
    expect(iframe.contentDocument!.querySelector("h2")!.textContent).toBe("New tab");
  });
});

describe("writeFrame", () => {
  it("writes the document in place, without navigating the frame", async () => {
    // srcdoc would navigate; GeckoView 159 never navigates frames inside an
    // extension tab, so every load hung there. The frame must keep its
    // initial about:blank document and simply get new contents.
    const iframe = document.createElement("iframe");
    iframe.className = "render-test";
    iframe.setAttribute("sandbox", "allow-same-origin");
    document.body.append(iframe);
    const before = iframe.contentDocument;
    expect(hasContent(iframe)).toBe(false);

    await writeFrame(iframe, "<html><head><style>p { color: rgb(255, 0, 0) }</style></head><body><p>hi</p></body></html>");

    expect(iframe.contentDocument).toBe(before);
    expect(iframe.srcdoc).toBe("");
    expect(iframe.contentDocument!.readyState).toBe("complete");
    const p = iframe.contentDocument!.querySelector("p")!;
    expect(p.textContent).toBe("hi");
    expect(iframe.contentWindow!.getComputedStyle(p).color).toBe("rgb(255, 0, 0)");
    expect(hasContent(iframe)).toBe(true);
  });

  it("keeps the sandbox: scripts and inline handlers in the document never run", async () => {
    const iframe = document.createElement("iframe");
    iframe.className = "render-test";
    iframe.setAttribute("sandbox", "allow-same-origin");
    document.body.append(iframe);
    const w = window as unknown as { __ranInFrame?: string };
    delete w.__ranInFrame;

    await writeFrame(
      iframe,
      `<body><script>parent.__ranInFrame = "script"</script>` +
        `<img src="data:," onerror="parent.__ranInFrame = 'handler'" onload="parent.__ranInFrame = 'handler'"></body>`,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(w.__ranInFrame).toBeUndefined();
  });
});

describe("hidden iframes", () => {
  it("still take their document — background tabs depend on it", async () => {
    // The tab strip keeps one iframe per tab and hides all but the active one.
    // If a hidden iframe did not load, a load started in a background tab (or a
    // tab switched away from mid-load) would hang forever.
    const iframe = document.createElement("iframe");
    iframe.className = "render-test";
    iframe.setAttribute("sandbox", "allow-same-origin");
    iframe.hidden = true;
    document.body.append(iframe);

    cleanups.push(
      await renderHtml("<p>loaded while hidden</p>", BASE, {
        iframe,
        fetchResource: () => Promise.reject(new Error("no subresources")),
        onNavigate: () => {},
      }),
    );
    expect(iframe.contentDocument!.body.textContent).toContain(
      "loaded while hidden",
    );
  });
});

describe("renderHtml — forms", () => {
  it("keeps form controls in the document", async () => {
    const { doc } = await render(
      `<form action="/s"><input name="q"><button>go</button></form>`,
    );
    expect(doc.querySelector("form")).not.toBeNull();
    expect(doc.querySelector('input[name="q"]')).not.toBeNull();
    expect(doc.querySelector("button")).not.toBeNull();
  });

  it("intercepts a GET submit from the sandboxed document", async () => {
    // Chromium refuses submission (no allow-forms) *before* dispatching the
    // submit event, so interception hangs off the control click instead.
    const { doc, submissions } = await render(
      `<form action="/search"><input name="q" value="cats"><button>go</button></form>`,
    );
    doc.querySelector("button")!.click();
    expect(submissions).toEqual([
      {
        submission: {
          url: "httpx://site@example.org/search?q=cats",
          method: "GET",
        },
        reason: null,
      },
    ]);
  });

  it("intercepts a POST submit with a urlencoded body", async () => {
    const { doc, submissions } = await render(
      `<form action="/comment" method="post">
         <input name="text" value="hi there"><button>send</button>
       </form>`,
    );
    doc.querySelector("button")!.click();
    const { submission } = submissions[0]!;
    expect(submission!.method).toBe("POST");
    expect(submission!.url).toBe("httpx://site@example.org/comment");
    expect(submission!.body!.toString()).toBe("text=hi+there");
  });

  it("reports refused forms instead of submitting them", async () => {
    const { doc, submissions } = await render(
      `<form action="https://evil.example/collect"><button>go</button></form>`,
    );
    // Nothing loadable is left behind either, so a broken listener cannot leak.
    expect(doc.querySelector("form")!.hasAttribute("action")).toBe(false);
    doc.querySelector("button")!.click();
    expect(submissions).toEqual([
      { submission: null, reason: "external-action" },
    ]);
  });

  it("submits on Enter in a text field, using the default button", async () => {
    const { doc, submissions } = await render(
      `<form action="/s">
         <input name="q" value="cats">
         <button name="b" value="first">a</button>
         <button name="b" value="second">b</button>
       </form>`,
    );
    doc.querySelector("input")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(submissions[0]!.submission!.url).toBe(
      "httpx://site@example.org/s?q=cats&b=first",
    );
  });

  it("does not submit on Enter in a textarea", async () => {
    const { doc, submissions } = await render(
      `<form action="/s"><textarea name="t">x</textarea></form>`,
    );
    doc.querySelector("textarea")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(submissions).toEqual([]);
  });

  it("ignores clicks on non-submit controls", async () => {
    const { doc, submissions } = await render(
      `<form action="/s">
         <button type="button">plain</button>
         <input type="reset" value="reset">
         <input type="checkbox" name="c">
       </form>`,
    );
    for (const selector of [
      'button[type="button"]',
      'input[type="reset"]',
      'input[type="checkbox"]',
    ]) {
      (doc.querySelector(selector) as HTMLElement).click();
    }
    expect(submissions).toEqual([]);
  });

  it("does not navigate the parent when a form is submitted", async () => {
    const { doc, navigations } = await render(
      `<form action="/s"><button>go</button></form>`,
    );
    doc.querySelector("button")!.click();
    expect(navigations).toEqual([]);
  });
});

const css = (text: string, type = "text/css"): Blob => new Blob([text], { type });

describe("renderHtml — linked stylesheets", () => {
  const styles = (doc: Document): string =>
    [...doc.querySelectorAll("style")].map((s) => s.textContent).join("\n");

  it("inlines an httpx stylesheet in place, sanitized", async () => {
    const { doc, fetched } = await render(
      `<head><style>h1 { color: rgb(9, 9, 9) }</style>
       <link rel="stylesheet" href="site.css" media="screen">
       <style>h1 { margin: 3px }</style></head><h1>t</h1>`,
      {
        respond: (url) =>
          url.endsWith(".css")
            ? css(`@import url(more.css); h1 { color: rgb(1, 2, 3) }
                   p { background: url(javascript:alert(1)) }`)
            : undefined,
      },
    );
    expect(fetched).toContain("httpx://site@example.org/dir/site.css");
    expect(doc.querySelector("link")).toBeNull();
    const sheets = [...doc.querySelectorAll("style")].map((s) => s.textContent!);
    // The page's three in source order; a styled page gets no base style.
    expect(sheets).toHaveLength(3);
    expect(sheets[0]).toContain("rgb(9, 9, 9)");
    expect(sheets[1]).toContain("rgb(1, 2, 3)");
    expect(sheets[2]).toContain("margin: 3px");
    expect(doc.querySelectorAll("style")[1]!.getAttribute("media")).toBe("screen");
    expect(sheets[1]).not.toMatch(/@import|javascript/);
    expect(fetched).not.toContain("httpx://site@example.org/dir/more.css");
    expect(getComputedStyle(doc.querySelector("h1")!).color).toBe("rgb(1, 2, 3)");
  });

  it("resolves the sheet's url()s against the sheet, and fetches them", async () => {
    const { doc, fetched } = await render(
      `<link rel="stylesheet" href="/theme/site.css"><p>x</p>`,
      {
        respond: (url) =>
          url.endsWith(".css") ? css(`body { background-image: url(img/bg.png) }`) : undefined,
      },
    );
    expect(fetched).toContain("httpx://site@example.org/theme/img/bg.png");
    expect(styles(doc)).toMatch(/url\("blob:/);
    expect(styles(doc)).not.toContain("httpx://");
  });

  it("drops a sheet that is not text/css, fails, or is an alternate", async () => {
    const { doc, fetched } = await render(
      `<link rel="stylesheet" href="png.css">
       <link rel="stylesheet" href="gone.css">
       <link rel="alternate stylesheet" href="alt.css">
       <link rel="icon" href="favicon.png"><p>x</p>`,
      {
        available: (url) => !url.endsWith("gone.css"),
        respond: (url) =>
          url.endsWith("png.css") ? undefined : css("p { color: rgb(7, 7, 7) }"),
      },
    );
    expect(fetched).toEqual(
      expect.arrayContaining([
        "httpx://site@example.org/dir/png.css",
        "httpx://site@example.org/dir/gone.css",
      ]),
    );
    expect(fetched).not.toContain("httpx://site@example.org/dir/alt.css");
    expect(fetched).not.toContain("httpx://site@example.org/dir/favicon.png");
    expect(doc.querySelector("link")).toBeNull();
    expect(doc.querySelectorAll("style")).toHaveLength(1); // the base style
  });

  it("leaves no https stylesheet to the frame on an httpx page", async () => {
    const { doc, fetched } = await render(
      `<link rel="stylesheet" href="https://cdn.example/site.css"><p>x</p>`,
    );
    expect(fetched).toEqual([]);
    expect(doc.querySelector("link")).toBeNull();
  });

  it("fetches an https stylesheet through the extension on a proxied page", async () => {
    const { doc, fetched } = await render(
      `<link rel="stylesheet" href="https://cdn.example/site.css"><p>x</p>`,
      { proxied: true, respond: () => css("p { color: rgb(5, 6, 7) }") },
    );
    expect(fetched).toEqual(["https://cdn.example/site.css"]);
    expect(styles(doc)).toContain("rgb(5, 6, 7)");
  });

  it("fetches a sheet linked twice only once", async () => {
    const { doc, fetched } = await render(
      `<link rel="stylesheet" href="a.css"><link rel="stylesheet" href="a.css">`,
      { respond: () => css("p { color: rgb(1, 1, 1) }") },
    );
    expect(fetched).toEqual(["httpx://site@example.org/dir/a.css"]);
    expect(doc.querySelectorAll("style")).toHaveLength(2);
  });

  it("keeps a smuggled </style> escaped in an inlined sheet", async () => {
    const { doc } = await render(`<link rel="stylesheet" href="x.css"><p>x</p>`, {
      respond: () =>
        css(`p::after { content: "\\3c /style\\3e \\3c img src=https://evil.example/x\\3e " }`),
    });
    expect(styles(doc)).not.toContain("</style");
    expect(doc.querySelector('img[src*="evil.example"]')).toBeNull();
  });
});
