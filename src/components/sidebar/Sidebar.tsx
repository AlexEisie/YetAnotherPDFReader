/** Resizable navigation sidebar hosting the panels, and the right-hand comments pane. */
import { useRef, type ReactNode } from "react";
import { GalleryVertical, Layers, ListTree, MessageSquareText, Paperclip, ScanText, X } from "lucide-react";
import type { DocumentController } from "../../document/DocumentController";
import { useDocState } from "../../hooks/useDoc";
import { useT, type MessageKey } from "../../i18n";
import { useSettings } from "../../settings/store";
import { useUi } from "../../state/ui";
import { ThumbnailsPanel } from "./ThumbnailsPanel";
import { OutlinePanel } from "./OutlinePanel";
import { AnnotationsPanel } from "./AnnotationsPanel";
import { AttachmentsPanel, LayersPanel, SearchPanel } from "./MiscPanels";
import { capturePointer } from "../../lib/dom";

const PANELS: { id: string; label: MessageKey; icon: typeof ListTree }[] = [
  { id: "thumbnails", label: "sidebar.thumbnails", icon: GalleryVertical },
  { id: "outline", label: "sidebar.outline", icon: ListTree },
  { id: "annotations", label: "sidebar.annotations", icon: MessageSquareText },
  { id: "attachments", label: "sidebar.attachments", icon: Paperclip },
  { id: "layers", label: "sidebar.layers", icon: Layers },
  { id: "search", label: "sidebar.search", icon: ScanText },
];

function Resizer({ value, setting, min, max, invert }: { value: number; setting: string; min: number; max: number; invert?: boolean }) {
  const set = useSettings((s) => s.set);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        e.preventDefault();
        const start = e.clientX;
        ref.current?.classList.add("active");
        capturePointer(e.target, e.pointerId);
        const move = (ev: PointerEvent) => {
          const delta = (ev.clientX - start) * (invert ? -1 : 1);
          set(setting, Math.max(min, Math.min(max, value + delta)));
        };
        const up = () => {
          ref.current?.classList.remove("active");
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      onDoubleClick={() => set(setting, invert ? 320 : 248)}
    />
  );
}

export function Sidebar({ c }: { c: DocumentController }) {
  const t = useT();
  const panel = useDocState(c, (s) => s.sidebarPanel, "thumbnails");
  const attachmentCount = useDocState(c, (s) => s.attachmentCount, 0);
  const hasLayers = useDocState(c, (s) => s.hasLayers, false);
  const width = useSettings((s) => s.settings.ui.sidebarWidth);
  const right = useSettings((s) => s.settings.appearance.sidebarPosition === "right");

  const available = PANELS.filter(
    (p) => (p.id !== "attachments" || attachmentCount > 0) && (p.id !== "layers" || hasLayers),
  );
  const current = available.some((p) => p.id === panel) ? panel : "thumbnails";

  let body: ReactNode;
  switch (current) {
    case "outline":
      body = <OutlinePanel c={c} />;
      break;
    case "annotations":
      body = <AnnotationsPanel c={c} />;
      break;
    case "attachments":
      body = <AttachmentsPanel c={c} />;
      break;
    case "layers":
      body = <LayersPanel c={c} />;
      break;
    case "search":
      body = <SearchPanel c={c} />;
      break;
    default:
      body = <ThumbnailsPanel c={c} />;
  }

  return (
    <aside className="sidebar" style={{ width }} aria-label={t("menu.sidebar")}>
      <div className="sidebar-tabs" role="tablist">
        {available.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            className="icon-btn"
            aria-selected={current === p.id}
            aria-pressed={current === p.id}
            data-tip={t(p.label)}
            onClick={() => c.setSidebar(true, p.id)}
          >
            <p.icon size={17} />
          </button>
        ))}
        <span className="spacer" />
        <button type="button" className="icon-btn small" data-tip={t("sidebar.close")} onClick={() => c.setSidebar(false)}>
          <X size={15} />
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>{body}</div>
      <Resizer value={width} setting="ui.sidebarWidth" min={160} max={640} invert={right} />
    </aside>
  );
}

export function CommentsPane({ c }: { c: DocumentController }) {
  const t = useT();
  const width = useSettings((s) => s.settings.ui.commentsPaneWidth);
  return (
    <aside className="comments-pane" style={{ width }} aria-label={t("sidebar.annotations")}>
      <div className="sidebar-header">
        <MessageSquareText size={15} />
        {t("sidebar.annotations")}
        <span className="spacer" />
        <button type="button" className="icon-btn small" aria-label={t("common.close")} onClick={() => useUi.setState({ commentsPane: false })}>
          <X size={15} />
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <AnnotationsPanel c={c} />
      </div>
      <Resizer value={width} setting="ui.commentsPaneWidth" min={240} max={640} invert />
    </aside>
  );
}
