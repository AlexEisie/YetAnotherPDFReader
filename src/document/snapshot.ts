/**
 * Snapshot tool: render a rectangular page region to an image and put it on the clipboard.
 *
 * The region is rendered again from the PDF (not grabbed from the screen), so the image is
 * sharp at any resolution. When comments are included and there are unsaved annotation
 * changes, the current state is first built into a temporary PDF so the image matches what
 * is on screen (the same approach as printing).
 */
import { save } from "@tauri-apps/plugin-dialog";
import { pdfjs, getSharedWorker, type PDFDocumentProxy } from "../pdf/pdfjs";
import { t } from "../i18n";
import { api } from "../lib/ipc";
import { toAppError } from "../lib/errors";
import { createLogger } from "../lib/log";
import { settings } from "../settings/store";
import { toast } from "../state/ui";
import { pageColorStyle } from "./pageColors";
import type { DocumentController } from "./DocumentController";

const log = createLogger("snapshot");

type Rect = [number, number, number, number];

/** Limits that keep a snapshot well inside canvas and clipboard limits. */
const MAX_SIDE = 16384;
const MAX_PIXELS = 40_000_000;
/** How long "Save as image…" stays available after a capture. */
const SAVE_WINDOW_MS = 8000;

let busy = false;

/** Output pixels per PDF unit for the current resolution setting. */
export function snapshotScale(c: DocumentController, pageNumber: number): number {
  const res = settings().snapshot.resolution;
  if (res !== "screen") return Number(res) / 72;
  const css = c.layers?.pageView(pageNumber)?.viewport.scale ?? c.state.scale;
  return css * (window.devicePixelRatio || 1);
}

/** Intersect `rect` with the page box; `null` when nothing is left. */
export function clampToPage(rect: Rect, view: number[]): Rect | null {
  const r: Rect = [
    Math.max(Math.min(rect[0], rect[2]), view[0]),
    Math.max(Math.min(rect[1], rect[3]), view[1]),
    Math.min(Math.max(rect[0], rect[2]), view[2]),
    Math.min(Math.max(rect[1], rect[3]), view[3]),
  ];
  return r[2] - r[0] >= 1 && r[3] - r[1] >= 1 ? r : null;
}

/** Image size in pixels and the scale actually used (reduced for huge regions). */
export function snapshotSize(rect: Rect, scale: number): { width: number; height: number; scale: number } {
  const w = Math.abs(rect[2] - rect[0]) * scale;
  const h = Math.abs(rect[3] - rect[1]) * scale;
  const shrink = Math.min(1, MAX_SIDE / Math.max(w, h, 1), Math.sqrt(MAX_PIXELS / Math.max(w * h, 1)));
  const round = shrink < 1 ? Math.floor : Math.round;
  return { width: Math.max(1, round(w * shrink)), height: Math.max(1, round(h * shrink)), scale: scale * shrink };
}

function canvas2d(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!ctx) throw new Error("canvas unavailable");
  return [canvas, ctx];
}

/** Apply the current page colour mode (dark, sepia, …) like the viewer does with CSS. */
function applyPageColors(source: HTMLCanvasElement): HTMLCanvasElement {
  const style = pageColorStyle(settings().pageColors, document.documentElement.dataset.theme === "dark");
  if (style.mode === "normal" && style.filter === "none") return source;
  const [out, ctx] = canvas2d(source.width, source.height);
  ctx.filter = style.filter;
  ctx.drawImage(source, 0, 0);
  ctx.filter = "none";
  if (style.tint) {
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = style.tint;
    ctx.fillRect(0, 0, out.width, out.height);
  }
  source.width = source.height = 0;
  return out;
}

/** Rendering overrides (OCR renders at its own resolution, without comments or page colours). */
export interface RegionOptions {
  /** Output pixels per PDF unit. */
  scale?: number;
  annotations?: boolean;
  pageColors?: boolean;
}

