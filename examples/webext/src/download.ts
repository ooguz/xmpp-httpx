import { parseHttpxUrl } from "xmpp-httpx";
import { extensionApi } from "./ext.js";

/**
 * Content the viewport cannot display becomes a download instead of a wall of
 * mojibake in a `<pre>`. Everything here treats server-supplied strings
 * (content types, `Content-Disposition` filenames) as hostile.
 */

const RENDERABLE_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/ecmascript",
  "application/x-www-form-urlencoded",
]);

/** Bare media type, lowercased, parameters stripped. */
export function mediaType(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

/** True when `renderHtml`/`renderPlain` can show this content type. */
export function isRenderableType(contentType: string): boolean {
  const type = mediaType(contentType);
  if (type === "") return true; // no type at all — treat as text, as browsers do
  if (type.startsWith("text/") || type.startsWith("image/")) return true;
  if (/\+(?:json|xml)$/.test(type)) return true;
  return RENDERABLE_TYPES.has(type);
}

/** True when the server explicitly asked for a save-to-disk. */
export function isAttachment(contentDisposition: string | null): boolean {
  return /^\s*attachment\b/i.test(contentDisposition ?? "");
}

/**
 * `Content-Disposition` filename (RFC 5987 `filename*` preferred), else the
 * URL's last path segment, else "download". The result is always a bare
 * filename: separators, control characters and leading dots are stripped so a
 * hostile server cannot steer the write outside the download directory.
 */
export function filenameFor(
  url: string,
  contentDisposition: string | null,
): string {
  return (
    sanitizeFilename(fromDisposition(contentDisposition)) ??
    sanitizeFilename(lastPathSegment(url)) ??
    "download"
  );
}

function fromDisposition(value: string | null): string | undefined {
  if (!value) return undefined;
  const extended = /filename\*\s*=\s*([^;]+)/i.exec(value);
  if (extended?.[1]) {
    // ext-value: charset'language'percent-encoded-value
    const parts = extended[1].trim().split("'");
    const encoded = (parts.length >= 3 ? parts.slice(2).join("'") : parts[0]) ?? "";
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i.exec(value);
  const raw = plain?.[1] ?? plain?.[2];
  return raw?.replace(/\\(.)/g, "$1").trim();
}

function lastPathSegment(url: string): string | undefined {
  let path: string;
  try {
    path = parseHttpxUrl(url).path;
  } catch {
    return undefined;
  }
  const segment = path.split("/").filter(Boolean).at(-1);
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function sanitizeFilename(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  // Reduce to the basename first, as browsers do: "../../etc/passwd" is a
  // request to write "passwd" here, not a path we honor any part of.
  const cleaned = (name.split(/[/\\]/).pop() ?? "")
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return cleaned === "" ? undefined : cleaned;
}

/**
 * Saves `blob` to the user's downloads. Returns a cleanup that revokes the
 * blob URL — call it on navigation, not immediately: Chromium needs the blob
 * alive until the download has actually started.
 */
export function saveBlob(blob: Blob, filename: string): () => void {
  const url = URL.createObjectURL(blob);
  const downloads = extensionApi()?.downloads;
  if (downloads) {
    void downloads
      .download({ url, filename })
      .catch(() => clickAnchor(url, filename));
  } else {
    // Plain-tab development, or the permission was refused.
    clickAnchor(url, filename);
  }
  return () => URL.revokeObjectURL(url);
}

function clickAnchor(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
