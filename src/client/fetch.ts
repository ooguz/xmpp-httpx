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
  /** Per-request idle timeout for a streamed response body. */
  idleTimeoutMs?: number;
  /**
   * Browse the ordinary web through an exit. When `input` is an http(s):// URL
   * it is sent to this exit JID as an absolute-form request (RFC 9112 §3.2.2;
   * the exit must advertise `urn:xmpp:http#absolute-form`), which is how a
   * proxy uses XEP-0332. An httpx:// input addresses its own JID and ignores
   * this; an ordinary URL with no exit is an error, as there is no JID to
   * address.
   */
  exit?: string;
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
  const client = resolveClient(init.session);

  const rawMethod = (init.method ?? "GET").toUpperCase();
  if (!isHttpMethod(rawMethod)) {
    throw new HttpxError("protocol-error", `unsupported HTTP method "${rawMethod}"`);
  }
  const method: HttpMethod = rawMethod;

  // httpx:// addresses its own JID; an ordinary URL goes to the exit in
  // absolute-form (proxy use). The resource is kept verbatim, fragment aside.
  const raw = typeof input === "string" ? input : input.href;
  let to: string;
  let resource: string;
  let hostHeader: string;
  if (/^httpx:\/\//i.test(raw)) {
    const url = parseHttpxUrl(input);
    to = url.jid;
    resource = url.resource;
    hostHeader = jidDomain(url.jid);
  } else if (/^https?:\/\//i.test(raw) && init.exit !== undefined && init.exit !== "") {
    to = init.exit;
    const hash = raw.indexOf("#");
    resource = hash === -1 ? raw : raw.slice(0, hash);
    hostHeader = new URL(raw).host;
  } else if (/^https?:\/\//i.test(raw)) {
    // Ordinary URL, no exit: a TypeError, like parseHttpxUrl's, so callers that
    // map that to a "not an httpx address" page (Dillo, Electron) keep working.
    throw new TypeError(`an ordinary URL needs an exit to fetch it through: ${raw}`);
  } else {
    throw new TypeError(`not an httpx URL (and no exit for an ordinary one): ${raw}`);
  }

  const headers = new Headers(init.headers);
  if (!headers.has("host")) {
    headers.set("host", hostHeader);
  }

  const { body, contentType } = normalizeFetchBody(init.body);
  if (contentType !== undefined && !headers.has("content-type")) {
    headers.set("content-type", contentType);
  }

  const response = await client.request(to, {
    method,
    resource,
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(init.timeoutMs !== undefined ? { timeoutMs: init.timeoutMs } : {}),
    ...(init.idleTimeoutMs !== undefined
      ? { idleTimeoutMs: init.idleTimeoutMs }
      : {}),
    ...(init.signal !== undefined && init.signal !== null
      ? { signal: init.signal }
      : {}),
  });

  return response.toResponse();
}
