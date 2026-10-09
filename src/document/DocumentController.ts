/**
 * DocumentController — the engine behind one document tab.
 *
 * Owns the pdf.js document + viewer, the annotation model and its undo history, the save
 * pipeline and view-state persistence. React components observe it through two vanilla zustand
 * stores (`store` for document/view state, `annotations` for the annotation model) and call its
 * methods; the controller itself never imports React.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  EventBus,
  FindState,
  GenericL10n,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from "../pdf/viewer";
import { pdfjs, loadDocument, type PDFDocumentProxy, type LoadedDocument } from "../pdf/pdfjs";
import type { PageViewLike, ViewerLike } from "../pdf/viewerTypes";
import { RenderingState } from "../pdf/viewerTypes";
import { api, type DocInfo } from "../lib/ipc";
import { AppError, toAppError } from "../lib/errors";
import { createLogger } from "../lib/log";
import { t, currentLocale, cjkHintForLocale } from "../i18n";
import { settings, onSettingsChange } from "../settings/store";
import type { Settings, LayoutSetting } from "../settings/defaults";
import { openDialog, toast, useUi } from "../state/ui";
import { useLibrary, writeRecovery, removeRecovery, readRecovery, type ViewStateEntry } from "../state/library";
import { History, invertChanges, type BaseState, type Change, type HistoryState } from "../annotations/history";
import {
  applyChanges,
  computeHiddenRefs,
  createAnnotationStore,
  indexByPage,
  restoreSnapshot,
  snapshot,
  withDescendants,
  type AnnotationStore,
} from "../annotations/store";
import { fromExisting, kindLabelKey, newId, nowIso, type Annotation } from "../annotations/model";
import { serializeChanges } from "../annotations/serialize";
import type { DocumentFont, InfoUpdate, PageOp } from "../annotations/dto";
import type { PlacementPayload, ToolId } from "../annotations/tools";
import { isMarkupTool, createStyled } from "../annotations/tools";
import { NavHistory, type ViewLocation } from "./navHistory";
import { PageLayerManager } from "./pageLayers";
import { HiddenAnnotations } from "./renderPatch";
import { applyPageColorStyle, pageColorStyle } from "./pageColors";
import { captureRegion } from "./snapshot";
import { layoutToModes, modesToLayout, nextZoomLevel, zoomSettingToScaleValue, MAX_SCALE, MIN_SCALE, ScrollMode } from "./layout";
import { selectionToQuads, quadsBounds } from "./textSelection";
import { ThumbnailService, renderCoverDataUrl } from "./thumbnails";
import { AttachmentDownloadManager, openExternalLink } from "./externalLinks";
import { recoveryPayload, restoreRecoveryPayload } from "./recovery";
import { appInfo } from "../state/app";

const log = createLogger("document");

export type DocStatus = "loading" | "ready" | "error" | "cancelled";

export interface FindUiState {
  query: string;
  caseSensitive: boolean;
  entireWord: boolean;
  matchDiacritics: boolean;
  highlightAll: boolean;
  /** pdf.js FindState: 0 found, 1 not found, 2 wrapped, 3 pending */
  state: number | null;
  current: number;
  total: number;
}

export interface Permissions {
  print: boolean;
  copy: boolean;
  modify: boolean;
  annotate: boolean;
  fillForms: boolean;
  assemble: boolean;
}

export interface TextSelectionInfo {
  text: string;
  /** Client coordinates of the end of the selection (for the floating selection toolbar). */
  x: number;
  y: number;
  top: number;
}

export interface ContextMenuRequest {
  x: number;
  y: number;
  kind: "text" | "annotation" | "page";
  page: number | null;
  annotationId: string | null;
}

export interface DocState {
  status: DocStatus;
  error: AppError | null;
  progress: number | null;
  info: DocInfo | null;
  fileName: string;
  numPages: number;
  page: number;
  pageLabel: string | null;
  hasPageLabels: boolean;
  pageSize: [number, number] | null;
  scale: number;
  scaleValue: string;
  rotation: number;
  layout: LayoutSetting;
  canGoBack: boolean;
  canGoForward: boolean;
  history: HistoryState;
  formsDirty: boolean;
  /** Metadata overrides relative to the base bytes (kept after saving, see `infoDirty`). */
  info_update: InfoUpdate | null;
  infoDirty: boolean;
  saving: boolean;
  permissions: Permissions;
  find: FindUiState;
  tool: ToolId;
  payload: PlacementPayload | null;
  streamed: boolean;
  /** Changed or deleted on disk since opened / saved. */
  disk: "ok" | "changed" | "deleted";
  sidebarOpen: boolean;
  sidebarPanel: string;
  selection: TextSelectionInfo | null;
  contextMenu: ContextMenuRequest | null;
  outlineCount: number;
  attachmentCount: number;
  hasLayers: boolean;
  /** Bumped whenever page geometry changes (rotation, zoom, layout) so overlays re-measure. */
  layoutVersion: number;
}

const ALL_ALLOWED: Permissions = { print: true, copy: true, modify: true, annotate: true, fillForms: true, assemble: true };

function initialState(path: string): DocState {
  const s = settings();
  return {
    status: "loading",
    error: null,
    progress: null,
    info: null,
    fileName: path.split(/[\\/]/).pop() ?? path,
    numPages: 0,
    page: 1,
    pageLabel: null,
    hasPageLabels: false,
    pageSize: null,
    scale: 1,
    scaleValue: "auto",
    rotation: 0,
    layout: s.reading.defaultLayout,
    canGoBack: false,
    canGoForward: false,
    history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, dirty: false },
    formsDirty: false,
    info_update: null,
    infoDirty: false,
    saving: false,
    permissions: ALL_ALLOWED,
    find: {
      query: "",
      caseSensitive: false,
      entireWord: false,
      matchDiacritics: false,
      highlightAll: true,
      state: null,
      current: 0,
      total: 0,
    },
    tool: s.navigation.defaultTool,
    payload: null,
    streamed: false,
    disk: "ok",
    sidebarOpen: false,
    sidebarPanel: s.ui.sidebarPanel,
    selection: null,
    contextMenu: null,
    outlineCount: 0,
    attachmentCount: 0,
    hasLayers: false,
    layoutVersion: 0,
  };
}

/** pdf.js permission flags. */
const PERM = { PRINT: 0x04, MODIFY: 0x08, COPY: 0x10, ANNOTATE: 0x20, FILL: 0x100, ASSEMBLE: 0x400, PRINT_HQ: 0x800 };

export class DocumentController {
  readonly store: StoreApi<DocState>;
  readonly annotations: AnnotationStore = createAnnotationStore();
  readonly history = new History();
  readonly thumbnails: ThumbnailService;

  pdf: PDFDocumentProxy | null = null;
  viewer: (PDFViewer & ViewerLike) | null = null;
  eventBus: EventBus | null = null;
  linkService: PDFLinkService | null = null;
  layers: PageLayerManager | null = null;

  private loadingTask: LoadedDocument["task"] | null = null;
  private password: string | null = null;
  /** Session serving the base bytes (may outlive a save that replaced the file). */
  private baseSession: DocInfo | null = null;
  /** Session tracking the file currently on disk. */
  private diskSession: DocInfo | null = null;
  /** In-memory base bytes after structural page operations. */
  private baseBytes: Uint8Array | null = null;
  private hidden: HiddenAnnotations | null = null;
  /** Form fields were edited since the base was loaded (values must be part of every save). */
  private formsTouched = false;
  private hiddenStyle: HTMLStyleElement | null = null;
  private container: HTMLDivElement | null = null;
  private viewerAbort: AbortController | null = null;
  private disposers: (() => void)[] = [];
  private lastLocation: { pageNumber: number; scale: number | string; top: number; left: number; rotation: number } | null = null;
  private pendingRestore: ViewStateEntry | null = null;
  private viewStateTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private wheelZoomAcc = 1;
  private pageFlipLock = 0;
  private destroyed = false;
  private inkMerge: { id: string; time: number } | null = null;
  /** Tool to restore when the one-shot snapshot mode ends. */
  private beforeSnapshot: { tool: ToolId; payload: PlacementPayload | null } | null = null;
  readonly nav: NavHistory;

