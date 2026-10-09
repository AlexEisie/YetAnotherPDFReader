/**
 * UI smoke test: drives the front-end (browser mode with the mocked Tauri backend) in headless
 * Edge / Chrome and saves screenshots of the main flows.
 *
 *   npm run dev                         # in another terminal
 *   node scripts/ui-smoke.mjs [out-dir] [scenario ...]
 *
 * Exits with code 1 when the page logged errors.
 */
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const URL = process.env.YAPR_URL ?? "http://localhost:5174/";
const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

const [outArg, ...wanted] = process.argv.slice(2);
const out = resolve(outArg ?? "target/ui-smoke");
mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: BROWSERS.find((p) => existsSync(p)),
  headless: true,
  args: ["--lang=zh-CN", "--disable-gpu-sandbox"],
  defaultViewport: { width: 1360, height: 860, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`console: ${msg.text().slice(0, 500)}`);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let shotIndex = 0;
async function shot(name) {
  const file = join(out, `${String(++shotIndex).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
  console.log("screenshot", file);
}
async function click(selector) {
  await page.waitForSelector(selector, { visible: true, timeout: 10000 });
  await page.click(selector);
}
async function pageBox(n) {
  return page.$eval(`.page[data-page-number="${n}"]`, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
}

async function openSample(name = "sample.pdf") {
  await page.goto(URL, { waitUntil: "networkidle0" });
  await page.evaluate((n) => {
    localStorage.clear();
    window.yaprDev.nextOpen(n);
  }, name);
  await page.reload({ waitUntil: "networkidle0" });
  await page.evaluate((n) => window.yaprDev.nextOpen(n), name);
  await click(".start-actions .btn.primary");
  await page.waitForSelector('.page[data-page-number="1"] canvas', { timeout: 20000 });
  await page.waitForFunction(() => window.yaprDev.active()?.annotations.getState().loaded, { timeout: 20000 });
  await sleep(800);
}

const scenarios = {
  async start() {
    await page.goto(URL, { waitUntil: "networkidle0" });
    await sleep(500);
    await shot("start-page");
  },

  async reading() {
    await openSample();
    await shot("document");
    await page.keyboard.press("F4");
    await sleep(800);
    await shot("thumbnails");
    await page.click(".sidebar-tabs button:nth-child(2)");
    await sleep(800);
    await shot("outline");
    await page.click(".sidebar-tabs button:nth-child(3)");
    await sleep(800);
    await page.click(".comment-card");
    await sleep(1200);
    await shot("comment-selected");
  },

  async drawing() {
    await openSample();
    await page.keyboard.press("c");
    await sleep(300);
    const box = await pageBox(1);
    // Rectangle
    await page.keyboard.press("r");
    await page.mouse.move(box.x + 120, box.y + 520);
    await page.mouse.down();
    await page.mouse.move(box.x + 260, box.y + 600, { steps: 5 });
    await page.mouse.up();
    // Ink
    await page.keyboard.press("d");
    await page.mouse.move(box.x + 300, box.y + 520);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) await page.mouse.move(box.x + 300 + i * 6, box.y + 520 + Math.sin(i / 3) * 25);
    await page.mouse.up();
    // Arrow
    await page.keyboard.press("a");
    await page.mouse.move(box.x + 560, box.y + 520);
    await page.mouse.down();
    await page.mouse.move(box.x + 700, box.y + 600, { steps: 4 });
    await page.mouse.up();
    await sleep(400);
    await shot("shapes");
    // Sticky note + reply
    await page.keyboard.press("s");
    await page.mouse.click(box.x + 760, box.y + 300);
    await sleep(500);
    await page.keyboard.type("这是一条便笺 / a sticky note");
    await page.type(".note-popup .note-foot input", "First reply");
    await page.keyboard.press("Enter");
    await sleep(500);
    await shot("note-popup");
    await page.keyboard.press("Escape");
    // Highlight via text selection
    await page.keyboard.press("Escape");
    const span = await page.$eval('.page[data-page-number="1"] .textLayer span:nth-of-type(4)', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top + r.height / 2, w: r.width };
    });
    await page.mouse.move(span.x + 2, span.y);
    await page.mouse.down();
    await page.mouse.move(span.x + span.w * 0.7, span.y, { steps: 6 });
    await page.mouse.up();
    await sleep(600);
    await shot("selection-toolbar");
    await page.click(".selection-toolbar button:nth-child(2)");
    await sleep(500);
    // Free text
    await page.keyboard.press("t");
    await page.mouse.click(box.x + 120, box.y + 650);
    await sleep(300);
    await page.keyboard.type("Free text annotation 自由文本");
    await page.mouse.click(box.x + 600, box.y + 760);
    await sleep(500);
    await shot("annotations-done");
    const summary = await page.evaluate(() => {
      const c = window.yaprDev.active();
      const st = c.annotations.getState();
      return {
        added: Object.values(st.items)
          .filter((a) => !st.pristine[a.id])
          .map((a) => a.kind),
        undo: c.state.history.undoLabel,
        dirty: c.isDirty,
      };
    });
    console.log("drawing summary", JSON.stringify(summary));
    await page.keyboard.down("Control");
    await page.keyboard.press("s");
    await page.keyboard.up("Control");
    await sleep(800);
    await shot("saved");
  },

  async modes() {
    await openSample();
    // Snapshot marquee while dragging.
    await page.click('.toolbar [data-tip-key="Ctrl+Alt+S"]');
    const b = await pageBox(1);
    await page.mouse.move(b.x + 60, b.y + 80);
    await sleep(300);
    await shot("snapshot-mode");
    await page.mouse.down();
    await page.mouse.move(b.x + 420, b.y + 300, { steps: 5 });
    await sleep(300);
    await shot("snapshot-marquee");
    await page.mouse.up();
    await sleep(800);
    await shot("snapshot-copied");
    await page.keyboard.press("Escape");
    // Thumbnails are dimmed in the page colour modes.
    await page.keyboard.press("F4");
    await sleep(800);
    for (const mode of ["dark", "night", "sepia", "green"]) {
      await page.click('.toolbar [data-tip="页面背景"], .toolbar [data-tip="Page Background"]');
      await sleep(200);
      const items = await page.$$(".menu .menu-item");
      const index = { dark: 1, night: 2, sepia: 3, green: 4 }[mode];
      await items[index].click();
      await sleep(900);
      await shot(`mode-${mode}`);
    }
  },

  async dialogs() {
    await openSample();
    await page.keyboard.down("Control");
    await page.keyboard.press("f");
    await page.keyboard.up("Control");
    await page.keyboard.type("Adobe");
    await sleep(1200);
    await shot("find");
    await page.keyboard.press("Escape");
    await page.keyboard.down("Control");
    await page.keyboard.down("Shift");
    await page.keyboard.press("p");
    await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
    await page.keyboard.type("zoom");
    await sleep(300);
    await shot("palette");
    await page.keyboard.press("Escape");
    await page.keyboard.down("Control");
    await page.keyboard.press("p");
    await page.keyboard.up("Control");
    await sleep(400);
    await shot("print-dialog");
    await page.keyboard.press("Escape");
    await page.keyboard.down("Control");
    await page.keyboard.press("d");
    await page.keyboard.up("Control");
    await sleep(600);
    await shot("properties");
    await page.click('.dialog [role="tab"]:nth-child(4)');
    await page.waitForSelector(".font-list .font-row", { timeout: 5000 });
    await shot("properties-fonts");
    await page.keyboard.press("Escape");
    await page.click('.menubar-item:nth-child(1)');
    await sleep(300);
    await shot("file-menu");
    await page.keyboard.press("Escape");
  },

  async settings() {
    await page.goto(URL, { waitUntil: "networkidle0" });
    await page.keyboard.down("Control");
    await page.keyboard.press(",");
    await page.keyboard.up("Control");
    await sleep(500);
    await shot("settings-general");
    const navItems = await page.$$(".settings-nav-item");
    await navItems[2].click();
    await sleep(300);
    await shot("settings-reading");
    await page.click(".setting-row.link");
    await sleep(400);
    await shot("settings-page-colors");
    await page.type(".settings-nav .input", "zoom");
    await sleep(300);
    await shot("settings-search");
    await page.focus(".settings-nav .input");
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await page.type(".settings-nav .input", "快照");
    await sleep(300);
    await shot("settings-snapshot-search");
  },

  async extras() {
    await openSample();
    await page.keyboard.press("c");
    await sleep(300);
    const box = await pageBox(1);
    // Stamp: open the picker, choose the first standard stamp, place it.
    await click(".subtoolbar .icon-btn:has(svg.lucide-stamp)");
    await sleep(300);
    await shot("stamp-picker");
    await page.click(".popover .stamp-grid button");
    await page.mouse.click(box.x + 650, box.y + 560);
    await sleep(300);
    // Signature: draw one and place it.
    await page.evaluate(() => window.yaprDev.active().setTool("select"));
    await click(".subtoolbar .icon-btn:has(svg.lucide-pen-line)");
    await sleep(200);
    await page.click(".popover .btn");
    await page.waitForSelector(".signature-pad");
    const pad = await page.$eval(".signature-pad", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    await page.mouse.move(pad.x + 40, pad.y + 120);
    await page.mouse.down();
    for (let i = 0; i <= 40; i++) await page.mouse.move(pad.x + 40 + i * 9, pad.y + 100 + Math.sin(i / 3) * 35);
    await page.mouse.up();
    await sleep(200);
    await shot("signature-dialog");
    await page.click(".dialog-footer .btn.primary");
    await sleep(300);
    await page.mouse.click(box.x + 250, box.y + 650);
    await sleep(300);
    // Polygon by clicks, finished with Enter.
    await page.evaluate(() => window.yaprDev.active().setTool("polygon"));
    await sleep(100);
    for (const [dx, dy] of [[450, 420], [560, 380], [600, 480], [480, 520]]) await page.mouse.click(box.x + dx, box.y + dy);
    await page.keyboard.press("Enter");
    await sleep(300);
    // Ink then erase it.
    await page.evaluate(() => window.yaprDev.active().setTool("ink"));
    await sleep(100);
    await page.mouse.move(box.x + 120, box.y + 560);
    await page.mouse.down();
    for (let i = 0; i <= 20; i++) await page.mouse.move(box.x + 120 + i * 8, box.y + 560);
    await page.mouse.up();
    await sleep(1700);
    await page.evaluate(() => window.yaprDev.active().setTool("eraser"));
    await sleep(100);
    await page.mouse.move(box.x + 200, box.y + 540);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + 580, { steps: 6 });
    await page.mouse.up();
    await sleep(300);
    await shot("stamp-signature-polygon");
    const kinds = await page.evaluate(() => {
      const st = window.yaprDev.active().annotations.getState();
      return Object.values(st.items)
        .filter((a) => !st.pristine[a.id])
        .map((a) => a.kind + (a.stampImage ? "(image)" : ""));
    });
    console.log("extras created", JSON.stringify(kinds));
    // Full-text search panel
    await page.keyboard.down("Control");
    await page.keyboard.down("Shift");
    await page.keyboard.press("f");
    await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
    await sleep(300);
    await page.keyboard.type("operating systems");
    await page.keyboard.press("Enter");
    await sleep(2000);
    await shot("search-panel");
    // Second tab, then close the first (unsaved) one → prompt.
    await page.evaluate(() => window.yaprDev.nextOpen("large.pdf"));
    await page.keyboard.down("Control");
    await page.keyboard.press("o");
    await page.keyboard.up("Control");
    await sleep(2000);
    await shot("two-tabs");
    await page.click(".tab:first-of-type .tab-close");
    await sleep(400);
    await shot("unsaved-prompt");
    await page.keyboard.press("Escape");
    // Read mode and presentation mode
    await page.keyboard.down("Control");
    await page.keyboard.press("h");
    await page.keyboard.up("Control");
    await sleep(500);
    await shot("read-mode");
    await page.keyboard.down("Control");
    await page.keyboard.press("h");
    await page.keyboard.up("Control");
    await page.keyboard.press("F5");
    await sleep(1200);
    await shot("presentation");
    await page.keyboard.press("ArrowRight");
    await sleep(600);
    await shot("presentation-next");
    await page.keyboard.press("Escape");
    await sleep(500);
  },

  async unsaved() {
    await openSample();
    await page.evaluate(() => {
      const c = window.yaprDev.active();
      const a = Object.values(c.annotations.getState().items)[0];
      c.updateAnnotation(a.id, { contents: "changed" });
    });
    await page.click(".tab .tab-close");
    await page.waitForSelector(".dialog");
    await sleep(300);
    const focus = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? document.activeElement?.tagName);
    console.log("focused in prompt:", focus);
    await page.keyboard.press("Escape");
    await sleep(300);
    const open = await page.$$eval(".dialog", (d) => d.length);
    if (open) throw new Error("Escape did not close the unsaved-changes prompt");
    const tabs = await page.$$eval(".tab", (t) => t.length);
    if (tabs !== 1) throw new Error("cancel must keep the tab open");
  },

  async large() {
    await openSample("large.pdf");
    await page.keyboard.press("End");
    await sleep(1500);
    await shot("large-last-page");
    const mem = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
    console.log("JS heap MB", Math.round(mem / 1e6));
  },

  async password() {
    await page.goto(URL, { waitUntil: "networkidle0" });
    await page.evaluate(() => window.yaprDev.nextOpen("encrypted.pdf"));
    await click(".start-actions .btn.primary");
    await page.waitForSelector(".dialog input[type=password]", { timeout: 10000 });
    await page.type(".dialog input[type=password]", "wrong");
    await page.keyboard.press("Enter");
    await sleep(800);
    await shot("password-wrong");
    await page.$eval(".dialog input", (el) => (el.value = ""));
    await page.type(".dialog input", "secret");
    await page.keyboard.press("Enter");
    await page.waitForSelector('.page[data-page-number="1"] canvas', { timeout: 10000 });
    await sleep(800);
    await shot("password-ok");
  },

  async help() {
    await openSample();
    await page.keyboard.press("F1");
    await page.waitForSelector(".help-view .help-block", { timeout: 5000 });
    await sleep(300);
    await shot("help-start");
    await page.type(".help-view .search-box input", "OCR");
    await sleep(300);
    await shot("help-search");
    await page.click(".help-view .search-box input", { clickCount: 3 });
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    const items = await page.$$(".help-view .settings-nav-item");
    await items[3].click();
    await sleep(300);
    await shot("help-pages");
    await items[7].click();
    await sleep(300);
    await shot("help-shortcuts");
    await items[9].click();
    await sleep(300);
    await shot("help-about");
    // Update check against GitHub (live).
    await page.click(".help-about ~ .help-block .btn.primary");
    await page.waitForSelector(".update-status:not(:has(.spin))", { timeout: 20000 }).catch(() => undefined);
    await sleep(500);
    await shot("update-check");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    // "Try it" buttons run the command and close the guide.
    await page.keyboard.press("F1");
    await page.waitForSelector(".help-view .help-cmd", { timeout: 5000 });
    const items2 = await page.$$(".help-view .settings-nav-item");
    await items2[3].click();
    await sleep(200);
    await page.click(".help-view .help-cmd");
    await page.waitForSelector(".organize", { timeout: 5000 });
    await sleep(300);
    await shot("help-try-organizer");
    await page.keyboard.press("Escape");
    // "What's new" after an update.
    await page.evaluate(() => {
      window.yaprDebug.setSetting("ui.lastSeenVersion", "0.1.0");
      window.yaprDebug.showWhatsNewAfterUpdate();
    });
    await page.waitForSelector(".whats-new", { timeout: 5000 });
    await sleep(300);
    await shot("whats-new");
    await page.keyboard.press("Escape");
  },

  async organize() {
    await openSample();
    await page.keyboard.down("Control");
    await page.keyboard.down("Shift");
    await page.keyboard.press("o");
    await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
    await page.waitForSelector(".organize .org-card", { timeout: 10000 });
    await sleep(1200);
    await shot("organize");
    // Multi-select with Ctrl+click, then the context menu.
    const cards = await page.$$(".org-card");
    await cards[1].click();
    await page.keyboard.down("Control");
    await cards[3].click();
    await page.keyboard.up("Control");
    await sleep(300);
    await cards[3].hover();
    await sleep(300);
    await shot("organize-selection");
    await cards[3].click({ button: "right" });
    await sleep(300);
    await shot("organize-menu");
    await page.keyboard.press("Escape");
    // Insert dialog from the toolbar.
    await page.click(".organize-actions .btn:first-child");
    await sleep(200);
    await page.click(".menu .menu-item:first-child");
    await page.waitForSelector(".dialog .drop-zone", { timeout: 5000 });
    await sleep(300);
    await shot("insert-files");
    await page.keyboard.press("Escape");
    // Watermark dialog with preview.
    await page.click(".organize-actions .btn:last-child");
    await page.waitForSelector(".wm-preview img", { timeout: 10000 });
    await sleep(500);
    await shot("watermark");
    await page.keyboard.press("Escape");
    // Split dialog.
    await page.click(".organize-actions .btn:nth-last-child(2)");
    await page.waitForSelector(".split-preview", { timeout: 5000 });
    await shot("split");
    await page.keyboard.press("Escape");
    await page.click(".organize-bar .btn.primary");
    await sleep(300);
    // Password protection dialog from the command palette.
    await page.keyboard.down("Control");
    await page.keyboard.down("Shift");
    await page.keyboard.press("p");
    await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
    await sleep(200);
    await page.keyboard.type("密码保护");
    await sleep(200);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".security-status", { timeout: 5000 });
    await sleep(500);
    await page.click(".security-section .checkbox input");
    await page.click(".security-section:nth-of-type(2) .checkbox input");
    await sleep(200);
    await page.type(".security-section .input-with-button input", "Secr3t!pass");
    await sleep(200);
    await shot("security");
    await page.keyboard.press("Escape");
  },
};

const run = wanted.length ? wanted : Object.keys(scenarios);
for (const name of run) {
  console.log(`--- ${name}`);
  try {
    await scenarios[name]();
  } catch (err) {
    errors.push(`scenario ${name} failed: ${err.stack ?? err}`);
    await shot(`${name}-failure`).catch(() => undefined);
  }
}
await browser.close();
if (errors.length) {
  console.log("\nERRORS:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("\nOK");
