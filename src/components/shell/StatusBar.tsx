/** Status bar: page, page size, zoom, layout, save state, background activity. */
import { Lock, Pause, Play, ShieldAlert, Square, Volume2, Loader2 } from "lucide-react";
import { useActiveController, useAnnotState, useDocState } from "../../hooks/useDoc";
import { useT, useLocale } from "../../i18n";
import { formatBytes } from "../../i18n/format";
import { useReadAloud, togglePauseReading, stopReading } from "../../document/readAloud";
import { useAutoScroll } from "../../document/autoScroll";
import { openDialog } from "../../state/ui";
import { settings } from "../../settings/store";
import { Menu, type MenuEntry } from "../common/Menu";
import { useState } from "react";

function formatPageSize(size: [number, number], locale: string): string {
  const mm = (pt: number) => (pt / 72) * 25.4;
  const metric = !/^en-US|^en$/.test(locale);
  if (metric) return `${Math.round(mm(size[0]))} × ${Math.round(mm(size[1]))} mm`;
  return `${(size[0] / 72).toFixed(2)} × ${(size[1] / 72).toFixed(2)} in`;
}

/** Short usage hint for tools that need explaining (shown while the tool is active). */
function toolHint(tool: string, t: ReturnType<typeof useT>): string | null {
  if (tool === "polygon" || tool === "polyline") return t("polygon.hint");
  if (tool === "eraser") return t("eraser.hint");
  if (tool === "snapshot") return t("snapshot.hint");
  if (tool === "highlight" || tool === "underline" || tool === "strikeout" || tool === "squiggly") {
    return t("markup.hint", { action: t(`cmd.tool.${tool}`) });
  }
  return null;
}

export function StatusBar() {
  const t = useT();
  const locale = useLocale();
  const c = useActiveController();
  const status = useDocState(c, (s) => s.status, "loading");
  const page = useDocState(c, (s) => s.page, 0);
  const numPages = useDocState(c, (s) => s.numPages, 0);
  const pageSize = useDocState(c, (s) => s.pageSize, null);
  const scale = useDocState(c, (s) => s.scale, 1);
  const dirty = useDocState(c, (s) => s.history.dirty || s.formsDirty || s.infoDirty, false);
  const saving = useDocState(c, (s) => s.saving, false);
  const size = useDocState(c, (s) => s.info?.size ?? 0, 0);
  const readOnly = useDocState(c, (s) => !!s.info?.readOnly, false);
  const perms = useDocState(c, (s) => s.permissions, null);
  const loaded = useAnnotState(c, (s) => s.loaded, true);
  const selectionCount = useAnnotState(c, (s) => s.selection.length, 0);
  const tool = useDocState(c, (s) => s.tool, "select");
  const tts = useReadAloud();
  const autoScroll = useAutoScroll();
  const [zoomMenu, setZoomMenu] = useState<DOMRect | null>(null);

  if (!c || status !== "ready") {
    return (
      <div className="statusbar">
        <span className="status-item">{t("status.ready")}</span>
      </div>
    );
  }
  const restricted = !!perms && settings().saving.respectRestrictions && (!perms.annotate || !perms.print || !perms.copy);
  const zoomEntries: MenuEntry[] = [
    { type: "command", id: "view.autoZoom" },
    { type: "command", id: "view.fitPage" },
    { type: "command", id: "view.fitWidth" },
    { type: "command", id: "view.actualSize" },
    { type: "separator" },
    ...[50, 75, 100, 125, 150, 200, 400].map<MenuEntry>((z) => ({ type: "item", label: `${z}%`, onSelect: () => c.setZoom(z / 100) })),
  ];

  return (
    <div className="statusbar">
      <button type="button" className="status-item" onClick={() => void openDialog("goToPage", { tabId: c.tabId })}>
        {t("common.pageOf", { page, total: numPages })}
      </button>
      {pageSize && <span className="status-item" title={t("status.pageSize")}>{formatPageSize(pageSize, locale)}</span>}
      <span className="status-item">{formatBytes(size, locale)}</span>
      {!loaded && (
        <span className="status-item">
          <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> {t("status.loadingAnnotations")}
        </span>
      )}
      {selectionCount > 0 && <span className="status-item">{t("status.selection", { count: selectionCount })}</span>}
      {tts.status !== "idle" && (
        <span className="status-item">
          <Volume2 size={12} />
          {tts.page ? t("tts.reading", { page: tts.page }) : ""}
          <button type="button" className="icon-btn small" onClick={() => togglePauseReading()} aria-label={t("cmd.tts.pause")}>
            {tts.status === "paused" ? <Play size={12} /> : <Pause size={12} />}
          </button>
          <button type="button" className="icon-btn small" onClick={() => stopReading()} aria-label={t("cmd.tts.stop")}>
            <Square size={11} />
          </button>
        </span>
      )}
      {autoScroll.active && <span className="status-item">{t("autoscroll.on")}</span>}
      {toolHint(tool, t) && <span className="status-item tool-hint">{toolHint(tool, t)}</span>}
      <span className="spacer" />
      {restricted && (
        <span className="status-item" title={t("dialog.restricted.message")}>
          <ShieldAlert size={12} /> {t("status.restricted")}
        </span>
      )}
      {readOnly && (
        <span className="status-item">
          <Lock size={12} /> {t("status.readOnly")}
        </span>
      )}
      <span className="status-item">
        {saving ? (
          <>
            <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> {t("save.saving")}
          </>
        ) : dirty ? (
          <>
            <span className="dot-dirty" /> {t("status.unsaved")}
          </>
        ) : (
          t("status.saved")
        )}
      </span>
      <button type="button" className="status-item" onClick={(e) => setZoomMenu(e.currentTarget.getBoundingClientRect())}>
        {t("status.zoom")} {Math.round(scale * 100)}%
      </button>
      {zoomMenu && <Menu entries={zoomEntries} anchor={new DOMRect(zoomMenu.left, zoomMenu.top - 4, zoomMenu.width, 0)} onClose={() => setZoomMenu(null)} />}
    </div>
  );
}
