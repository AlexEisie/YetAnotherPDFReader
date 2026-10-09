/**
 * Per-page overlay layers hosted inside pdf.js page views.
 *
 * pdf.js owns the page DOM and freely removes unknown children when it resets a page (zoom,
 * rotation, eviction from its render buffer). The manager keeps one persistent set of layer
 * elements per page and re-attaches them after every reset / render, so React portals mounted
 * into them survive.
 *
 * Layer stacking inside `div.page` (bottom → top):
 *   canvasWrapper [canvas, markup layer (multiply), content layer]  — page-color filters apply here
 *   image-restore layer (re-inverts images in "night" mode)
 *   textLayer, annotationLayer (pdf.js)
 *   ui layer (hit targets, selection handles, drafts)
 */
import { RenderingState, type PageViewLike, type ViewerLike } from "../pdf/viewerTypes";

export interface PageLayers {
  pageNumber: number;
  markup: HTMLDivElement;
  content: HTMLDivElement;
  restore: HTMLDivElement;
  ui: HTMLDivElement;
}

type PatchedPageView = PageViewLike & { __yaprPatched?: boolean };

function makeLayer(className: string): HTMLDivElement {
  const div = document.createElement("div");
  div.className = className;
  return div;
}

export class PageLayerManager {
  private layers = new Map<number, PageLayers>();
  private active = new Set<number>();
  private listeners = new Set<() => void>();
  private snapshot: number[] = [];
  private pendingEmit = false;

  constructor(private readonly viewer: ViewerLike) {}

  /** Wrap `reset` of every page view so layers are re-attached right after pdf.js clears a page. */
  patchPageViews(): void {
    for (let i = 0; i < this.viewer.pagesCount; i++) {
      const view = this.viewer.getPageView(i) as PatchedPageView | undefined;
      if (!view || view.__yaprPatched) continue;
      const original = view.reset.bind(view);
      view.reset = (opts) => {
        original(opts);
        if (!opts?.keepCanvasWrapper && this.active.delete(view.id)) this.scheduleEmit();
        // Only pages that were rendered before own layers; others get them on "pagerender".
        if (this.layers.has(view.id)) this.attach(view);
      };
      view.__yaprPatched = true;
    }
  }

  get(pageNumber: number): PageLayers {
    let set = this.layers.get(pageNumber);
    if (!set) {
      set = {
        pageNumber,
        markup: makeLayer("yapr-layer yapr-markup-layer"),
        content: makeLayer("yapr-layer yapr-content-layer"),
        restore: makeLayer("yapr-layer yapr-restore-layer"),
        ui: makeLayer("yapr-layer yapr-ui-layer"),
      };
      set.ui.dataset.pageNumber = String(pageNumber);
      this.layers.set(pageNumber, set);
    }
    return set;
  }

  /** Ensure the layer elements of `view` are in place. Cheap when nothing changed. */
  attach(view: PageViewLike): void {
    const set = this.get(view.id);
    const div = view.div;
    const wrapper = div.querySelector<HTMLDivElement>(":scope > .canvasWrapper");
    if (wrapper) {
      if (set.markup.parentElement !== wrapper) wrapper.append(set.markup);
      if (set.content.parentElement !== wrapper) wrapper.append(set.content);
      if (set.restore.previousElementSibling !== wrapper) wrapper.after(set.restore);
    }
    if (div.lastElementChild !== set.ui) div.append(set.ui);
  }

  /** Called on pdf.js "pagerender": the page is (re)drawn and must show annotations. */
  onPageRender(view: PageViewLike): void {
    this.attach(view);
    if (!this.active.has(view.id)) {
      this.active.add(view.id);
      this.scheduleEmit();
    }
  }

  /** Drop pages that pdf.js evicted from its buffer. */
  prune(): void {
    let changed = false;
    for (const page of this.active) {
      const view = this.viewer.getPageView(page - 1);
      if (!view || view.renderingState === RenderingState.INITIAL) {
        this.active.delete(page);
        changed = true;
      }
    }
    if (changed) this.scheduleEmit();
  }

  /** Page numbers whose overlays should currently be rendered, ascending. */
  activePages(): number[] {
    return this.snapshot;
  }

  pageView(pageNumber: number): PageViewLike | undefined {
    return this.viewer.getPageView(pageNumber - 1);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private scheduleEmit() {
    if (this.pendingEmit) return;
    this.pendingEmit = true;
    queueMicrotask(() => {
      this.pendingEmit = false;
      this.snapshot = [...this.active].sort((a, b) => a - b);
      for (const l of this.listeners) l();
    });
  }

  /** Re-attach every known layer (after the layout changed). */
  reattachAll(): void {
    for (const page of this.layers.keys()) {
      const view = this.pageView(page);
      if (view) this.attach(view);
    }
  }

  destroy(): void {
    for (const set of this.layers.values()) {
      set.markup.remove();
      set.content.remove();
      set.restore.remove();
      set.ui.remove();
    }
    this.layers.clear();
    this.active.clear();
    this.snapshot = [];
    this.listeners.clear();
  }
}
