/**
 * End-to-end test of page editing in the real desktop app: pictures and PDFs inserted through
 * the insert dialog, the page organizer (keyboard rotate / duplicate / delete), flipping,
 * watermarks, and password protection written to disk and verified with pdf.js.
 *
 *   npm run dev                      # Vite dev server (the debug build loads it)
 *   cargo build -p yapr
 *   node scripts/e2e-editing.mjs
 */
import puppeteer from "puppeteer-core";
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const PORT = 9334;
const root = resolve(import.meta.dirname, "..");
const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], { cwd: root, encoding: "utf8" }));
const exe = join(meta.target_directory, "debug", process.platform === "win32" ? "yapr.exe" : "yapr");

const dir = mkdtempSync(join(tmpdir(), "yapr-e2e-edit-"));
const doc = join(dir, "document.pdf");
copyFileSync(join(root, "dev", "samples", "sample.pdf"), doc);
const extra = join(dir, "extra.pdf");
copyFileSync(join(root, "dev", "samples", "large.pdf"), extra);
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
const openPdf = (password) =>
  getDocument({
    data: new Uint8Array(readFileSync(doc)),
    password,
    standardFontDataUrl: `${join(pdfjsRoot, "standard_fonts").replace(/\\/g, "/")}/`,
  }).promise;

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
  await sleep(800);
  const pages = () => page.evaluate(() => window.yaprDebug.active().state.numPages);
  const ready = () => page.waitForFunction(() => window.yaprDebug.active().state.status === "ready", { timeout: 30000 });
  check((await pages()) === 12, "sample has 12 pages");

  // Pictures written by the WebView (a JPEG photo and a transparent PNG).
  const pictures = await page.evaluate(async (folder) => {
    const make = async (type, w, h, alpha) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, "#1f6feb");
      g.addColorStop(1, alpha ? "rgba(229,72,77,0.2)" : "#e5484d");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      const blob = await new Promise((r) => canvas.toBlob(r, type, 0.9));
      return new Uint8Array(await blob.arrayBuffer());
    };
    const { invoke } = window.__TAURI_INTERNALS__;
    const write = async (name, bytes) => {
      const path = `${folder}\\${name}`;
      const metaJson = new TextEncoder().encode(JSON.stringify({ path, keepBackup: false }));
      // Frame: u32 meta length, u32 blob count, u64 blob lengths, meta, blobs.
      const frame = new Uint8Array(16 + metaJson.length + bytes.length);
      const view = new DataView(frame.buffer);
      view.setUint32(0, metaJson.length, true);
      view.setUint32(4, 1, true);
      view.setBigUint64(8, BigInt(bytes.length), true);
      frame.set(metaJson, 16);
      frame.set(bytes, 16 + metaJson.length);
      await invoke("fs_write", frame);
      return path;
    };
    return [await write("photo.jpg", await make("image/jpeg", 640, 400, false)), await write("logo.png", await make("image/png", 200, 300, true))];
  }, dir).catch((err) => {
    failures.push(`could not write pictures: ${err}`);
    return [];
  });

  // 1. Insert dialog: PDF + two pictures at the start, pictures on A4.
  if (pictures.length === 2) {
    await page.evaluate(
      (paths) => {
        const c = window.yaprDebug.active();
        void window.yaprDebug.openDialog("insertFiles", { tabId: c.tabId, at: 0, paths });
      },
      [extra, ...pictures],
    );
    await page.waitForFunction(() => document.querySelectorAll(".source-item").length === 3, { timeout: 20000 });
    // Narrow the PDF to its first two pages.
    await page.type(".source-item .source-meta input", "1-2");
    await page.select(".dialog .select-native", "start");
    const sizeSelect = await page.$$(".dialog .select-native");
    if (sizeSelect[1]) await page.evaluate((el) => { el.value = "A4"; el.dispatchEvent(new Event("change", { bubbles: true })); }, sizeSelect[1]);
    await page.click(".dialog-footer .btn.primary");
    await page.waitForFunction(() => window.yaprDebug.active().state.numPages === 16, { timeout: 30000 });
    await ready();
    check((await pages()) === 16, `insert dialog added 2 PDF pages + 2 pictures (${await pages()})`);
  }

  // 2. Organizer: select page 1, rotate with R, duplicate with Ctrl+D, delete the copy.
  await page.evaluate(() => window.yaprDebug.active().setOrganizing(true));
  await page.waitForSelector(".org-card", { timeout: 10000 });
  await sleep(500);
  await page.click('.org-card[data-page="1"]');
  await page.keyboard.press("r");
  await page.waitForFunction(() => !window.yaprDebug.active().state.saving && document.querySelector(".busy-overlay") === null, { timeout: 15000 }).catch(() => undefined);
  await sleep(1500);
  const rotated = await page.evaluate(async () => (await window.yaprDebug.active().pdf.getPage(1)).rotate);
  check(rotated === 90, `organizer R rotates the selected page (${rotated})`);
  await page.keyboard.down("Control");
  await page.keyboard.press("d");
  await page.keyboard.up("Control");
  await page.waitForFunction(() => window.yaprDebug.active().state.numPages === 17, { timeout: 15000 }).catch(() => undefined);
  check((await pages()) === 17, `Ctrl+D duplicates the page (${await pages()})`);
  await sleep(800);
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => window.yaprDebug.active().state.numPages === 16, { timeout: 15000 }).catch(() => undefined);
  check((await pages()) === 16, `Delete removes the selected copy (${await pages()})`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  check(!(await page.evaluate(() => window.yaprDebug.active().state.organizing)), "Esc closes the organizer");

  // 3. Flip the last page, watermark every page, then save.
  await page.evaluate(async () => {
    const c = window.yaprDebug.active();
    const n = c.state.numPages;
    await c.applyPageOps([{ op: "flip", pages: [n - 1], horizontal: true }], [], "flip");
    await c.applyPageOps(
      [
        {
          op: "watermark",
          pages: Array.from({ length: n }, (_, i) => i),
          watermark: { text: "E2E 水印", fontSize: 40, bold: true, color: [1, 0, 0], image: null, imageScale: 0.4, opacity: 0.3, rotation: 45, position: "tile", layer: "above", cjkHint: "zh-CN" },
        },
      ],
      [],
      "watermark",
    );
  });
  await ready();
  await page.keyboard.down("Control");
  await page.keyboard.press("s");
  await page.keyboard.up("Control");
  await page.waitForFunction(() => !window.yaprDebug.active().isDirty, { timeout: 30000 });
  {
    const pdf = await openPdf();
    check(pdf.numPages === 16, `saved file has 16 pages (${pdf.numPages})`);
    const first = await pdf.getPage(1);
    check(first.rotate === 90, "rotation saved");
    const [, , w, h] = (await pdf.getPage(3)).view;
    const [, , w4, h4] = (await pdf.getPage(4)).view;
    check(Math.round(w) === 842 && Math.round(h) === 595, `landscape photo on a landscape A4 page (${w}×${h})`);
    check(Math.round(w4) === 595 && Math.round(h4) === 842, `portrait picture on a portrait A4 page (${w4}×${h4})`);
    const ops = await (await pdf.getPage(8)).getOperatorList();
    check(ops.fnArray.length > 20, "watermarked page renders");
    await pdf.loadingTask.destroy();
  }

  // 4. Password protection: protect, save, reopen; then remove again.
  await page.evaluate(async () => {
    const all = { print: true, printHighQuality: true, copy: true, modify: true, annotate: true, fillForms: true, assemble: true };
    await window.yaprDebug.active().applySecurity({ openPassword: "e2e-secret", permissionsPassword: "", permissions: all });
  });
  await ready();
  check(await page.evaluate(() => window.yaprDebug.active().isDirty), "protection is a pending change");
  // Undo / redo of a security change keeps the right password.
  await page.evaluate(() => window.yaprDebug.active().undo());
  await ready();
  check(!(await page.evaluate(async () => (await window.yaprDebug.active().securityInfo()).encrypted)), "undo removes the pending protection");
  await page.evaluate(() => window.yaprDebug.active().redo());
  await ready();
  check((await page.evaluate(async () => (await window.yaprDebug.active().securityInfo()).encrypted)), "redo restores it without asking for a password");
  await page.keyboard.down("Control");
  await page.keyboard.press("s");
  await page.keyboard.up("Control");
  await page.waitForFunction(() => !window.yaprDebug.active().isDirty, { timeout: 30000 });
  {
    let refused = false;
    try {
      const pdf = await openPdf();
      await pdf.loadingTask.destroy();
    } catch (err) {
      refused = err?.name === "PasswordException";
    }
    check(refused, "saved file needs a password");
    const pdf = await openPdf("e2e-secret");
    check(pdf.numPages === 16, "the password opens it");
    await pdf.loadingTask.destroy();
  }
  // Editing an encrypted document must not ask for the password again.
  await page.evaluate(() => window.yaprDebug.active().applyPageOps([{ op: "rotate", pages: [1], delta: 90 }], [], "rotate"));
  await ready();
  check(!(await page.$(".dialog input[type=password]")), "no password prompt after a page operation");
  await page.evaluate(() => window.yaprDebug.active().applySecurity(null));
  await ready();
  await page.keyboard.down("Control");
  await page.keyboard.press("s");
  await page.keyboard.up("Control");
  await page.waitForFunction(() => !window.yaprDebug.active().isDirty, { timeout: 30000 });
  {
    const pdf = await openPdf();
    check(pdf.numPages === 16 && (await pdf.getPage(2)).rotate === 90, "protection removed and later edits kept");
    await pdf.loadingTask.destroy();
  }
} catch (err) {
  failures.push(`e2e error: ${err.stack ?? err}`);
  try {
    const pages = await browser?.pages();
    const p = pages?.find((x) => x.url().includes("localhost") || x.url().includes("tauri"));
    if (p) {
      const toasts = await p.$$eval(".toast", (els) => els.map((e) => e.textContent));
      failures.push(`toasts: ${JSON.stringify(toasts)}`);
      await p.screenshot({ path: join(dir, "failure.png") });
      failures.push(`screenshot: ${join(dir, "failure.png")}`);
    }
  } catch {
    // diagnostics only
  }
} finally {
  await browser?.disconnect();
  app.kill();
}

if (failures.length) {
  console.log("\nFAILURES:\n" + failures.join("\n"));
  console.log("\napp output (tail):\n" + appLog.slice(-3000));
  process.exit(1);
}
console.log("\nEDITING E2E OK");
