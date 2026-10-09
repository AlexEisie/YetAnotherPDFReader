/**
 * End-to-end test of the real desktop app (Rust backend included).
 *
 * Launches the debug build with WebView2 remote debugging enabled, drives it with puppeteer,
 * adds comments, rotates a page, saves through the Rust writer and verifies the written PDF
 * with pdf.js.
 *
 *   npm run dev                      # Vite dev server (the debug build loads it)
 *   cargo build -p yapr
 *   node scripts/e2e-tauri.mjs
 */
import puppeteer from "puppeteer-core";
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const PORT = 9333;
const root = resolve(import.meta.dirname, "..");
const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], { cwd: root, encoding: "utf8" }));
const exe = join(meta.target_directory, "debug", process.platform === "win32" ? "yapr.exe" : "yapr");

const dir = mkdtempSync(join(tmpdir(), "yapr-e2e-"));
const doc = join(dir, "document.pdf");
copyFileSync(join(root, "dev", "samples", "sample.pdf"), doc);
const originalSize = statSync(doc).size;
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

  await page.waitForFunction(
    () => {
      const c = window.yaprDebug?.active();
      return c && c.state.status === "ready" && c.annotations.getState().loaded;
    },
    { timeout: 30000 },
  );
  await page.waitForSelector('.page[data-page-number="1"] canvas');
  await sleep(800);
  const existing = await page.evaluate(() => Object.keys(window.yaprDebug.active().annotations.getState().items).length);
  check(existing >= 6, `Rust read_annotations found the file's comments (${existing})`);

  // Document properties ▸ Fonts (scanned in Rust from the open session)
  const fonts = await page.evaluate(async () => (await window.yaprDebug.active().listFonts()).map((f) => `${f.name}:${f.embedded ? "E" : "-"}`));
  check(fonts.length >= 2 && fonts.some((f) => f.endsWith(":E")), `listed fonts (${fonts.join(", ")})`);

  const box = await page.$eval('.page[data-page-number="1"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  // Snapshot tool: drag a region and check the image that landed on the system clipboard.
  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  await page.keyboard.press("s");
  await page.keyboard.up("Alt");
  await page.keyboard.up("Control");
  check((await page.evaluate(() => window.yaprDebug.active().state.tool)) === "snapshot", "Ctrl+Alt+S selects the snapshot tool");
  check((await page.$$(".snapshot-dim")).length > 0 && !!(await page.$(".snapshot-guide")), "snapshot mode dims the pages and shows the guide");
  await page.mouse.move(box.x + 60, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 360, box.y + 260, { steps: 6 });
  const label = await page.$eval(".snapshot-size", (el) => el.textContent).catch(() => null);
  check(!!label && /\d+ × \d+/.test(label), `marquee shows the output size (${label})`);
  await page.mouse.up();
  const after = await page.evaluate(() => ({ tool: window.yaprDebug.active().state.tool, dim: document.querySelectorAll(".snapshot-dim").length }));
  check(after.tool === "select" && after.dim === 0, `snapshot mode ends after one capture (tool ${after.tool})`);
  await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /×/.test(t.textContent ?? "")), { timeout: 15000 });
  const clip = execFileSync(
    "powershell",
    ["-NoProfile", "-STA", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $i = [Windows.Forms.Clipboard]::GetImage(); if ($i) { \"$($i.Width)x$($i.Height)\" } else { 'none' }"],
    { encoding: "utf8" },
  ).trim();
  const [cw, ch] = clip.split("x").map(Number);
  check(cw > 250 && ch > 150 && Math.abs(cw / ch - 1.5) < 0.05, `clipboard holds the snapshot image (${clip})`);
  // Esc leaves snapshot mode without capturing and restores the previous tool.
  await page.keyboard.press("h");
  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  await page.keyboard.press("s");
  await page.keyboard.up("Alt");
  await page.keyboard.up("Control");
  await page.keyboard.press("Escape");
  check((await page.evaluate(() => window.yaprDebug.active().state.tool)) === "hand", "Esc returns from snapshot mode to the previous tool");
  await page.keyboard.press("v");
  await page.mouse.click(box.x + 300, box.y + 700);

  // Rectangle
  await page.keyboard.press("r");
  await page.mouse.move(box.x + 120, box.y + 520);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + 600, { steps: 5 });
  await page.mouse.up();
  // Sticky note with text
  await page.keyboard.press("s");
  await page.mouse.click(box.x + 600, box.y + 200);
  await sleep(400);
  await page.keyboard.type("E2E note 中文");
  await page.keyboard.press("Escape");
  // Highlight from a text selection
  const span = await page.$eval('.page[data-page-number="1"] .textLayer span:nth-of-type(4)', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top + r.height / 2, w: r.width };
  });
  await page.mouse.move(span.x + 2, span.y);
  await page.mouse.down();
  await page.mouse.move(span.x + span.w * 0.6, span.y, { steps: 6 });
  await page.mouse.up();
  await sleep(600);
  await page.click(".selection-toolbar button:nth-child(2)");
  await sleep(300);
  // Modify an existing comment: recolour the file's square on page 3 through the model.
  await page.evaluate(() => {
    const c = window.yaprDebug.active();
    const sq = Object.values(c.annotations.getState().items).find((a) => a.kind === "square" && a.ref);
    if (sq) c.updateAnnotation(sq.id, { color: [0, 0, 1], borderWidth: 4 });
  });
  const added = await page.evaluate(() => {
    const st = window.yaprDebug.active().annotations.getState();
    return Object.values(st.items)
      .filter((a) => !st.pristine[a.id])
      .map((a) => a.kind);
  });
  check(added.includes("square") && added.includes("note") && added.includes("highlight"), `created ${added.join(", ")}`);

  // Save through Rust
  await page.keyboard.down("Control");
  await page.keyboard.press("s");
  await page.keyboard.up("Control");
  await page.waitForFunction(() => !window.yaprDebug.active().isDirty, { timeout: 15000 });
  check(statSync(doc).size > originalSize, `file grew after save (${originalSize} → ${statSync(doc).size})`);

  // Structural edit: rotate page 2, then save again.
  await page.evaluate(() => window.yaprDebug.active().applyPageOps([{ op: "rotate", pages: [1], delta: 90 }]));
  await page.waitForFunction(() => window.yaprDebug.active().state.status === "ready", { timeout: 15000 });
  await page.keyboard.down("Control");
  await page.keyboard.press("s");
  await page.keyboard.up("Control");
  await page.waitForFunction(() => !window.yaprDebug.active().isDirty, { timeout: 15000 });
  const undoState = await page.evaluate(() => window.yaprDebug.active().state.history.canUndo);
  check(undoState, "history still undoable after saving");

  // Page operations and their undo (each one rebuilds the document in Rust).
  const pages = () => page.evaluate(() => window.yaprDebug.active().state.numPages);
  const op = (ops, sourcePath) =>
    page.evaluate(
      async (ops, sourcePath) => {
        const c = window.yaprDebug.active();
        const sources = [];
        if (sourcePath) {
          const { invoke } = window.__TAURI_INTERNALS__;
          sources.push(new Uint8Array(await invoke("fs_read", { path: sourcePath, maxBytes: null })));
        }
        await c.applyPageOps(ops, sources);
      },
      ops,
      sourcePath ?? null,
    );
  const undo = () => page.evaluate(() => window.yaprDebug.active().undo());
  await op([{ op: "insertBlank", at: 0, count: 2, width: 595, height: 842 }]);
  check((await pages()) === 14, `insert two blank pages → ${await pages()}`);
  await undo();
  check((await pages()) === 12, `undo insert → ${await pages()}`);
  await op([{ op: "delete", pages: [11] }]);
  check((await pages()) === 11, `delete last page → ${await pages()}`);
  await undo();
  check((await pages()) === 12, `undo delete → ${await pages()}`);
  await op([{ op: "insertFromBlob", at: 12, blob: 0, pages: [0, 1, 2] }], join(root, "dev", "samples", "large.pdf"));
  check((await pages()) === 15, `insert 3 pages from another PDF → ${await pages()}`);
  await undo();
  check((await pages()) === 12, `undo merge → ${await pages()}`);
  const comments = await page.evaluate(() => {
    const st = window.yaprDebug.active().annotations.getState();
    return Object.values(st.items).filter((a) => !a.inReplyTo).length;
  });
  check(comments >= 9, `comments intact after page-op undo (${comments})`);
  const dirtyAfterUndo = await page.evaluate(() => window.yaprDebug.active().isDirty);
  check(!dirtyAfterUndo, "back at the saved state after undoing all page operations");
} catch (err) {
  failures.push(`e2e error: ${err.stack ?? err}`);
} finally {
  await browser?.disconnect();
  app.kill();
}

