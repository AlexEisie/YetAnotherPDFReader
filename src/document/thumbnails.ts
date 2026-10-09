/**
 * Lazily rendered page thumbnails with a bounded LRU cache of JPEG object URLs (a few KB each),
 * so even documents with thousands of pages keep a small memory footprint.
 */
import { pdfjs, type PDFDocumentProxy } from "../pdf/pdfjs";
import { createLogger } from "../lib/log";

const log = createLogger("thumbnails");

export interface Thumbnail {
  url: string;
  width: number;
  height: number;
}

const MAX_CACHED = 240;
const CONCURRENCY = 2;

interface Job {
  page: number;
  resolve: (t: Thumbnail | null) => void;
}

export class ThumbnailService {
  private cache = new Map<string, Thumbnail>();
  private inflight = new Map<string, Promise<Thumbnail | null>>();
  private queue: Job[] = [];
  private running = 0;
  private generation = 0;
  private destroyed = false;

  constructor(
    private readonly getPdf: () => PDFDocumentProxy | null,
    /** Target thumbnail width in CSS pixels × device pixel ratio. */
    private readonly targetWidth: () => number,
    private readonly rotation: () => number,
    private readonly onRendered?: (page: number) => void,
  ) {}

  private key(page: number): string {
    return `${this.generation}:${page}:${this.rotation()}:${this.targetWidth()}`;
  }

  peek(page: number): Thumbnail | null {
    return this.cache.get(this.key(page)) ?? null;
  }

  request(page: number): Promise<Thumbnail | null> {
    const key = this.key(page);
    const hit = this.cache.get(key);
    if (hit) {
      // refresh LRU position
      this.cache.delete(key);
      this.cache.set(key, hit);
      return Promise.resolve(hit);
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const promise = new Promise<Thumbnail | null>((resolve) => {
      this.queue.push({ page, resolve });
      this.pump();
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  /** Drop queued work for pages that scrolled out of view. */
  cancelExcept(visible: Set<number>): void {
    const keep: Job[] = [];
    for (const job of this.queue) {
      if (visible.has(job.page)) keep.push(job);
      else job.resolve(null);
    }
    this.queue = keep;
  }

  private pump() {
    while (this.running < CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running++;
      this.render(job.page)
        .then(job.resolve, (err) => {
          log.warn(`thumbnail ${job.page} failed`, err);
          job.resolve(null);
        })
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  private async render(pageNumber: number): Promise<Thumbnail | null> {
    const pdf = this.getPdf();
    if (!pdf || this.destroyed) return null;
    const generation = this.generation;
    const key = this.key(pageNumber);
    const page = await pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1, rotation: (page.rotate + this.rotation()) % 360 });
    const scale = this.targetWidth() / base.width;
    const viewport = page.getViewport({ scale, rotation: (page.rotate + this.rotation()) % 360 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvas,
      canvasContext: ctx,
      viewport,
      intent: "display",
      annotationMode: pdfjs.AnnotationMode.ENABLE,
    }).promise;
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.82));
    canvas.width = canvas.height = 0;
    this.onRendered?.(pageNumber);
    if (!blob || this.destroyed || generation !== this.generation) return null;
    const thumb: Thumbnail = { url: URL.createObjectURL(blob), width: viewport.width, height: viewport.height };
    this.cache.set(key, thumb);
    this.evict();
    return thumb;
  }

  private evict() {
    while (this.cache.size > MAX_CACHED) {
      const [oldestKey, oldest] = this.cache.entries().next().value as [string, Thumbnail];
      URL.revokeObjectURL(oldest.url);
      this.cache.delete(oldestKey);
    }
  }

  /** Forget everything (document replaced, pages reordered, ...). */
  invalidate(): void {
    this.generation++;
    for (const t of this.cache.values()) URL.revokeObjectURL(t.url);
    this.cache.clear();
    for (const job of this.queue) job.resolve(null);
    this.queue = [];
  }

  destroy(): void {
    this.destroyed = true;
    this.invalidate();
  }
}

/** Render the first page as a tiny JPEG data URL for the recent-documents list. */
export async function renderCoverDataUrl(pdf: PDFDocumentProxy, width = 264): Promise<string | null> {
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
    const url = canvas.toDataURL("image/jpeg", 0.7);
    canvas.width = canvas.height = 0;
    return url;
  } catch (err) {
    log.debug("cover render failed", err);
    return null;
  }
}
