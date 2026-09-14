import type { DpiConfig } from "./config.js";

/**
 * The plugin's own pages, at `dpi:/httpx/…`.
 *
 * Dillo routes `dpi:/<server>/<path>` to the plugin registered as `<server>`
 * (`Capi_url_uses_dpi` in `src/capi.c`), and dpid registers ours under its
 * directory name, `httpx`, next to the `proto.httpx` alias. So the same
 * process that serves `httpx://` pages can serve a status page and a
 * settings form without any other registration.
 *
 * Forms here are GET forms, because that is all Dillo hands a plugin (the
 * `open_url` tag carries only the URL). Dillo allows a GET to a `dpi:` URL
 * only when the page it came from is itself a `dpi:` page
 * (`a_Capi_dpi_verify_request`), which is exactly the settings page. The
 * consequence for the password field is spelled out on the page: the value
 * travels in the URL, so it shows in the address bar and in Dillo's
 * in-memory history for the session. The plugin never logs the query of a
 * `dpi:` URL for the same reason.
 */

export const LOCAL_PREFIX = "dpi:/httpx";

export interface PluginState {
  /** The JID the live session is bound to, or null while signed out. */
  signedInAs: string | null;
  configPath: string;
  config: DpiConfig | null;
  /** Why the config could not be loaded, when it could not. */
  configError: string | null;
}

export interface SettingsDeps {
  state(): Promise<PluginState>;
  /** Persist a config and forget the current session so the next request uses it. */
  save(config: DpiConfig): Promise<void>;
  /** Drop the current session; the next request signs in again. */
  reconnect(): Promise<void>;
}

export function isLocalUrl(url: string): boolean {
  return url === LOCAL_PREFIX || url.startsWith(`${LOCAL_PREFIX}/`) || url.startsWith(`${LOCAL_PREFIX}?`);
}

/** `dpi:/httpx/save?jid=…` → the path (`/save`) and its query. */
export function splitLocalUrl(url: string): { path: string; query: URLSearchParams } {
  const rest = url.slice(LOCAL_PREFIX.length);
  const q = rest.indexOf("?");
  const path = (q === -1 ? rest : rest.slice(0, q)) || "/";
  const query = new URLSearchParams(q === -1 ? "" : rest.slice(q + 1));
  return { path, query };
}

/** The URL as it may appear in a log line: a `dpi:` query is never shown. */
export function loggableUrl(url: string): string {
  if (!isLocalUrl(url)) return url;
  const { path } = splitLocalUrl(url);
  return `${LOCAL_PREFIX}${path}`;
}

/** Turn a submitted form into a config, or explain what is wrong with it. */
export function configFromQuery(
  query: URLSearchParams,
  current: DpiConfig | null,
): { config: DpiConfig } | { error: string } {
  const jid = (query.get("jid") ?? "").trim();
  if (!/^[^@/\s]+@[^@/\s]+$/.test(jid)) return { error: "The JID must look like alice@example.org." };
  // An empty password field keeps the stored one, so the page need not echo it.
  const password = query.get("password") ?? "";
  const effectivePassword = password !== "" ? password : (current?.password ?? "");
  if (effectivePassword === "") return { error: "A password is required." };
  const service = (query.get("service") ?? "").trim();
  if (service !== "" && !/^(wss?|xmpps?):\/\//.test(service)) {
    return { error: "The service must be a ws://, wss://, xmpp:// or xmpps:// URL, or empty." };
  }
  const resource = (query.get("resource") ?? "").trim() || "dillo";
  const timeoutRaw = (query.get("timeoutMs") ?? "").trim();
  const timeoutMs = timeoutRaw === "" ? (current?.timeoutMs ?? 30_000) : Number(timeoutRaw);
  if (!(timeoutMs > 0)) return { error: "The timeout must be a positive number of milliseconds." };
  return {
    config: {
      jid,
      password: effectivePassword,
      service: service === "" ? undefined : service,
      resource,
      timeoutMs,
    },
  };
}