// Verify the written file with pdf.js
const require = createRequire(import.meta.url);
const pdfjsRoot = resolve(require.resolve("pdfjs-dist/package.json"), "..");
const { getDocument } = await import(pathToFileURL(join(pdfjsRoot, "legacy/build/pdf.mjs")).href);
const pdf = await getDocument({
  data: new Uint8Array(readFileSync(doc)),
  standardFontDataUrl: `${join(pdfjsRoot, "standard_fonts").replace(/\\/g, "/")}/`,
}).promise;
const p1 = await (await pdf.getPage(1)).getAnnotations();
const p2 = await pdf.getPage(2);
const p3 = await (await pdf.getPage(3)).getAnnotations();
const subtypes = p1.map((a) => a.subtype);
check(subtypes.includes("Square"), `page 1 has the new Square (${subtypes.join(", ")})`);
check(subtypes.includes("Highlight"), "page 1 has the new Highlight");
const note = p1.find((a) => a.subtype === "Text");
check(note?.contentsObj?.str === "E2E note 中文", `note text survived (${note?.contentsObj?.str})`);
check(p2.rotate === 90, `page 2 rotated (${p2.rotate})`);
const sq = p3.find((a) => a.subtype === "Square");
check(!!sq && sq.color && sq.color[2] === 255 && sq.color[0] === 0, "existing square was recoloured in place");
check(pdf.numPages === 12, `page count preserved (${pdf.numPages})`);
await pdf.loadingTask.destroy();

if (failures.length) {
  console.log("\nFAILURES:\n" + failures.join("\n"));
  console.log("\napp output (tail):\n" + appLog.slice(-3000));
  process.exit(1);
}
console.log("\nE2E OK");
