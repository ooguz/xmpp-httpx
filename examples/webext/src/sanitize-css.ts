import { resolveUrl } from "xmpp-httpx";

/**
 * CSS sanitizer built on CSSOM (`CSSStyleSheet.replaceSync`) rather than a
 * bundled CSS parser: the browser's own parser normalizes the input, and
 * constructed stylesheets already refuse `@import` per spec. We additionally
 * drop every other at-rule we don't recognize, and route every `url()` through
 * a resolver so the caller decides what a reference may point at — the render
 * pipeline swaps httpx references for the `blob:` URLs it fetched, and drops
 * declarations it could not satisfy.
 *
 * The sanitizer is idempotent: running it over its own output is a no-op apart
 * from resolver substitutions, which is what lets `render.ts` run it twice
 * (pass 1 discovers the httpx references, pass 2 substitutes blob URLs).
 */

const ALLOWED_URL_SCHEME = /^(?:httpx|https|data|blob):/i;
const DANGEROUS_VALUE = /expression\s*\(|-moz-binding|javascript:/i;
const DANGEROUS_PROPS = new Set(["behavior", "-moz-binding"]);
/** Bound the parser's work; real stylesheets are orders of magnitude smaller. */
const MAX_CSS_LENGTH = 512 * 1024;

/**
 * Decides what an absolute `url()` reference in a declaration becomes:
 * a replacement URL to keep, or `null` to drop the whole declaration.
 */
export type CssUrlResolver = (absoluteUrl: string) => string | null;

/** Keeps references the render pipeline already trusts for images. */
export const allowSafeSchemes: CssUrlResolver = (url) =>
  ALLOWED_URL_SCHEME.test(url) ? url : null;

function resolveToken(
  raw: string,
  baseUrl: string,
  resolve: CssUrlResolver,
): string | null {
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, "");
  if (trimmed === "" || trimmed.startsWith("#")) return trimmed; // url(#svg-filter)
  let absolute: string;
  try {
    absolute = resolveUrl(baseUrl, trimmed);
  } catch {
    return null;
  }
  return resolve(absolute);
}

/**
 * Reads one `url()` token starting after the opening paren. Quoted forms are
 * scanned honoring the quote, so a ")" *inside* the URL does not end the token
 * early — a regex up to the first ")" silently mangles `url("a)b.png")`.
 */
function readUrlToken(
  value: string,
  from: number,
): { raw: string; end: number } | null {
  let i = from;
  while (i < value.length && /\s/.test(value[i]!)) i++;
  const quote = value[i];
  if (quote !== '"' && quote !== "'") {
    // Unquoted: CSS forbids an unescaped ")" here, so the first one ends it.
    const close = value.indexOf(")", i);
    return close === -1 ? null : { raw: value.slice(i, close).trim(), end: close + 1 };
  }
  i++;
  let raw = "";
  for (; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "\\") {
      raw += value[i + 1] ?? ""; // escaped character stands for itself
      i++;
      continue;
    }
    if (ch === quote) break;
    raw += ch;
  }
  i++; // past the closing quote
  while (i < value.length && /\s/.test(value[i]!)) i++;
  return value[i] === ")" ? { raw, end: i + 1 } : null;
}

/** Rewrites every `url()` in a value, or returns null if one was rejected. */
function rewriteUrls(
  value: string,
  baseUrl: string,
  resolve: CssUrlResolver,
): string | null {
  let out = "";
  let index = 0;
  const lowered = value.toLowerCase();
  for (;;) {
    const start = lowered.indexOf("url(", index);
    if (start === -1) return out + value.slice(index);
    const token = readUrlToken(value, start + 4);
    if (!token) return out + value.slice(index); // malformed; CSSOM will refuse it
    const replacement = resolveToken(token.raw, baseUrl, resolve);
    if (replacement === null) return null;
    out += value.slice(index, start);
    out += `url("${replacement.replace(/[\\"]/g, "\\$&")}")`;
    index = token.end;
  }
}

