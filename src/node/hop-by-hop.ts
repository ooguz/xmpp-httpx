/**
 * Hop-by-hop fields (RFC 9110 §7.6.1) describe one connection, not the
 * message, and a proxy must not forward them: Connection and everything it
 * names, plus the fields that are hop-by-hop by definition. Proxy-* fields
 * are for this proxy alone — forwarding Proxy-Authorization would hand the
 * user's proxy credentials to every origin.
 */
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

export function stripHopByHop(headers: Headers): Headers {
  const out = new Headers(headers);
  const named = (headers.get("connection") ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  for (const name of [...HOP_BY_HOP, ...named]) out.delete(name);
  return out;
}
