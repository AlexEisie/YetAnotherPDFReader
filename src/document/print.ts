/**
 * Printing: pages are rasterised at the chosen resolution into a hidden print container and
 * handed to the system print dialog (`window.print()`), which provides printer selection,
 * copies, duplex, scaling, "Microsoft Print to PDF", etc.
 *
 * When comments are printed and the document has unsaved changes, the current state is first
 * built into a temporary PDF (exactly what would be saved) so the printout matches the screen.
 */
import { pdfjs, getSharedWorker, type PDFDocumentProxy } from "../pdf/pdfjs";
import type { DocumentController } from "./DocumentController";
import { AppError, cancelled } from "../lib/errors";
import { createLogger } from "../lib/log";

export { formatPageRange, parsePageRange } from "./pageRange";

const log = createLogger("print");

export interface PrintOptions {
  /** 1-based page numbers in print order. */
  pages: number[];
  dpi: number;
  annotations: boolean;
}

let printing = false;

export async function printDocument(
  controller: DocumentController,
  opts: PrintOptions,
  onProgress: (done: number, total: number) => void,
  signal: AbortSignal,
): Promise<void> {
  if (printing) return;
  const pdf = controller.pdf;
  if (!pdf) throw new AppError("INTERNAL", "no document");
  printing = true;
  let source: PDFDocumentProxy = pdf;
  let temp: PDFDocumentProxy | null = null;
  const container = document.createElement("div");
  container.id = "printContainer";
  const pageStyle = document.createElement("style");
  const urls: string[] = [];
  try {
    const dirty = controller.isDirty;
    if (opts.annotations && dirty) {
      const bytes = await controller.buildCurrentBytes();
      temp = await pdfjs.getDocument({ data: bytes, password: controller.documentPassword ?? undefined, worker: getSharedWorker() })
        .promise;
      source = temp;
    }
    const first = await source.getPage(opts.pages[0]);
    const firstVp = first.getViewport({ scale: 1 });
    pageStyle.textContent = `@page { size: ${firstVp.width}pt ${firstVp.height}pt; margin: 0; }`;
    document.head.append(pageStyle);
    document.body.append(container);

    const scale = opts.dpi / 72;
    for (let i = 0; i < opts.pages.length; i++) {
      if (signal.aborted) throw cancelled();
      onProgress(i, opts.pages.length);
      const page = await source.getPage(opts.pages[i]);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new AppError("PRINT_ERROR", "canvas unavailable");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({
        canvas,
        canvasContext: ctx,
        viewport,
        intent: "print",
        annotationMode: opts.annotations ? pdfjs.AnnotationMode.ENABLE_STORAGE : pdfjs.AnnotationMode.DISABLE,
        printAnnotationStorage: opts.annotations && !temp ? pdf.annotationStorage.print : undefined,
      }).promise;
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
      canvas.width = canvas.height = 0;
      page.cleanup();
      if (!blob) throw new AppError("PRINT_ERROR", `page ${opts.pages[i]} could not be rasterised`);
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const wrapper = document.createElement("div");
      wrapper.className = "printedPage";
      const img = document.createElement("img");
      img.src = url;
      wrapper.append(img);
      container.append(wrapper);
      await img.decode().catch(() => undefined);
    }
    onProgress(opts.pages.length, opts.pages.length);
    if (signal.aborted) throw cancelled();
    // Give the layout a frame before opening the dialog.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    window.print();
  } catch (err) {
    log.error("print failed", err);
    throw err;
  } finally {
    container.remove();
    pageStyle.remove();
    for (const url of urls) URL.revokeObjectURL(url);
    await temp?.loadingTask.destroy().catch(() => undefined);
    printing = false;
  }
}