function sanitizeDeclaration(
  style: CSSStyleDeclaration,
  baseUrl: string,
  resolve: CssUrlResolver,
): void {
  for (const prop of Array.from(style)) {
    const value = style.getPropertyValue(prop);
    if (DANGEROUS_PROPS.has(prop.toLowerCase()) || DANGEROUS_VALUE.test(value)) {
      style.removeProperty(prop);
      continue;
    }
    if (!value.includes("url(")) continue;
    const rewritten = rewriteUrls(value, baseUrl, resolve);
    if (rewritten === null) {
      style.removeProperty(prop);
    } else if (rewritten !== value) {
      const priority = style.getPropertyPriority(prop);
      style.removeProperty(prop);
      style.setProperty(prop, rewritten, priority);
    }
  }
}

/**
 * Serializes the rules we allow, sanitizing their declarations in place, and
 * silently omits every other rule. Allow-listing on the way out rather than
 * calling `deleteRule` avoids CSSOM's refusal to remove an `@namespace` rule
 * while other rules exist — an unremovable rule must not become a kept rule.
 */
function serializeAllowedRules(
  container: CSSStyleSheet | CSSGroupingRule,
  baseUrl: string,
  resolve: CssUrlResolver,
): string {
  const kept: string[] = [];
  for (const rule of Array.from(container.cssRules)) {
    switch (rule.type) {
      case CSSRule.STYLE_RULE:
      case CSSRule.FONT_FACE_RULE:
        sanitizeDeclaration((rule as CSSStyleRule).style, baseUrl, resolve);
        kept.push(rule.cssText);
        break;
      case CSSRule.KEYFRAMES_RULE:
        for (const kf of Array.from((rule as CSSKeyframesRule).cssRules)) {
          sanitizeDeclaration((kf as CSSKeyframeRule).style, baseUrl, resolve);
        }
        kept.push(rule.cssText);
        break;
      case CSSRule.MEDIA_RULE:
      case CSSRule.SUPPORTS_RULE: {
        const inner = serializeAllowedRules(
          rule as CSSGroupingRule,
          baseUrl,
          resolve,
        );
        if (inner === "") break;
        const condition =
          rule.type === CSSRule.MEDIA_RULE
            ? `@media ${(rule as CSSMediaRule).media.mediaText}`
            : `@supports ${(rule as CSSSupportsRule).conditionText}`;
        kept.push(`${condition} {\n${inner}\n}`);
        break;
      }
      default:
      // @import (already refused by replaceSync), @namespace, @page,
      // @counter-style, @font-feature-values, @viewport, anything unknown.
    }
  }
  return kept.join("\n");
}

/** Sanitizes a full `<style>` block's text content. */
export function sanitizeStylesheet(
  css: string,
  baseUrl: string,
  resolve: CssUrlResolver = allowSafeSchemes,
): string {
  if (css.length > MAX_CSS_LENGTH) return "";
  const sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync(css);
  } catch {
    return "";
  }
  return (
    serializeAllowedRules(sheet, baseUrl, resolve)
      // A CSS string may legitimately contain "</style", which would close the
      // raw-text element early when the document is re-serialized into srcdoc
      // and inject markup. `\3c` is the CSS escape for "<".
      .replace(/<\/(style)/gi, "\\3c /$1")
  );
}

/** Sanitizes an inline `style="…"` attribute value. */
export function sanitizeInlineStyle(
  value: string,
  baseUrl: string,
  resolve: CssUrlResolver = allowSafeSchemes,
): string {
  if (value.length > MAX_CSS_LENGTH) return "";
  const probe = document.createElement("div");
  probe.style.cssText = value;
  sanitizeDeclaration(probe.style, baseUrl, resolve);
  return probe.style.cssText;
}

/** Sanitizes every `<style>` element and `style=` attribute in `doc` in place. */
export function sanitizeDocumentStyles(
  doc: Document,
  baseUrl: string,
  resolve: CssUrlResolver = allowSafeSchemes,
): void {
  for (const element of doc.querySelectorAll("style")) {
    const sanitized = sanitizeStylesheet(element.textContent ?? "", baseUrl, resolve);
    if (sanitized === "") {
      element.remove();
    } else {
      element.textContent = sanitized;
    }
  }
  for (const element of doc.querySelectorAll("[style]")) {
    const sanitized = sanitizeInlineStyle(
      element.getAttribute("style") ?? "",
      baseUrl,
      resolve,
    );
    if (sanitized === "") {
      element.removeAttribute("style");
    } else {
      element.setAttribute("style", sanitized);
    }
  }
}
