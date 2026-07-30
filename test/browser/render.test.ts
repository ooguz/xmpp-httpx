import { afterEach, describe, expect, it } from "vitest";
import type {
  FormRefusal,
  FormSubmission,
} from "../../examples/webext/src/forms.js";
import {
  renderError,
  renderHtml,
  renderPlain,
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
  options: { available?: (url: string) => boolean } = {},
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
      return PNG;
    },
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

  it("injects the base style first so page CSS wins", async () => {
    const { doc } = await render("<style>body { margin: 4px }</style><p>x</p>");
    const styles = [...doc.querySelectorAll("style")];
    expect(styles[0]!.textContent).toContain("font-family");
    expect(styles.at(-1)!.textContent).toContain("margin: 4px");
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
