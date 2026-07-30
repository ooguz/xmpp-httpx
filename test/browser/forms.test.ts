import { describe, expect, it } from "vitest";
import {
  defaultSubmitter,
  isImplicitSubmitTarget,
  isSubmitControl,
  prepareForms,
  refusalFor,
  submissionFor,
} from "../../examples/webext/src/forms.js";

const BASE = "httpx://site@example.org/dir/page.html";

/** Parses `html`, runs prepareForms, and returns the first form. */
function prepare(html: string): HTMLFormElement {
  const doc = new DOMParser().parseFromString(html, "text/html");
  prepareForms(doc, BASE);
  return doc.querySelector("form")!;
}

describe("prepareForms", () => {
  it("resolves relative actions against the page URL", () => {
    expect(prepare('<form action="search"></form>').getAttribute("action")).toBe(
      "httpx://site@example.org/dir/search",
    );
    expect(prepare('<form action="/q"></form>').getAttribute("action")).toBe(
      "httpx://site@example.org/q",
    );
  });

  it("treats a missing or empty action as the current page", () => {
    expect(prepare("<form></form>").getAttribute("action")).toBe(BASE);
    expect(prepare('<form action="  "></form>').getAttribute("action")).toBe(BASE);
  });

  it("refuses non-httpx actions and leaves nothing loadable behind", () => {
    const form = prepare('<form action="https://evil.example/collect"></form>');
    expect(refusalFor(form)).toBe("external-action");
    expect(submissionFor(form)).toBeNull();
    expect(form.hasAttribute("action")).toBe(false);
    expect(form.getAttribute("data-httpx-action")).toBe(
      "https://evil.example/collect",
    );
  });

  it("refuses file uploads and removes the pickers", () => {
    const form = prepare(
      '<form action="/u"><input type="file" name="f"><input name="t"></form>',
    );
    expect(refusalFor(form)).toBe("file-upload");
    expect(form.querySelector('input[type="file"]')).toBeNull();
    expect(form.querySelector('input[name="t"]')).not.toBeNull();
  });

  it("removes image inputs, which submit click coordinates", () => {
    const form = prepare('<form action="/u"><input type="IMAGE" src="x.png"></form>');
    expect(form.querySelector("input")).toBeNull();
  });

  it("refuses multipart forms", () => {
    const form = prepare('<form action="/u" enctype="multipart/form-data"></form>');
    expect(refusalFor(form)).toBe("multipart");
  });

  it("strips submitter overrides and the form target", () => {
    const form = prepare(
      `<form action="/a" target="_blank">
         <button formaction="https://evil.example" formmethod="post"
                 formenctype="text/plain" formtarget="_top">go</button>
       </form>`,
    );
    expect(form.hasAttribute("target")).toBe(false);
    const button = form.querySelector("button")!;
    for (const attr of ["formaction", "formmethod", "formenctype", "formtarget"]) {
      expect(button.hasAttribute(attr), attr).toBe(false);
    }
  });
});

