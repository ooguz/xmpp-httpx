import { describe, expect, it } from "vitest";
import { buildTabStrip } from "../../examples/webext/src/tab-strip.js";

const A = "httpx://site@example.org/a";

function render(
  entries: { id: number; title: string; url: string; active: boolean }[],
) {
  const selected: number[] = [];
  const closed: number[] = [];
  const list = document.createElement("ul");
  list.replaceChildren(
    buildTabStrip(entries, {
      onSelect: (id) => selected.push(id),
      onClose: (id) => closed.push(id),
    }),
  );
  return { list, selected, closed };
}

describe("buildTabStrip", () => {
  it("labels each tab and marks the active one", () => {
    const { list } = render([
      { id: 1, title: "Page A", url: A, active: false },
      { id: 2, title: "New tab", url: "", active: true },
    ]);
    const items = [...list.querySelectorAll("li")];
    expect(items.length).toBe(2);
    expect(items[0]!.querySelector(".select")!.textContent).toBe("Page A");
    expect(items[0]!.hasAttribute("data-active")).toBe(false);
    expect(items[1]!.getAttribute("data-active")).toBe("true");
    expect(items[1]!.querySelector(".select")!.getAttribute("aria-current")).toBe(
      "true",
    );
  });

  it("shows the URL as the tooltip, or the title when there is none", () => {
    const { list } = render([
      { id: 1, title: "Page A", url: A, active: true },
      { id: 2, title: "New tab", url: "", active: false },
    ]);
    const selects = [...list.querySelectorAll(".select")];
    expect(selects[0]!.getAttribute("title")).toBe(A);
    expect(selects[1]!.getAttribute("title")).toBe("New tab");
  });

  it("renders a hostile page title as text, never as markup", () => {
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const { list } = render([{ id: 1, title: hostile, url: A, active: true }]);
    expect(list.querySelector("img")).toBeNull();
    expect(list.querySelector("script")).toBeNull();
    expect(list.querySelector(".select")!.textContent).toBe(hostile);
    expect(list.querySelector(".close")!.getAttribute("aria-label")).toBe(
      `Close tab: ${hostile}`,
    );
  });

  it("reports selection and closing separately", () => {
    const { list, selected, closed } = render([
      { id: 7, title: "Page A", url: A, active: false },
    ]);
    (list.querySelector(".select") as HTMLElement).click();
    expect(selected).toEqual([7]);
    expect(closed).toEqual([]);

    (list.querySelector(".close") as HTMLElement).click();
    expect(closed).toEqual([7]);
    expect(selected).toEqual([7]); // closing does not also select
  });

  it("builds nothing for an empty set", () => {
    expect(render([]).list.children.length).toBe(0);
  });
});
