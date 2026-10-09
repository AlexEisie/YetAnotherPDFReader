#!/usr/bin/env node
// Load PDFs with pdf.js (pdfjs-dist legacy build) and print the page count and every page's
// annotations, as the front-end would see them. Each page's operator list is also built with
// annotation appearances enabled, so broken appearance streams, fonts or images surface as
// pdf.js warnings/errors.
//
// Usage: node scripts/verify_with_pdfjs.mjs [--password=secret] [--json] [--render=dir] file.pdf ...
//   --render=dir  also rasterise every page (annotations included) to dir/<file>-p<N>.png
//                 (needs @napi-rs/canvas, which pdfjs-dist uses in Node).
// Exit code 1 when a file fails to load or pdf.js reports warnings.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
const load = (file) => import(pathToFileURL(path.join(pdfjsRoot, file)).href);
const { getDocument, AnnotationMode } = await load("legacy/build/pdf.mjs");
// Run the worker code in this thread ("fake worker") so its warnings reach the hooks below.
globalThis.pdfjsWorker = await load("legacy/build/pdf.worker.mjs");
// pdf.js wants factory directories with a trailing forward slash.
const dirUrl = (name) => path.join(pdfjsRoot, name).split(path.sep).join("/") + "/";

const args = process.argv.slice(2);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const json = args.includes("--json");
const password = option("password");
const renderDir = option("render");
const files = args.filter((a) => !a.startsWith("--"));
if (files.length === 0) {
  console.error("usage: verify_with_pdfjs.mjs [--password=...] [--json] [--render=dir] file.pdf ...");
  process.exit(2);
}

// pdf.js reports problems through console.warn / console.log ("Warning: ...").
const warnings = [];
const print = console.log.bind(console);
const capture = (fallback) => (...parts) => {
  const text = parts.join(" ");
  if (/^(Warning|Error)/.test(text)) warnings.push(text);
  else fallback(...parts);
};
console.log = capture(print);
console.warn = capture(console.error.bind(console));

const hex = (color) => (color ? "#" + Array.from(color, (c) => c.toString(16).padStart(2, "0")).join("") : null);
const round = (values) => (values ? Array.from(values, (v) => Math.round(v * 100) / 100) : null);

function describe(a) {
  return {
    id: a.id,
    subtype: a.subtype,
    rect: round(a.rect),
    color: hex(a.color),
    hasAppearance: a.hasAppearance,
    contents: a.contentsObj?.str ?? "",
    title: a.titleObj?.str ?? "",
    name: a.name ?? undefined,
    opacity: a.opacity,
    borderWidth: a.borderStyle?.width,
    quadPoints: a.quadPoints ? a.quadPoints.length / 8 : undefined,
    inkLists: a.inkLists ? a.inkLists.length : undefined,
    vertices: a.vertices ? a.vertices.length : undefined,
    lineCoordinates: a.lineCoordinates ? round(a.lineCoordinates) : undefined,
    popupRef: a.popupRef ?? undefined,
    parentRect: a.parentRect ? round(a.parentRect) : undefined,
    inReplyTo: a.inReplyTo ?? undefined,
    replyType: a.inReplyTo ? a.replyType : undefined,
    textContent: a.textContent ? a.textContent.join(" | ") : undefined,
    fontSize: a.defaultAppearanceData?.fontSize,
    richText: a.richText ? a.richText.str : undefined,
  };
}

async function render(doc, page, file, index) {
  const viewport = page.getViewport({ scale: 1.5 });
  const { canvas, context } = doc.canvasFactory.create(viewport.width, viewport.height);
  await page.render({ canvas, canvasContext: context, viewport, annotationMode: AnnotationMode.ENABLE }).promise;
  await mkdir(renderDir, { recursive: true });
  const out = path.join(renderDir, `${path.basename(file, ".pdf")}-p${index}.png`);
  await writeFile(out, canvas.toBuffer("image/png"));
  return out;
}

async function inspect(file) {
  const report = { file, pages: [] };
  const loadingTask = getDocument({
    data: new Uint8Array(await readFile(file)),
    password,
    cMapUrl: dirUrl("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: dirUrl("standard_fonts"),
    verbosity: 1,
    isEvalSupported: false,
  });
  try {
    const doc = await loadingTask.promise;
    report.numPages = doc.numPages;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const annotations = await page.getAnnotations({ intent: "display" });
      const ops = await page.getOperatorList({ annotationMode: AnnotationMode.ENABLE });
      report.pages.push({
        page: i,
        rotate: page.rotate,
        view: round(page.view),
        operators: ops.fnArray.length,
        annotations: annotations.map(describe),
        image: renderDir ? await render(doc, page, file, i) : undefined,
      });
    }
  } finally {
    await loadingTask.destroy();
  }
  return report;
}

function printReport(report) {
  print(`\n== ${report.file}`);
  if (report.error) {
    print(`  ERROR: ${report.error}`);
    return;
  }
  print(`  pages: ${report.numPages}`);
  const basic = ["id", "subtype", "rect", "color", "hasAppearance", "contents"];
  for (const p of report.pages) {
    print(`  page ${p.page} rotate=${p.rotate} view=[${p.view}] operators=${p.operators} annotations=${p.annotations.length}`);
    if (p.image) print(`    rendered: ${p.image}`);
    for (const a of p.annotations) {
      const extras = Object.entries(a)
        .filter(([k, v]) => v !== undefined && !basic.includes(k))
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ");
      print(`    ${a.id} ${a.subtype} rect=[${a.rect}] color=${a.color} ap=${a.hasAppearance} contents=${JSON.stringify(a.contents)} ${extras}`);
    }
  }
  for (const w of report.warnings) print(`  ${w}`);
}

let failed = false;
for (const file of files) {
  warnings.length = 0;
  let report;
  try {
    report = await inspect(file);
  } catch (err) {
    report = { file, error: String(err?.stack ?? err) };
  }
  report.warnings = [...warnings];
  failed ||= Boolean(report.error) || warnings.length > 0;
  if (json) print(JSON.stringify(report, null, 2));
  else printReport(report);
}
process.exit(failed ? 1 : 0);
