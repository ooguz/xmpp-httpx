import xml, { Element } from "@xmpp/xml";
import { NS_HTTPX } from "../constants.js";
import { CodecError } from "../errors.js";
import { decodeData, encodeData, type DataDescriptor } from "./data.js";
import { extensionChildren } from "./extensions.js";
import { decodeHeaders, encodeHeaders } from "./headers.js";

export interface RespStanza {
  version: string;
  statusCode: number;
  statusMessage?: string;
  headers: Headers;
  data?: DataDescriptor;
  /** Children in other namespaces, carried verbatim (see codec/extensions.ts). */
  extensions?: Element[];
}

export function encodeResp(resp: RespStanza): Element {
  const attrs: Record<string, string> = {
    xmlns: NS_HTTPX,
    version: resp.version,
    statusCode: String(resp.statusCode),
  };
  if (resp.statusMessage !== undefined) {
    attrs["statusMessage"] = resp.statusMessage;
  }

  const el = xml("resp", attrs);
  const headers = encodeHeaders(resp.headers);
  if (headers) el.append(headers);
  if (resp.data) el.append(encodeData(resp.data));
  for (const extension of resp.extensions ?? []) el.append(extension);
  return el;
}

export function decodeResp(el: Element): RespStanza {
  if (!el.is("resp", NS_HTTPX)) {
    throw new CodecError(
      `expected <resp xmlns='${NS_HTTPX}'>, got <${el.getName()}>`,
    );
  }

  const rawStatus = el.attrs["statusCode"];
  const statusCode = Number(rawStatus);
  if (!rawStatus || !Number.isInteger(statusCode) || statusCode <= 0) {
    throw new CodecError(`invalid or missing statusCode "${rawStatus ?? ""}"`);
  }

  const resp: RespStanza = {
    version: el.attrs["version"] ?? "1.1",
    statusCode,
    headers: decodeHeaders(el),
  };

  const statusMessage = el.attrs["statusMessage"];
  if (statusMessage !== undefined) resp.statusMessage = statusMessage;

  const data = decodeData(el);
  if (data) resp.data = data;
  const extensions = extensionChildren(el);
  if (extensions.length > 0) resp.extensions = extensions;
  return resp;
}
