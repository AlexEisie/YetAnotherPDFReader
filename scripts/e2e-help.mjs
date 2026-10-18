/**
 * End-to-end test of the user guide and the update check in the real desktop app.
 *
 * The update check runs once against the real GitHub API (skipped when offline) and then
 * against faked responses (request interception) for a newer release, the "skip" choice, the
 * automatic check and network errors.
 *
 *   npm run dev                      # Vite dev server (the debug build loads it)
 *   cargo build -p yapr
 *   node scripts/e2e-help.mjs
 */
import puppeteer from "puppeteer-core";
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 9336;
const root = resolve(import.meta.dirname, "..");
const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], { cwd: root, encoding: "utf8" }));
const exe = join(meta.target_directory, "debug", process.platform === "win32" ? "yapr.exe" : "yapr");
const version = JSON.parse(execFileSync("node", ["-p", "JSON.stringify(require('./package.json').version)"], { cwd: root, encoding: "utf8" }));

const dir = mkdtempSync(join(tmpdir(), "yapr-e2e-help-"));
const doc = join(dir, "document.pdf");
copyFileSync(join(root, "dev", "samples", "sample.pdf"), doc);

const app = spawn(exe, [doc], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (d) => (appLog += d));
app.stderr.on("data", (d) => (appLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (cond, message) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${message}`);
  if (!cond) failures.push(message);
};

const fakeRelease = {
  tag_name: "v9.9.9",
  name: "v9.9.9 — test release",
  body: "## ✨ New\n- **Teleportation**: open documents before you think of them\n- Faster everything",
  html_url: "https://github.com/AlexEisie/YetAnotherPDFReader/releases/tag/v9.9.9",
  published_at: "2030-01-01T00:00:00Z",
  assets: [
    { name: "YetAnotherPDFReader_9.9.9_windows_x64-setup.exe", browser_download_url: "https://github.com/AlexEisie/YetAnotherPDFReader/releases/download/v9.9.9/YetAnotherPDFReader_9.9.9_windows_x64-setup.exe", size: 16_000_000 },
    { name: "YetAnotherPDFReader_9.9.9_windows_x64_portable.zip", browser_download_url: "https://github.com/AlexEisie/YetAnotherPDFReader/releases/download/v9.9.9/YetAnotherPDFReader_9.9.9_windows_x64_portable.zip", size: 19_000_000 },
    { name: "YetAnotherPDFReader_9.9.9_linux_x64.deb", browser_download_url: "https://github.com/AlexEisie/YetAnotherPDFReader/releases/download/v9.9.9/YetAnotherPDFReader_9.9.9_linux_x64.deb", size: 20_000_000 },
  ],
};

let browser;
try {
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
    } catch {
      await sleep(500);
    }
  }
  if (!browser) throw new Error("could not connect to WebView2");
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = (await browser.pages()).find((p) => p.url().includes("localhost") || p.url().includes("tauri"));
    if (!page) await sleep(250);
  }
  if (!page) throw new Error("app page not found");
  page.on("pageerror", (e) => failures.push(`pageerror: ${e.message}`));
  await page.waitForFunction(() => window.yaprDebug?.active()?.state.status === "ready", { timeout: 30000 });
  // The first start after a version bump shows "what's new"; close it.
  if (await page.$(".whats-new")) {
    await page.keyboard.press("Escape");
    await sleep(300);
  }
  await page.evaluate(() => {
    window.yaprDebug.setSetting("general.updateCheck", "off");
    window.yaprDebug.setSetting("ui.skippedUpdate", "");
  });

  // ---------------------------------------------------------------- user guide
  await page.keyboard.press("F1");
  const opened = await page.waitForSelector(".help-view .help-block", { timeout: 5000 }).then(() => true).catch(() => false);
  check(opened, "F1 opens the user guide");
  const topics = await page.$$eval(".help-view .settings-nav-item", (els) => els.length);
  check(topics === 10, `the guide has 10 topics (${topics})`);
  await page.type(".help-view .search-box input", "PDF");
  await sleep(200);
  const results = await page.$$eval(".help-view .help-block", (els) => els.length);
  check(results > 3, `search finds matching sections (${results})`);
  await page.$eval(".help-view .search-box input", (el) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // Shortcut list reflects the effective bindings.
  const nav = await page.$$(".help-view .settings-nav-item");
  await nav[7].click();
  await sleep(200);
  const shortcutRows = await page.$$eval(".help-keys tr", (els) => els.length);
  check(shortcutRows > 40, `shortcut list (${shortcutRows} commands)`);
  // A "try it" button runs its command and closes the guide.
  await nav[3].click();
  await sleep(200);
  await page.click(".help-view .help-cmd");
  await sleep(500);
  const organizing = await page.evaluate(() => window.yaprDebug.active().state.organizing && !document.querySelector(".help-view"));
  check(organizing, "\"try it\" opens the page organizer and closes the guide");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // ---------------------------------------------------------------- live update check
  await page.evaluate(() => void window.yaprDebug.openDialog("update", {}));
  await page.waitForSelector(".update-status:not(:has(.spin))", { timeout: 20000 });
  const live = await page.$eval(".update-status", (el) => ({ cls: el.className, text: el.textContent }));
  if (live.cls.includes("error")) {
    console.log(`SKIP  live update check (offline: ${live.text})`);
  } else {
    check(live.cls.includes("ok") && live.text.includes(version), `live check: ${version} is up to date (${live.text.trim()})`);
    const last = await page.evaluate(() => window.yaprDebug.settings().ui.lastUpdateCheck);
    check(Date.now() - last < 60_000, "the time of the check is recorded");
  }
  await page.keyboard.press("Escape");

  // ---------------------------------------------------------------- faked responses
  let respond = { status: 200, body: JSON.stringify(fakeRelease) };
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (req.url().startsWith("https://api.github.com/")) {
      void req.respond({ status: respond.status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: respond.body });
    } else void req.continue();
  });

  await page.evaluate(() => void window.yaprDebug.openDialog("update", {}));
  await page.waitForSelector(".update-status.new", { timeout: 15000 });
  const offer = await page.evaluate(() => ({
    title: document.querySelector(".update-status.new strong")?.textContent ?? "",
    notes: document.querySelector(".update-notes")?.textContent ?? "",
    download: document.querySelector(".dialog-footer .btn.primary")?.textContent ?? "",
    asset: document.querySelector(".update-status.new .muted")?.textContent ?? "",
  }));
  check(offer.title.includes("9.9.9"), `a newer release is offered (${offer.title})`);
  check(offer.notes.includes("Teleportation") && !offer.notes.includes("**"), "release notes are rendered");
  check(/setup\.exe/.test(offer.asset) && /15\.3|16(\.0)? MB/.test(offer.download), `the installer package is offered (${offer.download.trim()} · ${offer.asset.trim()})`);
  await page.click(".dialog-footer .btn.ghost");
  await sleep(300);
  const skipped = await page.evaluate(() => window.yaprDebug.settings().ui.skippedUpdate);
  check(skipped === "9.9.9", "\"skip this version\" is remembered");

  // Automatic check: quiet for the skipped version, a toast for a newer one.
  await page.evaluate(() => {
    window.yaprDebug.setSetting("general.updateCheck", "daily");
    window.yaprDebug.setSetting("ui.lastUpdateCheck", 0);
  });
  await page.evaluate(() => window.yaprDebug.autoCheckForUpdates());
  await sleep(500);
  // The announcement is the toast with an action button (the "skipped" notice has none).
  const quiet = await page.$$eval(".toast", (els) => !els.some((e) => e.textContent.includes("9.9.9") && e.querySelector(".toast-action")));
  check(quiet, "the automatic check stays quiet for a skipped version");
  await page.evaluate(() => {
    window.yaprDebug.setSetting("ui.skippedUpdate", "");
    window.yaprDebug.setSetting("ui.lastUpdateCheck", 0);
  });
  await page.evaluate(() => window.yaprDebug.autoCheckForUpdates());
  const toast = await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((e) => e.textContent.includes("9.9.9") && e.querySelector(".toast-action")), { timeout: 5000 }).then(() => true).catch(() => false);
  check(toast, "the automatic check announces a new version");
  const again = await page.evaluate(async () => {
    const before = window.yaprDebug.settings().ui.lastUpdateCheck;
    await window.yaprDebug.autoCheckForUpdates();
    return window.yaprDebug.settings().ui.lastUpdateCheck === before;
  });
  check(again, "no second automatic check within the interval");

  // Errors are explained and can be retried.
  respond = { status: 503, body: "{}" };
  await page.evaluate(() => void window.yaprDebug.openDialog("update", {}));
  await page.waitForSelector(".update-status.error", { timeout: 15000 });
  check(true, "a failing check shows an error with retry");
  respond = { status: 200, body: JSON.stringify({ ...fakeRelease, tag_name: `v${version}` }) };
  await page.evaluate(() => document.querySelector(".dialog-footer .btn svg.lucide-refresh-cw")?.closest("button")?.click());
  const recovered = await page.waitForSelector(".update-status.ok", { timeout: 15000 }).then(() => true).catch(() => false);
  check(recovered, "retry succeeds once GitHub answers");
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.yaprDebug.setSetting("general.updateCheck", "off"));

  // ---------------------------------------------------------------- what's new after an update
  const seen = await page.evaluate(() => window.yaprDebug.settings().ui.lastSeenVersion);
  check(seen === version, `the running version is remembered on start-up (${seen})`);
  await page.evaluate(() => {
    window.yaprDebug.setSetting("ui.lastSeenVersion", "0.1.0");
    window.yaprDebug.showWhatsNewAfterUpdate();
  });
  const notes = await page
    .waitForSelector(".whats-new", { timeout: 5000 })
    .then(() => page.$$eval(".whats-new h4", (els) => els.map((e) => e.textContent)))
    .catch(() => []);
  check(notes[0] === `v${version}` && !notes.includes("v0.1.0") && notes.length >= 2, `after an update every newer version is listed (${notes.join(", ")})`);
  const lines = await page.$$eval(".whats-new li", (els) => els.map((e) => e.textContent.length));
  check(lines.length > 0 && lines.every((n) => n < 120), `one short line per feature (${lines.length} lines)`);
  await page.keyboard.press("Escape");
  await sleep(300);
  const again2 = await page.evaluate(() => {
    window.yaprDebug.showWhatsNewAfterUpdate();
    return new Promise((r) => setTimeout(() => r(!document.querySelector(".whats-new") && window.yaprDebug.settings().ui.lastSeenVersion), 300));
  });
  check(again2 === version, "shown only once per update");
} catch (err) {
  failures.push(`e2e error: ${err.stack ?? err}`);
} finally {
  await browser?.disconnect();
  app.kill();
}

if (failures.length) {
  console.log("\nFAILURES:\n" + failures.join("\n"));
  console.log("\napp output (tail):\n" + appLog.slice(-3000));
  process.exit(1);
}
console.log("\nHELP & UPDATE E2E OK");
