import type { Element } from "@xmpp/xml";
import {
  DEFAULT_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  SAFE_CHUNK_SIZE_CAP,
} from "../constants.js";
import { base64Length } from "../util/base64.js";

/** Normalized body input to the encoding decision. */
export type BodySource =
  | { kind: "empty" }
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "element"; element: Element }
  | { kind: "stream"; contentLength?: number };

export type StreamMechanism = "ibb" | "chunkedBase64" | "sipub" | "jingle";

export type EncodingDecision =
  | { mode: "none" }
  | { mode: "text"; text: string }
  | { mode: "xml"; element: Element }
  | { mode: "base64"; bytes: Uint8Array }
  | { mode: "ibb"; blockSize: number }
  | { mode: "chunkedBase64"; chunkSize: number }
  | { mode: "sipub" }
  | { mode: "jingle"; blockSize: number }
  /** Body doesn't fit inline and the peer accepts no stream mechanism. */
  | { mode: "too-large" };

export interface StreamAcceptFlags {
  ibb: boolean;
  chunked: boolean;
  sipub: boolean;
  jingle: boolean;
  maxChunkSize?: number;
}

export interface SelectInput {
  body: BodySource;
  contentType?: string;
  accept: StreamAcceptFlags;
  inlineBudgetBytes: number;
  preferredStreams: readonly StreamMechanism[];
}

const TEXTUAL_TYPES = /^(text\/|application\/(json|javascript|ecmascript|xml|x-www-form-urlencoded)($|;)|\w[\w.+-]*\/[\w.+-]*\+(json|xml)($|;))/i;

function isTextualContentType(contentType: string | undefined): boolean {
  return contentType !== undefined && TEXTUAL_TYPES.test(contentType.trim());
}

// Control characters that are illegal in XML 1.0 even when escaped.
// eslint-disable-next-line no-control-regex
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

/** Length after XML entity escaping of & < > " ' (worst case &quot; = +5). */
function escapedLength(text: string): number {
  let extra = 0;
  for (const c of text) {
    if (c === "&") extra += 4;
    else if (c === "<" || c === ">") extra += 3;
    else if (c === '"' || c === "'") extra += 5;
  }
  return text.length + extra;
}

/**
 * Decoded-byte chunk/block size. An explicit requester maxChunkSize is
 * honored up to the spec maximum (the requester knows its stanza limits);
 * without one we stay under the conservative SAFE_CHUNK_SIZE_CAP.
 */
export function resolveChunkSize(requesterMax: number | undefined): number {
  const wanted =
    requesterMax ?? Math.min(DEFAULT_CHUNK_SIZE, SAFE_CHUNK_SIZE_CAP);
  return Math.min(MAX_CHUNK_SIZE, Math.max(MIN_CHUNK_SIZE, wanted));
}

/**
 * Derives inline/chunk budgets from a known server stanza-size limit
 * (advertised via XEP-0478 stream limits, or from server config). The
 * defaults assume only the RFC 6120 10 KiB floor; servers commonly allow
 * 128 KiB－1 MiB, and larger budgets mean fewer stanzas per body:
 *
 *   new HttpxClient(session, { ...stanzaBudgets(262144) })
 *   new HttpxServer(session, { ...stanzaBudgets(262144) })
 */
export function stanzaBudgets(maxStanzaBytes: number): {
  inlineBudgetBytes: number;
  maxChunkSize: number;
} {
  // Envelope headroom: iq/message wrapper, req/resp attributes, headers.
  const ENVELOPE_HEADROOM = 2048;
  const CHUNK_ENVELOPE = 512;
  const inlineBudgetBytes = Math.max(1024, maxStanzaBytes - ENVELOPE_HEADROOM);
  const decodedChunk = Math.floor(((maxStanzaBytes - CHUNK_ENVELOPE) * 3) / 4);
  const maxChunkSize = Math.min(
    MAX_CHUNK_SIZE,
    Math.max(MIN_CHUNK_SIZE, decodedChunk),
  );
  return { inlineBudgetBytes, maxChunkSize };
}

/**
 * Decides how a body travels, shared by server responses and client request
 * bodies. First match wins:
 *   empty → none; XML element in budget → xml; textual UTF-8 in budget →
 *   text; base64 in budget → base64; else the first acceptable stream
 *   mechanism; else too-large.
 *
 * Synchronous by design: callers wanting small streamed bodies inlined must
 * buffer them into a bytes source first (the server does this when the
 * content length is known and fits).
 */
export function selectEncoding(input: SelectInput): EncodingDecision {
  const { body } = input;

  if (body.kind === "empty") return { mode: "none" };

  if (body.kind === "element") {
    const serialized = body.element.toString();
    if (serialized.length <= input.inlineBudgetBytes) {
      return { mode: "xml", element: body.element };
    }
    return selectStream(input);
  }

  if (body.kind === "bytes") {
    if (isTextualContentType(input.contentType)) {
      const text = tryDecodeUtf8(body.bytes);
      if (
        text !== undefined &&
        !XML_ILLEGAL.test(text) &&
        escapedLength(text) <= input.inlineBudgetBytes
      ) {
        return { mode: "text", text };
      }
    }
    if (base64Length(body.bytes.length) <= input.inlineBudgetBytes) {
      return { mode: "base64", bytes: body.bytes };
    }
  }

  return selectStream(input);
}

function tryDecodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function selectStream(input: SelectInput): EncodingDecision {
  for (const mechanism of input.preferredStreams) {
    if (mechanism === "ibb" && input.accept.ibb) {
      return { mode: "ibb", blockSize: resolveChunkSize(input.accept.maxChunkSize) };
    }
    if (mechanism === "chunkedBase64" && input.accept.chunked) {
      return {
        mode: "chunkedBase64",
        chunkSize: resolveChunkSize(input.accept.maxChunkSize),
      };
    }
    if (mechanism === "sipub" && input.accept.sipub) {
      return { mode: "sipub" };
    }
    if (mechanism === "jingle" && input.accept.jingle) {
      return {
        mode: "jingle",
        blockSize: resolveChunkSize(input.accept.maxChunkSize),
      };
    }
  }
  return { mode: "too-large" };
}
