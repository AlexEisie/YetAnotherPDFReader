/**
 * Screenshots for the README (docs/images/<lang>/), taken from the browser build with the mocked
 * backend and the generated demo document.
 *
 *   python scripts/make-demo-pdf.py     # dev/samples/demo.pdf
 *   npm run dev                         # in another terminal
 *   node scripts/readme-shots.mjs [zh-CN|en ...]
 */
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const URL = process.env.YAPR_URL ?? "http://localhost:5174/";
const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const langs = process.argv.slice(2).length ? process.argv.slice(2) : ["zh-CN", "en"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: BROWSERS.find((p) => existsSync(p)),
  headless: true,
  args: ["--disable-gpu-sandbox", "--font-render-hinting=none"],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (err) => errors.push(err.message));

let out = "";
let lang = "";
const shot = async (name, clip) => {
  await sleep(350);
  await page.screenshot({ path: join(out, `${name}.png`), clip });
  console.log(lang, name);
};
const cmd = (fn, ...args) => page.evaluate(fn, ...args);
const setSetting = (path, value) => cmd((p, v) => window.yaprDev.setSetting(p, v), path, value);
const setUi = (patch) => cmd((p) => window.yaprDev.setUi(p), patch);
const active = (fn, ...args) => cmd((src, a) => new Function("c", "args", src)(window.yaprDev.active(), a), `return (${fn})(c, args)`, args);

async function boot(settings, files = ["demo.pdf"]) {
  await page.goto(URL, { waitUntil: "networkidle0" });
  await cmd((s) => {
    localStorage.clear();
    localStorage.setItem("yapr-store:settings", JSON.stringify(s));
  }, settings);
  await page.reload({ waitUntil: "networkidle0" });
  for (const f of files) {
    await cmd((n) => window.yaprDev.nextOpen(n), f);
    const home = await page.$(".start-actions .btn.primary");
    if (home) await home.click();
    else {
      await page.keyboard.down("Control");
      await page.keyboard.press("o");
      await page.keyboard.up("Control");
    }
    await page.waitForFunction((n) => window.yaprDev.active()?.state.fileName === n && window.yaprDev.active()?.annotations.getState().loaded, { timeout: 20000 }, f);
    await page.waitForSelector('.page[data-page-number="1"] canvas', { timeout: 20000 });
  }
  await sleep(900);
}

async function pageBox(n) {
  return page.$eval(`.page[data-page-number="${n}"]`, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
}

/** Select `text` inside page `n`'s text layer and return true when found. */
async function selectText(n, text) {
  return cmd(
    (n, text) => {
      const layer = document.querySelector(`.page[data-page-number="${n}"] .textLayer`);
      if (!layer) return false;
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const i = node.data.indexOf(text);
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + text.length);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return true;
      }
      return false;
    },
    n,
    text,
  );
}

async function drag(from, to, steps = 8) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
  await sleep(200);
}

/** Comments used by several screenshots (page 2 of the demo). */
async function annotate(zh) {
  await active((c) => c.goToPage(2));
  await sleep(700);
  if (await selectText(2, "持续、规范的记录比单次的")) await active((c) => c.setTool("highlight"));
  await sleep(300);
  if (await selectText(2, "至少二十分钟")) await active((c) => c.setTool("underline"));
  await sleep(300);
  await active((c) => c.setTool("select"));
  const b = await pageBox(2);
  const sx = b.w / 595;
  // Rectangle around the picture, ink tick, arrow and a sticky note.
  await active((c) => c.setTool("square"));
  await drag([b.x + 60 * sx, b.y + 430 * sx], [b.x + 535 * sx, b.y + 700 * sx]);
  await active((c) => c.setTool("arrow"));
  await drag([b.x + 560 * sx, b.y + 330 * sx], [b.x + 470 * sx, b.y + 420 * sx]);
  await active((c) => c.setTool("note"));
  await page.mouse.click(b.x + 548 * sx, b.y + 120 * sx);
  await sleep(500);
  await page.keyboard.type(zh ? "这段可以补充一张光污染对比图。" : "Add a light-pollution comparison here?");
  await page.keyboard.press("Escape");
  await active((c) => c.setTool("ink"));
  await page.mouse.move(b.x + 470 * sx, b.y + 300 * sx);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) await page.mouse.move(b.x + (470 + i * 3) * sx, b.y + (300 + Math.sin(i / 2.5) * 6) * sx);
  await page.mouse.up();
  await active((c) => c.setTool("select"));
  await page.keyboard.press("Escape");
  await sleep(400);
}

