/**
 * DPIP — the Dillo plugin protocol's wire format, as `dpip/dpip.c` defines it.
 *
 * A message is a *tag*:
 *
 *     <cmd='open_url' url='httpx://web@example.org/' '>
 *
 * Attribute values are single-quoted; a quote inside a value is doubled
 * (`a_Dpip_build_cmd` "stuff-copies" it). The tag ends with the three bytes
 * ` '>` — `DPIP_TAG_END` — which cannot occur inside a value: a literal ` '`
 * there is written ` ''`, so the byte before the `>` is never a lone quote
 * preceded by a space. Dillo finds a tag's end with a plain `strstr` for that
 * terminator, and so does {@link TagBuffer}.
 *
 * After `start_send_page`, the connection switches to raw mode and everything
 * that follows, up to EOF, is the payload — an HTTP response.
 */

export const TAG_END = " '>";

export type DpipTag = Record<string, string>;

/** `{cmd: "open_url", url}` → `<cmd='open_url' url='…' '>`, quotes doubled. */
export function buildTag(attrs: Record<string, string>): string {
  let out = "<";
  for (const [name, value] of Object.entries(attrs)) {
    if (name === "" || /[\s='<>]/.test(name)) {
      throw new TypeError(`invalid dpip attribute name: ${JSON.stringify(name)}`);
    }
    out += `${name}='${value.replaceAll("'", "''")}' `;
  }
  return `${out}'>`;
}

/**
 * The inverse of {@link buildTag}, for one complete tag (terminator included
 * or not). Mirrors `a_Dpip_get_attr_l`: names start after `<` or a space,
 * values run to the first quote not followed by another quote.
 */
export function parseTag(tag: string): DpipTag {
  if (!tag.startsWith("<")) throw new TypeError("dpip tag must start with '<'");
  const attrs: DpipTag = {};
  let i = 1;
  while (i < tag.length) {
    const c = tag[i];
    if (c === " ") {
      i += 1;
      continue;
    }
    if (c === "'") {
      // The terminator: `'>` closes the tag.
      if (tag[i + 1] !== ">") throw new TypeError("malformed dpip tag terminator");
      return attrs;
    }
    const eq = tag.indexOf("='", i);
    if (eq === -1) throw new TypeError("dpip attribute without a quoted value");
    const name = tag.slice(i, eq);
    if (name === "" || /[\s']/.test(name)) {
      throw new TypeError(`malformed dpip attribute name: ${JSON.stringify(name)}`);
    }
    i = eq + 2;
    let value = "";
    for (;;) {
      const q = tag.indexOf("'", i);
      if (q === -1) throw new TypeError("unterminated dpip attribute value");
      value += tag.slice(i, q);
      if (tag[q + 1] === "'") {
        value += "'";
        i = q + 2;
        continue;
      }
      i = q + 1;
      break;
    }
    attrs[name] = value;
  }
  throw new TypeError("dpip tag has no terminator");
}

/**
 * Incremental tag reader over a byte stream: feed it chunks as they arrive,
 * ask for complete tags. Whatever follows the last tag consumed is the
 * payload, kept byte-exact.
 */
export class TagBuffer {
  private buffer: Uint8Array = new Uint8Array(0);
  /** Refuse to buffer more than this while waiting for a terminator. */
  readonly limit: number;

  constructor(limit = 64 * 1024) {
    this.limit = limit;
  }

  push(chunk: Uint8Array): void {
    const next = new Uint8Array(this.buffer.length + chunk.length);
    next.set(this.buffer, 0);
    next.set(chunk, this.buffer.length);
    this.buffer = next;
    if (this.buffer.length > this.limit) {
      throw new RangeError(`dpip tag exceeds ${this.limit} bytes`);
    }
  }

  /** The next complete tag, or null until one has fully arrived. */
  nextTag(): DpipTag | null {
    const end = indexOfTagEnd(this.buffer);
    if (end === -1) return null;
    const tagBytes = this.buffer.subarray(0, end + TAG_END.length);
    this.buffer = this.buffer.slice(end + TAG_END.length);
    return parseTag(new TextDecoder().decode(tagBytes));
  }

  /** Bytes after the last tag returned — the raw payload, if any. */
  rest(): Uint8Array {
    const rest = this.buffer;
    this.buffer = new Uint8Array(0);
    return rest;
  }
}

function indexOfTagEnd(bytes: Uint8Array): number {
  // " '>" = 0x20 0x27 0x3e
  for (let i = 0; i + 2 < bytes.length; i += 1) {
    if (bytes[i] === 0x20 && bytes[i + 1] === 0x27 && bytes[i + 2] === 0x3e) return i;
  }
  return -1;
}
