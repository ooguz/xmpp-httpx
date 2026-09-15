// Assembles dist/chromium and dist/firefox from the vite build (dist/app)
// plus a per-target manifest.json. The divergences are structural:
// Chrome MV3 requires background.service_worker, Firefox requires
// background.scripts (event page) and supports protocol_handlers.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = JSON.parse(readFileSync(join(root, "manifest.base.json"), "utf8"));

const targets = {
  chromium: {
    ...base,
    background: { service_worker: "background.js" },
  },
  firefox: {
    ...base,
    background: { scripts: ["background.js"] },
    browser_specific_settings: {
      gecko: {
        // Permanent once signed: AMO keys the add-on on this ID forever.
        id: "httpx-browser@ooguz.dev",
        // 142, not 128: the data-consent key below landed in Firefox 140
        // (142 on Android), and AMO now requires it for new submissions. The
        // extension's own floor is lower — FormData's submitter argument
        // (121) is the newest API it needs — so this is a packaging
        // requirement, not a capability one.
        strict_min_version: "142.0",
        // Nothing is collected or transmitted anywhere except the XMPP account
        // the user configures: credentials stay in storage.local, and no
        // telemetry, analytics, or remote endpoint exists in the code.
        data_collection_permissions: { required: ["none"] },
      },
    },
    protocol_handlers: [
      {
        protocol: "ext+httpx",
        name: "HTTPX (HTTP over XMPP)",
        uriTemplate: "/browser.html#%s",
      },
    ],
    // Firefox's default MV3 CSP adds upgrade-insecure-requests, which would
    // rewrite dev-time ws://localhost XMPP connections to wss://.
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  },
};

for (const [name, manifest] of Object.entries(targets)) {
  const out = join(root, "dist", name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(root, "dist", "app"), out, { recursive: true });
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`wrote dist/${name}`);
}
