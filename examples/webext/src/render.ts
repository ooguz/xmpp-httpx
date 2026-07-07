import DOMPurify from "dompurify";
import { resolveHttpxUrl } from "xmpp-httpx";

/**
 * Rendering pipeline for fetched HTML:
 *   sanitize (DOMPurify, no scripts/styles/forms) → resolve relative URLs →
 *   fetch httpx subresources into blob: URLs → srcdoc into a sandboxed
 *   iframe WITHOUT allow-scripts (allow-same-origin alone is safe when
 *   nothing can execute, and it lets us intercept link clicks from here).
 */

// Allow relative refs plus the schemes we understand; everything else is
// stripped by DOMPurify.
const ALLOWED_URI = /^(?:(?:httpx?|https|blob|data|mailto|xmpp):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i;

const PURIFY_CONFIG = {
  FORBID_TAGS: [
    "script",
    "style",
    "link",
    "form",
    "input",
    "button",
    "iframe",
    "frame",
    "object",
    "embed",
    "base",
    "meta",
  ],
  ALLOWED_URI_REGEXP: ALLOWED_URI,
  WHOLE_DOCUMENT: true,
};

const BASE_STYLE = `
  body { font-family: system-ui, sans-serif; line-height: 1.5; margin: 1.5rem auto;
         max-width: 46rem; padding: 0 1rem; }
  img { max-width: 100%; }
  a { color: #1a56db; }
`;

export interface RenderTarget {
  iframe: HTMLIFrameElement;
  fetchResource: (url: string) => Promise<Blob>;
  onNavigate: (url: string) => void;
}

/** Returns a cleanup function revoking the blob: URLs it minted. */
export async function renderHtml(
  html: string,
  baseUrl: string,
  target: RenderTarget,
): Promise<() => void> {
  const clean = DOMPurify.sanitize(html, PURIFY_CONFIG);
  const doc = new DOMParser().parseFromString(clean, "text/html");
  const blobUrls: string[] = [];

  // Subresources: images travel over httpx too.
  const images = [...doc.querySelectorAll("img")];
  await Promise.all(
    images.map(async (img) => {
      img.removeAttribute("srcset");
      const src = img.getAttribute("src");
      if (!src) return;
      const resolved = resolveHttpxUrl(baseUrl, src);
      if (!resolved.startsWith("httpx://")) return; // https images left alone
      try {
        const blob = await target.fetchResource(resolved);
        const url = URL.createObjectURL(blob);
        blobUrls.push(url);
        img.setAttribute("src", url);
      } catch {
        img.setAttribute("alt", img.getAttribute("alt") ?? "(unavailable)");
        img.removeAttribute("src");
      }
    }),
  );

  // Links: resolve to absolute so interception sees final URLs.
  for (const anchor of doc.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href");
    if (href) anchor.setAttribute("href", resolveHttpxUrl(baseUrl, href));
  }

  const style = doc.createElement("style");
  style.textContent = BASE_STYLE;
  doc.head.append(style);

  const { iframe } = target;
  await new Promise<void>((resolve) => {
    iframe.addEventListener("load", () => resolve(), { once: true });
    iframe.srcdoc = doc.documentElement.outerHTML;
  });

  // allow-same-origin (and no scripts) → we can reach into the document.
  iframe.contentDocument?.addEventListener("click", (event) => {
    const anchor = (event.target as Element | null)?.closest?.("a[href]");
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    if (href.startsWith("httpx://")) {
      target.onNavigate(href);
    } else if (/^https?:/i.test(href)) {
      window.open(href, "_blank", "noopener");
    }
  });

  return () => {
    for (const url of blobUrls) URL.revokeObjectURL(url);
  };
}

/** Renders non-HTML responses: images directly, text in a <pre>. */
export async function renderPlain(
  contentType: string,
  body: Blob,
  target: Pick<RenderTarget, "iframe">,
): Promise<() => void> {
  const doc = document.implementation.createHTMLDocument();
  const style = doc.createElement("style");
  style.textContent = BASE_STYLE;
  doc.head.append(style);

  let revoke: () => void = () => {};
  if (contentType.startsWith("image/")) {
    const url = URL.createObjectURL(body);
    revoke = () => URL.revokeObjectURL(url);
    const img = doc.createElement("img");
    img.src = url;
    doc.body.append(img);
  } else {
    const pre = doc.createElement("pre");
    pre.style.whiteSpace = "pre-wrap";
    pre.textContent = await body.text();
    doc.body.append(pre);
  }

  const { iframe } = target;
  await new Promise<void>((resolve) => {
    iframe.addEventListener("load", () => resolve(), { once: true });
    iframe.srcdoc = doc.documentElement.outerHTML;
  });
  return revoke;
}
