/** Document tabs with drag-to-reorder, middle-click close and a context menu. */
import { useRef, useState } from "react";
import { FileText, Home, Loader2, Plus, X, AlertCircle } from "lucide-react";
import { Menu, type MenuAnchor } from "../common/Menu";
import { useT } from "../../i18n";
import {
  activateTab,
  closeOthers,
  closeTab,
  closeToRight,
  getController,
  moveTab,
  useTabs,
  type TabInfo,
} from "../../state/tabs";
import { useDocState } from "../../hooks/useDoc";
import { openFileDialog, copyPath, showInFolder } from "../../document/fileActions";

function TabItem({
  tab,
  active,
  onContext,
  onDragStart,
  dragging,
}: {
  tab: TabInfo;
  active: boolean;
  onContext: (anchor: MenuAnchor, id: string) => void;
  onDragStart: (e: React.PointerEvent, id: string) => void;
  dragging: boolean;
}) {
  const t = useT();
  const c = getController(tab.id);
  const fileName = useDocState(c, (s) => s.fileName, tab.path.split(/[\\/]/).pop() ?? tab.path);
  const status = useDocState(c, (s) => s.status, "loading");
  const dirty = useDocState(c, (s) => s.history.dirty || s.formsDirty || s.infoDirty, false);
  const path = useDocState(c, (s) => s.info?.path ?? tab.path, tab.path);

  return (
    <div
      className={`tab${active ? " active" : ""}${dragging ? " dragging" : ""}`}
      role="tab"
      aria-selected={active}
      data-tab-id={tab.id}
      data-tip={path}
      onPointerDown={(e) => {
        if (e.button === 0) {
          activateTab(tab.id);
          onDragStart(e, tab.id);
        }
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          void closeTab(tab.id);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext({ x: e.clientX, y: e.clientY }, tab.id);
      }}
    >
      <span className="tab-icon">
        {status === "loading" ? (
          <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
        ) : status === "error" ? (
          <AlertCircle size={14} color="var(--danger)" />
        ) : (
          <FileText size={14} />
        )}
      </span>
      <span className="tab-title">{fileName}</span>
      <button
        type="button"
        className={`tab-close${dirty ? " dirty" : ""}`}
        aria-label={t("tabs.close")}
        data-tip={dirty ? t("tabs.unsaved") : t("tabs.close")}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          void closeTab(tab.id);
        }}
      >
        <span className="dot" />
        <X size={13} />
      </button>
    </div>
  );
}

export function TabBar() {
  const t = useT();
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; id: string } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const onDragStart = (e: React.PointerEvent, id: string) => {
    const startX = e.clientX;
    let started = false;
    const move = (ev: PointerEvent) => {
      if (!started && Math.abs(ev.clientX - startX) < 6) return;
      if (!started) {
        started = true;
        setDragId(id);
      }
      const nodes = [...(scrollRef.current?.querySelectorAll<HTMLElement>(".tab") ?? [])];
      const order = useTabs.getState().tabs;
      const from = order.findIndex((tb) => tb.id === id);
      for (let i = 0; i < nodes.length; i++) {
        const r = nodes[i].getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX <= r.right && i !== from) {
          const mid = r.left + r.width / 2;
          if ((i > from && ev.clientX > mid) || (i < from && ev.clientX < mid)) moveTab(id, i);
          break;
        }
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragId(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const menuFor = (id: string) => {
    const c = getController(id);
    return [
      { type: "item" as const, label: t("tabs.close"), onSelect: () => void closeTab(id) },
      { type: "item" as const, label: t("cmd.file.closeOthers"), onSelect: () => void closeOthers(id), disabled: tabs.length < 2 },
      { type: "item" as const, label: t("tabs.closeToRight"), onSelect: () => void closeToRight(id), disabled: tabs.at(-1)?.id === id },
      { type: "separator" as const },
      { type: "item" as const, label: t("tabs.copyPath"), onSelect: () => c && void copyPath(c), disabled: !c?.state.info },
      { type: "item" as const, label: t("cmd.file.showInFolder"), onSelect: () => c && void showInFolder(c), disabled: !c?.state.info },
      { type: "separator" as const },
      { type: "command" as const, id: "file.reopenClosed" },
    ];
  };

  return (
    <div className="tabbar" role="tablist">
      <button
        type="button"
        className={`icon-btn small home-btn${activeId === null ? " active" : ""}`}
        data-tip={t("tabs.home")}
        onClick={() => activateTab(null)}
      >
        <Home size={15} />
      </button>
      <div
        className="tabbar-scroll"
        ref={scrollRef}
        onWheel={(e) => {
          if (scrollRef.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) scrollRef.current.scrollLeft += e.deltaY;
        }}
      >
        {tabs.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            dragging={dragId === tab.id}
            onDragStart={onDragStart}
            onContext={(anchor, id) => setMenu({ anchor, id })}
          />
        ))}
      </div>
      <button type="button" className="icon-btn small new-tab" data-tip={t("tabs.new")} onClick={() => void openFileDialog()}>
        <Plus size={16} />
      </button>
      {menu && <Menu entries={menuFor(menu.id)} anchor={menu.anchor} onClose={() => setMenu(null)} />}
    </div>
  );
}
