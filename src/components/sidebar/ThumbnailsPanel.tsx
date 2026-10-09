/**
 * Page thumbnails: virtualised (only visible thumbnails exist in the DOM and are rendered),
 * multi-selection, drag-to-reorder and page context menu.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZoomIn, ZoomOut } from "lucide-react";
import type { DocumentController } from "../../document/DocumentController";
import { useDocState } from "../../hooks/useDoc";
import { useT } from "../../i18n";
import { Menu, type MenuEntry, type MenuAnchor } from "../common/Menu";
import { settings, useSettings } from "../../settings/store";
import { openDialog, toast } from "../../state/ui";
import type { Thumbnail } from "../../document/thumbnails";
import { toAppError } from "../../lib/errors";

const LABEL_H = 22;
const GAP = 14;

function ThumbItem({
  c,
  page,
  width,
  height,
  current,
  selected,
  dropMark,
  dragging,
  label,
  onPointerDown,
  onContext,
}: {
  c: DocumentController;
  page: number;
  width: number;
  height: number;
  current: boolean;
  selected: boolean;
  dropMark: "before" | "after" | null;
  dragging: boolean;
  label: string;
  onPointerDown: (e: React.PointerEvent, page: number) => void;
  onContext: (e: React.MouseEvent, page: number) => void;
}) {
  const t = useT();
  const [thumb, setThumb] = useState<Thumbnail | null>(() => c.thumbnails.peek(page));
  const rotation = useDocState(c, (s) => s.rotation, 0);
  const version = useDocState(c, (s) => s.layoutVersion, 0);
  useEffect(() => {
    let alive = true;
    const cached = c.thumbnails.peek(page);
    if (cached) {
      setThumb(cached);
      return;
    }
    setThumb(null);
    c.thumbnails.request(page).then((th) => alive && th && setThumb(th));
    return () => {
      alive = false;
    };
  }, [c, page, rotation, version]);

  // Fit the thumbnail inside the slot keeping its own aspect ratio.
  let w = width;
  let h = height;
  if (thumb) {
    const ratio = thumb.height / thumb.width;
    if (ratio * width <= height) h = ratio * width;
    else w = height / ratio;
  }
  return (
    <div
      className={`thumb-item${current ? " current" : ""}${selected ? " selected" : ""}${dragging ? " dragging" : ""}${dropMark === "before" ? " drop-before" : dropMark === "after" ? " drop-after" : ""}`}
      style={{ width: width + 12 }}
      role="option"
      aria-selected={current}
      data-page={page}
      onPointerDown={(e) => onPointerDown(e, page)}
      onContextMenu={(e) => onContext(e, page)}
      title={t("thumbs.page", { label })}
    >
      <div className="thumb-frame" style={{ width: w, height: h }}>
        {thumb && <img src={thumb.url} alt="" draggable={false} />}
      </div>
      <div className="thumb-label">{label}</div>
    </div>
  );
}

export function ThumbnailsPanel({ c }: { c: DocumentController }) {
  const t = useT();
  const numPages = useDocState(c, (s) => s.numPages, 0);
  const page = useDocState(c, (s) => s.page, 1);
  const pageSize = useDocState(c, (s) => s.pageSize, null);
  const size = useSettings((s) => s.settings.ui.thumbnailSize);
  const setSetting = useSettings((s) => s.set);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; pages: number[] } | null>(null);
  const [drag, setDrag] = useState<{ pages: number[]; target: number; side: "before" | "after" } | null>(null);
  const labelsRef = useRef<string[] | null>(null);
  const [, setLabelsTick] = useState(0);

  useEffect(() => {
    c.pdf
      ?.getPageLabels()
      .then((labels) => {
        labelsRef.current = labels;
        setLabelsTick((n) => n + 1);
      })
      .catch(() => undefined);
  }, [c, numPages]);

  const width = Math.round(132 * size);
  const aspect = pageSize ? pageSize[1] / pageSize[0] : 1.414;
  const thumbH = Math.round(width * Math.min(2.2, Math.max(0.4, aspect)));
  const itemH = thumbH + LABEL_H + GAP;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the current page visible in the panel.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || drag) return;
    const top = (page - 1) * itemH;
    if (top < el.scrollTop || top + itemH > el.scrollTop + el.clientHeight) {
      el.scrollTo({ top: Math.max(0, top - el.clientHeight / 2 + itemH / 2) });
    }
  }, [page, itemH, drag]);

  const first = Math.max(1, Math.floor(scrollTop / itemH) + 1 - 2);
  const last = Math.min(numPages, Math.ceil((scrollTop + viewH) / itemH) + 2);
  const visible = useMemo(() => {
    const out: number[] = [];
    for (let p = first; p <= last; p++) out.push(p);
    return out;
  }, [first, last]);

  useEffect(() => {
    c.thumbnails.cancelExcept(new Set(visible));
  }, [c, visible]);

  const canAssemble = !settings().saving.respectRestrictions || c.state.permissions.assemble;

  const runOps = useCallback(
    async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        toast("error", toAppError(err).message);
      }
    },
    [],
  );

  const onPointerDown = (e: React.PointerEvent, p: number) => {
    if (e.button !== 0) return;
    if (e.ctrlKey || e.metaKey) {
      setSelected((s) => {
        const next = new Set(s);
        if (next.has(p)) next.delete(p);
        else next.add(p);
        return next;
      });
      return;
    }
    if (e.shiftKey) {
      const anchor = selected.size ? Math.min(...selected) : page;
      const next = new Set<number>();
      for (let i = Math.min(anchor, p); i <= Math.max(anchor, p); i++) next.add(i);
      setSelected(next);
      return;
    }
    const pages = selected.has(p) && selected.size > 1 ? [...selected].sort((a, b) => a - b) : [p];
    if (!selected.has(p)) setSelected(new Set());
    const startY = e.clientY;
    let started = false;
    let target = p;
    let side: "before" | "after" = "before";
    const el = scrollRef.current!;
    const move = (ev: PointerEvent) => {
      if (!canAssemble) return;
      if (!started && Math.abs(ev.clientY - startY) < 8) return;
      started = true;
      const rect = el.getBoundingClientRect();
      const y = ev.clientY - rect.top + el.scrollTop - 10;
      const idx = Math.max(0, Math.min(numPages - 1, Math.floor(y / itemH)));
      target = idx + 1;
      side = y - idx * itemH > itemH / 2 ? "after" : "before";
      // Auto-scroll near the edges.
      if (ev.clientY < rect.top + 30) el.scrollTop -= 12;
      else if (ev.clientY > rect.bottom - 30) el.scrollTop += 12;
      setDrag({ pages, target, side });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (!started) {
        c.goToPage(p);
        return;
      }
      // Compute the new order.
      const moving = new Set(pages);
      const rest = Array.from({ length: numPages }, (_, i) => i + 1).filter((x) => !moving.has(x));
      let insertAt = rest.findIndex((x) => x === target);
      if (moving.has(target)) return;
      if (side === "after") insertAt += 1;
      if (insertAt < 0) insertAt = rest.length;
      const order = [...rest.slice(0, insertAt), ...pages, ...rest.slice(insertAt)];
      if (order.every((x, i) => x === i + 1)) return;
      void runOps(() => c.applyPageOps([{ op: "reorder", order: order.map((x) => x - 1) }], [], t("history.pages")));
      setSelected(new Set());
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onContext = (e: React.MouseEvent, p: number) => {
    e.preventDefault();
    const pages = selected.has(p) ? [...selected].sort((a, b) => a - b) : [p];
    if (!selected.has(p)) setSelected(new Set([p]));
    setMenu({ anchor: { x: e.clientX, y: e.clientY }, pages });
  };

  const menuEntries = (pages: number[]): MenuEntry[] => {
    const idx = pages.map((p) => p - 1);
    return [
      { type: "item", label: t("cmd.page.rotateCw"), disabled: !canAssemble, onSelect: () => void runOps(() => c.applyPageOps([{ op: "rotate", pages: idx, delta: 90 }])) },
      { type: "item", label: t("cmd.page.rotateCcw"), disabled: !canAssemble, onSelect: () => void runOps(() => c.applyPageOps([{ op: "rotate", pages: idx, delta: -90 }])) },
      { type: "separator" },
      {
        type: "item",
        label: t("cmd.page.insertBlank"),
        disabled: !canAssemble,
        onSelect: () => void openDialog("pageOps", { tabId: c.tabId, mode: "insertBlank", pages }),
      },
      {
        type: "item",
        label: t("cmd.page.insertFile"),
        disabled: !canAssemble,
        onSelect: () => void openDialog("pageOps", { tabId: c.tabId, mode: "insertFile", pages }),
      },
      { type: "separator" },
      { type: "item", label: t("cmd.page.extract"), onSelect: () => void openDialog("pageOps", { tabId: c.tabId, mode: "extract", pages }) },
      {
        type: "item",
        label: t("cmd.page.delete"),
        danger: true,
        disabled: !canAssemble || pages.length >= numPages,
        onSelect: () => void openDialog("pageOps", { tabId: c.tabId, mode: "delete", pages }),
      },
    ];
  };

  const labels = labelsRef.current;
  return (
    <div className="col" style={{ height: "100%", gap: 0 }}>
      <div className="panel-toolbar">
        <span className="faint" style={{ fontSize: "var(--fs-xs)", flex: 1 }}>
          {t("common.pages", { count: numPages })}
          {selected.size > 1 ? ` · ${selected.size}` : ""}
        </span>
        <button type="button" className="icon-btn small" data-tip={t("thumbs.size")} onClick={() => setSetting("ui.thumbnailSize", Math.max(0.5, size - 0.25))}>
          <ZoomOut size={14} />
        </button>
        <button type="button" className="icon-btn small" data-tip={t("thumbs.size")} onClick={() => setSetting("ui.thumbnailSize", Math.min(2, size + 0.25))}>
          <ZoomIn size={14} />
        </button>
      </div>
      <div
        ref={scrollRef}
        className="sidebar-body"
        data-keys="local"
        tabIndex={0}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowRight") c.nextPage();
          else if (e.key === "ArrowUp" || e.key === "ArrowLeft") c.previousPage();
          else if (e.key === "Home") c.firstPage();
          else if (e.key === "End") c.lastPage();
          else if (e.key === "Delete" && canAssemble) void openDialog("pageOps", { tabId: c.tabId, mode: "delete", pages: selected.size ? [...selected] : [page] });
          else return;
          e.preventDefault();
        }}
      >
        <div style={{ height: numPages * itemH + 20, position: "relative" }}>
          {visible.map((p) => (
            <div key={p} style={{ position: "absolute", top: (p - 1) * itemH + 10, left: 0, right: 0, display: "flex", justifyContent: "center" }}>
              <ThumbItem
                c={c}
                page={p}
                width={width}
                height={thumbH}
                current={p === page}
                selected={selected.has(p)}
                dragging={!!drag?.pages.includes(p)}
                dropMark={drag && drag.target === p && !drag.pages.includes(p) ? drag.side : null}
                label={labels?.[p - 1] ?? String(p)}
                onPointerDown={onPointerDown}
                onContext={onContext}
              />
            </div>
          ))}
        </div>
      </div>
      {menu && <Menu entries={menuEntries(menu.pages)} anchor={menu.anchor} onClose={() => setMenu(null)} />}
    </div>
  );
}
