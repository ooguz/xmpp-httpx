/**
 * Byte-progress reporting for response bodies.
 *
 * The rendering pipeline deliberately buffers a *complete* document before
 * sanitizing and painting it (partial markup is where mXSS lives, and
 * re-sanitizing a growing buffer is O(n²)) — so "progressive rendering" here
 * means progressive *feedback*: count the bytes as they stream in over XMPP,
 * show the user how far along the transfer is, then render once, as before.
 *
 * `bufferBody` is that counting read. It replaces `response.blob()` at the
 * two places a live network stream is actually consumed — the cache layer's
 * miss path, and `load()`'s consumption of "bypass" responses (POST, or the
 * degraded no-Cache-API mode), which are the only ones that reach `load()`
 * unbuffered. Each load reports through exactly one of the two, decided by
 * the cache state, so the count never restarts mid-load.
 */

export interface LoadProgress {
  /** Bytes received so far. */
  received: number;
  /** Expected body size, or null when unknown (no usable Content-Length). */
  total: number | null;
}

export type ProgressCallback = (progress: LoadProgress) => void;

/**
 * The expected body size a response advertises, or null. The library deletes
 * Content-Length whenever it transparently decompresses a body, so a header
 * that survives describes the bytes we will actually count — but a server can
 * still lie, so callers must treat this as a hint, never a bound.
 */
export function totalFromHeaders(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Reads a response body to completion, reporting byte progress along the way,
 * and returns it as a Blob typed by the response's Content-Type — what
 * `response.blob()` would have produced. If the received bytes outgrow the
 * advertised total, the total was a lie and later reports drop to
 * indeterminate (total: null) rather than showing a bar stuck past 100%.
 */
export async function bufferBody(
  response: Response,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  // With nobody listening, response.blob() is the same result near zero-copy —
  // a Blob-backed response (a cache rebuild) hands back its backing Blob,
  // where the counting loop below would copy the bytes twice for nothing.
  if (!onProgress) return response.blob();
  const type = response.headers.get("content-type") ?? "";
  const reader = response.body?.getReader();
  if (!reader) return response.blob();

  let total = totalFromHeaders(response.headers);
  let received = 0;
  const parts: BlobPart[] = [];
  onProgress({ received, total });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.byteLength;
    if (total !== null && received > total) total = null;
    onProgress({ received, total });
  }
  return new Blob(parts, { type });
}

/** "512 B", "3.4 KB", "1.2 MB" — for the byte chip and progress tooltips. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** The byte chip's text: "1.2 MB of 3.4 MB" when the total is known. */
export function formatProgress(progress: LoadProgress): string {
  return progress.total === null
    ? formatBytes(progress.received)
    : `${formatBytes(progress.received)} of ${formatBytes(progress.total)}`;
}
