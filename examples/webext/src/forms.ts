import { parseHttpxUrl, resolveHttpxUrl } from "xmpp-httpx";

/**
 * Form support, limited to what httpx can actually carry: GET queries and
 * `application/x-www-form-urlencoded` POST bodies.
 *
 * The sandboxed iframe has no `allow-forms`, and Chromium checks that flag
 * *before* dispatching the submit event — a parent-side "submit" listener
 * never fires (verified in test/browser/render.test.ts). So submission is
 * driven the same way links are: the parent intercepts clicks on submit
 * controls and Enter-key implicit submission, then computes the submission
 * itself. The sandbox stays as tight as it was.
 *
 * Forms we cannot honor are marked at render time and explained at submit
 * time rather than silently doing something else.
 */

/** Why a form cannot be submitted, if it cannot be. */
export type FormRefusal = "external-action" | "file-upload" | "multipart";

const REFUSAL_ATTR = "data-httpx-refusal";

export interface FormSubmission {
  /** Absolute httpx URL; for GET the computed query is already applied. */
  url: string;
  method: "GET" | "POST";
  /** urlencoded pairs, POST only. */
  body?: URLSearchParams;
}

/**
 * Resolves form actions and neutralizes the parts of the form model we do not
 * implement. Runs after sanitization, on the document that will be shown.
 */
export function prepareForms(doc: Document, baseUrl: string): void {
  for (const form of doc.querySelectorAll("form")) {
    // A submitter must not be able to redirect or retarget the submission.
    for (const element of form.querySelectorAll(
      "[formaction], [formmethod], [formenctype], [formtarget]",
    )) {
      for (const attr of ["formaction", "formmethod", "formenctype", "formtarget"]) {
        element.removeAttribute(attr);
      }
    }
    form.removeAttribute("target");

    // No uploads: a file picker that silently submits nothing is worse than
    // no file picker, and `type=image` submits click coordinates.
    const uploads = form.querySelectorAll(
      'input[type="file" i], input[type="image" i]',
    );
    for (const input of uploads) input.remove();

    const action = form.getAttribute("action")?.trim() ?? "";
    let resolved: string;
    try {
      resolved = action === "" ? baseUrl : resolveHttpxUrl(baseUrl, action);
    } catch {
      resolved = baseUrl;
    }

    if (!resolved.startsWith("httpx://")) {
      refuse(form, "external-action");
      // Leave nothing loadable behind: even if interception broke, the
      // document must not be able to post user input to the internet.
      form.removeAttribute("action");
      form.setAttribute("data-httpx-action", resolved);
      continue;
    }

    form.setAttribute("action", resolved);
    if (uploads.length > 0) {
      refuse(form, "file-upload");
    } else if (/multipart\/form-data/i.test(form.getAttribute("enctype") ?? "")) {
      refuse(form, "multipart");
    }
  }
}

function refuse(form: Element, reason: FormRefusal): void {
  form.setAttribute(REFUSAL_ATTR, reason);
}

/** True for controls that submit their form: `<button>` (default type) and
 * `<input type=submit>`; never `type=button`/`reset`. */
export function isSubmitControl(element: Element): boolean {
  const type = (element.getAttribute("type") ?? "").toLowerCase();
  const tag = element.tagName.toLowerCase();
  if (tag === "button") return type === "" || type === "submit";
  if (tag === "input") return type === "submit";
  return false;
}

/**
 * The form's default button — the first submit control in tree order, which is
 * the submitter for Enter-key implicit submission.
 */
export function defaultSubmitter(form: HTMLFormElement): HTMLElement | null {
  for (const element of form.querySelectorAll("button, input")) {
    if (isSubmitControl(element)) return element as HTMLElement;
  }
  return null;
}

/**
 * True when Enter in `element` should submit its form: text-ish inputs only,
 * never a textarea (where Enter inserts a newline).
 */
export function isImplicitSubmitTarget(element: Element): boolean {
  if (element.tagName.toLowerCase() !== "input") return false;
  const type = (element.getAttribute("type") ?? "text").toLowerCase();
  return !["checkbox", "radio", "button", "reset", "submit", "file"].includes(type);
}

/** The refusal recorded by `prepareForms`, if any. */
export function refusalFor(form: HTMLFormElement): FormRefusal | null {
  return (form.getAttribute(REFUSAL_ATTR) as FormRefusal | null) ?? null;
}

/**
 * Computes what submitting `form` means. Returns null when the form was
 * refused at render time — the caller explains it to the user.
 */
export function submissionFor(
  form: HTMLFormElement,
  submitter?: HTMLElement | null,
): FormSubmission | null {
  if (refusalFor(form)) return null;

  const action = form.getAttribute("action") ?? "";
  const method =
    (form.getAttribute("method") ?? "").trim().toUpperCase() === "POST"
      ? "POST"
      : "GET";
  const params = formParams(form, submitter);

  if (method === "POST") return { url: action, method, body: params };

  // GET replaces any query already in the action, as browsers do.
  const url = parseHttpxUrl(action);
  const query = params.toString();
  return {
    url: `httpx://${url.jid}${url.path}${query === "" ? "" : `?${query}`}`,
    method,
  };
}

/**
 * `FormData` applies the standard construction algorithm (disabled controls
 * skipped, unchecked boxes omitted, the submitter's own name/value included),
 * so we do not reimplement it. File entries cannot occur — `prepareForms`
 * removed file inputs — but they are skipped defensively.
 */
function formParams(
  form: HTMLFormElement,
  submitter?: HTMLElement | null,
): URLSearchParams {
  let data: FormData;
  try {
    data = new FormData(form, (submitter as HTMLElement | undefined) ?? undefined);
  } catch {
    data = new FormData(form);
  }
  const params = new URLSearchParams();
  for (const [name, value] of data) {
    if (typeof value === "string") params.append(name, value);
  }
  return params;
}
