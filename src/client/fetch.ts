import { HttpxError } from "../errors.js";
import { jidDomain, type XmppSession } from "../session.js";
import { isHttpMethod, type HttpMethod, type HttpxBodyInit } from "../types.js";
import { parseHttpxUrl } from "../urls.js";
import { HttpxClient } from "./client.js";

export interface HttpxFetchInit extends Omit<RequestInit, "body"> {
  /** The XMPP session (or an existing HttpxClient) to tunnel through. */
  session: XmppSession | HttpxClient;
  body?: BodyInit | null;
  timeoutMs?: number;
}

const defaultClients = new WeakMap<object, HttpxClient>();

function resolveClient(sessionOrClient: XmppSession | HttpxClient): HttpxClient {
  if (sessionOrClient instanceof HttpxClient) return sessionOrClient;
  let client = defaultClients.get(sessionOrClient);
  if (!client) {
    client = new HttpxClient(sessionOrClient);
    defaultClients.set(sessionOrClient, client);
  }
  return client;
}

function normalizeFetchBody(body: BodyInit | null | undefined): {
  body?: HttpxBodyInit;
  contentType?: string;
} {
  if (body === undefined || body === null) return {};
  if (typeof body === "string") return { body };
  if (body instanceof Uint8Array) return { body };
  if (body instanceof ArrayBuffer) return { body: new Uint8Array(body) };
  if (ArrayBuffer.isView(body)) {
    return {
      body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    };
  }
  if (body instanceof URLSearchParams) {
    return {
      body: body.toString(),
      contentType: "application/x-www-form-urlencoded;charset=UTF-8",
    };
  }
  if (body instanceof Blob) {
    return {
      body: body.stream(),
      ...(body.type !== "" ? { contentType: body.type } : {}),
    };
  }
  if (body instanceof ReadableStream) {
    return { body: body as ReadableStream<Uint8Array> };
  }
  throw new HttpxError(
    "not-implemented",
    "unsupported fetch body type (FormData is not supported over httpx yet)",
  );
}

/**
 * fetch() for httpx:// URLs — the entry point a browser integration uses.
 *
 *   const response = await httpxFetch("httpx://server@example.org/index.html", {
 *     session,
 *   });
 *
 * Returns a real WHATWG Response wrapping the (possibly streaming) body.
 */
export async function httpxFetch(
  input: string | URL,
  init: HttpxFetchInit,
): Promise<Response> {
  const url = parseHttpxUrl(input);
  const client = resolveClient(init.session);

  const rawMethod = (init.method ?? "GET").toUpperCase();
  if (!isHttpMethod(rawMethod)) {
    throw new HttpxError("protocol-error", `unsupported HTTP method "${rawMethod}"`);
  }
  const method: HttpMethod = rawMethod;

  const headers = new Headers(init.headers);
  if (!headers.has("host")) {
    headers.set("host", jidDomain(url.jid));
  }

  const { body, contentType } = normalizeFetchBody(init.body);
  if (contentType !== undefined && !headers.has("content-type")) {
    headers.set("content-type", contentType);
  }

  const response = await client.request(url.jid, {
    method,
    resource: url.resource,
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(init.timeoutMs !== undefined ? { timeoutMs: init.timeoutMs } : {}),
    ...(init.signal !== undefined && init.signal !== null
      ? { signal: init.signal }
      : {}),
  });

  return response.toResponse();
}