export async function handleLocal(url: string, deps: SettingsDeps): Promise<Response> {
  const { path, query } = splitLocalUrl(url);
  if (path === "/" || path === "") {
    return page(await deps.state());
  }
  if (path === "/save") {
    const before = await deps.state();
    const parsed = configFromQuery(query, before.config);
    if ("error" in parsed) return page(before, { kind: "error", text: parsed.error }, 400);
    await deps.save(parsed.config);
    return page(await deps.state(), {
      kind: "ok",
      text: `Saved to ${before.configPath}. The next httpx:// page signs in as ${parsed.config.jid}.`,
    });
  }
  if (path === "/reconnect") {
    await deps.reconnect();
    return page(await deps.state(), { kind: "ok", text: "Signed out. The next httpx:// page signs in again." });
  }
  return new Response(renderShell("Not found", `<p>No such page: <code>${escape(url)}</code>.</p>${backLink()}`), {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function page(state: PluginState, notice?: { kind: "ok" | "error"; text: string }, status = 200): Response {
  return new Response(renderSettingsPage(state, notice), {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export function renderSettingsPage(
  state: PluginState,
  notice?: { kind: "ok" | "error"; text: string },
): string {
  const c = state.config;
  const connection =
    state.signedInAs !== null
      ? `Signed in as <b>${escape(state.signedInAs)}</b>. <a href="${LOCAL_PREFIX}/reconnect">Sign out</a> (the next page signs in again).`
      : c !== null
        ? `Signed out. The next <code>httpx://</code> page signs in as <b>${escape(c.jid)}</b>.`
        : `Signed out and not configured.`;
  const configLine =
    state.configError !== null
      ? `<p><b>Configuration problem:</b> ${escape(state.configError)}</p>`
      : `<p>Configuration file: <code>${escape(state.configPath)}</code></p>`;
  const noticeHtml =
    notice === undefined
      ? ""
      : `<p style="border-left:4px solid ${notice.kind === "ok" ? "#2b7a4b" : "#a86a12"};padding-left:8px">${escape(notice.text)}</p>`;

  const body = `
<p>${connection}</p>
${configLine}
${noticeHtml}
<h2>Account</h2>
<form action="${LOCAL_PREFIX}/save" method="get">
<table>
<tr><td>JID</td><td><input name="jid" size="40" value="${escape(c?.jid ?? "")}"></td></tr>
<tr><td>Password</td><td><input name="password" type="password" size="40" value=""> <small>${
    c !== null ? "leave empty to keep the stored one" : ""
  }</small></td></tr>
<tr><td>Service</td><td><input name="service" size="40" value="${escape(c?.service ?? "")}"> <small>optional, e.g. wss://example.org/xmpp-websocket</small></td></tr>
<tr><td>Resource</td><td><input name="resource" size="20" value="${escape(c?.resource ?? "dillo")}"></td></tr>
<tr><td>Timeout (ms)</td><td><input name="timeoutMs" size="8" value="${escape(String(c?.timeoutMs ?? 30000))}"></td></tr>
<tr><td></td><td><input type="submit" value="Save"></td></tr>
</table>
</form>
<p><small>Dillo submits this form as a GET, so the values, the password
included, travel in the URL: they show in the address bar and in this
session's history. Nothing is logged. If you would rather not, edit the
configuration file directly; it is re-read on the next sign-in.</small></p>
<h2>Try it</h2>
<p>The demo site, when <code>npm run demo</code> is running:
<a href="httpx://web@httpx.localhost/">httpx://web@httpx.localhost/</a></p>
`;
  return renderShell("httpx plugin", body);
}

function renderShell(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escape(title)}</title></head>
<body><h1>${escape(title)}</h1>${body}<p><small>xmpp-httpx Dillo plugin</small></p></body></html>
`;
}

function backLink(): string {
  return `<p><a href="${LOCAL_PREFIX}/">Back to the plugin page</a></p>`;
}

export function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
