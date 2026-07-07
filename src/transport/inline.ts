import type { DataDescriptor } from "../codec/data.js";
import { textEncoder } from "../util/bytes.js";

type InlineDescriptor = Extract<
  DataDescriptor,
  { kind: "text" } | { kind: "xml" } | { kind: "base64" }
>;

export function isInline(d: DataDescriptor): d is InlineDescriptor {
  return d.kind === "text" || d.kind === "xml" || d.kind === "base64";
}

/** Materializes an inline body as raw bytes. */
export function inlineToBytes(d: InlineDescriptor): Uint8Array {
  switch (d.kind) {
    case "text":
      return textEncoder.encode(d.text);
    case "xml":
      return textEncoder.encode(d.element.toString());
    case "base64":
      return d.bytes;
  }
}
