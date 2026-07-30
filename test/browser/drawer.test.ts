import { describe, expect, it } from "vitest";
import { buildDrawerList } from "../../examples/webext/src/drawer.js";

const A = "httpx://site@example.org/a.html";

/** Renders a list into a detached <ul> the way app.ts does. */
function render(entries: { url: string; title: string }[]) {
  const opened: string[] = [];
  const removed: string[] = [];
  const list = document.createElement("ul");
  list.replaceChildren(
    buildDrawerList(entries, {
      onOpen: (url) => opened.push(url),
      onRemove: (url) => removed.push(url),
      removeLabel: "Forget this page",
    }),
  );
  return { list, opened, removed };
}

describe("buildDrawerList", () => {
  it("shows the title and URL of each entry", () => {
    const { list } = render([
      { url: A, title: "Page A" },
      { url: "httpx://site@example.org/b", title: "Page B" },
    ]);
    expect(list.querySelectorAll("li").length).toBe(2);
    expect(list.querySelector(".title")!.textContent).toBe("Page A");
    expect(list.querySelector(".url")!.textContent).toBe(A);
  });

  it("renders a hostile title as text, never as markup", () => {
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const { list } = render([{ url: A, title: hostile }]);
    expect(list.querySelector("img")).toBeNull();
    expect(list.querySelector("script")).toBeNull();
    expect(list.querySelector(".title")!.textContent).toBe(hostile);
  });

  it("reports opens and removes to the host", () => {
    const { list, opened, removed } = render([{ url: A, title: "Page A" }]);
    (list.querySelector("button.entry") as HTMLElement).click();
    (list.querySelector("button.remove") as HTMLElement).click();
    expect(opened).toEqual([A]);
    expect(removed).toEqual([A]);
  });

  it("labels the remove button as the caller asked", () => {
    const { list } = render([{ url: A, title: "Page A" }]);
    expect(list.querySelector("button.remove")!.getAttribute("title")).toBe(
      "Forget this page",
    );
  });

  it("builds nothing for an empty list", () => {
    const { list } = render([]);
    expect(list.children.length).toBe(0);
  });
});
