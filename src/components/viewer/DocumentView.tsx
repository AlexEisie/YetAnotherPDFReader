/**
 * The document viewport of one tab: pdf.js scroll container, annotation overlays, floating UI,
 * loading / error states, hand-tool panning and page-flip keyboard handling.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle, FileWarning, RefreshCw, X } from "lucide-react";
import type { DocumentController } from "../../document/DocumentController";
import { useDocState } from "../../hooks/useDoc";
import { useT } from "../../i18n";
import { capturesPointer, isMarkupTool } from "../../annotations/tools";
import { PageOverlay } from "../annotations/PageOverlay";
import { OrganizeView } from "../organize/OrganizeView";
import { FloatingLayer } from "../annotations/FloatingLayer";
import { settings, useSettings } from "../../settings/store";
import { closeTab } from "../../state/tabs";
import { ScrollMode } from "../../document/layout";
import { isEditableTarget } from "../../commands/keys";
import { capturePointer } from "../../lib/dom";

const NO_PAGES: number[] = [];

function Overlays({ c }: { c: DocumentController }) {
  const epoch = useDocState(c, (s) => s.status, "loading");
  const layers = c.layers;
  const subscribe = useCallback((cb: () => void) => (layers ? layers.subscribe(cb) : () => {}), [layers]);
  const pages = useSyncExternalStore(subscribe, () => layers?.activePages() ?? NO_PAGES);
  if (!layers || epoch !== "ready") return null;
  return (
    <>
      {pages.map((p) => (
        <PageOverlay key={p} c={c} pageNumber={p} layers={layers.get(p)} />
      ))}
    </>
  );
}

function StatusView({ c }: { c: DocumentController }) {
  const t = useT();
  const status = useDocState(c, (s) => s.status, "loading");
  const error = useDocState(c, (s) => s.error, null);
  const progress = useDocState(c, (s) => s.progress, null);
  const fileName = useDocState(c, (s) => s.fileName, "");
  const [showDetails, setShowDetails] = useState(false);
  if (status === "ready" || status === "cancelled") return null;
  if (status === "loading") {
    return (
      <div className="doc-status">
        <div className="spinner large" />
        <div>{t("common.loading")}</div>
        {progress !== null && (
          <div className="progress">
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
      </div>
    );
  }
  const code = error?.code ?? "INTERNAL";
  return (
    <div className="doc-status">
      <div className="error-card">
        <FileWarning size={42} color="var(--danger)" />
        <h2>{t("error.loadFailedTitle")}</h2>
        <div className="muted">{fileName}</div>
        <p>{t(`error.${code}` as never)}</p>
        {error && (error.detail || error.message) && (
          <>
            <button type="button" className="btn ghost small" onClick={() => setShowDetails(!showDetails)}>
              {showDetails ? t("common.hideDetails") : t("common.showDetails")}
            </button>
            {showDetails && <div className="details-box" style={{ width: "100%" }}>{[error.message, error.detail].filter(Boolean).join("\n\n")}</div>}
          </>
        )}
        <div className="row">
          <button type="button" className="btn primary" onClick={() => void c.open()}>
            <RefreshCw size={15} /> {t("common.retry")}
          </button>
          <button type="button" className="btn" onClick={() => void closeTab(c.tabId)}>
            <X size={15} /> {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

function PageIndicator({ c }: { c: DocumentController }) {
  const page = useDocState(c, (s) => s.page, 1);
  const label = useDocState(c, (s) => s.pageLabel, null);
  const numPages = useDocState(c, (s) => s.numPages, 0);
  const enabled = useSettings((s) => s.settings.reading.pageIndicator);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = c.scrollContainer;
    if (!el || !enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const on = () => {
      setVisible(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setVisible(false), 900);
    };
    el.addEventListener("scroll", on, { passive: true });
    return () => {
      el.removeEventListener("scroll", on);
      if (timer) clearTimeout(timer);
    };
  }, [c, enabled, numPages]);
  if (!enabled || !numPages) return null;
  return (
    <div className={`page-indicator${visible ? " visible" : ""}`}>
      {label && label !== String(page) ? `${label} · ` : ""}
      {page} / {numPages}
    </div>
  );
}

function DiskBanner({ c }: { c: DocumentController }) {
  const t = useT();
  const disk = useDocState(c, (s) => s.disk, "ok");
  const dirty = useDocState(c, (s) => s.history.dirty || s.formsDirty, false);
  const fileName = useDocState(c, (s) => s.fileName, "");
  if (disk === "ok") return null;
  return (
    <div className="findbar" style={{ left: "50%", right: "auto", transform: "translateX(-50%)", gap: 10, padding: "8px 10px" }} role="alert">
      <AlertTriangle size={18} color="var(--warning)" />
      <span style={{ maxWidth: 420 }}>
        {disk === "deleted" ? t("dialog.deleted.message", { name: fileName }) : t("dialog.changed.message", { name: fileName })}
        {disk === "changed" && dirty && <span className="muted"> {t("dialog.changed.detailDirty")}</span>}
      </span>
      {disk === "changed" && (
        <button type="button" className="btn small primary" onClick={() => void c.reload()}>
          {t("dialog.changed.reload")}
        </button>
      )}
      <button type="button" className="btn small" onClick={() => c.acknowledgeDiskChange()}>
        {disk === "changed" ? t("dialog.changed.keep") : t("common.ok")}
      </button>
    </div>
  );
}

const INTERACTIVE = "a, input, textarea, select, button, .annot-hit, .annot-handle, .annot-selection-box, .annot-freetext-editor, .linkAnnotation, .buttonWidgetAnnotation, .textWidgetAnnotation, .choiceWidgetAnnotation";

export function DocumentView({ c, active }: { c: DocumentController; active: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const tool = useDocState(c, (s) => s.tool, "select");
  const organizing = useDocState(c, (s) => s.organizing, false);
  const status = useDocState(c, (s) => s.status, "loading");

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    c.mount(el);
    setRoot(rootRef.current);
    return () => c.unmount();
  }, [c]);

  // Re-apply page colours once the viewer exists (theme may already be dark).
  useEffect(() => {
    if (status === "ready") c.applyPageColors();
  }, [c, status]);

  useEffect(() => {
    if (!active || status !== "ready") return;
    requestAnimationFrame(() => {
      // Never steal focus from dialogs, menus or text fields.
      const focused = document.activeElement as HTMLElement | null;
      if (focused?.closest(".dialog, .menu, .popover, .settings-view, input, textarea, [contenteditable='true']")) return;
      containerRef.current?.focus({ preventScroll: true });
    });
  }, [active, status]);

  // Hand tool, middle-button and Space panning; clearing the selection on empty clicks.
  useEffect(() => {
    const el = containerRef.current;
    const rootEl = rootRef.current;
    if (!el || !rootEl) return;
    let spaceHeld = false;
    let spaceDragged = false;

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(INTERACTIVE) && !target.closest(".floating-layer")) {
        if (!isEditableTarget(target)) el.focus({ preventScroll: true });
        if (e.button === 0 && !capturesPointer(c.state.tool)) c.clearSelection();
      }
      const nav = settings().navigation;
      const middle = e.button === 1 && nav.middleClickPan;
      const hand = e.button === 0 && (c.state.tool === "hand" || spaceHeld);
      if (!middle && !hand) return;
      if (!middle && target.closest(INTERACTIVE)) return;
      e.preventDefault();
      const sx = e.clientX;
      const sy = e.clientY;
      const left = el.scrollLeft;
      const top = el.scrollTop;
      rootEl.classList.add("panning");
      capturePointer(el, e.pointerId);
      const move = (ev: PointerEvent) => {
        spaceDragged = true;
        el.scrollLeft = left - (ev.clientX - sx);
        el.scrollTop = top - (ev.clientY - sy);
      };
      const up = () => {
        rootEl.classList.remove("panning");
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    };

    const pageMode = () => c.viewer?.scrollMode === ScrollMode.PAGE;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || e.ctrlKey || e.altKey || e.metaKey) return;
      const nav = settings().navigation;
      const noHScroll = el.scrollWidth <= el.clientWidth + 1;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
      const atTop = el.scrollTop <= 1;
      let handled = true;
      switch (e.key) {
        case " ":
          if (!e.repeat && nav.spaceToPan) {
            spaceHeld = true;
            spaceDragged = false;
            rootEl.dataset.tool = "hand";
          }
          break;
        case "PageDown":
          if (pageMode() && atBottom) c.nextPage();
          else handled = false;
          break;
        case "PageUp":
          if (pageMode() && atTop) c.previousPage();
          else handled = false;
          break;
        case "ArrowRight":
          if ((pageMode() || nav.pageKeysTurnPage) && noHScroll) c.nextPage();
          else handled = false;
          break;
        case "ArrowLeft":
          if ((pageMode() || nav.pageKeysTurnPage) && noHScroll) c.previousPage();
          else handled = false;
          break;
        case "ArrowDown":
          if (pageMode() && atBottom) c.nextPage();
          else handled = false;
          break;
        case "ArrowUp":
          if (pageMode() && atTop) c.previousPage();
          else handled = false;
          break;
        default:
          handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== " " || !spaceHeld) return;
      spaceHeld = false;
      rootEl.dataset.tool = c.state.tool;
      if (!spaceDragged) {
        // A plain tap of Space pages down (or back with Shift), like a browser.
        const dir = e.shiftKey ? -1 : 1;
        if (pageMode()) {
          if (dir > 0) c.nextPage();
          else c.previousPage();
        } else c.scrollBy(0, dir * el.clientHeight * 0.9);
      }
      e.preventDefault();
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("keyup", onKeyUp);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("keyup", onKeyUp);
    };
  }, [c]);

  return (
    <div
      ref={rootRef}
      className="yapr-viewer-root"
      data-tool={tool}
      data-capture={capturesPointer(tool) ? "" : undefined}
      data-markup-tool={isMarkupTool(tool) ? "" : undefined}
    >
      <div ref={containerRef} className="yapr-scroll" tabIndex={-1}>
        <div className="pdfViewer" />
      </div>
      <Overlays c={c} />
      <FloatingLayer c={c} root={root} />
      <PageIndicator c={c} />
      {tool === "snapshot" && <SnapshotGuide c={c} />}
      {organizing && <OrganizeView c={c} />}
      <DiskBanner c={c} />
      <StatusView c={c} />
    </div>
  );
}

/** Guide shown while the one-shot snapshot mode is active. */
function SnapshotGuide({ c }: { c: DocumentController }) {
  const t = useT();
  return (
    <div className="snapshot-guide" role="status">
      <span>{t("snapshot.guide")}</span>
      <button type="button" onClick={() => c.endSnapshot()}>
        {t("common.cancel")}
        <kbd>Esc</kbd>
      </button>
    </div>
  );
}
