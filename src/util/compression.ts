/**
 * HTTP Content-Encoding over httpx, built on the platform's
 * CompressionStream/DecompressionStream (Node ≥ 18 and evergreen browsers —
 * browser-safe by design).
 *
 * Compression matters more here than on plain HTTP: inline and chunked
 * bodies pay a 33% base64 tax, so a gzipped body often turns a multi-stanza
 * stream into a single inline <resp>.
 */

export const SUPPORTED_ENCODINGS = ["gzip", "deflate"] as const;
export type ContentEncoding = (typeof SUPPORTED_ENCODINGS)[number];

/** Below this many bytes the gzip header outweighs the savings. */
export const MIN_COMPRESS_BYTES = 256;

export function isSupportedEncoding(value: string): value is ContentEncoding {
  return (SUPPORTED_ENCODINGS as readonly string[]).includes(value);
}

/**
 * Picks the first encoding we support from an Accept-Encoding header.
 * Quality values are ignored except q=0, which disables an encoding.
 */
export function chooseEncoding(
  acceptEncoding: string | null,
): ContentEncoding | undefined {
  if (acceptEncoding === null) return undefined;
  for (const part of acceptEncoding.split(",")) {
    const [rawName, ...params] = part.trim().split(";");
    const name = rawName?.trim().toLowerCase() ?? "";
    const disabled = params.some((p) => /^\s*q\s*=\s*0(\.0*)?\s*$/.test(p));
    if (!disabled && isSupportedEncoding(name)) return name;
  }
  return undefined;
}

/**
 * Parses a Content-Encoding header into the coding chain (applied in order).
 * Returns undefined when any coding is unsupported — the caller must then
 * leave body and headers untouched.
 */
export function parseContentEncodings(
  contentEncoding: string | null,
): ContentEncoding[] | undefined {
  if (contentEncoding === null) return [];
  const codings: ContentEncoding[] = [];
  for (const part of contentEncoding.split(",")) {
    const name = part.trim().toLowerCase();
    if (name === "" || name === "identity") continue;
    if (!isSupportedEncoding(name)) return undefined;
    codings.push(name);
  }
  return codings;
}

const COMPRESSIBLE_TYPES =
  /^(text\/|application\/(json|javascript|ecmascript|xml|x-www-form-urlencoded|wasm)($|;)|\w[\w.+-]*\/[\w.+-]*\+(json|xml)($|;)|image\/svg\+xml($|;))/i;

export function isCompressibleContentType(
  contentType: string | null | undefined,
): boolean {
  return contentType != null && COMPRESSIBLE_TYPES.test(contentType.trim());
}

// The DOM lib types the (De)CompressionStream writable side as BufferSource;
// we only ever write Uint8Array, so narrow at this one boundary.
type BytePair = ReadableWritablePair<Uint8Array, Uint8Array>;

export function compressStream(
  stream: ReadableStream<Uint8Array>,
  encoding: ContentEncoding,
): ReadableStream<Uint8Array> {
  return stream.pipeThrough(
    new CompressionStream(encoding) as unknown as BytePair,
  );
}

/** Undoes a coding chain (outermost coding listed last per RFC 9110). */
export function decompressStream(
  stream: ReadableStream<Uint8Array>,
  codings: readonly ContentEncoding[],
): ReadableStream<Uint8Array> {
  let out = stream;
  for (const coding of [...codings].reverse()) {
    out = out.pipeThrough(
      new DecompressionStream(coding) as unknown as BytePair,
    );
  }
  return out;
}
