/**
 * Smoke test of the *release* build (production assets, CSP, custom protocol).
 *
 *   npm run app:build
 *   node scripts/e2e-release.mjs
 *
 * Opens a sample document, checks that pages, the text layer and thumbnails render, saves a
 * screenshot and scans the application log for errors written during the run.
 */
import puppeteer from "puppeteer-core";
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 9334;
const root = resolve(import.meta.dirname, "..");
const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], { cwd: root, encoding: "utf8" }));
const exe = join(meta.target_directory, "release", process.platform === "win32" ? "yapr.exe" : "yapr");
const out = join(root, "target", "ui-smoke");
mkdirSync(out, { recursive: true });

const logDir = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "io.github.yapr.reader", "logs");
const logSizeBefore = existsSync(logDir) ? Object.fromEntries(readdirSync(logDir).map((f) => [f, statSync(join(logDir, f)).size])) : {};

const dir = mkdtempSync(join(tmpdir(), "yapr-release-"));
const doc = join(dir, "sample.pdf");
copyFileSync(join(root, "dev", "samples", "sample.pdf"), doc);

const app = spawn(exe, [doc], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (cond, message) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${message}`);
  if (!cond) failures.push(message);
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
  const [page] = await browser.pages();
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  console.log("url", page.url());
  await page.waitForSelector('.page[data-page-number="1"] canvas', { timeout: 30000 });
  await page.waitForSelector('.page[data-page-number="1"] .textLayer span', { timeout: 30000 });
  check(true, "first page rendered with a text layer");
  // The first start after a version bump shows "what's new"; close it.
  if (await page.$(".whats-new")) {
    await page.keyboard.press("Escape");
    await sleep(300);
  }
  await page.keyboard.press("F4");
  await page.waitForSelector(".thumb-frame img", { timeout: 15000 }).then(
    () => check(true, "thumbnails rendered (blob: images allowed by CSP)"),
    () => check(false, "thumbnails rendered"),
  );
  const status = await page.$eval(".statusbar", (el) => el.textContent);
  check(/12/.test(status ?? ""), `status bar shows the page count (${status})`);
  // Runtime <style> elements (hidden-annotation rules, print page size) must not be blocked by
  // the CSP nonce Tauri adds to production assets.
  const styled = await page.evaluate(() => {
    const el = document.createElement("style");
    el.textContent = "#yapr-csp-probe { width: 37px; }";
    document.head.append(el);
    const probe = document.createElement("div");
    probe.id = "yapr-csp-probe";
    document.body.append(probe);
    const width = getComputedStyle(probe).width;
    probe.remove();
    el.remove();
    return width;
  });
  check(styled === "37px", `runtime <style> elements apply (${styled})`);
  const fonts = await page.evaluate(async () => (await window.yaprDebug?.active()?.listFonts())?.length ?? -1);
  if (fonts !== -1) check(fonts > 0, `fonts listed (${fonts})`);
  await sleep(1500);
  await page.screenshot({ path: join(out, "release.png") });
  check(consoleErrors.length === 0, `no console errors (${consoleErrors.slice(0, 3).join(" | ")})`);
} catch (err) {
  failures.push(`release check error: ${err.stack ?? err}`);
} finally {
  await browser?.disconnect();
  app.kill();
}

await sleep(500);
if (existsSync(logDir)) {
  const errors = [];
  for (const f of readdirSync(logDir)) {
    const text = readFileSync(join(logDir, f), "utf8").slice(logSizeBefore[f] ?? 0);
    errors.push(...text.split(/\r?\n/).filter((l) => /\]\[(ERROR|WARN)\]/.test(l)));
  }
  check(errors.length === 0, `application log has no warnings/errors${errors.length ? `:\n  ${errors.slice(0, 8).join("\n  ")}` : ""}`);
}

if (failures.length) {
  console.log("\nFAILURES:\n" + failures.join("\n"));
  process.exit(1);
}
console.log("\nRELEASE OK");