/** Render `rect` (PDF user space) of a page to a canvas, or null when the region is empty. */
export async function renderRegion(c: DocumentController, pdf: PDFDocumentProxy, pageIndex: number, rect: Rect, options: RegionOptions = {}): Promise<HTMLCanvasElement | null> {
  const s = settings();
  const withComments = (options.annotations ?? s.snapshot.annotations) && s.annotations.showAnnotations;
  let temp: PDFDocumentProxy | null = null;
  try {
    let source = pdf;
    if (withComments && c.state.history.dirty) {
      const bytes = await c.buildCurrentBytes();
      temp = await pdfjs.getDocument({ data: bytes, password: c.documentPassword ?? undefined, worker: getSharedWorker() }).promise;
      source = temp;
    }
    const page = await source.getPage(pageIndex + 1);
    const region = clampToPage(rect, page.view);
    if (!region) return null;
    const size = snapshotSize(region, options.scale ?? snapshotScale(c, pageIndex + 1));
    const viewport = page.getViewport({ scale: size.scale, rotation: (page.rotate + c.state.rotation) % 360 });
    const [ax, ay] = viewport.convertToViewportPoint(region[0], region[1]);
    const [bx, by] = viewport.convertToViewportPoint(region[2], region[3]);
    const [canvas, ctx] = canvas2d(size.width, size.height);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvas,
      canvasContext: ctx,
      viewport,
      transform: [1, 0, 0, 1, -Math.min(ax, bx), -Math.min(ay, by)],
      annotationMode: withComments ? pdfjs.AnnotationMode.ENABLE_STORAGE : pdfjs.AnnotationMode.DISABLE,
    }).promise;
    page.cleanup();
    return (options.pageColors ?? s.snapshot.pageColors) ? applyPageColors(canvas) : canvas;
  } finally {
    await temp?.loadingTask.destroy().catch(() => undefined);
  }
}

async function writeClipboard(canvas: HTMLCanvasElement): Promise<void> {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  await api.clipboardWriteImage(canvas.width, canvas.height, new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
}

function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i > 0 ? path.slice(0, i + 1) : "";
}

async function saveImage(c: DocumentController, canvas: HTMLCanvasElement, pageNumber: number): Promise<void> {
  try {
    const base = c.state.fileName.replace(/\.pdf$/i, "") || "snapshot";
    const target = await save({
      defaultPath: `${dirname(c.filePath)}${base}-p${pageNumber}.png`,
      filters: [{ name: "PNG", extensions: ["png"] }],
      title: t("snapshot.saveAs"),
    });
    if (!target) return;
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (!blob) throw new Error("PNG encoding failed");
    await api.fsWrite(target, new Uint8Array(await blob.arrayBuffer()));
    toast("success", t("snapshot.saved", { path: target }));
  } catch (err) {
    log.error("saving the snapshot failed", err);
    toast("error", t("snapshot.saveFailed"), { detail: toAppError(err).message });
  }
}

/** Capture `rect` (PDF user space) of a page and copy it to the clipboard as an image. */
export async function captureRegion(c: DocumentController, pageIndex: number, rect: Rect): Promise<void> {
  const pdf = c.pdf;
  if (!pdf || busy) return;
  busy = true;
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = await renderRegion(c, pdf, pageIndex, rect);
    if (!canvas) return;
    await writeClipboard(canvas);
    const image = canvas;
    canvas = null;
    let released = false;
    const release = () => {
      if (!released) image.width = image.height = 0;
      released = true;
    };
    // Keep the image for "Save as" while the toast is visible, then free it.
    const timer = window.setTimeout(release, SAVE_WINDOW_MS + 500);
    toast("success", t("toast.snapshot"), {
      detail: t("snapshot.size", { width: image.width, height: image.height }),
      timeout: SAVE_WINDOW_MS,
      action: {
        label: t("snapshot.saveAs"),
        run: () => {
          window.clearTimeout(timer);
          void saveImage(c, image, pageIndex + 1).finally(release);
        },
      },
    });
  } catch (err) {
    log.error("snapshot failed", err);
    toast("error", t("snapshot.failed"), { detail: toAppError(err).message });
  } finally {
    if (canvas) canvas.width = canvas.height = 0;
    busy = false;
  }
}