describe("submissionFor", () => {
  it("builds a GET query from the controls", () => {
    const form = prepare(
      `<form action="/search">
         <input name="q" value="hello world">
         <input name="page" value="2">
       </form>`,
    );
    expect(submissionFor(form)).toEqual({
      url: "httpx://site@example.org/search?q=hello+world&page=2",
      method: "GET",
    });
  });

  it("replaces a query already present in the action, as browsers do", () => {
    const form = prepare('<form action="/s?old=1"><input name="q" value="x"></form>');
    expect(submissionFor(form)!.url).toBe("httpx://site@example.org/s?q=x");
  });

  it("drops the query entirely when the form is empty", () => {
    const form = prepare('<form action="/s?old=1"></form>');
    expect(submissionFor(form)!.url).toBe("httpx://site@example.org/s");
  });

  it("builds a urlencoded body for POST", () => {
    const form = prepare(
      `<form action="/comment" method="POST">
         <input name="name" value="ada">
         <textarea name="text">hi &amp; bye</textarea>
       </form>`,
    );
    const submission = submissionFor(form)!;
    expect(submission.method).toBe("POST");
    expect(submission.url).toBe("httpx://site@example.org/comment");
    expect(submission.body!.get("name")).toBe("ada");
    expect(submission.body!.get("text")).toBe("hi & bye");
  });

  it("treats unknown methods as GET", () => {
    const form = prepare('<form action="/x" method="PUT"><input name="a" value="1"></form>');
    expect(submissionFor(form)!.method).toBe("GET");
  });

  it("applies the standard control rules", () => {
    const form = prepare(
      `<form action="/x">
         <input name="on" type="checkbox" value="1" checked>
         <input name="off" type="checkbox" value="1">
         <input name="skipped" value="v" disabled>
         <input value="nameless">
         <select name="s"><option value="a">a</option><option value="b" selected>b</option></select>
         <input name="hidden" type="hidden" value="h">
       </form>`,
    );
    const url = submissionFor(form)!.url;
    expect(url).toContain("on=1");
    expect(url).not.toContain("off=");
    expect(url).not.toContain("skipped=");
    expect(url).not.toContain("nameless");
    expect(url).toContain("s=b");
    expect(url).toContain("hidden=h");
  });

  it("includes the submitter's own name and value", () => {
    const form = prepare(
      `<form action="/x">
         <button name="action" value="delete">Delete</button>
         <button name="action" value="save">Save</button>
       </form>`,
    );
    const buttons = [...form.querySelectorAll("button")];
    expect(submissionFor(form, buttons[1]!)!.url).toContain("action=save");
    expect(submissionFor(form, buttons[0]!)!.url).toContain("action=delete");
    // No submitter → no submit-button value at all.
    expect(submissionFor(form)!.url).not.toContain("action=");
  });
});

describe("submit-control classification", () => {
  const el = (html: string) =>
    new DOMParser().parseFromString(html, "text/html").body.firstElementChild!;

  it("recognizes the controls that submit", () => {
    expect(isSubmitControl(el("<button>go</button>"))).toBe(true);
    expect(isSubmitControl(el('<button type="submit">go</button>'))).toBe(true);
    expect(isSubmitControl(el('<input type="submit">'))).toBe(true);
  });

  it("rejects the controls that do not", () => {
    expect(isSubmitControl(el('<button type="button">x</button>'))).toBe(false);
    expect(isSubmitControl(el('<button type="reset">x</button>'))).toBe(false);
    expect(isSubmitControl(el('<input type="reset">'))).toBe(false);
    expect(isSubmitControl(el('<input type="text">'))).toBe(false);
    expect(isSubmitControl(el("<a>x</a>"))).toBe(false);
  });

  it("picks the first submit control as the default submitter", () => {
    const form = prepare(
      `<form action="/x">
         <button type="button">no</button>
         <button name="a" value="1">yes</button>
         <button name="a" value="2">also no</button>
       </form>`,
    );
    expect(defaultSubmitter(form)!.getAttribute("value")).toBe("1");
    expect(defaultSubmitter(prepare('<form action="/x"></form>'))).toBeNull();
  });

  it("allows Enter submission only from text-ish inputs", () => {
    expect(isImplicitSubmitTarget(el('<input type="text">'))).toBe(true);
    expect(isImplicitSubmitTarget(el("<input>"))).toBe(true);
    expect(isImplicitSubmitTarget(el('<input type="search">'))).toBe(true);
    expect(isImplicitSubmitTarget(el('<input type="password">'))).toBe(true);
    expect(isImplicitSubmitTarget(el('<input type="checkbox">'))).toBe(false);
    expect(isImplicitSubmitTarget(el("<textarea></textarea>"))).toBe(false);
    expect(isImplicitSubmitTarget(el("<select></select>"))).toBe(false);
  });
});