  constructor(
    readonly tabId: string,
    private path: string,
  ) {
    this.store = createStore<DocState>(() => initialState(path));
    this.nav = new NavHistory(
      () => this.currentLocation(),
      (loc) => this.goToLocation(loc),
      () => this.set({ canGoBack: this.nav.canGoBack, canGoForward: this.nav.canGoForward }),
    );
    this.thumbnails = new ThumbnailService(
      () => this.pdf,
      () => {
        const q = settings().performance.thumbnailQuality;
        const base = q === "low" ? 96 : q === "high" ? 220 : 150;
        return Math.round(base * settings().ui.thumbnailSize * Math.min(2, window.devicePixelRatio || 1));
      },
      () => this.state.rotation,
      (page) => this.eventBus?.dispatch("thumbnailrendered", { source: this, pageNumber: page, pdfPage: null }),
    );
    this.history.subscribe(() => this.set({ history: this.history.state }));
    this.disposers.push(
      onSettingsChange(
        (s) => s,
        (s, prev) => this.onSettingsChanged(s, prev),
      ),
    );
  }

  // --------------------------------------------------------------------------------------------
  // State helpers
  // --------------------------------------------------------------------------------------------

  get state(): DocState {
    return this.store.getState();
  }

  private set(patch: Partial<DocState>) {
    if (!this.destroyed) this.store.setState(patch);
  }

  get filePath(): string {
    return this.path;
  }

  get isReady(): boolean {
    return this.state.status === "ready" && !!this.pdf;
  }

  get isDirty(): boolean {
    const s = this.state;
    return s.history.dirty || s.formsDirty || s.infoDirty;
  }

  get documentPassword(): string | null {
    return this.password;
  }

  /** Can comments be added / edited (document permissions + settings)? */
  get canAnnotate(): boolean {
    const p = this.state.permissions;
    return !settings().saving.respectRestrictions || p.annotate || p.modify;
  }

  // --------------------------------------------------------------------------------------------
  // Opening
  // --------------------------------------------------------------------------------------------

  async open(restore: ViewStateEntry | null = null): Promise<void> {
    this.set({ status: "loading", error: null, progress: null });
    try {
      const info = await api.docOpen(this.path);
      if (this.destroyed) {
        void api.docClose(info.sessionId);
        return;
      }
      this.baseSession = info;
      this.diskSession = info;
      this.set({ info, fileName: info.fileName });
      const rememberView = settings().general.rememberView;
      this.pendingRestore = restore ?? (rememberView ? useLibrary.getState().getViewState(info.path) : null);
      const loaded = await this.load({ kind: "session", info });
      if (this.destroyed) {
        await loaded.task.destroy();
        return;
      }
      await this.attachDocument(loaded);
      void this.afterOpen();
    } catch (err) {
      const e = toAppError(err);
      if (this.destroyed) return;
      if (e.isCancellation) {
        this.set({ status: "cancelled" });
        return;
      }
      log.error(`failed to open ${this.path}`, e.message, e.detail ?? "");
      this.set({ status: "error", error: e });
    }
  }

  private load(source: Parameters<typeof loadDocument>[0]): Promise<LoadedDocument> {
    const s = settings();
    return loadDocument(source, {
      onPassword: (reason) => openDialog("password", { fileName: this.state.fileName, reason }),
      onProgress: (loaded, total) => {
        if (total > 0) this.set({ progress: Math.min(1, loaded / total) });
      },
      onStreamError: (err) => this.onStreamError(err),
      streamThresholdBytes: s.performance.streamThresholdMb * 1024 * 1024,
      prefetchAll: s.performance.prefetchAll,
      useSystemFonts: s.reading.useSystemFonts,
      enableXfa: s.reading.enableXfa,
      enableHWA: s.performance.hardwareAcceleration,
    });
  }

  private onStreamError(err: AppError) {
    if (err.code === "FILE_CHANGED") this.set({ disk: "changed" });
    toast("error", t("error.FILE_CHANGED"), {
      detail: err.message,
      action: { label: t("common.reload"), run: () => void this.reload() },
      timeout: 0,
    });
  }

  private async attachDocument(loaded: LoadedDocument): Promise<void> {
    const pdf = loaded.pdf;
    this.pdf = pdf;
    this.loadingTask = loaded.task;
    this.password = loaded.password;
    this.hidden = new HiddenAnnotations(pdf);
    this.formsTouched = false;
    // The shipped typings declare these callbacks as `null`.
    const storage = pdf.annotationStorage as unknown as { onSetModified: (() => void) | null; onResetModified: (() => void) | null };
    storage.onSetModified = () => {
      this.formsTouched = true;
      this.set({ formsDirty: true });
    };
    storage.onResetModified = () => this.set({ formsDirty: false });

    const [permissions, outline, attachments, ocConfig] = await Promise.all([
      pdf.getPermissions().catch(() => null),
      pdf.getOutline().catch(() => null),
      pdf.getAttachments().catch(() => null),
      pdf.getOptionalContentConfig().catch(() => null),
    ]);
    const perms: Permissions = permissions
      ? {
          print: permissions.has(PERM.PRINT) || permissions.has(PERM.PRINT_HQ),
          copy: permissions.has(PERM.COPY),
          modify: permissions.has(PERM.MODIFY),
          annotate: permissions.has(PERM.ANNOTATE),
          fillForms: permissions.has(PERM.FILL) || permissions.has(PERM.ANNOTATE),
          assemble: permissions.has(PERM.ASSEMBLE) || permissions.has(PERM.MODIFY),
        }
      : ALL_ALLOWED;
    const restore = this.pendingRestore;
    const s = settings();
    const sidebarDefault = s.appearance.sidebarDefault;
    let sidebarOpen = this.state.sidebarOpen;
    let sidebarPanel = this.state.sidebarPanel;
    if (sidebarDefault === "remember" && restore) {
      sidebarOpen = restore.sidebarOpen;
      sidebarPanel = restore.sidebarPanel || sidebarPanel;
    } else if (sidebarDefault === "thumbnails") {
      sidebarOpen = true;
      sidebarPanel = "thumbnails";
    } else if (sidebarDefault === "outline") {
      sidebarOpen = !!outline?.length;
      if (sidebarOpen) sidebarPanel = "outline";
    } else if (sidebarDefault === "remember") {
      sidebarOpen = s.ui.sidebarOpen;
    }

    this.set({
      numPages: pdf.numPages,
      permissions: perms,
      streamed: loaded.streamed,
      outlineCount: outline?.length ?? 0,
      attachmentCount: attachments?.size ?? 0,
      hasLayers: !!ocConfig && [...(ocConfig as unknown as Iterable<unknown>)].length > 0,
      sidebarOpen,
      sidebarPanel,
    });
    if (this.container) this.initViewer();
    this.set({ status: "ready", progress: null });
  }

  /** Background work once the document is displayed. */
  private async afterOpen() {
    const info = this.diskSession;
    const pdf = this.pdf;
    if (!info || !pdf) return;
    const s = settings();
    void renderCoverDataUrl(pdf).then((thumb) => {
      useLibrary
        .getState()
        .addRecent({ path: info.path, name: info.fileName, pages: pdf.numPages, thumb }, s.general.recentCount);
    });
    await this.loadFileAnnotations();
    await this.checkRecovery();
    this.startRecoveryTimer();
  }

  /** Read the annotations stored in the file into the model (in the background). */
  private async loadFileAnnotations(bytes?: Uint8Array): Promise<void> {
    try {
      const existing = bytes
        ? await api.pdfReadAnnotations(bytes, this.password)
        : this.baseSession
          ? await api.docAnnotations(this.baseSession.sessionId, this.password)
          : [];
      if (this.destroyed) return;
      const items: Record<string, Annotation> = {};
      for (const e of existing) {
        const a = fromExisting(e);
        if (a) items[a.id] = a;
      }
      this.annotations.setState((st) => ({
        items,
        pristine: items,
        byPage: indexByPage(items),
        loaded: true,
        loadError: null,
        selection: [],
        editing: null,
        version: st.version + 1,
      }));
      this.refreshHidden(true);
    } catch (err) {
      const e = toAppError(err);
      log.warn("could not read annotations", e.message);
      this.annotations.setState({ loaded: true, loadError: e.message });
    }
  }

