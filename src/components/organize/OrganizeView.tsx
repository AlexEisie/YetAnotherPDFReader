/**
 * Page organizer: a grid of page thumbnails covering the viewer, for rearranging documents.
 *
 * Select pages (click, Ctrl / Shift + click, rubber-band free keyboard selection), drag them to
 * a new place, drop PDFs or pictures from the file manager between pages, and rotate, flip,
 * duplicate, replace, extract, delete or split from the toolbar, the context menu, the hover
 * buttons or the keyboard. Every change is one undoable step.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  FlipHorizontal2 as FlipTopBottom,
  FlipVertical2 as FlipLeftRight,
  Copy,
  Droplets,
  FilePlus2,
  FileOutput,
  Plus,
  Replace,
  RotateCcw,
  RotateCw,
  Scissors,
  Lock,
  Trash2,
  X,
} from "lucide-react";
import type { DocumentController } from "../../document/DocumentController";
import { ThumbnailService, type Thumbnail } from "../../document/thumbnails";
import { orderMoving } from "../../document/pageEditing";
import { useDocState } from "../../hooks/useDoc";
import { useT } from "../../i18n";
import { toAppError } from "../../lib/errors";
import { useSettings } from "../../settings/store";
import { openDialog, setBusy, toast } from "../../state/ui";
import { setFileDropTarget } from "../../state/fileDrop";
import { Menu, type MenuAnchor, type MenuEntry } from "../common/Menu";

const PAD = 24;
const CELL_GAP = 22;
const LABEL_H = 30;

interface Grid {
  cols: number;
  cellW: number;
  cellH: number;
  slotW: number;
  slotH: number;
}

function PageCard({
  service,
  page,
  slotW,
  slotH,
  selected,
  focused,
  dragging,
  label,
  canEdit,
  onPointerDown,
  onDouble,
  onContext,
  onRotate,
  onDelete,
  onInsertBefore,
}: {
  service: ThumbnailService;
  page: number;
  slotW: number;
  slotH: number;
  selected: boolean;
  focused: boolean;
  dragging: boolean;
  label: string;
  canEdit: boolean;
  onPointerDown: (e: React.PointerEvent, page: number) => void;
  onDouble: (page: number) => void;
  onContext: (e: React.MouseEvent, page: number) => void;
  onRotate: (page: number, delta: number) => void;
  onDelete: (page: number) => void;
  onInsertBefore: (e: React.MouseEvent, page: number) => void;
}) {
  const t = useT();
  const [thumb, setThumb] = useState<Thumbnail | null>(() => service.peek(page));
  useEffect(() => {
    let alive = true;
    const cached = service.peek(page);
    setThumb(cached);
    if (!cached) void service.request(page).then((th) => alive && th && setThumb(th));
    return () => {
      alive = false;
    };
  }, [service, page]);

  let w = slotW;
  let h = slotH;
  if (thumb) {
    const ratio = thumb.height / thumb.width;
    if (ratio * slotW <= slotH) h = ratio * slotW;
    else w = slotH / ratio;
  }
  return (
    <div
      className={`org-card${selected ? " selected" : ""}${focused ? " focused" : ""}${dragging ? " dragging" : ""}`}
      data-page={page}
      role="option"
      aria-selected={selected}
      onPointerDown={(e) => onPointerDown(e, page)}
      onDoubleClick={() => onDouble(page)}
      onContextMenu={(e) => onContext(e, page)}
    >
      <div className="org-slot" style={{ width: slotW, height: slotH }}>
        <div className="org-thumb" style={{ width: w, height: h }}>
          {thumb ? <img src={thumb.url} alt="" draggable={false} /> : <div className="org-thumb-loading" />}
        </div>
        {selected && (
          <span className="org-check" aria-hidden>
            <Check size={13} strokeWidth={3} />
          </span>
        )}
        {canEdit && (
          <div className="org-quick" onPointerDown={(e) => e.stopPropagation()}>
            <button type="button" className="icon-btn small" data-tip={t("organize.rotateCcw")} onClick={() => onRotate(page, -90)}>
              <RotateCcw size={15} />
            </button>
            <button type="button" className="icon-btn small" data-tip={t("organize.rotateCw")} onClick={() => onRotate(page, 90)}>
              <RotateCw size={15} />
            </button>
            <button type="button" className="icon-btn small danger" data-tip={t("common.delete")} onClick={() => onDelete(page)}>
              <Trash2 size={15} />
            </button>
          </div>
        )}
      </div>
      {canEdit && (
        <button
          type="button"
          className="org-insert"
          data-tip={t("organize.insertHere")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => onInsertBefore(e, page)}
        >
          <Plus size={14} strokeWidth={2.5} />
        </button>
      )}
      <div className="org-label">{label}</div>
    </div>
  );
}

export function OrganizeView({ c }: { c: DocumentController }) {
  const t = useT();
  const numPages = useDocState(c, (s) => s.numPages, 0);
  const docVersion = useDocState(c, (s) => s.docVersion, 0);
  const permissions = useDocState(c, (s) => s.permissions, null);
  const size = useSettings((s) => s.settings.ui.organizeSize);
  const setSetting = useSettings((s) => s.set);
  const respect = useSettings((s) => s.settings.saving.respectRestrictions);
  const canEdit = !respect || !!permissions?.assemble || !!permissions?.modify;

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(900);
  const [viewH, setViewH] = useState(600);
  const [scrollTop, setScrollTop] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(() => new Set([c.state.page]));
  const [anchor, setAnchor] = useState<number>(c.state.page);
  const [focus, setFocus] = useState<number>(c.state.page);
  const [drag, setDrag] = useState<{ pages: number[]; gap: number } | null>(null);
  const [fileGap, setFileGap] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; entries: MenuEntry[] } | null>(null);
  const [working, setWorking] = useState(false);
  const labelsRef = useRef<string[] | null>(null);
  const [, setTick] = useState(0);

  // Own thumbnail cache at organizer size; rebuilt whenever the document changes.
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const [service, setService] = useState<ThumbnailService | null>(null);
  useEffect(() => {
    const next = new ThumbnailService(() => c.pdf, () => Math.round(sizeRef.current * (window.devicePixelRatio || 1)), () => 0);
    setService(next);
    return () => next.destroy();
  }, [c, docVersion]);

  useEffect(() => {
    c.pdf
      ?.getPageLabels()
      .then((labels) => {
        labelsRef.current = labels;
        setTick((n) => n + 1);
      })
      .catch(() => undefined);
  }, [c, docVersion]);

  // Drop selections that no longer exist (pages deleted, undo, …).
  useEffect(() => {
    setSelected((s) => {
      const next = new Set([...s].filter((p) => p <= numPages));
      return next.size === s.size ? s : next;
    });
    setFocus((f) => Math.min(Math.max(1, f), Math.max(1, numPages)));
  }, [numPages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewW(el.clientWidth);
      setViewH(el.clientHeight);
    });
    ro.observe(el);
    rootRef.current?.focus();
    return () => ro.disconnect();
  }, []);

  const grid: Grid = useMemo(() => {
    const slotW = size;
    const slotH = Math.round(size * 1.414);
    const cellW = slotW + 24;
    const cellH = slotH + LABEL_H + 12;
    const cols = Math.max(1, Math.floor((viewW - 2 * PAD + CELL_GAP) / (cellW + CELL_GAP)));
    return { cols, cellW, cellH, slotW, slotH };
  }, [size, viewW]);

  // One extra cell for the "add pages" tile.
  const items = numPages + (canEdit ? 1 : 0);
  const rows = Math.ceil(items / grid.cols);
  const rowH = grid.cellH + CELL_GAP;
  const firstRow = Math.max(0, Math.floor((scrollTop - PAD) / rowH) - 1);
  const lastRow = Math.min(rows - 1, Math.ceil((scrollTop + viewH) / rowH) + 1);
  const left0 = Math.max(PAD, (viewW - (grid.cols * grid.cellW + (grid.cols - 1) * CELL_GAP)) / 2);
  const cellPos = (index: number) => ({
    x: left0 + (index % grid.cols) * (grid.cellW + CELL_GAP),
    y: PAD + Math.floor(index / grid.cols) * rowH,
  });

  const visible = useMemo(() => {
    const out: number[] = [];
    for (let r = firstRow; r <= lastRow; r++) {
      for (let col = 0; col < grid.cols; col++) {
        const p = r * grid.cols + col + 1;
        if (p <= numPages) out.push(p);
      }
    }
    return out;
  }, [firstRow, lastRow, grid.cols, numPages]);
  useEffect(() => service?.cancelExcept(new Set(visible)), [service, visible]);

  /** Insertion gap (0..numPages) under a client point. */
  const gapAt = useCallback(
    (clientX: number, clientY: number): number => {
      const el = scrollRef.current;
      if (!el) return numPages;
      const rect = el.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top + el.scrollTop - PAD;
      const row = Math.max(0, Math.floor(y / rowH));
      const colF = (x - left0 + CELL_GAP / 2) / (grid.cellW + CELL_GAP);
      const col = Math.max(0, Math.min(grid.cols - 1, Math.floor(colF)));
      const half = colF - Math.floor(colF) > 0.5 ? 1 : 0;
      return Math.max(0, Math.min(numPages, row * grid.cols + col + (colF < 0 ? 0 : half)));
    },
    [numPages, rowH, left0, grid.cellW, grid.cols],
  );

  const sorted = useMemo(() => [...selected].sort((a, b) => a - b), [selected]);
  const labelOf = (p: number) => labelsRef.current?.[p - 1] || String(p);

  const close = useCallback(() => c.setOrganizing(false), [c]);

  // ------------------------------------------------------------------------------- operations

  const run = useCallback(
    async (fn: () => Promise<void>, select?: (pages: number) => number[] | null) => {
      if (working) return;
      setWorking(true);
      setBusy(t("pageops.working"));
      try {
        await fn();
        const next = select?.(c.state.numPages);
        if (next) {
          setSelected(new Set(next));
          if (next.length) {
            setAnchor(next[0]);
            setFocus(next[0]);
          }
        }
      } catch (err) {
        toast("error", toAppError(err).message);
      } finally {
        setBusy(null);
        setWorking(false);
        rootRef.current?.focus();
      }
    },
    [c, t, working],
  );

  const pagesFor = (p?: number) => (p !== undefined && !selected.has(p) ? [p] : sorted);

  const rotate = (delta: number, pages = sorted) =>
    pages.length &&
    void run(() => c.applyPageOps([{ op: "rotate", pages: pages.map((p) => p - 1), delta }], [], t(delta > 0 ? "organize.rotateCw" : "organize.rotateCcw")));

  const flip = (horizontal: boolean, pages = sorted) =>
    pages.length &&
    void run(() => c.applyPageOps([{ op: "flip", pages: pages.map((p) => p - 1), horizontal }], [], t(horizontal ? "organize.flipH" : "organize.flipV")));

  const duplicate = (pages = sorted) => {
    if (!pages.length) return;
    const at = pages[pages.length - 1];
    void run(
      () => c.applyPageOps([{ op: "duplicate", pages: pages.map((p) => p - 1), at }], [], t("organize.duplicate")),
      () => pages.map((_, i) => at + 1 + i),
    );
  };

  const remove = (pages = sorted) => {
    if (!pages.length) return;
    if (pages.length >= numPages) {
      toast("warning", t("pageops.delete.all"));
      return;
    }
    void run(async () => {
      await c.applyPageOps([{ op: "delete", pages: pages.map((p) => p - 1) }], [], t("cmd.page.delete"));
      toast("success", t("organize.deleted", { count: pages.length }), {
        action: { label: t("cmd.edit.undo"), run: () => void c.undo() },
      });
    }, () => []);
  };

  const move = (pages: number[], gap: number) => {
    const order = orderMoving(numPages, pages, gap);
    if (!order) return;
    const moved = new Set(pages.map((p) => p - 1));
    void run(
      () => c.applyPageOps([{ op: "reorder", order }], [], t("history.pages")),
      () => order.map((old, i) => (moved.has(old) ? i + 1 : 0)).filter(Boolean),
    );
  };

  const insertBlank = (gap: number) => {
    const near = Math.min(Math.max(gap, 1), numPages);
    void run(
      async () => {
        const page = await c.pdf?.getPage(near);
        const [x0, y0, x1, y1] = page?.view ?? [0, 0, 595.28, 841.89];
        const [w, h] = [x1 - x0, y1 - y0];
        const rotated = ((page?.rotate ?? 0) / 90) % 2 === 1;
        await c.applyPageOps([{ op: "insertBlank", at: gap, count: 1, width: rotated ? h : w, height: rotated ? w : h }], [], t("cmd.page.insertBlank"));
      },
      () => [gap + 1],
    );
  };

  const insertFiles = (gap: number, paths?: string[]) => void openDialog("insertFiles", { tabId: c.tabId, at: gap, paths });

  const insertEntries = (gap: number): MenuEntry[] => [
    { type: "item", label: t("organize.insertFiles"), icon: FilePlus2, onSelect: () => insertFiles(gap) },
    { type: "item", label: t("organize.insertBlankQuick"), icon: Plus, onSelect: () => insertBlank(gap) },
  ];

  const pageEntries = (pages: number[]): MenuEntry[] => [
    { type: "item", label: t("organize.rotateCw"), icon: RotateCw, keys: "R", disabled: !canEdit, onSelect: () => rotate(90, pages) },
    { type: "item", label: t("organize.rotateCcw"), icon: RotateCcw, keys: "Shift+R", disabled: !canEdit, onSelect: () => rotate(-90, pages) },
    { type: "item", label: t("organize.flipH"), icon: FlipLeftRight, disabled: !canEdit, onSelect: () => flip(true, pages) },
    { type: "item", label: t("organize.flipV"), icon: FlipTopBottom, disabled: !canEdit, onSelect: () => flip(false, pages) },
    { type: "separator" },
    { type: "submenu", label: t("organize.insertBefore"), disabled: !canEdit, items: insertEntries(pages[0] - 1) },
    { type: "submenu", label: t("organize.insertAfter"), disabled: !canEdit, items: insertEntries(pages[pages.length - 1]) },
    { type: "item", label: t("organize.duplicate"), icon: Copy, keys: "Ctrl+D", disabled: !canEdit, onSelect: () => duplicate(pages) },
    { type: "item", label: t("organize.replace"), icon: Replace, disabled: !canEdit, onSelect: () => void openDialog("replacePages", { tabId: c.tabId, pages }) },
    { type: "item", label: t("cmd.page.extract"), icon: FileOutput, onSelect: () => void openDialog("pageOps", { tabId: c.tabId, mode: "extract", pages }) },
    { type: "item", label: t("watermark.title"), icon: Droplets, disabled: !canEdit, onSelect: () => void openDialog("watermark", { tabId: c.tabId, pages }) },
    { type: "separator" },
    { type: "item", label: t("organize.delete", { count: pages.length }), icon: Trash2, keys: "Delete", danger: true, disabled: !canEdit || pages.length >= numPages, onSelect: () => remove(pages) },
  ];

  // --------------------------------------------------------------------------------- pointer

  const onPointerDown = (e: React.PointerEvent, p: number) => {
    if (e.button !== 0 || working) return;
    rootRef.current?.focus();
    setFocus(p);
    if (e.ctrlKey || e.metaKey) {
      setSelected((s) => {
        const next = new Set(s);
        if (next.has(p)) next.delete(p);
        else next.add(p);
        return next;
      });
      setAnchor(p);
      return;
    }
    if (e.shiftKey) {
      const next = new Set<number>();
      for (let i = Math.min(anchor, p); i <= Math.max(anchor, p); i++) next.add(i);
      setSelected(next);
      return;
    }
    const pages = selected.has(p) ? sorted : [p];
    if (!selected.has(p)) {
      setSelected(new Set([p]));
      setAnchor(p);
    }
    if (!canEdit) return;
    const start = { x: e.clientX, y: e.clientY };
    let started = false;
    let gap = p - 1;
    let scrollTimer: ReturnType<typeof setInterval> | null = null;
    let lastY = e.clientY;
    const el = scrollRef.current!;
    const update = (x: number, y: number) => {
      gap = gapAt(x, y);
      setDrag({ pages, gap });
    };
    const moveHandler = (ev: PointerEvent) => {
      if (!started && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
      started = true;
      lastY = ev.clientY;
      update(ev.clientX, ev.clientY);
      const rect = el.getBoundingClientRect();
      const edge = ev.clientY < rect.top + 48 ? -1 : ev.clientY > rect.bottom - 48 ? 1 : 0;
      if (edge && !scrollTimer) {
        scrollTimer = setInterval(() => {
          const r = el.getBoundingClientRect();
          const dir = lastY < r.top + 48 ? -1 : lastY > r.bottom - 48 ? 1 : 0;
          if (!dir) return;
          el.scrollTop += dir * 18;
          update(ev.clientX, lastY);
        }, 30);
      } else if (!edge && scrollTimer) {
        clearInterval(scrollTimer);
        scrollTimer = null;
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", moveHandler);
      window.removeEventListener("pointerup", up);
      if (scrollTimer) clearInterval(scrollTimer);
      setDrag(null);
      if (started) move(pages, gap);
    };
    window.addEventListener("pointermove", moveHandler);
    window.addEventListener("pointerup", up);
  };

  const onContext = (e: React.MouseEvent, p: number) => {
    e.preventDefault();
    const pages = pagesFor(p);
    if (!selected.has(p)) {
      setSelected(new Set([p]));
      setAnchor(p);
    }
    setFocus(p);
    setMenu({ anchor: { x: e.clientX, y: e.clientY }, entries: pageEntries(pages) });
  };

  const openPage = (p: number) => {
    close();
    c.goToPage(p);
  };

  // ----------------------------------------------------------------------- dropped files

  useEffect(() => {
    if (!canEdit) return;
    return setFileDropTarget({
      label: () => t("organize.dropHint"),
      over: (_paths, x, y) => setFileGap(gapAt(x, y)),
      leave: () => setFileGap(null),
      drop: (paths, x, y) => {
        setFileGap(null);
        if (paths.length) insertFiles(gapAt(x, y), paths);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit, gapAt, t]);

  // ------------------------------------------------------------------------------ keyboard

  const scrollIntoView = (p: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const { y } = cellPos(p - 1);
    if (y < el.scrollTop) el.scrollTop = y - 8;
    else if (y + grid.cellH > el.scrollTop + el.clientHeight) el.scrollTop = y + grid.cellH - el.clientHeight + 8;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea, select")) return;
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    const go = (p: number) => {
      const target = Math.max(1, Math.min(numPages, p));
      setFocus(target);
      scrollIntoView(target);
      if (e.shiftKey) {
        const next = new Set<number>();
        for (let i = Math.min(anchor, target); i <= Math.max(anchor, target); i++) next.add(i);
        setSelected(next);
      } else {
        setSelected(new Set([target]));
        setAnchor(target);
      }
    };
    switch (e.key) {
      case "ArrowLeft":
        go(focus - 1);
        break;
      case "ArrowRight":
        go(focus + 1);
        break;
      case "ArrowUp":
        go(focus - grid.cols);
        break;
      case "ArrowDown":
        go(focus + grid.cols);
        break;
      case "Home":
        go(1);
        break;
      case "End":
        go(numPages);
        break;
      case "Enter":
        openPage(focus);
        break;
      case "Escape":
        if (selected.size) setSelected(new Set());
        else close();
        break;
      case "Delete":
      case "Backspace":
        if (canEdit) remove();
        break;
      case "a":
      case "A":
        if (!mod) return;
        setSelected(new Set(Array.from({ length: numPages }, (_, i) => i + 1)));
        break;
      case "d":
      case "D":
        if (!mod) return;
        if (canEdit) duplicate();
        break;
      case "r":
      case "R":
        if (mod) return;
        if (canEdit) rotate(e.shiftKey ? -90 : 90);
        break;
      case " ":
        setSelected((s) => {
          const next = new Set(s);
          if (next.has(focus)) next.delete(focus);
          else next.add(focus);
          return next;
        });
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // ---------------------------------------------------------------------------------- render

  const gap = drag?.gap ?? fileGap;
  let marker: { x: number; y: number } | null = null;
  if (gap !== null) {
    const index = Math.min(gap, numPages - 1);
    const pos = cellPos(Math.max(0, index));
    marker = gap >= numPages ? { x: pos.x + grid.cellW + CELL_GAP / 2, y: pos.y } : { x: pos.x - CELL_GAP / 2, y: pos.y };
  }
  const none = sorted.length === 0;
  const disabled = !canEdit || none || working;
  const tipSelect = none ? t("organize.selectFirst") : undefined;
  const allSelected = sorted.length === numPages && numPages > 0;

  return (
    <div className="organize" ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} role="region" aria-label={t("organize.title")}>
      <div className="organize-bar" role="toolbar">
        <div className="organize-title">
          <strong>{t("organize.title")}</strong>
          <span className="muted">
            {none ? t("organize.count", { count: numPages }) : t("organize.selection", { count: sorted.length, total: numPages })}
          </span>
        </div>
        <div className="organize-actions">
          <button type="button" className="btn" disabled={!canEdit || working} onClick={(e) => setMenu({ anchor: e.currentTarget.getBoundingClientRect(), entries: insertEntries(none ? numPages : sorted[sorted.length - 1]) })}>
            <FilePlus2 size={16} /> {t("organize.insert")}
          </button>
          <div className="toolbar-sep" />
          <button type="button" className="icon-btn" disabled={disabled} data-tip={tipSelect ?? t("organize.rotateCcw")} data-tip-key="Shift+R" onClick={() => rotate(-90)}>
            <RotateCcw size={18} />
          </button>
          <button type="button" className="icon-btn" disabled={disabled} data-tip={tipSelect ?? t("organize.rotateCw")} data-tip-key="R" onClick={() => rotate(90)}>
            <RotateCw size={18} />
          </button>
          <button type="button" className="icon-btn" disabled={disabled} data-tip={tipSelect ?? t("organize.flipH")} onClick={() => flip(true)}>
            <FlipLeftRight size={18} />
          </button>
          <button type="button" className="icon-btn" disabled={disabled} data-tip={tipSelect ?? t("organize.flipV")} onClick={() => flip(false)}>
            <FlipTopBottom size={18} />
          </button>
          <div className="toolbar-sep" />
          <button type="button" className="icon-btn" disabled={disabled} data-tip={tipSelect ?? t("organize.duplicate")} data-tip-key="Ctrl+D" onClick={() => duplicate()}>
            <Copy size={18} />
          </button>
          <button type="button" className="icon-btn" disabled={disabled} data-tip={tipSelect ?? t("organize.replace")} onClick={() => void openDialog("replacePages", { tabId: c.tabId, pages: sorted })}>
            <Replace size={18} />
          </button>
          <button type="button" className="icon-btn" disabled={none || working} data-tip={tipSelect ?? t("cmd.page.extract")} onClick={() => void openDialog("pageOps", { tabId: c.tabId, mode: "extract", pages: sorted })}>
            <FileOutput size={18} />
          </button>
          <button type="button" className="icon-btn danger" disabled={disabled || allSelected} data-tip={tipSelect ?? t("organize.delete", { count: sorted.length })} data-tip-key="Delete" onClick={() => remove()}>
            <Trash2 size={18} />
          </button>
          <div className="toolbar-sep" />
          <button type="button" className="btn" disabled={working} onClick={() => void openDialog("splitDocument", { tabId: c.tabId })}>
            <Scissors size={16} /> {t("split.button")}
          </button>
          <button type="button" className="btn" disabled={!canEdit || working} onClick={() => void openDialog("watermark", { tabId: c.tabId, pages: none ? undefined : sorted })}>
            <Droplets size={16} /> {t("watermark.button")}
          </button>
        </div>
        <div className="spacer" />
        <button type="button" className="btn ghost" onClick={() => setSelected(allSelected ? new Set() : new Set(Array.from({ length: numPages }, (_, i) => i + 1)))}>
          {allSelected ? t("organize.selectNone") : t("organize.selectAll")}
        </button>
        <input
          className="organize-zoom"
          type="range"
          min={100}
          max={320}
          step={10}
          value={size}
          aria-label={t("organize.thumbSize")}
          onChange={(e) => setSetting("ui.organizeSize", Number(e.target.value))}
        />
        <button type="button" className="btn primary" onClick={close}>
          <X size={16} /> {t("organize.done")}
        </button>
      </div>

      {!canEdit && (
        <div className="organize-banner">
          <Lock size={16} />
          <span>{t("organize.locked")}</span>
          <button type="button" className="btn small" onClick={() => void openDialog("security", { tabId: c.tabId })}>
            {t("security.unlock")}
          </button>
        </div>
      )}

      <div
        className={`organize-scroll${drag ? " dragging" : ""}`}
        ref={scrollRef}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget && !e.ctrlKey && !e.shiftKey) setSelected(new Set());
        }}
        role="listbox"
        aria-multiselectable
      >
        <div className="organize-canvas" style={{ height: PAD * 2 + rows * rowH }}>
          {service && visible.map((p) => {
            const pos = cellPos(p - 1);
            return (
              <div key={p} className="org-cell" style={{ left: pos.x, top: pos.y, width: grid.cellW, height: grid.cellH }}>
                <PageCard
                  service={service}
                  page={p}
                  slotW={grid.slotW}
                  slotH={grid.slotH}
                  selected={selected.has(p)}
                  focused={focus === p}
                  dragging={!!drag && drag.pages.includes(p)}
                  label={labelOf(p)}
                  canEdit={canEdit && !working}
                  onPointerDown={onPointerDown}
                  onDouble={openPage}
                  onContext={onContext}
                  onRotate={(page, delta) => rotate(delta, pagesFor(page))}
                  onDelete={(page) => remove(pagesFor(page))}
                  onInsertBefore={(e, page) => setMenu({ anchor: e.currentTarget.getBoundingClientRect(), entries: insertEntries(page - 1) })}
                />
              </div>
            );
          })}
          {canEdit && lastRow >= Math.floor(numPages / grid.cols) && (
            <div className="org-cell" style={{ ...(() => { const pos = cellPos(numPages); return { left: pos.x, top: pos.y }; })(), width: grid.cellW, height: grid.cellH }}>
              <button
                type="button"
                className="org-add"
                style={{ width: grid.slotW, height: grid.slotH }}
                disabled={working}
                onClick={(e) => setMenu({ anchor: e.currentTarget.getBoundingClientRect(), entries: insertEntries(numPages) })}
              >
                <Plus size={28} />
                <span>{t("organize.addPages")}</span>
                <small className="muted">{t("organize.addPagesHint")}</small>
              </button>
            </div>
          )}
          {marker && <div className="org-marker" style={{ left: marker.x - 2, top: marker.y, height: grid.slotH }} />}
        </div>
      </div>

      <div className="organize-foot muted">{t("organize.hint")}</div>
      {menu && <Menu entries={menu.entries} anchor={menu.anchor} onClose={() => setMenu(null)} />}
    </div>
  );
}
