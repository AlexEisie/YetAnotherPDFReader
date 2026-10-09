/**
 * Narrow, accurately typed views of the pdf.js viewer classes we use. The shipped `.d.ts` files
 * of `pdfjs-dist/web` are generated from JSDoc and type many fields as `null`; these interfaces
 * describe the runtime shape we rely on (verified against pdfjs-dist 6.4).
 */
import type { PDFPageProxy, PageViewport } from "pdfjs-dist";

export interface PageColors {
  background: string;
  foreground: string;
}

export interface PageViewLike {
  id: number;
  div: HTMLDivElement;
  pdfPage: PDFPageProxy | null;
  viewport: PageViewport;
  renderingState: number;
  rotation: number;
  scale: number;
  pageLabel: string | null;
  imageCoordinates: Float32Array | null;
  pageColors: PageColors | null;
  reset(opts?: {
    keepAnnotationLayer?: boolean;
    keepAnnotationEditorLayer?: boolean;
    keepXfaLayer?: boolean;
    keepTextLayer?: boolean;
    keepCanvasWrapper?: boolean;
    preserveDetailViewState?: boolean;
  }): void;
  update(opts: { scale?: number; rotation?: number; drawingDelay?: number }): void;
}

export interface VisiblePage {
  id: number;
  x: number;
  y: number;
  percent: number;
  view: PageViewLike;
}

export interface ViewerLike {
  container: HTMLDivElement;
  viewer: HTMLDivElement;
  pagesCount: number;
  currentPageNumber: number;
  currentPageLabel: string | null;
  currentScale: number;
  currentScaleValue: string;
  pagesRotation: number;
  scrollMode: number;
  spreadMode: number;
  pageColors: PageColors | null;
  getPageView(index: number): PageViewLike | undefined;
  _getVisiblePages(): { first: VisiblePage | undefined; last: VisiblePage | undefined; views: VisiblePage[]; ids: Set<number> };
  _pages: PageViewLike[];
}

export const RenderingState = {
  INITIAL: 0,
  RUNNING: 1,
  PAUSED: 2,
  FINISHED: 3,
} as const;
