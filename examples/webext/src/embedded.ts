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

/**
 * How the chrome sync should write the active tab's URL into the session
 * history. Standalone, the page's own back/forward buttons drive per-tab
 * stacks and every write replaces, keeping the session history at one entry.
 * Embedded, those buttons are hidden and the host app's back button is the
 * only history control the user has — so a navigation from one page to
 * another must push an entry for it to walk.
 *
 * Every other write replaces, even embedded:
 * - `navigated === false`: the tab's URL did not change since the last sync,
 *   so the write is a re-spelling of the current page's hash (a hand-edited
 *   non-canonical hash being corrected), not a move. Pushing here would
 *   re-push the canonical entry on every host back press that lands on the
 *   non-canonical one — an inescapable back-button trap.
 * - `currentHash === ""`: the boot-time upgrade of the empty-tab entry into
 *   the first page, which must not leave a blank entry behind the first page.
 * - `nextHash === ""`: a return to the empty-tab state is not a page.
 *
 * Traversals themselves never reach this decision: the caller compares the
 * serialized spelling the browser stores, so by the time hashchange fires the
 * location already matches and no write happens.
 */
export function historyWriteMode(
  embedded: boolean,
  navigated: boolean,
  currentHash: string,
  nextHash: string,
): "push" | "replace" {
  return embedded && navigated && currentHash !== "" && nextHash !== ""
    ? "push"
    : "replace";
}
