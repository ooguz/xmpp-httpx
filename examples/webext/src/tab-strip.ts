/**
 * The tab strip's DOM. Kept out of app.ts for the same reason as the drawer:
 * tab labels are page titles, i.e. hostile input, and this is the extension's
 * own DOM. Every label goes in via `textContent`.
 */

export interface TabStripEntry {
  id: number;
  title: string;
  url: string;
  active: boolean;
}

export interface TabStripHandlers {
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
}

export function buildTabStrip(
  entries: readonly TabStripEntry[],
  handlers: TabStripHandlers,
): DocumentFragment {
  const fragment = document.createDocumentFragment();

  for (const entry of entries) {
    const item = document.createElement("li");
    item.className = "tab";
    if (entry.active) item.dataset["active"] = "true";

    const select = document.createElement("button");
    select.className = "select";
    select.type = "button";
    select.textContent = entry.title;
    select.title = entry.url === "" ? entry.title : entry.url;
    select.setAttribute("aria-current", String(entry.active));
    select.addEventListener("click", () => handlers.onSelect(entry.id));

    const close = document.createElement("button");
    close.className = "close";
    close.type = "button";
    close.textContent = "✕";
    close.title = "Close tab";
    close.setAttribute("aria-label", `Close tab: ${entry.title}`);
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      handlers.onClose(entry.id);
    });

    item.append(select, close);
    fragment.append(item);
  }

  return fragment;
}