async function pageBackground(mode) {
  await setSetting("pageColors.mode", mode);
  await sleep(900);
}

for (lang of langs) {
  const zh = lang.startsWith("zh");
  out = resolve("docs/images", zh ? "zh" : "en");
  mkdirSync(out, { recursive: true });
  const base = { general: { language: lang }, appearance: { theme: "dark", showMenuBar: true } };

  // 1. Hero: dark theme, thumbnails, comments pane, annotations.
  await boot(base);
  await annotate(zh);
  await active((c) => c.setSidebar(true, "thumbnails"));
  await setUi({ commentsPane: true });
  await active((c) => c.goToPage(2));
  await shot("hero");

  // 2. Comment tools with a note popup.
  await page.keyboard.press("c");
  await sleep(300);
  await setUi({ commentsPane: false });
  await active((c) => c.setSidebar(false));
  await active((c) => c.setZoom(1.1));
  await sleep(500);
  await active((c) => {
    const st = c.annotations.getState();
    const note = Object.values(st.items).find((a) => a.kind === "note" && !st.pristine[a.id]);
    c.goToPage(2);
    if (note) {
      c.select([note.id]);
      c.setEditing(note.id);
    }
  });
  await sleep(600);
  await shot("annotations");
  await page.keyboard.press("Escape");

  // 3. Light theme with the outline.
  await boot({ ...base, appearance: { theme: "light", showMenuBar: true } });
  await active((c) => c.setSidebar(true, "outline"));
  await active((c) => c.goToPage(3));
  await shot("light");

  // 4. Page colour modes: page 2 cropped out of the window for each mode.
  await boot(base);
  await active((c) => c.setZoom("page-fit"));
  await active((c) => c.goToPage(2));
  await sleep(800);
  for (const mode of ["normal", "dark", "night", "sepia", "green"]) {
    await pageBackground(mode);
    const b = await pageBox(2);
    await shot(`mode-${mode}`, { x: Math.round(b.x), y: Math.max(110, Math.round(b.y)), width: Math.round(b.w), height: Math.min(Math.round(b.h), 760) });
  }
  await pageBackground("normal");

  // 5. Snapshot: drag around section 4 and its chart on page 3.
  await active((c) => c.setZoom(1.1));
  await active((c) => c.goToPage(3));
  await sleep(800);
  const rectOf = (text) =>
    cmd((text) => {
      const spans = [...document.querySelectorAll('.page[data-page-number="3"] .textLayer span')];
      const el = spans.find((s) => s.textContent.includes(text));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, b: r.bottom };
    }, text);
  let head = await rectOf("4. ");
  await cmd((dy) => document.querySelector(".yapr-scroll").scrollBy(0, dy), (head?.y ?? 300) - 190);
  await sleep(600);
  head = await rectOf("4. ");
  const caption = await rectOf("图 2");
  const b3 = await pageBox(3);
  await active((c) => c.startSnapshot());
  await sleep(300);
  await page.mouse.move(b3.x + b3.w * 0.09, head.y - 14);
  await page.mouse.down();
  await page.mouse.move(b3.x + b3.w * 0.91, (caption?.b ?? head.y + 520) + 10, { steps: 8 });
  await shot("snapshot");
  await page.mouse.up();
  await sleep(900);
  await shot("snapshot-done");
  await setUi({ toasts: [] });

  // 6. Command palette and settings.
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("p");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await sleep(300);
  await page.keyboard.type(zh ? "页面" : "page");
  await shot("palette");
  await page.keyboard.press("Escape");
  await page.keyboard.down("Control");
  await page.keyboard.press(",");
  await page.keyboard.up("Control");
  await sleep(500);
  const nav = await page.$$(".settings-nav-item");
  if (nav[2]) await nav[2].click();
  await sleep(300);
  await page.click(".setting-row.link").catch(() => {});
  await shot("settings");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // 7. Start page with recent documents.
  await boot(base, ["sample.pdf", "demo.pdf"]);
  await page.click(".tabbar .home-btn");
  await sleep(800);
  await shot("start");
}

