/**
 * Embedded mode: a host app that renders this page in its own browser chrome
 * (the Klar fork's toolbar, for instance) appends `?embedded=1` to the page
 * URL, and the extension's own tab strip and URL bar are hidden — one page,
 * one chrome. The flag must be read once at boot: syncChrome() rewrites the
 * visible URL with history.replaceState, so location.search cannot be trusted
 * later.
 */

/** True when the page URL's query string carries the embedded flag. */
export function isEmbedded(search: string): boolean {
  return new URLSearchParams(search).has("embedded");
}

/**
 * Marks the document so the stylesheet hides the extension's own chrome
 * (see the `body[data-embedded]` rules in style.css). Returns the flag.
 */
export function applyEmbedded(doc: Document, search: string): boolean {
  const embedded = isEmbedded(search);
  if (embedded) doc.body.dataset["embedded"] = "true";
  return embedded;
}