  // --------------------------------------------------------------------------------------------
  // Viewer
  // --------------------------------------------------------------------------------------------

  /** Called by the React view with its scroll container (`position: absolute`, child `.pdfViewer`). */
  mount(container: HTMLDivElement): void {
    if (this.container === container) return;
    this.container = container;
    if (this.pdf && !this.viewer) this.initViewer();
  }

  unmount(): void {
    this.teardownViewer();
    this.container = null;
  }

  private initViewer(): void {
    const container = this.container;
    const pdf = this.pdf;
    if (!container || !pdf || this.viewer) return;
    const viewerDiv = container.querySelector<HTMLDivElement>(".pdfViewer");
    if (!viewerDiv) throw new Error("viewer element missing");
    const s = settings();
    const abort = new AbortController();
    this.viewerAbort = abort;

    const eventBus = new EventBus();
    const linkService = new PDFLinkService({
      eventBus,
      externalLinkTarget: LinkTarget.NONE,
      externalLinkRel: "noopener noreferrer nofollow",
    });
    const findController = new PDFFindController({ linkService, eventBus, updateMatchesCountOnProgress: true });
    const options = {
      container,
      viewer: viewerDiv,
      eventBus,
      linkService,
      findController,
      downloadManager: new AttachmentDownloadManager() as never,
      annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
      annotationEditorMode: pdfjs.AnnotationEditorType.DISABLE,
      imageResourcesPath: "/pdfjs/images/",
      maxCanvasPixels: maxCanvasPixels(s),
      enablePermissions: s.saving.respectRestrictions,
      enableAutoLinking: true,
      imagesRightClickMinSize: 24,
      l10n: new GenericL10n(undefined),
      abortSignal: abort.signal,
    };
    // `abortSignal` is supported at runtime but missing from the shipped option typings.
    const viewer = new PDFViewer(options as unknown as ConstructorParameters<typeof PDFViewer>[0]) as PDFViewer & ViewerLike;
    linkService.setViewer(viewer);
    linkService.setDocument(pdf);
    linkService.setHistory(this.nav.asPdfHistory());

    this.eventBus = eventBus;
    this.linkService = linkService;
    this.viewer = viewer;
    this.layers = new PageLayerManager(viewer);
    this.installHiddenStyle(container);
    this.wireEvents(eventBus, viewer, abort.signal);
    this.wireDom(container, abort.signal);
    this.applyViewerSettings(s);

    viewer.setDocument(pdf);
  }

  private teardownViewer() {
    if (this.viewer) {
      this.saveViewState();
      // Aborting detaches every listener and observer of the viewer. We deliberately do not call
      // `setDocument(null)`: it empties the page list while pdf.js' background page
      // initialisation is still resolving, which then throws inside pdf.js. Cancelling the
      // render tasks is enough; the old viewer is garbage once its promises settle.
      this.viewerAbort?.abort();
      try {
        (this.viewer as unknown as { _cancelRendering(): void })._cancelRendering();
      } catch (err) {
        log.debug("viewer teardown", err);
      }
    }
    this.layers?.destroy();
    this.hiddenStyle?.remove();
    this.hiddenStyle = null;
    this.layers = null;
    this.viewer = null;
    this.eventBus = null;
    this.linkService = null;
    this.viewerAbort = null;
  }

  private wireEvents(bus: EventBus, viewer: PDFViewer & ViewerLike, signal: AbortSignal) {
    const on = (name: string, fn: (evt: any) => void) => bus.on(name, fn, { signal });

    on("pagesinit", () => {
      this.layers?.patchPageViews();
      const restore = this.pendingRestore;
      this.pendingRestore = null;
      const s = settings();
      const layout = (restore?.layout as LayoutSetting | undefined) ?? s.reading.defaultLayout;
      this.setLayout(layout, false);
      if (restore && restore.rotation) viewer.pagesRotation = restore.rotation;
      viewer.currentScaleValue = restore?.scaleValue || zoomSettingToScaleValue(s.reading.defaultZoom, s.reading.customZoom);
      if (restore && restore.page > 1 && restore.page <= viewer.pagesCount) {
        viewer.scrollPageIntoView({
          pageNumber: restore.page,
          destArray: (restore.dest as never) ?? undefined,
          allowNegativeOffset: true,
          ignoreDestinationZoom: true,
        });
      }
      this.pdf
        ?.getPageLabels()
        .then((labels) => {
          if (labels && this.viewer === viewer) {
            viewer.setPageLabels(labels);
            this.set({ hasPageLabels: labels.some((l, i) => l !== String(i + 1)), pageLabel: viewer.currentPageLabel });
          }
        })
        .catch(() => undefined);
      this.updatePageSize();
    });

    on("pagechanging", ({ pageNumber, pageLabel }) => {
      this.set({ page: pageNumber, pageLabel: pageLabel ?? null });
      this.updatePageSize();
    });

    on("scalechanging", ({ scale, presetValue }) => {
      this.set({ scale, scaleValue: presetValue ?? String(scale), layoutVersion: this.state.layoutVersion + 1 });
    });

    on("rotationchanging", ({ pagesRotation }) => {
      this.set({ rotation: pagesRotation, layoutVersion: this.state.layoutVersion + 1 });
      this.thumbnails.invalidate();
      this.updatePageSize();
    });

    const onModes = () => this.set({ layout: modesToLayout(viewer.scrollMode, viewer.spreadMode), layoutVersion: this.state.layoutVersion + 1 });
    on("scrollmodechanged", onModes);
    on("spreadmodechanged", onModes);

    on("updatefindmatchescount", ({ matchesCount }) => {
      this.set({ find: { ...this.state.find, current: matchesCount.current, total: matchesCount.total } });
    });
    on("updatefindcontrolstate", ({ state, previous, matchesCount }) => {
      if (state === FindState.WRAPPED) toast("info", t(previous ? "find.wrappedBottom" : "find.wrappedTop"), { timeout: 2500 });
      this.set({
        find: { ...this.state.find, state, current: matchesCount?.current ?? 0, total: matchesCount?.total ?? 0 },
      });
    });

    on("pagerender", ({ source }) => this.layers?.onPageRender(source as PageViewLike));
    on("pagerendered", ({ source, error, cssTransform, isDetailView }) => {
      const view = source as PageViewLike;
      this.layers?.attach(view);
      if (!cssTransform && !isDetailView) this.updateRestoreLayer(view);
      if (error && !(error instanceof pdfjs.RenderingCancelledException)) {
        log.error(`page ${view.id} failed to render`, error);
      }
    });

    on("updateviewarea", ({ location }) => {
      this.lastLocation = location;
      this.layers?.prune();
      this.scheduleViewStateSave();
    });

    on("pagesloaded", () => this.updatePageSize());
  }