// ------------------------------------------------------------------------------- compositions

const dataUrl = (file) => `data:image/png;base64,${readFileSync(file).toString("base64")}`;
const TEXT = {
  "zh-CN": {
    modes: ["正常", "深色（反色）", "夜间（图片保持原色）", "棕褐色", "护眼绿"],
    tagline: "快速、轻量、开源的桌面 PDF 阅读器",
    chips: ["Rust + Tauri 2", "多标签阅读", "批注与签名", "夜间阅读", "框选截图", "9 种界面语言"],
  },
  en: {
    modes: ["Normal", "Dark (inverted)", "Night (natural images)", "Sepia", "Eye-care green"],
    tagline: "A fast, lightweight, open-source desktop PDF reader",
    chips: ["Rust + Tauri 2", "Tabs", "Comments & signatures", "Night reading", "Region snapshots", "9 UI languages"],
  },
};
const icon = readFileSync("src-tauri/icons/app-icon.svg", "utf8");
for (lang of langs) {
  const dir = resolve("docs/images", lang.startsWith("zh") ? "zh" : "en");
  out = dir;
  const tx = TEXT[lang] ?? TEXT.en;
  const font = `font-family: "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif;`;

  // Page colour modes side by side.
  const modes = ["normal", "dark", "night", "sepia", "green"];
  await page.setViewport({ width: 1600, height: 560, deviceScaleFactor: 1 });
  await page.setContent(`<body style="margin:0;background:#1b1c20;${font}">
    <div style="display:flex;gap:18px;padding:22px 24px;justify-content:center">
    ${modes
      .map(
        (m, i) => `<figure style="margin:0;text-align:center;color:#e8e8ec;font-size:16px">
          <img src="${dataUrl(join(dir, `mode-${m}.png`))}" style="width:290px;height:430px;object-fit:cover;object-position:top;border-radius:8px;box-shadow:0 6px 24px #0008">
          <figcaption style="margin-top:12px">${tx.modes[i]}</figcaption></figure>`,
      )
      .join("")}</div></body>`);
  await sleep(300);
  await page.screenshot({ path: join(dir, "modes.png"), clip: { x: 0, y: 0, width: 1600, height: 520 } });
  for (const m of modes) rmSync(join(dir, `mode-${m}.png`));
  console.log(lang, "modes");

  // Cover banner (also usable as the GitHub social preview, 1280×640).
  await page.setViewport({ width: 1280, height: 640, deviceScaleFactor: 1 });
  await page.setContent(`<body style="margin:0;width:1280px;height:640px;overflow:hidden;${font}
      background:radial-gradient(1200px 600px at 0% 0%, #3a1d2a 0%, #1b1c22 55%, #141519 100%);color:#f4f4f6;position:relative">
    <div style="position:absolute;left:64px;top:120px;width:500px">
      <div style="width:96px;height:96px">${icon.replace(/width="1024" height="1024"/, 'width="96" height="96"')}</div>
      <div style="font-size:46px;font-weight:700;margin-top:26px;letter-spacing:-0.5px">YetAnotherPDFReader</div>
      <div style="font-size:21px;color:#c9cad3;margin-top:12px;line-height:1.5">${tx.tagline}</div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:30px">
        ${tx.chips.map((c) => `<span style="padding:7px 14px;border-radius:999px;background:#ffffff14;border:1px solid #ffffff22;font-size:15px;color:#e6e6ea">${c}</span>`).join("")}
      </div>
    </div>
    <img src="${dataUrl(join(dir, "hero.png"))}" style="position:absolute;left:600px;top:70px;width:860px;border-radius:12px;
      box-shadow:0 30px 80px #000c, 0 0 0 1px #ffffff1a">
  </body>`);
  await sleep(400);
  await page.screenshot({ path: join(dir, "banner.png") });
  console.log(lang, "banner");
}

await browser.close();
if (errors.length) {
  console.log("page errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("OK");
