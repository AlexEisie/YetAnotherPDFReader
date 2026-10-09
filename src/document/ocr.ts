/**
 * Text recognition (OCR) with the bundled PaddleOCR engine:
 *
 * - recognise the text of a dragged region (shown in a dialog to copy),
 * - make whole pages searchable by writing an invisible text layer,
 * - detect scanned documents (pages without text) to suggest OCR.
 */
import type { OcrLine, TextLayerPage } from "../annotations/dto";
import { api } from "../lib/ipc";
import { cancelled } from "../lib/errors";
import { currentLocale, t } from "../i18n";
import { renderRegion } from "./snapshot";
import type { DocumentController } from "./DocumentController";

type Rect = [number, number, number, number];

/** Resolutions offered for OCR (dpi). 200 is a good balance of accuracy and speed. */
export const OCR_DPI = [150, 200, 300] as const;
export type OcrDpi = (typeof OCR_DPI)[number];

/** Region OCR renders at least this resolution (small text needs pixels). */
const REGION_DPI = 220;
/** Pages larger than this are rendered at a lower resolution (memory and speed). */
const MAX_PAGE_PIXELS = 24_000_000;

function pixels(canvas: HTMLCanvasElement): Uint8Array {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas unavailable");
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

const isWide = (s: string) => /[⺀-鿿가-힯豈-﫿＀-￯]/.test(s);

/**
 * Join recognised lines into plain text: boxes that share a row are joined with a space
 * (none between CJK characters), rows become lines.
 */
export function linesToText(lines: OcrLine[]): string {
  const box = (l: OcrLine) => {
    const ys = l.points.map((p) => p[1]);
    const xs = l.points.map((p) => p[0]);
    return { top: Math.min(...ys), bottom: Math.max(...ys), left: Math.min(...xs) };
  };
  const rows: { top: number; bottom: number; items: { left: number; text: string }[] }[] = [];
  for (const line of lines) {
    const b = box(line);
    const height = b.bottom - b.top;
    const row = rows.find((r) => Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top) > 0.5 * Math.min(height, r.bottom - r.top));
    if (row) {
      row.items.push({ left: b.left, text: line.text });
      row.top = Math.min(row.top, b.top);
      row.bottom = Math.max(row.bottom, b.bottom);
    } else {
      rows.push({ top: b.top, bottom: b.bottom, items: [{ left: b.left, text: line.text }] });
    }
  }
  rows.sort((a, b) => a.top - b.top);
  return rows
    .map((r) =>
      r.items
        .sort((a, b) => a.left - b.left)
        .reduce((text, item) => {
          if (!text) return item.text;
          const joint = isWide(text.slice(-1)) && isWide(item.text[0]) ? "" : " ";
          return text + joint + item.text;
        }, ""),
    )
    .join("\n");
}

export interface RegionText {
  text: string;
  lines: number;
  /** Mean confidence 0..1 (0 when nothing was found). */
  confidence: number;
}

/** Recognise the text in `rect` (PDF user space) of a page. */
export async function recognizeRegion(c: DocumentController, pageIndex: number, rect: Rect): Promise<RegionText> {
  const pdf = c.pdf;
  if (!pdf) return { text: "", lines: 0, confidence: 0 };
  const canvas = await renderRegion(c, pdf, pageIndex, rect, { scale: REGION_DPI / 72, annotations: false, pageColors: false });
  if (!canvas) return { text: "", lines: 0, confidence: 0 };
  try {
    const lines = await api.ocrRecognize(canvas.width, canvas.height, pixels(canvas));
    const confidence = lines.length ? lines.reduce((s, l) => s + l.confidence, 0) / lines.length : 0;
    return { text: linesToText(lines), lines: lines.length, confidence };
  } finally {
    canvas.width = canvas.height = 0;
  }
}

/** Whether a page already has (real) text. */
export async function pageHasText(c: DocumentController, pageNumber: number): Promise<boolean> {
  const page = await c.pdf?.getPage(pageNumber);
  if (!page) return false;
  const content = await page.getTextContent();
  const chars = content.items.reduce((n, item) => n + ("str" in item ? item.str.trim().length : 0), 0);
  return chars >= 8;
}

/** Heuristic: the first pages have no text at all, so the document is probably scanned. */
export async function looksScanned(c: DocumentController): Promise<boolean> {
  const n = Math.min(3, c.pdf?.numPages ?? 0);
  if (!n) return false;
  for (let p = 1; p <= n; p++) {
    if (await pageHasText(c, p)) return false;
  }
  return true;
}

/** Recognise one page and convert the lines to PDF user space. */
export async function recognizePage(c: DocumentController, pageNumber: number, dpi: OcrDpi): Promise<TextLayerPage> {
  const page = await c.pdf!.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(dpi / 72, Math.sqrt(MAX_PAGE_PIXELS / (base.width * base.height)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!ctx) throw new Error("canvas unavailable");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  try {
    // Comments are not part of the page content: leave them out of the text layer.
    await page.render({ canvas, canvasContext: ctx, viewport, annotationMode: 0 }).promise;
    const lines = await api.ocrRecognize(canvas.width, canvas.height, pixels(canvas));
    return {
      page: pageNumber - 1,
      lines: lines.map((l) => {
        // Image pixels → PDF user space (handles /Rotate and the crop box).
        const q = l.points.flatMap(([x, y]) => viewport.convertToPdfPoint(x, y)) as TextLayerPage["lines"][number]["quad"];
        return { text: l.text, quad: q };
      }),
    };
  } finally {
    canvas.width = canvas.height = 0;
    page.cleanup();
  }
}

export interface OcrProgress {
  done: number;
  total: number;
  page: number;
  skipped: number;
}

/**
 * Recognise `pages` (1-based) and add their text as one undoable step. Pages that already
 * contain text are skipped when `skipText` is set. Returns the number of pages that got text.
 */
export async function ocrPages(
  c: DocumentController,
  pages: number[],
  options: { dpi: OcrDpi; skipText: boolean },
  onProgress: (p: OcrProgress) => void,
  signal: AbortSignal,
): Promise<{ recognized: number; skipped: number; lines: number }> {
  const layers: TextLayerPage[] = [];
  let skipped = 0;
  for (let i = 0; i < pages.length; i++) {
    if (signal.aborted) throw cancelled("OCR cancelled");
    const page = pages[i];
    onProgress({ done: i, total: pages.length, page, skipped });
    if (options.skipText && (await pageHasText(c, page))) {
      skipped++;
      continue;
    }
    const layer = await recognizePage(c, page, options.dpi);
    if (layer.lines.length) layers.push(layer);
  }
  if (signal.aborted) throw cancelled("OCR cancelled");
  onProgress({ done: pages.length, total: pages.length, page: pages[pages.length - 1] ?? 0, skipped });
  const lines = layers.reduce((n, l) => n + l.lines.length, 0);
  if (layers.length) await c.applyPageOps([{ op: "textLayer", pages: layers, cjkHint: currentLocale() }], [], t("ocr.history"));
  return { recognized: layers.length, skipped, lines };
}
