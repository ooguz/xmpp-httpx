// End-to-end smoke test of the WebExtension browser: drives the *built*
// extension page in real Chromium against the demo gateway over real XMPP.
//
// The browser-mode unit suites cover each module in isolation; this covers the
// wiring in app.ts that nothing else can reach — tab switching, per-tab
// history, the chrome staying in sync with the active tab. It earned its place
// by catching a bug the unit tests could not: after a POST the address bar
// reverted to the form's page, because only `navigate()` updated the tab URL.
//
// Prereqs:
//   docker compose -f test/e2e/docker-compose.yml up -d --wait
//   docker compose -f test/e2e/docker-compose.yml exec prosody \
//     prosodyctl register alice localhost e2e-alice
//   npm run build && npm --prefix examples/webext run build
// Run: npm run smoke
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP_DIR = join(ROOT, "examples/webext/dist/app");
const PORT = 8899;
const TIMEOUT = 20_000;
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

// The page is served over http://localhost so it runs in a secure context, as
// it would from an extension origin: the Cache API and storage behave the same.
const files = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]));
  const file = join(APP_DIR, path === "/" ? "browser.html" : path);
  if (!file.startsWith(APP_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

/** Starts the demo gateway and resolves once it announces itself. */
function startGateway() {
  const child = spawn(process.execPath, [join(ROOT, "scripts/demo-gateway.mjs")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gateway did not start")), 15_000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("serving")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(`[gateway] ${chunk}`));
    child.on("exit", (code) => reject(new Error(`gateway exited with ${code}`)));
  });
}

const problems = [];
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.log(`  FAIL ${name}: ${err.message}`);
    problems.push(`${name}: ${err.message}`);
  }
};

const gateway = await startGateway();
await new Promise((resolve) => files.listen(PORT, resolve));

const browser = await chromium.launch();
// One explicit context: the embedded-mode page below shares it, so the
// settings the first page saves are there for the second one's auto-connect.
const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await context.newPage();
page.on("console", (message) => {
  // Playwright injects utility scripts into every frame; the sandbox blocks
  // them in our scriptless srcdoc documents — that is the sandbox working.
  const text = message.text();
  if (message.type() === "error" && !text.includes("Blocked script execution")) {
    problems.push(`console: ${text}`);
  }
});
page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));

const activeFrame = async () =>
  (await (await page.$("#viewports iframe:not([hidden])")).contentFrame());
const pageText = async () => (await activeFrame()).locator("body").innerText();
const titleContains = (text) =>
  page.waitForFunction((want) => document.title.includes(want), text, {
    timeout: TIMEOUT,
  });

