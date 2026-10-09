/**
 * End-to-end test of text recognition (OCR) in the real desktop app: a scanned (image-only)
 * PDF is opened, the scanned-document suggestion appears, a region is recognised, the whole
 * document gets an invisible text layer, and the saved file is checked with pdf.js.
 *
 *   python scripts/make-sample-pdfs.py   # dev/samples/scanned.pdf
 *   npm run dev                          # Vite dev server (the debug build loads it)
 *   cargo build -p yapr
 *   node scripts/e2e-ocr.mjs
 */
import puppeteer from "puppeteer-core";
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const PORT = 9335;
/** Optional folder for README screenshots (`YAPR_SHOTS=docs/images node scripts/e2e-ocr.mjs`). */
const shots = process.env.YAPR_SHOTS ? resolve(process.env.YAPR_SHOTS) : null;
const root = resolve(import.meta.dirname, "..");
const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], { cwd: root, encoding: "utf8" }));
const exe = join(meta.target_directory, "debug", process.platform === "win32" ? "yapr.exe" : "yapr");

const dir = mkdtempSync(join(tmpdir(), "yapr-e2e-ocr-"));
const doc = join(dir, "scanned.pdf");
copyFileSync(join(root, "dev", "samples", "scanned.pdf"), doc);
console.log("document", doc);

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

const require = createRequire(import.meta.url);
const pdfjsRoot = resolve(require.resolve("pdfjs-dist/package.json"), "..");
const { getDocument } = await import(pathToFileURL(join(pdfjsRoot, "legacy/build/pdf.mjs")).href);
const fileText = async (pageNumber) => {
  const pdf = await getDocument({
    data: new Uint8Array(readFileSync(doc)),
    cMapUrl: `${join(pdfjsRoot, "cmaps").replace(/\\/g, "/")}/`,
    cMapPacked: true,
    standardFontDataUrl: `${join(pdfjsRoot, "standard_fonts").replace(/\\/g, "/")}/`,
  }).promise;
  const text = (await (await pdf.getPage(pageNumber)).getTextContent()).items.map((i) => i.str).join(" ");
  await pdf.loadingTask.destroy();
  return text;
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
  check((await fileText(1)).trim() === "", "the scanned sample has no text");

  // 1. Scanned documents get a suggestion with a "Recognize text" action.
  const suggested = await page
    .waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => t.querySelector("button") && /扫描|scanned/i.test(t.textContent ?? "")), { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check(suggested, "scanned document suggestion appears");

  // 2. Region OCR: the title and first lines of page 1.
  const started = Date.now();
  await page.evaluate(() => void window.yaprDebug.active().recognizeRegionText(0, [40, 560, 560, 800]));
  await page.waitForSelector(".dialog textarea.ocr-text", { timeout: 30000 });
  const regionText = await page.$eval(".dialog textarea.ocr-text", (el) => el.value);
  if (shots) {
    await sleep(500);
    await page.screenshot({ path: join(shots, "ocr-region.png") });
  }
  console.log(`      region OCR in ${Date.now() - started} ms:`, JSON.stringify(regionText.slice(0, 90)));
  check(/Introduction/.test(regionText) && /Portable Document Format/.test(regionText), "region text is recognised");
  await page.keyboard.press("Escape");

  // 3. Whole document through the dialog.
  await page.evaluate(() => {
    const c = window.yaprDebug.active();
    void window.yaprDebug.openDialog("ocrDocument", { tabId: c.tabId });
  });
  await page.waitForSelector(".dialog-footer .btn.primary", { timeout: 5000 });
  const docStarted = Date.now();
  await page.click(".dialog-footer .btn.primary");
  await page.waitForFunction(() => window.yaprDebug.active().isDirty, { timeout: 120000 });
  await page.waitForFunction(() => window.yaprDebug.active().state.status === "ready", { timeout: 30000 });
  console.log(`      document OCR (2 pages) in ${Date.now() - docStarted} ms`);
  const inApp = await page.evaluate(async () => {
    const pdf = window.yaprDebug.active().pdf;
    const text = async (n) => (await (await pdf.getPage(n)).getTextContent()).items.map((i) => i.str).join(" ");
    return [await text(1), await text(2)];
  });
  check(/Portable Document Format/.test(inApp[0]), "page 1 is searchable in the app");
  check(inApp[1].replace(/\s/g, "").length > 300, `page 2 has text (${inApp[1].length} chars)`);

  // Find in the document now finds words on the scanned page.
  await page.keyboard.down("Control");
  await page.keyboard.press("f");
  await page.keyboard.up("Control");
  await page.keyboard.type("PostScript");
  await page.keyboard.press("Enter");
  const found = await page
    .waitForFunction(() => window.yaprDebug.active().state.find.total > 0, { timeout: 15000 })
    .then(() => page.evaluate(() => window.yaprDebug.active().state.find.total))
    .catch(() => 0);
  check(found > 0, `find matches recognised text (${found})`);
  await sleep(800);
  // Highlights show whether the invisible text lines up with the scanned picture.
  await page.screenshot({ path: join(shots ?? dir, shots ? "ocr-search.png" : "find-highlights.png") });
  console.log("      screenshot", join(dir, "find-highlights.png"));
  await page.keyboard.press("Escape");

  // 4. Save and verify the file with pdf.js.
  await page.keyboard.down("Control");
  await page.keyboard.press("s");
  await page.keyboard.up("Control");
  await page.waitForFunction(() => !window.yaprDebug.active().isDirty, { timeout: 30000 });
  const saved = await fileText(1);
  check(/Portable Document Format/.test(saved) && /Introduction/.test(saved), "saved file contains the text layer");
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
console.log("\nOCR E2E OK");
