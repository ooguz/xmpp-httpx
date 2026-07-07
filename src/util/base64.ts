/**
 * Pure base64 codec working identically in Node, browsers, and workers —
 * no Buffer, no atob/btoa (which choke on large inputs and binary strings).
 */

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const CODES = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) {
  CODES[ALPHABET.charCodeAt(i)] = i;
}

export function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    parts.push(
      ALPHABET[(n >> 18) & 63]! +
        ALPHABET[(n >> 12) & 63]! +
        ALPHABET[(n >> 6) & 63]! +
        ALPHABET[n & 63]!,
    );
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    parts.push(ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + "==");
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    parts.push(
      ALPHABET[(n >> 18) & 63]! +
        ALPHABET[(n >> 12) & 63]! +
        ALPHABET[(n >> 6) & 63]! +
        "=",
    );
  }
  return parts.join("");
}

/**
 * Decodes base64, tolerating ASCII whitespace (stanza bodies are often
 * pretty-printed). Throws SyntaxError on any other invalid character or on
 * truncated input.
 */
export function decodeBase64(text: string): Uint8Array {
  // Strip whitespace without a regex pass over huge strings twice.
  let clean = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === " " || c === "\n" || c === "\r" || c === "\t") continue;
    clean += c;
  }

  let end = clean.length;
  let padding = 0;
  while (padding < 2 && end > 0 && clean[end - 1] === "=") {
    end--;
    padding++;
  }
  if (end % 4 === 1) {
    throw new SyntaxError("invalid base64 length");
  }

  const outLength = Math.floor((end * 3) / 4);
  const out = new Uint8Array(outLength);
  let outPos = 0;
  let acc = 0;
  let accBits = 0;
  for (let i = 0; i < end; i++) {
    const code = clean.charCodeAt(i);
    const value = code < 128 ? CODES[code]! : -1;
    if (value < 0) {
      throw new SyntaxError(`invalid base64 character at index ${i}`);
    }
    acc = (acc << 6) | value;
    accBits += 6;
    if (accBits >= 8) {
      accBits -= 8;
      out[outPos++] = (acc >> accBits) & 0xff;
    }
  }
  return out;
}

/** Length of the base64 encoding of n bytes. */
export function base64Length(n: number): number {
  return Math.ceil(n / 3) * 4;
}
