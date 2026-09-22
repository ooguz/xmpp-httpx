import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { join, normalize, resolve, sep, extname } from "node:path";
import { Readable } from "node:stream";
import type { HttpxHandler } from "../server/server.js";

/**
 * Serves a directory over httpx directly — no HTTP origin in the middle.
 *
 * The handler is deliberately small but not naive. Request paths come from the
 * network, so containment is checked twice:
 *
 * 1. Lexically, after percent-decoding — `..` segments in an *absolute* path
 *    collapse the way every HTTP server collapses them (`/../x` means `/x`),
 *    and anything that still points outside is refused.
 * 2. Against the *real* path, because `resolve()` does not follow symlinks: a
 *    link inside the root pointing at /etc would otherwise be served.
 *
 * Validators are emitted so a client cache can revalidate with a 304 instead of
 * re-sending a body over XMPP, which is the expensive part here.
 */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/vnd.microsoft.icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".wasm": "application/wasm",
};

export interface StaticSiteOptions {
  /** Seconds of freshness advertised via Cache-Control. 0 omits max-age. */
  maxAgeSeconds?: number;
  /** File served for a directory. Default "index.html". */
  index?: string;
}

export function contentTypeFor(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** True when `candidate` is `root` itself or genuinely beneath it. */
export function isWithin(root: string, candidate: string): boolean {
  // The separator matters: a bare prefix test would accept /srv/site-secrets
  // for root /srv/site.
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Resolves a request path inside `root`, or null if it escapes.
 *
 * Percent-decoding happens *before* the check, so `%2e%2e%2f` cannot smuggle
 * segments past it. Note that `..` in an absolute path collapses rather than
 * escaping — `/../secret` resolves to `<root>/secret`, exactly as an HTTP
 * server would treat it — so a traversal attempt surfaces as a 404, while
 * anything that truly lands outside is refused.
 */
export function resolveInRoot(root: string, resource: string): string | null {
  const path = (resource.split("?")[0] ?? "/").split("#")[0] ?? "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes("\0")) return null;

  const absoluteRoot = resolve(root);
  const candidate = resolve(join(absoluteRoot, normalize(decoded)));
  return isWithin(absoluteRoot, candidate) ? candidate : null;
}

/** Weak validator from size and mtime — enough for a static file. */
export function etagFor(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

export function createStaticHandler(
  root: string,
  options: StaticSiteOptions = {},
): HttpxHandler {
  const index = options.index ?? "index.html";
  const maxAge = options.maxAgeSeconds ?? 60;
  const absoluteRoot = resolve(root);
  // Resolved once, and of the *root* too: on systems where a parent is itself a
  // symlink (/tmp → /private/tmp), comparing a real path against a lexical root
  // would refuse everything.
  let realRootOnce: Promise<string> | undefined;
  const realRoot = (): Promise<string> =>
    (realRootOnce ??= realpath(absoluteRoot).catch(() => absoluteRoot));

  return async (req) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return {
        status: 405,
        statusMessage: "Method Not Allowed",
        headers: { allow: "GET, HEAD" },
        body: "method not allowed",
      };
    }

    const resolved = resolveInRoot(root, req.resource);
    if (resolved === null) {
      // Refusing rather than 404 makes traversal attempts visible in logs.
      return { status: 403, statusMessage: "Forbidden", body: "forbidden" };
    }

    let target = resolved;
    let info;
    try {
      info = await stat(target);
      if (info.isDirectory()) {
        target = join(target, index);
        info = await stat(target);
      }
      if (!info.isFile()) throw new Error("not a file");
    } catch {
      return { status: 404, statusMessage: "Not Found", body: "not found" };
    }

    // Second containment check, now that we know what the path really points
    // at: a symlink inside the root may still lead out of it.
    try {
      const [rootPath, realTarget] = await Promise.all([realRoot(), realpath(target)]);
      if (!isWithin(rootPath, realTarget)) {
        return { status: 403, statusMessage: "Forbidden", body: "forbidden" };
      }
    } catch {
      return { status: 404, statusMessage: "Not Found", body: "not found" };
    }

    const etag = etagFor(info.size, info.mtimeMs);
    const headers: Record<string, string> = {
      "content-type": contentTypeFor(target),
      etag,
      "last-modified": new Date(info.mtimeMs).toUTCString(),
      ...(maxAge > 0 ? { "cache-control": `max-age=${maxAge}` } : {}),
    };

    // A 304 is the whole reason for the validators: it saves sending the body
    // through XMPP again.
    if (req.headers.get("if-none-match") === etag) {
      return { status: 304, statusMessage: "Not Modified", headers };
    }

    if (req.method === "HEAD") {
      return { status: 200, headers: { ...headers, "content-length": String(info.size) } };
    }

    return {
      status: 200,
      // The length is what lets a small file go inline in the <resp> rather
      // than as a stream of its own, and what a sipub/jingle offer states.
      headers: { ...headers, "content-length": String(info.size) },
      // Streamed, so a large file is never held in memory: the transport
      // decides how to chunk it.
      body: Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>,
    };
  };
}
