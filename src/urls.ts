/**
 * The httpx:// URI scheme proposed by XEP-0332 §7: the authority is a JID
 * (no port), e.g. httpx://httpServer@example.org/index.html?x=1.
 *
 * Parsed manually because WHATWG URL treats user@host authorities of unknown
 * schemes inconsistently across runtimes.
 */
export interface HttpxUrl {
  /** The JID addressed, e.g. "httpServer@example.org". */
  jid: string;
  /** Absolute path, always starting with "/". */
  path: string;
  /** Query string including the leading "?" or "". */
  search: string;
  /** Normalized httpx URL (fragment stripped). */
  href: string;
  /** What goes into <req resource=…>: path + search. */
  resource: string;
}

export function parseHttpxUrl(input: string | URL): HttpxUrl {
  const raw = typeof input === "string" ? input : input.href;
  const match = /^httpx:\/\//i.exec(raw);
  if (!match) {
    throw new TypeError(`not an httpx URL: ${raw}`);
  }

  let rest = raw.slice(match[0].length);
  const hashIndex = rest.indexOf("#");
  if (hashIndex !== -1) rest = rest.slice(0, hashIndex);

  let authorityEnd = rest.length;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === "/" || c === "?") {
      authorityEnd = i;
      break;
    }
  }

  const jid = rest.slice(0, authorityEnd);
  if (jid.length === 0) {
    throw new TypeError(`httpx URL has no JID authority: ${raw}`);
  }
  if (jid.includes(":")) {
    throw new TypeError(`httpx URLs carry no port; invalid authority: ${jid}`);
  }

  let tail = rest.slice(authorityEnd);
  let search = "";
  const queryIndex = tail.indexOf("?");
  if (queryIndex !== -1) {
    search = tail.slice(queryIndex);
    tail = tail.slice(0, queryIndex);
  }
  const path = tail === "" ? "/" : tail;

  return {
    jid,
    path,
    search,
    href: `httpx://${jid}${path}${search}`,
    resource: `${path}${search}`,
  };
}

/**
 * Resolves a reference the way a browser resolves links: absolute httpx
 * URLs pass through; everything else (absolute path, relative path, query,
 * fragment) resolves against the base. Fragments are stripped (XEP-0332
 * resources carry no fragments). Non-httpx absolute URLs (https:, mailto:…)
 * are returned unchanged for the caller to handle.
 */
export function resolveHttpxUrl(base: string | HttpxUrl, ref: string): string {
  const trimmed = ref.trim();
  if (/^httpx:\/\//i.test(trimmed)) {
    return parseHttpxUrl(trimmed).href;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return trimmed; // some other scheme — not ours to resolve
  }
  const parsed = typeof base === "string" ? parseHttpxUrl(base) : base;
  // Borrow WHATWG path resolution against a dummy authority.
  const resolved = new URL(trimmed, `http://base${parsed.path}${parsed.search}`);
  return `httpx://${parsed.jid}${resolved.pathname}${resolved.search}`;
}

export function formatHttpxUrl(parts: {
  jid: string;
  path?: string;
  search?: string;
}): string {
  const path = parts.path ?? "/";
  const search = parts.search ?? "";
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const normalizedSearch =
    search === "" || search.startsWith("?") ? search : `?${search}`;
  return `httpx://${parts.jid}${normalizedPath}${normalizedSearch}`;
}

/**
 * Which of RFC 9112 §3.2's request-target forms a `<req resource=…>` uses.
 * XEP-0332 only ever shows origin-form; the other three exist because a
 * proxy needs them — CONNECT names an authority, a forward proxy is handed
 * an absolute URI, and OPTIONS may address the server itself.
 */
export type ResourceForm = "origin" | "absolute" | "authority" | "asterisk";

// Authority-form: host[:port], no userinfo, no path, no query. The host is a
// reg-name, an IPv4 literal or a bracketed IPv6 literal; the port, when
// present, is 1-65535. Deliberately stricter than a URL parser, which would
// happily read "evil.com:80/../x" or "user@host:80" as an authority.
const REG_NAME = /^[A-Za-z0-9._~!$&'()*+,;=-]+$/;
const IPV6_LITERAL = /^\[[0-9A-Fa-f:.]+\]$/;

function isAuthority(resource: string): boolean {
  const colon = resource.lastIndexOf(":");
  const host = colon === -1 ? resource : resource.slice(0, colon);
  const port = colon === -1 ? "" : resource.slice(colon + 1);
  if (host.length === 0) return false;
  // A bracketed IPv6 literal contains colons of its own; the port separator
  // is only the one after the closing bracket.
  if (host.startsWith("[")) {
    if (!IPV6_LITERAL.test(host)) return false;
  } else if (!REG_NAME.test(host) || host.includes("[") || host.includes("]")) {
    return false;
  }
  if (colon === -1) return false; // host alone is not authority-form
  if (!/^[0-9]{1,5}$/.test(port)) return false;
  const value = Number(port);
  return value >= 1 && value <= 65535;
}

/**
 * Classifies a request target, or returns undefined when it is none of the
 * four forms. Origin-form is accepted exactly as before — anything starting
 * with "/" — so nothing that used to decode stops decoding.
 */
export function resourceForm(resource: string): ResourceForm | undefined {
  if (resource === "*") return "asterisk";
  if (resource.startsWith("/")) return "origin";
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(resource)) {
    let parsed: URL;
    try {
      parsed = new URL(resource);
    } catch {
      return undefined;
    }
    // "https://" parses on some runtimes with an empty host; a target with
    // no authority cannot be routed anywhere.
    if (parsed.hostname === "") return undefined;
    if (resource.includes("#")) return undefined; // targets carry no fragment
    return "absolute";
  }
  return isAuthority(resource) ? "authority" : undefined;
}
