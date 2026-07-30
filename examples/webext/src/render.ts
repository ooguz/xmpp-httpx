import DOMPurify from "dompurify";
import { resolveHttpxUrl } from "xmpp-httpx";
import {
  allowSafeSchemes,
  sanitizeDocumentStyles,
  type CssUrlResolver,
} from "./sanitize-css.js";

/**
 * Rendering pipeline for fetched HTML:
 *   sanitize (DOMPurify, no scripts/forms; CSS allowed but re-sanitized
 *   separately since DOMPurify doesn't parse CSS) → resolve relative URLs →
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

/**
 * Fetches httpx subresources into `blob:` URLs, once per URL. Failures are
 * remembered as `null` — nothing in the render pipeline should throw because a
 * background image is missing.
 */
class BlobCache {
  private readonly urls = new Map<string, string | null>();

  constructor(private readonly fetchResource: (url: string) => Promise<Blob>) {}

  async load(httpxUrls: Iterable<string>): Promise<void> {
    const pending = [...new Set(httpxUrls)].filter((url) => !this.urls.has(url));
    await Promise.all(
      pending.map(async (url) => {
        try {
          this.urls.set(url, URL.createObjectURL(await this.fetchResource(url)));
        } catch {
          this.urls.set(url, null);
        }
      }),
    );
  }

  get(httpxUrl: string): string | null {
    return this.urls.get(httpxUrl) ?? null;
  }

  revoke(): void {
    for (const url of this.urls.values()) {
      if (url) URL.revokeObjectURL(url);
    }
    this.urls.clear();
  }
}

/** Returns a cleanup function revoking the blob: URLs it minted. */
export async function renderHtml(
  html: string,
  baseUrl: string,
  target: RenderTarget,
): Promise<() => void> {
  const clean = DOMPurify.sanitize(html, PURIFY_CONFIG);
  const doc = new DOMParser().parseFromString(clean, "text/html");
  const blobs = new BlobCache(target.fetchResource);

  // CSS pass 1: sanitize and resolve every url() to absolute, collecting the
  // httpx references that need fetching before the document can be shown.
  const cssRefs = new Set<string>();
  sanitizeDocumentStyles(doc, baseUrl, (url) => {
    if (url.startsWith("httpx://")) cssRefs.add(url);
    return allowSafeSchemes(url);
  });

  // Images travel over httpx too; https ones are left to the iframe.
  const images = [...doc.querySelectorAll("img")];
  const imageRefs = new Map<Element, string>();
  for (const img of images) {
    img.removeAttribute("srcset");
    const src = img.getAttribute("src");
    if (!src) continue;
    const resolved = resolveHttpxUrl(baseUrl, src);
    if (resolved.startsWith("httpx://")) imageRefs.set(img, resolved);
  }

  await blobs.load([...cssRefs, ...imageRefs.values()]);

  for (const [img, resolved] of imageRefs) {
    const blobUrl = blobs.get(resolved);
    if (blobUrl) {
      img.setAttribute("src", blobUrl);
    } else {
      img.setAttribute("alt", img.getAttribute("alt") ?? "(unavailable)");
      img.removeAttribute("src");
    }
  }

  // CSS pass 2: swap the httpx references for their blob: URLs, dropping the
  // declarations whose resource never arrived.
  const substitute: CssUrlResolver = (url) =>
    url.startsWith("httpx://") ? blobs.get(url) : allowSafeSchemes(url);
  sanitizeDocumentStyles(doc, baseUrl, substitute);

  // Links: resolve to absolute so interception sees final URLs.
  for (const anchor of doc.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href");
    if (href) anchor.setAttribute("href", resolveHttpxUrl(baseUrl, href));
  }

  // Prepended, not appended: page CSS is now allowed and should win.
  const style = doc.createElement("style");
  style.textContent = BASE_STYLE;
  doc.head.prepend(style);

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

  return () => blobs.revoke();
}

export interface ErrorAction {
  /** Reported back to `onAction` when clicked. */
  id: string;
  label: string;
}

/**
 * Renders a browser-style error page. The document is scriptless like any
 * other, so the buttons are anchors whose clicks the parent intercepts — the
 * same mechanism that handles page links.
 */
export async function renderError(
  iframe: HTMLIFrameElement,
  info: { heading: string; detail?: string; actions?: ErrorAction[] },
  onAction: (id: string) => void = () => {},
): Promise<void> {
  const doc = document.implementation.createHTMLDocument();
  const style = doc.createElement("style");
  style.textContent = `${BASE_STYLE}
    .heading { display: flex; gap: 0.5rem; align-items: baseline; }
    pre { white-space: pre-wrap; opacity: 0.75; font-size: 0.9rem; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
    .actions a { display: inline-block; padding: 0.35rem 0.9rem; border-radius: 6px;
                 border: 1px solid #1a56db; text-decoration: none; }
  `;
  doc.head.append(style);

  const heading = doc.createElement("h2");
  heading.className = "heading";
  heading.append(doc.createTextNode(`⚠ ${info.heading}`));
  doc.body.append(heading);

  if (info.detail) {
    const pre = doc.createElement("pre");
    pre.textContent = info.detail; // textContent: never parsed as markup
    doc.body.append(pre);
  }

  if (info.actions?.length) {
    const actions = doc.createElement("div");
    actions.className = "actions";
    for (const action of info.actions) {
      const anchor = doc.createElement("a");
      anchor.href = "#";
      anchor.dataset["action"] = action.id;
      anchor.textContent = action.label;
      actions.append(anchor);
    }
    doc.body.append(actions);
  }

  await new Promise<void>((resolve) => {
    iframe.addEventListener("load", () => resolve(), { once: true });
    iframe.srcdoc = doc.documentElement.outerHTML;
  });

  iframe.contentDocument?.addEventListener("click", (event) => {
    const anchor = (event.target as Element | null)?.closest?.("a[data-action]");
    if (!anchor) return;
    event.preventDefault();
    onAction((anchor as HTMLElement).dataset["action"] ?? "");
  });
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
