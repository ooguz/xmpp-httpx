import xml, { Element } from "@xmpp/xml";
import {
  HTTP_VERSION,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  NS_HTTPX,
} from "../constants.js";
import { CodecError } from "../errors.js";
import { isHttpMethod, type HttpMethod, type StreamAccept } from "../types.js";
import { resourceForm } from "../urls.js";
import { decodeData, encodeData, type DataDescriptor } from "./data.js";
import { decodeHeaders, encodeHeaders } from "./headers.js";

export interface ReqStanza {
  method: HttpMethod;
  /**
   * The request target. Origin-form ("/index.html?x=1") is what XEP-0332
   * shows and what everything but a proxy sends; "*" (OPTIONS),
   * authority-form ("example.org:443", CONNECT only) and absolute-form
   * ("https://example.org/x") are also accepted — see docs/protocol-notes.md.
   */
  resource: string;
  version: string;
  /** Decoded-byte chunk size the requester accepts, clamped to [256, 65536]. */
  maxChunkSize?: number;
  /** Stream mechanisms the requester accepts for the response body. */
  accept: StreamAccept;
  headers: Headers;
  data?: DataDescriptor;
}

function clampChunkSize(value: number): number {
  return Math.min(MAX_CHUNK_SIZE, Math.max(MIN_CHUNK_SIZE, value));
}

export function encodeReq(req: ReqStanza): Element {
  const attrs: Record<string, string> = {
    xmlns: NS_HTTPX,
    method: req.method,
    resource: req.resource,
    version: req.version,
  };
  if (req.maxChunkSize !== undefined) {
    attrs["maxChunkSize"] = String(clampChunkSize(req.maxChunkSize));
  }
  // sipub/ibb/jingle default to true on the wire; only emit when false.
  if (!req.accept.sipub) attrs["sipub"] = "false";
  if (!req.accept.ibb) attrs["ibb"] = "false";
  if (!req.accept.jingle) attrs["jingle"] = "false";

  const el = xml("req", attrs);
  const headers = encodeHeaders(req.headers);
  if (headers) el.append(headers);
  if (req.data) el.append(encodeData(req.data));
  return el;
}

function decodeBooleanAttr(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new CodecError(`invalid boolean attribute value "${value}"`);
}

export function decodeReq(el: Element): ReqStanza {
  if (!el.is("req", NS_HTTPX)) {
    throw new CodecError(
      `expected <req xmlns='${NS_HTTPX}'>, got <${el.getName()}>`,
    );
  }

  const method = el.attrs["method"];
  if (!method || !isHttpMethod(method)) {
    throw new CodecError(`invalid or missing HTTP method "${method ?? ""}"`);
  }

  const resource = el.attrs["resource"];
  const form = resource ? resourceForm(resource) : undefined;
  if (!resource || form === undefined) {
    throw new CodecError(`invalid or missing resource "${resource ?? ""}"`);
  }
  // RFC 9112 §3.2.3: authority-form is CONNECT's and nothing else's. Letting
  // a GET carry "example.org:443" would hand a handler something that looks
  // like a path but names a host — the confusion a proxy least needs.
  if (form === "authority" && method !== "CONNECT") {
    throw new CodecError(
      `authority-form resource "${resource}" is only valid for CONNECT`,
    );
  }

  const version = el.attrs["version"] ?? HTTP_VERSION;

  const req: ReqStanza = {
    method,
    resource,
    version,
    accept: {
      sipub: decodeBooleanAttr(el.attrs["sipub"], true),
      ibb: decodeBooleanAttr(el.attrs["ibb"], true),
      jingle: decodeBooleanAttr(el.attrs["jingle"], true),
    },
    headers: decodeHeaders(el),
  };

  const rawChunkSize = el.attrs["maxChunkSize"];
  if (rawChunkSize !== undefined) {
    const parsed = Number(rawChunkSize);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new CodecError(`invalid maxChunkSize "${rawChunkSize}"`);
    }
    req.maxChunkSize = clampChunkSize(parsed);
  }

  const data = decodeData(el);
  if (data) req.data = data;
  return req;
}
