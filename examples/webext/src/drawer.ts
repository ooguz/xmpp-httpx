/**
 * The history/bookmarks list. Kept out of app.ts so it can be tested directly:
 * page titles are hostile input, and this list is the only place in the project
 * where a page-supplied string is put into the *extension's own* DOM rather
 * than into the sandboxed iframe. Everything here goes through `textContent`,
 * so no title can become markup no matter what a server sends.
 */

export interface DrawerEntry {
  url: string;
  title: string;
}

export interface DrawerHandlers {
  onOpen: (url: string) => void;
  onRemove: (url: string) => void;
  /** Tooltip for the per-entry remove button ("Forget this page", …). */
  removeLabel: string;
}

export function buildDrawerList(
  entries: readonly DrawerEntry[],
  handlers: DrawerHandlers,
): DocumentFragment {
  const fragment = document.createDocumentFragment();

  for (const { url, title } of entries) {
    const item = document.createElement("li");

    const open = document.createElement("button");
    open.className = "entry";
    open.type = "button";
    open.title = url;
    const titleLine = document.createElement("span");
    titleLine.className = "title";
    titleLine.textContent = title;
    const urlLine = document.createElement("span");
    urlLine.className = "url";
    urlLine.textContent = url;
    open.append(titleLine, urlLine);
    open.addEventListener("click", () => handlers.onOpen(url));

    const remove = document.createElement("button");
    remove.className = "remove";
    remove.type = "button";
    remove.textContent = "✕";
    remove.title = handlers.removeLabel;
    remove.addEventListener("click", () => handlers.onRemove(url));

    item.append(open, remove);
    fragment.append(item);
  }

  return fragment;
}
