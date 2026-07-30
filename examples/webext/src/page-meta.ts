import { resolveHttpxUrl } from "xmpp-httpx";

/**
 * Page metadata (title, favicon) read from the *raw* document, before
 * sanitization: DOMPurify strips `<link>`, and with it any icon reference.
 *
 * Reading hostile HTML here is inert — `DOMParser` executes no scripts and
 * loads no subresources, and everything extracted is used as text or as a URL
 * re-resolved through `resolveHttpxUrl`, never as markup.
 */

const MAX_TITLE_LENGTH = 200;

export interface PageMeta {
  /** Trimmed document title, if the page declared a non-empty one. */
  title?: string;
  /** Absolute icon URL, if the page declared one we are willing to load. */
  iconUrl?: string;
}

export function extractPageMeta(html: string, baseUrl: string): PageMeta {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const meta: PageMeta = {};

  const title = doc.querySelector("title")?.textContent?.trim();
  if (title) meta.title = title.slice(0, MAX_TITLE_LENGTH);

  const iconUrl = pickIcon(doc, baseUrl);
  if (iconUrl) meta.iconUrl = iconUrl;

  return meta;
}

/**
 * The last declared icon wins, matching how browsers treat later `<link>`
 * elements as overrides. Only httpx (fetched over XMPP) and https (loaded
 * directly) are accepted — the same trust set as page images.
 */
function pickIcon(doc: Document, baseUrl: string): string | undefined {
  const links = [...doc.querySelectorAll('link[rel~="icon"][href]')].reverse();
  for (const link of links) {
    const href = link.getAttribute("href")?.trim();
    if (!href) continue;
    let resolved: string;
    try {
      resolved = resolveHttpxUrl(baseUrl, href);
    } catch {
      continue;
    }
    if (/^(?:httpx|https):/i.test(resolved)) return resolved;
  }
  return undefined;
}