  private wireDom(container: HTMLDivElement, signal: AbortSignal) {
    const opts = { signal };
    container.addEventListener("wheel", (e) => this.onWheel(e), { signal, passive: false });

    // pdf.js does not re-fit preset zoom levels when the container is resized (sidebar toggled,
    // window resized), so re-apply them ourselves.
    let fitTimer: ReturnType<typeof setTimeout> | null = null;
    let lastWidth = container.clientWidth;
    let lastHeight = container.clientHeight;
    const observer = new ResizeObserver(() => {
      const { clientWidth: w, clientHeight: h } = container;
      if (w === 0 || h === 0 || (w === lastWidth && h === lastHeight)) return;
      lastWidth = w;
      lastHeight = h;
      if (fitTimer) clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        const viewer = this.viewer;
        const value = viewer?.currentScaleValue;
        if (viewer && (value === "auto" || value === "page-fit" || value === "page-width")) viewer.currentScaleValue = value;
      }, 120);
    });
    observer.observe(container);
    signal.addEventListener("abort", () => {
      observer.disconnect();
      if (fitTimer) clearTimeout(fitTimer);
    });

    // External links: never navigate the webview; route through the link policy.
    const onLinkClick = (e: MouseEvent) => {
      const anchor = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || !container.contains(anchor)) return;
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("#") || href === "") return; // internal destination, handled by pdf.js
      e.preventDefault();
      e.stopPropagation();
      if (e.type === "click" || (e as MouseEvent).button === 1) void openExternalLink(anchor.href);
    };
    container.addEventListener("click", onLinkClick, { signal, capture: true });
    container.addEventListener("auxclick", onLinkClick, { signal, capture: true });

    container.addEventListener(
      "pointerup",
      (e) => {
        if (e.button !== 0) return;
        const tool = this.state.tool;
        if (isMarkupTool(tool)) {
          // Let the selection settle first.
          requestAnimationFrame(() => this.markupFromSelection(tool));
        }
      },
      opts,
    );

    container.addEventListener(
      "contextmenu",
      (e) => {
        e.preventDefault();
        const target = e.target as HTMLElement;
        const annotationId = target.closest<HTMLElement>("[data-annot-id]")?.dataset.annotId ?? null;
        const pageDiv = target.closest<HTMLElement>(".page");
        const page = pageDiv ? Number(pageDiv.dataset.pageNumber) : null;
        const sel = document.getSelection();
        const hasText = !!sel && !sel.isCollapsed && container.contains(sel.anchorNode);
        this.set({
          contextMenu: {
            x: e.clientX,
            y: e.clientY,
            kind: annotationId ? "annotation" : hasText ? "text" : "page",
            page,
            annotationId,
          },
        });
        if (annotationId) this.select([annotationId]);
      },
      opts,
    );

    container.addEventListener(
      "dblclick",
      (e) => {
        if (!settings().navigation.doubleClickZoom) return;
        const target = e.target as HTMLElement;
        if (target.closest(".textLayer span, .annotationLayer section, [data-annot-id]")) return;
        const v = this.viewer;
        if (!v) return;
        v.currentScaleValue = v.currentScaleValue === "page-width" ? "page-fit" : "page-width";
      },
      opts,
    );

    // Floating selection toolbar.
    let selTimer: ReturnType<typeof setTimeout> | null = null;
    document.addEventListener(
      "selectionchange",
      () => {
        if (selTimer) clearTimeout(selTimer);
        selTimer = setTimeout(() => this.updateSelectionInfo(), 120);
      },
      opts,
    );
  }

  private updateSelectionInfo() {
    const container = this.container;
    const sel = document.getSelection();
    if (!container || !sel || sel.isCollapsed || sel.rangeCount === 0 || !container.contains(sel.anchorNode)) {
      if (this.state.selection) this.set({ selection: null });
      return;
    }
    const text = sel.toString();
    if (!text.trim()) {
      if (this.state.selection) this.set({ selection: null });
      return;
    }
    const rects = sel.getRangeAt(sel.rangeCount - 1).getClientRects();
    const last = rects[rects.length - 1];
    const first = sel.getRangeAt(0).getClientRects()[0];
    if (!last) return;
    this.set({ selection: { text, x: last.right, y: last.bottom, top: first?.top ?? last.top } });
  }

  private onWheel(e: WheelEvent) {
    const viewer = this.viewer;
    if (!viewer) return;
    const nav = settings().navigation;
    const wantsZoom = nav.wheelAction === "zoom" ? !e.ctrlKey : e.ctrlKey || e.metaKey;
    if (wantsZoom) {
      e.preventDefault();
      // Touchpad pinch produces small fractional deltas, mouse wheels ±100 per notch.
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
      const delta = Math.max(-300, Math.min(300, e.deltaY * unit));
      const stepFactor = nav.zoomStep === "fine" ? 0.0012 : nav.zoomStep === "coarse" ? 0.004 : 0.0022;
      this.wheelZoomAcc *= Math.exp(-delta * stepFactor);
      const current = viewer.currentScale;
      const target = Math.max(MIN_SCALE, Math.min(MAX_SCALE, current * this.wheelZoomAcc));
      if (Math.abs(target - current) >= 0.01) {
        viewer.updateScale({ scaleFactor: target / current, origin: [e.clientX, e.clientY], drawingDelay: 300 });
        this.wheelZoomAcc = 1;
      }
      return;
    }
    // Single-page layouts: flip pages at the scroll edges.
    if (viewer.scrollMode === ScrollMode.PAGE && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      const c = viewer.container;
      const atBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 2;
      const atTop = c.scrollTop <= 1;
      const now = performance.now();
      if (now > this.pageFlipLock && ((e.deltaY > 0 && atBottom) || (e.deltaY < 0 && atTop))) {
        e.preventDefault();
        this.pageFlipLock = now + 350;
        if (e.deltaY > 0) viewer.nextPage();
        else {
          viewer.previousPage();
          requestAnimationFrame(() => (c.scrollTop = c.scrollHeight));
        }
        return;
      }
    }
    if (nav.scrollSpeed !== 1 && !e.shiftKey) {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? viewer.container.clientHeight : 1;
      viewer.container.scrollBy({ top: e.deltaY * unit * nav.scrollSpeed, left: e.deltaX * unit * nav.scrollSpeed });
    }
  }

  private installHiddenStyle(container: HTMLDivElement) {
    const scope = `yapr-doc-${this.tabId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    container.classList.add(scope);
    const style = document.createElement("style");
    style.dataset.scope = scope;
    document.head.append(style);
    this.hiddenStyle = style;
  }

  /** Recompute which file annotations pdf.js must not draw and re-render affected pages. */
  refreshHidden(force = false): void {
    const hidden = this.hidden;
    if (!hidden) return;
    const state = this.annotations.getState();
    const refs = computeHiddenRefs(state, settings().annotations.showAnnotations);
    const before = new Set<string>();
    for (const [, a] of Object.entries(state.pristine)) if (a.ref && hidden.has(a.ref)) before.add(a.ref);
    const changed = hidden.set(refs) || force;
    if (this.hiddenStyle && this.container) {
      const scope = [...this.container.classList].find((c) => c.startsWith("yapr-doc-"));
      const selectors = [...refs].map((r) => `.${scope} [data-annotation-id="${CSS.escape(r)}"]`);
      this.hiddenStyle.textContent = selectors.length ? `${selectors.join(",\n")} { display: none !important; }` : "";
    }
    if (!changed || !this.viewer) return;
    // Re-render pages whose hidden set changed.
    const pages = new Set<number>();
    for (const a of Object.values(state.pristine)) {
      if (!a.ref) continue;
      if (refs.has(a.ref) !== before.has(a.ref) || force) pages.add(a.page + 1);
    }
    this.rerenderPages(pages);
  }

  private rerenderPages(pages: Iterable<number>) {
    const viewer = this.viewer;
    if (!viewer) return;
    let any = false;
    for (const p of pages) {
      const view = viewer.getPageView(p - 1);
      if (view && view.renderingState !== RenderingState.INITIAL) {
        view.reset({
          keepAnnotationLayer: true,
          keepAnnotationEditorLayer: true,
          keepXfaLayer: true,
          keepTextLayer: true,
          keepCanvasWrapper: true,
        });
        any = true;
      }
    }
    if (any) viewer.update();
  }

  /** Place backdrop-filter patches over images so "night" mode keeps their colours. */
  private updateRestoreLayer(view: PageViewLike) {
    const layers = this.layers;
    if (!layers) return;
    const restore = layers.get(view.id).restore;
    const style = pageColorStyle(settings().pageColors, document.documentElement.dataset.theme === "dark");
    if (!style.restoreImages || !view.imageCoordinates) {
      if (restore.childElementCount) restore.replaceChildren();
      return;
    }
    const coords = view.imageCoordinates;
    const frag = document.createDocumentFragment();
    for (let i = 0; i + 5 < coords.length; i += 6) {
      const [x1, y1, x2, y2, x3, y3] = [coords[i], coords[i + 1], coords[i + 2], coords[i + 3], coords[i + 4], coords[i + 5]];
      const left = Math.min(x1, x2, x3, x2 + x3 - x1);
      const right = Math.max(x1, x2, x3, x2 + x3 - x1);
      const top = Math.min(y1, y2, y3, y2 + y3 - y1);
      const bottom = Math.max(y1, y2, y3, y2 + y3 - y1);
      if (right - left < 0.01 || bottom - top < 0.01) continue;
      const patch = document.createElement("div");
      patch.style.cssText = `left:${left * 100}%;top:${top * 100}%;width:${(right - left) * 100}%;height:${(bottom - top) * 100}%`;
      frag.append(patch);
    }
    restore.replaceChildren(frag);
  }

  private updatePageSize() {
    const view = this.viewer?.getPageView(this.state.page - 1);
    const page = view?.pdfPage;
    if (!page) return;
    const vp = page.getViewport({ scale: 1 });
    this.set({ pageSize: [vp.width, vp.height] });
  }

  // --------------------------------------------------------------------------------------------
  // Settings
  // --------------------------------------------------------------------------------------------

  private onSettingsChanged(s: Settings, prev: Settings) {
    if (!this.viewer) return;
    if (
      s.pageColors !== prev.pageColors ||
      s.appearance.theme !== prev.appearance.theme ||
      s.accessibility.highContrast !== prev.accessibility.highContrast
    ) {
      this.applyPageColors();
    }
    if (s.performance.renderQuality !== prev.performance.renderQuality) {
      this.viewer.maxCanvasPixels = maxCanvasPixels(s);
      this.viewer.refresh();
    }
    if (s.annotations.showAnnotations !== prev.annotations.showAnnotations) this.refreshHidden();
    if (s.saving.recovery !== prev.saving.recovery || s.saving.recoveryInterval !== prev.saving.recoveryInterval) {
      this.startRecoveryTimer();
    }
    this.applyRootClasses(s);
  }

  /** Root element of the viewer (parent of the scroll container). */
  private get root(): HTMLElement | null {
    return this.container?.parentElement ?? null;
  }

  applyPageColors(): void {
    this.applyHighContrast();
    const root = this.root;
    if (!root) return;
    const style = pageColorStyle(settings().pageColors, document.documentElement.dataset.theme === "dark");
    applyPageColorStyle(root, style);
    const viewer = this.viewer;
    if (viewer) {
      for (let i = 0; i < viewer.pagesCount; i++) {
        const view = viewer.getPageView(i);
        if (view && view.renderingState === RenderingState.FINISHED) this.updateRestoreLayer(view);
      }
    }
  }

  /**
   * With a Windows contrast theme active (and the option enabled) pages are drawn with the
   * system's text / background colours through pdf.js' forced-colours support.
   */
  private applyHighContrast(): void {
    const viewer = this.viewer;
    if (!viewer) return;
    const forced = window.matchMedia("(forced-colors: active)").matches;
    const colors = settings().accessibility.highContrast && forced ? { background: "Canvas", foreground: "CanvasText" } : null;
    if (JSON.stringify(viewer.pageColors) === JSON.stringify(colors)) return;
    viewer.pageColors = colors;
    for (const view of viewer._pages) view.pageColors = colors;
    viewer.refresh();
  }

  private applyRootClasses(s: Settings) {
    const root = this.root;
    if (!root) return;
    root.dataset.pageGap = s.reading.pageGap;
    root.toggleAttribute("data-page-shadow", s.reading.pageShadow);
    root.toggleAttribute("data-no-text-select", !s.reading.textSelection);
    root.toggleAttribute("data-link-outline", s.reading.highlightLinks);
    root.toggleAttribute("data-hide-annotations", !s.annotations.showAnnotations);
    root.dataset.viewerBg = s.reading.viewerBackground;
  }

  private applyViewerSettings(s: Settings) {
    this.applyRootClasses(s);
    this.applyPageColors();
  }

  // --------------------------------------------------------------------------------------------
  // Navigation & view
  // --------------------------------------------------------------------------------------------

  private currentLocation(): ViewLocation | null {
    const loc = this.lastLocation;
    if (!loc) return null;
    return { pageNumber: loc.pageNumber, dest: [null, { name: "XYZ" }, loc.left, loc.top, null] };
  }

  private goToLocation(loc: ViewLocation) {
    this.viewer?.scrollPageIntoView({
      pageNumber: loc.pageNumber,
      destArray: (loc.dest as never) ?? undefined,
      allowNegativeOffset: true,
      ignoreDestinationZoom: true,
    });
  }

  goToPage(page: number, opts: { recordHistory?: boolean } = {}): void {
    const viewer = this.viewer;
    if (!viewer || page < 1 || page > viewer.pagesCount) return;
    if (opts.recordHistory !== false && Math.abs(page - this.state.page) > 1) this.nav.pushCurrentPosition();
    this.linkService?.goToPage(page);
  }

  /** Accepts a page number or a page label. Returns false when invalid. */
  goToPageInput(input: string): boolean {
    const viewer = this.viewer;
    if (!viewer) return false;
    const trimmed = input.trim();
    let page = viewer.pageLabelToPageNumber(trimmed) ?? 0;
    if (!page) page = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(page) || page < 1 || page > viewer.pagesCount) return false;
    this.goToPage(page);
    return true;
  }

  nextPage(): void {
    this.viewer?.nextPage();
  }

  previousPage(): void {
    this.viewer?.previousPage();
  }

  firstPage(): void {
    this.goToPage(1);
  }

  lastPage(): void {
    if (this.viewer) this.goToPage(this.viewer.pagesCount);
  }

  goToDestination(dest: string | unknown[] | null): void {
    if (dest) void this.linkService?.goToDestination(dest as never);
  }

  scrollToRect(page: number, rect: [number, number, number, number]): void {
    const viewer = this.viewer;
    if (!viewer) return;
    this.nav.pushCurrentPosition();
    viewer.scrollPageIntoView({
      pageNumber: page + 1,
      destArray: [null, { name: "XYZ" }, Math.max(0, rect[0] - 36), rect[3] + 36, null] as never,
      allowNegativeOffset: true,
      ignoreDestinationZoom: true,
    });
  }

  setZoom(value: number | "auto" | "page-fit" | "page-width" | "page-actual"): void {
    const viewer = this.viewer;
    if (!viewer) return;
    if (typeof value === "number") viewer.currentScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, value));
    else viewer.currentScaleValue = value;
  }

  zoomStep(direction: 1 | -1, origin?: [number, number]): void {
    const viewer = this.viewer;
    if (!viewer) return;
    const target = nextZoomLevel(viewer.currentScale, direction);
    viewer.updateScale({ scaleFactor: target / viewer.currentScale, origin, drawingDelay: 200 });
  }

  rotateView(delta: 90 | -90): void {
    const viewer = this.viewer;
    if (!viewer) return;
    viewer.pagesRotation = (viewer.pagesRotation + delta + 360) % 360;
  }

  setLayout(layout: LayoutSetting, persist = true): void {
    const viewer = this.viewer;
    if (!viewer) return;
    const { scroll, spread } = layoutToModes(layout, settings().reading.coverPage);
    // pdf.js requires the scroll mode before the spread mode for PAGE + spreads.
    viewer.scrollMode = scroll;
    viewer.spreadMode = spread;
    this.set({ layout });
    if (persist) this.scheduleViewStateSave();
  }

  setSidebar(open: boolean, panel?: string): void {
    this.set({ sidebarOpen: open, ...(panel ? { sidebarPanel: panel } : {}) });
    this.scheduleViewStateSave();
  }

  closeContextMenu(): void {
    if (this.state.contextMenu) this.set({ contextMenu: null });
  }

  /** Scroll the view by a fraction of the viewport (keyboard navigation). */
  scrollBy(dx: number, dy: number, smooth = settings().navigation.smoothScroll): void {
    const c = this.viewer?.container;
    if (!c) return;
    c.scrollBy({ left: dx, top: dy, behavior: smooth ? "smooth" : "instant" });
  }

  get scrollContainer(): HTMLDivElement | null {
    return this.viewer?.container ?? null;
  }

  // --------------------------------------------------------------------------------------------
  // Find
  // --------------------------------------------------------------------------------------------

  find(query: string, opts: Partial<Omit<FindUiState, "query" | "state" | "current" | "total">> = {}, findPrevious = false, again = false): void {
    const bus = this.eventBus;
    if (!bus) return;
    const find = { ...this.state.find, ...opts, query };
    this.set({ find: { ...find, state: query ? FindState.PENDING : null } });
    if (!query) {
      bus.dispatch("findbarclose", { source: this });
      this.set({ find: { ...find, state: null, current: 0, total: 0 } });
      return;
    }
    bus.dispatch("find", {
      source: this,
      type: again ? "again" : "",
      query,
      caseSensitive: find.caseSensitive,
      entireWord: find.entireWord,
      highlightAll: find.highlightAll,
      matchDiacritics: find.matchDiacritics,
      findPrevious,
    });
  }

  closeFind(): void {
    this.eventBus?.dispatch("findbarclose", { source: this });
    this.set({ find: { ...this.state.find, state: null, current: 0, total: 0 } });
  }

  // --------------------------------------------------------------------------------------------
  // Tools & annotations
  // --------------------------------------------------------------------------------------------

  setTool(tool: ToolId, payload: PlacementPayload | null = null): void {
    if (tool !== "select" && tool !== "hand" && tool !== "snapshot" && !this.canAnnotate) {
      toast("warning", t("toast.annotationsLocked"));
      return;
    }
    this.inkMerge = null;
    this.set({ tool, payload });
    this.annotations.setState({ editing: null });
    if (isMarkupTool(tool)) {
      // A selection made before choosing the tool is applied immediately (Acrobat behaviour).
      this.markupFromSelection(tool);
    }
  }

  /** Enter the one-shot snapshot mode, remembering the tool to return to. */
  startSnapshot(): void {
    if (this.state.tool === "snapshot") return;
    this.beforeSnapshot = { tool: this.state.tool, payload: this.state.payload };
    this.setTool("snapshot");
  }

  /** Leave snapshot mode and go back to the tool that was active before it. */
  endSnapshot(): void {
    if (this.state.tool !== "snapshot") return;
    const prev = this.beforeSnapshot;
    this.beforeSnapshot = null;
    if (prev && prev.tool !== "snapshot") this.setTool(prev.tool, prev.payload);
    else this.setTool("select");
  }

  /** Called after a tool finished creating an annotation. */
  toolDone(): void {
    if (!settings().annotations.keepTool) this.set({ tool: "select", payload: null });
  }

  /** Author written on new comments: the configured name, else the operating-system user. */
  author(): string {
    return settings().annotations.author.trim() || appInfo()?.userName || "";
  }

  /** Create text markup annotations from the current text selection. */
  markupFromSelection(tool: "highlight" | "underline" | "strikeout" | "squiggly"): boolean {
    const viewer = this.viewer;
    if (!viewer || !this.canAnnotate) return false;
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !this.container?.contains(sel.anchorNode)) return false;
    const quads = selectionToQuads(viewer, sel);
    if (!quads) return false;
    const created: Annotation[] = [];
    for (const [page, points] of quads.byPage) {
      const rect = quadsBounds(points);
      const a = createStyled(tool, page, rect, settings(), this.author());
      if (!a) continue;
      a.quadPoints = points;
      created.push(a);
    }
    sel.removeAllRanges();
    this.set({ selection: null });
    if (!created.length) return false;
    this.commit(
      t("history.add", { kind: t(kindLabelKey(created[0])) }),
      created.map((a) => ({ id: a.id, before: null, after: a })),
    );
    this.select(created.map((a) => a.id));
    this.toolDone();
    return true;
  }

  /** Apply + record a change set. */
  commit(label: string, changes: Change[], mergeKey?: string): void {
    if (!changes.length) return;
    applyChanges(this.annotations, changes);
    this.history.pushAnnotations(label, changes, mergeKey);
    this.refreshHidden();
  }

  getAnnotation(id: string): Annotation | undefined {
    return this.annotations.getState().items[id];
  }

  addAnnotation(a: Annotation, opts: { select?: boolean; edit?: boolean } = {}): void {
    this.commit(t("history.add", { kind: t(kindLabelKey(a)) }), [{ id: a.id, before: null, after: a }]);
    if (opts.select !== false) this.select([a.id]);
    if (opts.edit) this.annotations.setState({ editing: a.id });
    if (settings().annotations.showCommentsPane && !useUi.getState().commentsPane) useUi.setState({ commentsPane: true });
  }

  /**
   * Update one annotation. `mergeKey` merges rapid successive updates (slider drags, typing)
   * into one undo step.
   */
  updateAnnotation(
    id: string,
    patch: Partial<Annotation> | ((a: Annotation) => Annotation),
    opts: { label?: string; mergeKey?: string } = {},
  ): void {
    const before = this.getAnnotation(id);
    if (!before || before.locked) return;
    const next = typeof patch === "function" ? patch(before) : { ...before, ...patch };
    const after: Annotation = { ...next, modified: nowIso() };
    this.commit(opts.label ?? t("history.edit", { kind: t(kindLabelKey(before)) }), [{ id, before, after }], opts.mergeKey);
  }

  updateMany(ids: string[], patch: Partial<Annotation>, opts: { label?: string; mergeKey?: string } = {}): void {
    const items = this.annotations.getState().items;
    const changes: Change[] = [];
    for (const id of ids) {
      const before = items[id];
      if (!before || before.locked) continue;
      changes.push({ id, before, after: { ...before, ...patch, modified: nowIso() } });
    }
    if (!changes.length) return;
    const first = changes[0].before!;
    this.commit(opts.label ?? t("history.style", { kind: t(kindLabelKey(first)) }), changes, opts.mergeKey);
  }

  /**
   * Delete annotations together with their replies. Asks first when replies would be deleted
   * too (unless disabled in the settings or `confirmed`).
   */
  deleteAnnotations(ids: string[], opts: { confirmed?: boolean } = {}): void {
    const state = this.annotations.getState();
    const all = withDescendants(state, ids).filter((id) => state.items[id] && !state.items[id].locked);
    if (!all.length) return;
    const replies = all.length - ids.filter((id) => all.includes(id)).length;
    if (replies > 0 && !opts.confirmed && settings().annotations.confirmDeleteReplies) {
      void openDialog("confirm", {
        title: t("dialog.deleteReplies.title"),
        message: t("dialog.deleteReplies.message", { count: replies }),
        confirmLabel: t("common.delete"),
        danger: true,
      }).then((answer) => {
        if (answer.choice === "confirm") this.deleteAnnotations(ids, { confirmed: true });
      });
      return;
    }
    const first = state.items[all[0]];
    const label =
      ids.length === 1 ? t("history.delete", { kind: t(kindLabelKey(first)) }) : t("history.deleteMany", { count: ids.length });
    this.commit(
      label,
      all.map((id) => ({ id, before: state.items[id], after: null })),
    );
  }

  addReply(parentId: string, text: string): void {
    const parent = this.getAnnotation(parentId);
    if (!parent || !text.trim()) return;
    const reply: Annotation = {
      ...createStyled("note", parent.page, [parent.rect[0], parent.rect[3] - 20, parent.rect[0] + 20, parent.rect[3]], settings(), this.author())!,
      contents: text.trim(),
      inReplyTo: parentId,
      replyType: "R",
      color: parent.color,
    };
    this.commit(t("history.reply"), [{ id: reply.id, before: null, after: reply }]);
  }

  setReviewState(parentId: string, state: string): void {
    const parent = this.getAnnotation(parentId);
    if (!parent) return;
    const reply: Annotation = {
      ...createStyled("note", parent.page, [parent.rect[0], parent.rect[3] - 20, parent.rect[0] + 20, parent.rect[3]], settings(), this.author())!,
      contents: state === "None" ? "" : t(`annots.status.${state.toLowerCase()}` as never),
      inReplyTo: parentId,
      replyType: "R",
      state,
      stateModel: "Review",
    };
    this.commit(t("history.status"), [{ id: reply.id, before: null, after: reply }]);
  }

  /** Latest review state set on an annotation (Acrobat semantics). */
  reviewState(id: string): string | null {
    const items = Object.values(this.annotations.getState().items).filter(
      (a) => a.inReplyTo === id && a.stateModel === "Review" && a.state,
    );
    items.sort((a, b) => (a.created ?? a.modified ?? "").localeCompare(b.created ?? b.modified ?? ""));
    return items.at(-1)?.state ?? null;
  }

  select(ids: string[]): void {
    const cur = this.annotations.getState().selection;
    if (cur.length === ids.length && cur.every((id, i) => id === ids[i])) return;
    this.annotations.setState({ selection: ids, editing: null });
  }

  clearSelection(): void {
    const st = this.annotations.getState();
    if (st.selection.length || st.editing) this.annotations.setState({ selection: [], editing: null });
  }

  setEditing(id: string | null): void {
    this.annotations.setState({ editing: id, ...(id ? { selection: [id] } : {}) });
  }

  setHover(id: string | null): void {
    if (this.annotations.getState().hover !== id) this.annotations.setState({ hover: id });
  }

  /** Strokes drawn in quick succession are merged into one ink annotation (like Acrobat). */
  addInkStroke(page: number, stroke: number[]): void {
    const now = Date.now();
    const merge = this.inkMerge;
    const target = merge && now - merge.time < 1500 ? this.getAnnotation(merge.id) : undefined;
    const pad = 0;
    if (target && target.page === page && target.kind === "ink") {
      const inkList = [...target.inkList, stroke];
      this.updateAnnotation(
        target.id,
        { inkList, rect: inkBounds(inkList, target.borderWidth + pad) },
        { label: t("history.add", { kind: t("kind.ink") }), mergeKey: `ink:${target.id}` },
      );
      this.inkMerge = { id: target.id, time: now };
      return;
    }
    const a = createStyled("ink", page, [0, 0, 0, 0], settings(), this.author());
    if (!a) return;
    a.inkList = [stroke];
    a.rect = inkBounds(a.inkList, a.borderWidth + pad);
    this.addAnnotation(a, { select: false });
    this.inkMerge = { id: a.id, time: now };
  }

  finishInkSession(): void {
    this.inkMerge = null;
  }

  // --------------------------------------------------------------------------------------------
  // Undo / redo
  // --------------------------------------------------------------------------------------------

  async undo(): Promise<void> {
    const cmd = this.history.undo();
    if (!cmd) return;
    if (cmd.type === "annotations") {
      applyChanges(this.annotations, invertChanges(cmd.changes));
      this.refreshHidden();
    } else {
      await this.swapBase(cmd.before);
    }
  }

  async redo(): Promise<void> {
    const cmd = this.history.redo();
    if (!cmd) return;
    if (cmd.type === "annotations") {
      applyChanges(this.annotations, cmd.changes);
      this.refreshHidden();
    } else {
      await this.swapBase(cmd.after);
    }
  }

  // --------------------------------------------------------------------------------------------
  // Saving
  // --------------------------------------------------------------------------------------------

  setInfoUpdate(update: InfoUpdate | null): void {
    const next = update && Object.values(update).some((v) => v !== undefined) ? update : null;
    if (JSON.stringify(next) === JSON.stringify(this.state.info_update)) return;
    this.set({ info_update: next, infoDirty: true });
  }

  /** Bytes of the base document including current form values (pdf.js keeps the originals). */
  private async baseDocumentBytes(): Promise<{ bytes: Uint8Array; session: number | null }> {
    const pdf = this.pdf;
    if (!pdf) throw new AppError("INTERNAL", "no document");
    if (this.formsTouched) return { bytes: await pdf.saveDocument(), session: null };
    if (this.baseBytes) return { bytes: this.baseBytes, session: null };
    if (this.baseSession) return { bytes: new Uint8Array(0), session: this.baseSession.sessionId };
    return { bytes: await pdf.getData(), session: null };
  }

  /** Fonts used by the base document (Document Properties ▸ Fonts). */
  async listFonts(): Promise<DocumentFont[]> {
    const pdf = this.pdf;
    if (!pdf) return [];
    const password = this.password;
    if (this.baseBytes) return api.pdfFonts({ sourceSession: null, password }, this.baseBytes);
    if (this.baseSession) return api.pdfFonts({ sourceSession: this.baseSession.sessionId, password }, new Uint8Array(0));
    return api.pdfFonts({ sourceSession: null, password }, await pdf.getData());
  }

  /** Complete current document (annotations + forms + metadata) as bytes, without writing it. */
  async buildCurrentBytes(): Promise<Uint8Array> {
    const { changes, images } = serializeChanges(this.annotations.getState(), this.state.info_update, cjkHintForLocale(currentLocale()));
    let { bytes, session } = await this.baseDocumentBytes();
    if (session !== null) bytes = new Uint8Array(await api.docReadAll(session));
    return api.pdfBuild({ password: this.password, changes }, bytes, images);
  }

  /**
   * Save to `target` (defaults to the current path). Returns false when cancelled or failed
   * (errors are reported to the user).
   */
  async save(target: string | null = null): Promise<boolean> {
    if (!this.pdf || this.state.saving) return false;
    const info = this.diskSession;
    const destination = target ?? info?.path ?? null;
    if (!destination) return false;
    this.set({ saving: true });
    try {
      const { changes, images } = serializeChanges(this.annotations.getState(), this.state.info_update, cjkHintForLocale(currentLocale()));
      const base = await this.baseDocumentBytes();
      const result = await api.pdfSave(
        {
          target: destination,
          sourceSession: base.session,
          password: this.password,
          changes,
          keepBackup: settings().saving.keepBackup && destination === info?.path,
        },
        base.bytes,
        images,
      );
      this.history.markSaved();
      this.pdf.annotationStorage.resetModified();
      this.set({ formsDirty: false, infoDirty: false, disk: "ok" });
      // Track the file we just wrote (keep the base session: it still serves the old bytes).
      const newInfo = await api.docOpen(result.path);
      if (this.diskSession && this.diskSession !== this.baseSession) void api.docClose(this.diskSession.sessionId);
      this.diskSession = newInfo;
      this.path = newInfo.path;
      this.set({ info: newInfo, fileName: newInfo.fileName });
      void removeRecovery(newInfo.path);
      toast("success", t("save.saved", { name: newInfo.fileName }), result.backupPath ? { detail: t("save.backupKept") } : {});
      useLibrary.getState().addRecent({ path: newInfo.path, name: newInfo.fileName, pages: this.pdf.numPages, thumb: null }, settings().general.recentCount);
      return true;
    } catch (err) {
      const e = toAppError(err);
      log.error("save failed", e.message, e.detail ?? "");
      void openDialog("error", { title: t("save.failed", { name: this.state.fileName }), error: e });
      return false;
    } finally {
      this.set({ saving: false });
    }
  }

  /** Discard all changes and reload the file from disk. */
  async reload(): Promise<void> {
    const restore: ViewStateEntry = {
      page: this.state.page,
      scaleValue: this.state.scaleValue,
      layout: this.state.layout,
      rotation: this.state.rotation,
      sidebarOpen: this.state.sidebarOpen,
      sidebarPanel: this.state.sidebarPanel,
      dest: this.currentLocation()?.dest ?? null,
      updatedAt: Date.now(),
    };
    const container = this.container;
    this.teardownViewer();
    await this.disposeDocument();
    this.history.clear();
    this.nav.clear();
    this.thumbnails.invalidate();
    this.annotations.setState((s) => ({
      items: {},
      pristine: {},
      byPage: {},
      loaded: false,
      selection: [],
      editing: null,
      version: s.version + 1,
    }));
    this.set({ ...initialState(this.path), sidebarOpen: restore.sidebarOpen, sidebarPanel: restore.sidebarPanel });
    this.container = container;
    await this.open(restore);
    if (this.state.status === "ready") toast("info", t("toast.reloaded", { name: this.state.fileName }));
  }

  /** Check whether the file on disk changed (called when the window regains focus). */
  async checkDisk(): Promise<"ok" | "changed" | "deleted"> {
    const info = this.diskSession;
    if (!info) return "ok";
    try {
      const status = await api.docCheck(info.sessionId);
      const disk = !status.exists ? "deleted" : status.changed ? "changed" : "ok";
      this.set({ disk });
      return disk;
    } catch {
      return "ok";
    }
  }

  /** Mark the on-disk change as seen (user chose to keep the current version). */
  acknowledgeDiskChange(): void {
    this.set({ disk: "ok" });
    const path = this.diskSession?.path;
    if (!path) return;
    void api
      .docOpen(path)
      .then((info) => {
        if (this.diskSession && this.diskSession !== this.baseSession) void api.docClose(this.diskSession.sessionId);
        this.diskSession = info;
      })
      .catch(() => undefined);
  }

  // --------------------------------------------------------------------------------------------
  // Structural page operations
  // --------------------------------------------------------------------------------------------

  async applyPageOps(ops: PageOp[], sources: Uint8Array[] = [], label = t("history.pages")): Promise<void> {
    const pdf = this.pdf;
    if (!pdf || !ops.length) return;
    const beforeBytes = await this.currentBaseBytesForHistory();
    const before: BaseState = { bytes: beforeBytes, model: snapshot(this.annotations), page: this.state.page, info: this.state.info_update };
    const baked = await this.buildCurrentBytes();
    const result = await api.pdfPageOps({ password: this.password, ops }, baked, sources);
    // The viewer clamps the page when it is restored after the reload.
    const page = this.state.page;
    await this.replaceBase(result, page);
    const after: BaseState = { bytes: result, model: snapshot(this.annotations), page, info: null };
    this.history.pushBase(label, before, after);
  }

  /** Base bytes as they are now (materialised so the history can restore them later). */
  private async currentBaseBytesForHistory(): Promise<Uint8Array> {
    if (this.baseBytes) return this.baseBytes;
    if (this.baseSession) return new Uint8Array(await api.docReadAll(this.baseSession.sessionId));
    return (await this.pdf?.getData()) ?? new Uint8Array();
  }

  private async swapBase(state: BaseState): Promise<void> {
    await this.replaceBase(state.bytes, state.page, state.model);
    this.set({ info_update: state.info });
  }

  /** Replace the underlying PDF bytes (after page ops / undo of page ops). */
  private async replaceBase(bytes: Uint8Array, page: number, model?: BaseState["model"]): Promise<void> {
    const keepScale = this.state.scaleValue;
    const keepLayout = this.state.layout;
    this.pendingRestore = {
      page,
      scaleValue: keepScale,
      layout: keepLayout,
      rotation: this.state.rotation,
      sidebarOpen: this.state.sidebarOpen,
      sidebarPanel: this.state.sidebarPanel,
      dest: null,
      updatedAt: Date.now(),
    };
    this.teardownViewer();
    const old = this.pdf;
    this.pdf = null;
    // pdf.js transfers the buffer to the worker; keep our copy intact for the history.
    const loaded = await this.load({ kind: "data", data: bytes.slice() });
    await old?.loadingTask.destroy().catch(() => undefined);
    this.baseBytes = bytes;
    if (this.baseSession && this.baseSession !== this.diskSession) void api.docClose(this.baseSession.sessionId);
    this.baseSession = null;
    this.thumbnails.invalidate();
    await this.attachDocument(loaded);
    // Metadata overrides were baked into the new bytes.
    this.set({ info_update: null, infoDirty: false });
    if (model) {
      restoreSnapshot(this.annotations, model);
      this.refreshHidden(true);
    } else {
      await this.loadFileAnnotations(bytes);
    }
  }

  // --------------------------------------------------------------------------------------------
  // View state & recovery
  // --------------------------------------------------------------------------------------------

  private scheduleViewStateSave() {
    if (this.viewStateTimer) clearTimeout(this.viewStateTimer);
    this.viewStateTimer = setTimeout(() => this.saveViewState(), 1200);
  }

  saveViewState(): void {
    if (this.viewStateTimer) {
      clearTimeout(this.viewStateTimer);
      this.viewStateTimer = null;
    }
    const info = this.diskSession;
    if (!info || !this.viewer || !settings().general.rememberView) return;
    const s = this.state;
    useLibrary.getState().setViewState(info.path, {
      page: s.page,
      scaleValue: s.scaleValue,
      layout: s.layout,
      rotation: s.rotation,
      sidebarOpen: s.sidebarOpen,
      sidebarPanel: s.sidebarPanel,
      dest: this.currentLocation()?.dest ?? null,
    });
  }

  private startRecoveryTimer() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    const s = settings().saving;
    if (!s.recovery) return;
    let lastVersion = -1;
    this.recoveryTimer = setInterval(() => {
      const info = this.diskSession;
      const version = this.annotations.getState().version;
      if (!info || version === lastVersion) return;
      lastVersion = version;
      if (!this.history.dirty || this.baseBytes) {
        void removeRecovery(info.path);
        return;
      }
      void writeRecovery({
        path: info.path,
        fileSize: info.size,
        fileModifiedMs: info.modifiedMs,
        savedAt: Date.now(),
        payload: recoveryPayload(this.annotations.getState()),
      });
    }, s.recoveryInterval * 1000);
  }

  private async checkRecovery() {
    const info = this.diskSession;
    if (!info || !settings().saving.recovery) return;
    const entry = await readRecovery(info.path);
    if (!entry) return;
    if (entry.fileSize !== info.size || entry.fileModifiedMs !== info.modifiedMs) {
      void removeRecovery(info.path);
      return;
    }
    const answer = await openDialog("confirm", {
      title: t("dialog.recovery.title"),
      message: t("dialog.recovery.message", { name: info.fileName, time: new Date(entry.savedAt).toLocaleString(currentLocale()) }),
      confirmLabel: t("dialog.recovery.restore"),
      cancelLabel: t("dialog.recovery.discard"),
    });
    if (answer.choice === "confirm") {
      const changes = await restoreRecoveryPayload(this.annotations.getState(), entry.payload);
      if (changes.length) this.commit(t("dialog.recovery.restore"), changes);
    } else {
      void removeRecovery(info.path);
    }
  }

  // --------------------------------------------------------------------------------------------
  // Misc
  // --------------------------------------------------------------------------------------------

  /** Snapshot tool: copy a page region (PDF user space) to the clipboard as an image. */
  copyRegionImage(pageIndex: number, rect: [number, number, number, number]): Promise<void> {
    return captureRegion(this, pageIndex, rect);
  }

  /** Forget the crash-recovery snapshot (the user saved or deliberately discarded the changes). */
  async discardRecovery(): Promise<void> {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    const path = this.diskSession?.path;
    if (path) await removeRecovery(path);
  }

  /** Free render caches while the tab is in the background. */
  async suspend(): Promise<void> {
    const viewer = this.viewer;
    if (!viewer) return;
    for (let i = 0; i < viewer.pagesCount; i++) {
      const view = viewer.getPageView(i);
      if (view && view.renderingState !== RenderingState.INITIAL) view.reset();
    }
    this.thumbnails.invalidate();
    await this.pdf?.cleanup().catch(() => undefined);
    log.debug(`suspended ${this.state.fileName}`);
  }

  resume(): void {
    this.viewer?.update();
  }

  newAnnotationId(): string {
    return newId();
  }

  private async disposeDocument() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    const pdf = this.pdf;
    this.pdf = null;
    this.hidden = null;
    await (this.loadingTask ?? pdf?.loadingTask)?.destroy().catch(() => undefined);
    this.loadingTask = null;
    const sessions = new Set([this.baseSession?.sessionId, this.diskSession?.sessionId]);
    for (const id of sessions) if (id !== undefined) void api.docClose(id).catch(() => undefined);
    this.baseSession = null;
    this.diskSession = null;
    this.baseBytes = null;
  }

  /** Close for good. Callers must have dealt with unsaved changes. */
  async destroy(discardRecovery = true): Promise<void> {
    if (this.destroyed) return;
    const path = this.diskSession?.path;
    this.teardownViewer();
    this.destroyed = true;
    for (const d of this.disposers) d();
    this.disposers = [];
    if (this.viewStateTimer) clearTimeout(this.viewStateTimer);
    this.thumbnails.destroy();
    await this.disposeDocument();
    if (discardRecovery && path) void removeRecovery(path);
  }
}

function maxCanvasPixels(s: Settings): number {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  switch (s.performance.renderQuality) {
    case "saver":
      return 4_194_304;
    case "high":
      return Math.round(33_554_432 * Math.max(1, dpr / 1.5));
    case "ultra":
      return 67_108_864;
    default:
      return 16_777_216;
  }
}

function inkBounds(strokes: number[][], pad: number): [number, number, number, number] {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const s of strokes) {
    for (let i = 0; i + 1 < s.length; i += 2) {
      x1 = Math.min(x1, s[i]);
      y1 = Math.min(y1, s[i + 1]);
      x2 = Math.max(x2, s[i]);
      y2 = Math.max(y2, s[i + 1]);
    }
  }
  return [x1 - pad, y1 - pad, x2 + pad, y2 + pad];
}
