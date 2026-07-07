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
