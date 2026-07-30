/**
 * Content negotiation for handlers: picking a representation from the
 * requester's `Accept` header.
 *
 * A gateway serving both HTML and JSON needs this, and the alternative —
 * `headers.get("accept")?.includes("json")` — quietly gets q-values, wildcards
 * and ordering wrong. Pure and browser-safe.
 */

export interface AcceptEntry {
  /** Media type as written, lowercased: "text/html", "text/*", "*\/*". */
  type: string;
  /** Quality factor, 0–1. Entries with q=0 are refusals. */
  q: number;
}

/**
 * Parses an `Accept` header, most preferred first. Ties keep the order the
 * client wrote, which is the closest thing to intent we have. Malformed
 * parameters are ignored rather than failing the request.
 */
export function parseAccept(header: string | null | undefined): AcceptEntry[] {
  if (!header) return [];
  const entries: { entry: AcceptEntry; index: number }[] = [];

  for (const [index, part] of header.split(",").entries()) {
    const [rawType, ...params] = part.split(";");
    const type = (rawType ?? "").trim().toLowerCase();
    if (type === "") continue;

    let q = 1;
    for (const param of params) {
      const [name, value] = param.split("=", 2);
      if (name?.trim().toLowerCase() !== "q") continue;
      const parsed = Number(value?.trim());
      if (Number.isFinite(parsed)) q = Math.min(1, Math.max(0, parsed));
    }
    entries.push({ entry: { type, q }, index });
  }

  return entries
    .sort((a, b) => b.entry.q - a.entry.q || a.index - b.index)
    .map(({ entry }) => entry);
}

/** How specifically an Accept entry names a type: exact > subtype wildcard > any. */
function specificity(type: string): number {
  if (type === "*/*") return 0;
  if (type.endsWith("/*")) return 1;
  return 2;
}

function matches(pattern: string, offered: string): boolean {
  if (pattern === "*/*") return true;
  if (pattern === offered) return true;
  if (pattern.endsWith("/*")) {
    return offered.startsWith(`${pattern.slice(0, -1)}`);
  }
  return false;
}

/**
 * Chooses one of `offered` for the given `Accept` header, or `undefined` when
 * nothing acceptable is on offer (the caller's cue for a 406).
 *
 * `offered` is in *server* preference order, which decides ties — so
 * `negotiateContentType(accept, ["text/html", "application/json"])` prefers HTML
 * when a client says it takes either. An absent or empty header means "anything",
 * answered with the server's first choice, as RFC 9110 allows.
 */
export function negotiateContentType(
  header: string | null | undefined,
  offered: readonly string[],
): string | undefined {
  if (offered.length === 0) return undefined;
  const accepted = parseAccept(header);
  if (accepted.length === 0) return offered[0];

  let best: { type: string; q: number; specificity: number } | undefined;
  for (const offer of offered) {
    const normalized = offer.split(";")[0]?.trim().toLowerCase() ?? offer;
    // The most specific matching pattern governs, per RFC 9110 §12.5.1 — a
    // "*/*;q=0.1" must not drag down an explicit "text/html".
    let chosen: AcceptEntry | undefined;
    for (const entry of accepted) {
      if (!matches(entry.type, normalized)) continue;
      if (!chosen || specificity(entry.type) > specificity(chosen.type)) {
        chosen = entry;
      }
    }
    if (!chosen || chosen.q === 0) continue; // q=0 is an explicit refusal

    const candidate = { type: offer, q: chosen.q, specificity: specificity(chosen.type) };
    // Server order breaks ties: only a strictly better q wins.
    if (!best || candidate.q > best.q) best = candidate;
  }

  return best?.type;
}