try {
  await page.goto(`http://localhost:${PORT}/browser.html`);
  // Chromium's own bookkeeping may add entries we don't control (iframe
  // navigations, downloads), so history assertions measure growth from a
  // baseline, not absolute length.
  const baseline = await page.evaluate(() => history.length);

  await page.fill("#service", "ws://localhost:15280/xmpp-websocket");
  await page.fill("#jid", "alice@localhost");
  await page.fill("#password", "e2e-alice");
  await page.click("#connectBtn");
  await page.waitForSelector('#status[data-state="online"]', { timeout: TIMEOUT });
  console.log("connected to Prosody as alice@localhost");

  await page.fill("#address", "httpx://web@httpx.localhost/");
  await page.press("#address", "Enter");
  await titleContains("httpx demo");

  await step("page renders", async () => {
    const text = await pageText();
    if (!text.includes("Hello from XEP-0332")) throw new Error(text.slice(0, 200));
  });
  await step("page CSS applies", async () => {
    const width = await (await activeFrame())
      .locator("h1")
      .evaluate((h) => getComputedStyle(h).borderBottomWidth);
    if (width !== "3px") throw new Error(`borderBottomWidth=${width}`);
  });
  await step("CSS url() fetched into a blob", async () => {
    const image = await (await activeFrame())
      .locator(".badge")
      .evaluate((el) => getComputedStyle(el).backgroundImage);
    if (!image.includes("blob:")) throw new Error(image);
  });
  await step("httpx image fetched into a blob", async () => {
    const src = await (await activeFrame()).locator("img[alt=logo]").getAttribute("src");
    if (!src?.startsWith("blob:")) throw new Error(String(src));
  });
  await step("favicon is the page's own icon", async () => {
    const href = await page.getAttribute("#favicon", "href");
    if (!href?.startsWith("blob:")) throw new Error(String(href));
  });
  await step("tab strip shows the page title", async () => {
    const label = await page.locator(".tab[data-active] .select").innerText();
    if (!label.includes("httpx demo")) throw new Error(label);
  });
  await step("cache chip reports the network fetch", async () => {
    const chip = await page.locator("#cacheState").innerText();
    if (chip !== "network") throw new Error(chip);
  });

  await step("GET form submits", async () => {
    await (await activeFrame()).locator('form[action*="/search"] button').click();
    await titleContains("Search results");
    const text = await pageText();
    if (!text.includes("You searched for stanza")) throw new Error(text.slice(0, 200));
  });
  await step("back returns to the previous page", async () => {
    await page.click("#back");
    await titleContains("httpx demo");
  });
  await step("revalidation reports a cache hit or 304", async () => {
    const chip = await page.locator("#cacheState").innerText();
    if (chip !== "304" && chip !== "cache") throw new Error(chip);
  });
  await step("POST form submits a urlencoded body", async () => {
    await (await activeFrame()).locator('form[action*="/comment"] button').click();
    await titleContains("Comment posted");
    const text = await pageText();
    if (!text.includes("Text: hello") || !text.includes("Mood: happy")) {
      throw new Error(text.slice(0, 200));
    }
  });
  await step("the POST result owns the address bar", async () => {
    const shown = await page.inputValue("#address");
    if (!shown.endsWith("/comment")) throw new Error(shown);
  });

  await step("a new tab starts with its own empty history", async () => {
    await page.click("#newTab");
    if ((await page.locator(".tab").count()) !== 2) throw new Error("expected 2 tabs");
    if (!(await page.locator("#back").isDisabled())) throw new Error("back enabled");
    if (!(await pageText()).includes("New tab")) throw new Error("no new-tab page");
  });
  await step("the second tab loads independently", async () => {
    await page.fill("#address", "httpx://web@httpx.localhost/about.html");
    await page.press("#address", "Enter");
    await titleContains("About");
    if (!(await pageText()).includes("About")) throw new Error("about page missing");
  });
  await step("switching back restores the first tab without refetching", async () => {
    await page.locator(".tab:not([data-active]) .select").click();
    const text = await pageText();
    if (!text.includes("Comment posted")) throw new Error(text.slice(0, 200));
    if (await page.locator("#back").isDisabled()) throw new Error("back disabled");
  });
  await step("exactly one viewport is visible", async () => {
    const visible = await page.locator("#viewports iframe:not([hidden])").count();
    const total = await page.locator("#viewports iframe").count();
    if (visible !== 1 || total !== 2) throw new Error(`visible=${visible} total=${total}`);
  });

  await step("drawer lists visited pages", async () => {
    await page.click("#drawerBtn");
    const count = await page.locator("#drawerList li").count();
    if (count < 2) throw new Error(`only ${count} entries`);
  });
  await step("bookmarking shows up in the bookmarks panel", async () => {
    await page.click("#bookmark");
    if ((await page.getAttribute("#bookmark", "aria-pressed")) !== "true") {
      throw new Error("star not pressed");
    }
    await page.click("#tabBookmarks");
    if ((await page.locator("#drawerList li").count()) !== 1) {
      throw new Error("expected exactly 1 bookmark");
    }
  });
  await step("closing a tab activates the other one", async () => {
    await page.click("#drawerClose");
    await page.locator(".tab[data-active] .close").click();
    if ((await page.locator(".tab").count()) !== 1) throw new Error("expected 1 tab");
    if (!(await pageText()).includes("About")) throw new Error("wrong tab activated");
  });

  await step("an attachment downloads instead of rendering", async () => {
    const wait = page.waitForEvent("download", { timeout: TIMEOUT });
    await page.fill("#address", "httpx://web@httpx.localhost/download/report.bin");
    await page.press("#address", "Enter");
    const download = await wait;
    if (download.suggestedFilename() !== "httpx-report.bin") {
      throw new Error(download.suggestedFilename());
    }
  });
  await step("a raw-typed path with a space loads and round-trips", async () => {
    // tab.url keeps the raw space while location.hash serializes it to %20;
    // the chrome sync must compare serialized spellings or it rewrites the
    // hash on every sync (and, embedded, pushes duplicates).
    await page.fill("#address", "httpx://web@httpx.localhost/nice page.html");
    await page.press("#address", "Enter");
    await titleContains("Nice page");
    if (!(await pageText()).includes("path with a space")) throw new Error("wrong page");
  });
  await step("standalone: navigations never push session-history entries", async () => {
    const length = await page.evaluate(() => history.length);
    if (length !== baseline) throw new Error(`history.length=${length}, was ${baseline}`);
  });

  // --- embedded mode -------------------------------------------------------------
  // A second page in the same context: same origin, so the settings saved by
  // the connect above are found and the boot auto-connects. The host app
  // (Klar) supplies the chrome; its back/forward walk the session history.
  const emb = await context.newPage();
  emb.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && !text.includes("Blocked script execution")) {
      problems.push(`embedded console: ${text}`);
    }
  });
  emb.on("pageerror", (err) => problems.push(`embedded pageerror: ${err.message}`));
  const embTitle = (want) =>
    emb.waitForFunction((text) => document.title.includes(text), want, {
      timeout: TIMEOUT,
    });
  const embText = async () =>
    (await (await emb.$("#viewports iframe:not([hidden])")).contentFrame())
      .locator("body")
      .innerText();

  await emb.goto(
    `http://localhost:${PORT}/browser.html?embedded=1#httpx://web@httpx.localhost/`,
  );
  await embTitle("httpx demo");
  const embBaseline = await emb.evaluate(() => history.length);

  await step("embedded: the page's own chrome is hidden", async () => {
    if (await emb.locator("#tabstrip").isVisible()) throw new Error("tab strip visible");
    if (await emb.locator("#chrome").isVisible()) throw new Error("URL bar visible");
  });
  await step("embedded: a link click pushes one history entry", async () => {
    // renderHtml resolves hrefs to absolute httpx URLs before display.
    const frame = await (await emb.$("#viewports iframe:not([hidden])")).contentFrame();
    await frame.locator('a[href$="about.html"]').click();
    await embTitle("About");
    const length = await emb.evaluate(() => history.length);
    if (length !== embBaseline + 1) {
      throw new Error(`history.length=${length}, was ${embBaseline}`);
    }
  });
  await step("embedded: the host's back returns to the previous page", async () => {
    await emb.goBack();
    await embTitle("httpx demo");
    const text = await embText();
    if (!text.includes("Hello from XEP-0332")) throw new Error(text.slice(0, 200));
  });
  await step("embedded: the host's forward works, with no duplicate entry", async () => {
    await emb.goForward();
    await embTitle("About");
    const length = await emb.evaluate(() => history.length);
    if (length !== embBaseline + 1) {
      throw new Error(`history.length=${length}, was ${embBaseline}`);
    }
  });
  await step("embedded: an encoded-path link pushes exactly one entry", async () => {
    await emb.goBack();
    await embTitle("httpx demo");
    const frame = await (await emb.$("#viewports iframe:not([hidden])")).contentFrame();
    await frame.locator('a[href$="nice%20page.html"]').click();
    await embTitle("Nice page");
    // The forward entry (About) is truncated by the push, so the length must
    // land back at baseline+1: a raw-vs-serialized hash mismatch would have
    // pushed a duplicate on load completion and made it +2.
    const length = await emb.evaluate(() => history.length);
    if (length !== embBaseline + 1) {
      throw new Error(`history.length=${length}, was ${embBaseline}`);
    }
  });
  await step("embedded: back from the encoded page is not a dead press", async () => {
    await emb.goBack();
    await embTitle("httpx demo");
    const text = await embText();
    if (!text.includes("Hello from XEP-0332")) throw new Error(text.slice(0, 200));
    const length = await emb.evaluate(() => history.length);
    if (length !== embBaseline + 1) {
      throw new Error(`traversal grew history to ${length}`);
    }
  });
  await step("embedded: a non-canonical hash cannot trap the back button", async () => {
    // Spelling the *current* page without its trailing slash pushes at most
    // one entry (the assignment itself — from mid-stack it also truncates the
    // forward entries, so the length may even stay put); the page must correct
    // the spelling in place. A push here would re-push on every back press —
    // an inescapable loop that grows the history each time.
    const before = await emb.evaluate(() => history.length);
    await emb.evaluate(() => {
      window.location.hash = "#httpx://web@httpx.localhost";
    });
    await emb.waitForFunction(
      () => window.location.hash === "#httpx://web@httpx.localhost/",
      { timeout: TIMEOUT },
    );
    const after = await emb.evaluate(() => history.length);
    if (after > before + 1) {
      throw new Error(`hash correction grew history: ${before} -> ${after}`);
    }
    await emb.goBack();
    await emb.waitForTimeout(500);
    const settled = await emb.evaluate(() => history.length);
    if (settled > after) {
      throw new Error(`a back press grew history: ${after} -> ${settled}`);
    }
  });
  await step("embedded: a freshly typed attachment URL saves immediately", async () => {
    // Arrives as hashchange (the host toolbar's only channel) but is not a
    // spelling the page mirrored — so it must be treated as fresh and save.
    const wait = emb.waitForEvent("download", { timeout: TIMEOUT });
    await emb.evaluate(() => {
      window.location.hash = "#httpx://web@httpx.localhost/download/report.bin";
    });
    const download = await wait;
    if (download.suggestedFilename() !== "httpx-report.bin") {
      throw new Error(download.suggestedFilename());
    }
  });
  await step("embedded: traversing back over the receipt never re-saves", async () => {
    let resaved = false;
    emb.on("download", () => {
      resaved = true;
    });
    await emb.goBack();
    await embTitle("httpx demo");
    await emb.goForward();
    await embTitle("httpx-report.bin");
    await emb.waitForTimeout(500);
    if (resaved) throw new Error("history traversal re-saved the attachment");
  });

  // The omnibox deep link arrives wholly percent-encoded (background.js
  // builds "#" + encodeURIComponent(url)); boot must decode exactly that.
  const omni = await context.newPage();
  await step("an encoded omnibox deep link boots to the page", async () => {
    await omni.goto(
      `http://localhost:${PORT}/browser.html#httpx%3A%2F%2Fweb%40httpx.localhost%2F`,
    );
    await omni.waitForFunction(
      () => document.title.includes("httpx demo"),
      { timeout: TIMEOUT },
    );
    const shown = await omni.inputValue("#address");
    if (shown !== "httpx://web@httpx.localhost/") throw new Error(shown);
  });
} finally {
  await browser.close();
  files.close();
  gateway.kill();
}

if (problems.length === 0) {
  console.log("\nsmoke OK — every step passed, no console errors");
} else {
  console.log(`\nsmoke FAILED (${problems.length}):`);
  for (const problem of problems) console.log(` - ${problem}`);
  process.exitCode = 1;
}
