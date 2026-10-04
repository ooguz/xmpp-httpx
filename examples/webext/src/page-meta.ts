import { resolveUrl } from "xmpp-httpx";

/**
 * Page metadata (title, favicon) read from the *raw* document, before
 * sanitization: DOMPurify strips `<link>`, and with it any icon reference.
 *
 * Reading hostile HTML here is inert — `DOMParser` executes no scripts and
 * loads no subresources, and everything extracted is used as text or as a URL
 * re-resolved through `resolveUrl`, never as markup.
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
 * elements as overrides.
 *
 * **Over the session only.** The favicon is the one page-supplied resource
 * that lands on the *extension* page rather than inside the sandboxed iframe,
 * and the extension page otherwise loads nothing remote. Loading an `https:`
 * icon directly would let any visited page make the privileged origin issue a
 * cross-origin request (an IP/visit ping with third-party cookies attached),
 * so the icon is always fetched over the XMPP session instead: an httpx icon
 * from its own JID, and, on a page that was itself fetched through an exit
 * (proxy mode, an http(s) base), an http(s) icon through that same exit. An
 * httpx page's http(s) icon is ignored, as an httpx page's forms may not post
 * to the ordinary web either.
 */
function pickIcon(doc: Document, baseUrl: string): string | undefined {
  const proxied = /^https?:\/\//i.test(baseUrl);
  const links = [...doc.querySelectorAll('link[rel~="icon"][href]')].reverse();
  for (const link of links) {
    const href = link.getAttribute("href")?.trim();
    if (!href) continue;
    let resolved: string;
    try {
      resolved = resolveUrl(baseUrl, href);
    } catch {
      continue;
    }
    if (resolved.startsWith("httpx://")) return resolved;
    if (proxied && /^https?:\/\//i.test(resolved)) return resolved;
  }
  return undefined;
}
