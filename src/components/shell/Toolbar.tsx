/** Main toolbar. Low-priority groups collapse into the "More" menu on narrow windows. */
import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Hand,
  LayoutTemplate,
  MessageSquareText,
  Moon,
  MoreHorizontal,
  MousePointer2,
  PanelLeft,
  PanelRight,
  Search,
  Settings as SettingsIcon,
} from "lucide-react";
import { useT, type MessageKey } from "../../i18n";
import { useActiveController, useDocState } from "../../hooks/useDoc";
import { getCommand, isEnabled, runCommand } from "../../commands/registry";
import { effectiveKeys } from "../../commands/keybindings";
import { formatAccelerator } from "../../commands/keys";
import { MenuButton, type MenuEntry } from "../common/Menu";
import { useSettings } from "../../settings/store";
import { useUi, openSettings } from "../../state/ui";
import { MENUS } from "./menus";
import type { DocumentController } from "../../document/DocumentController";

function CmdButton({ id, label, showLabel }: { id: string; label?: MessageKey; showLabel?: boolean }) {
  const t = useT();
  const c = useActiveController();
  // Re-render on document state changes so enabled/checked states stay current.
  useDocState(c, (s) => s, null);
  useSettings((s) => s.settings);
  const cmd = getCommand(id);
  if (!cmd) return null;
  const Icon = cmd.icon;
  const keys = effectiveKeys(id);
  const checked = cmd.checked ? cmd.checked(c) : undefined;
  const text = t(label ?? cmd.label);
  return (
    <button
      type="button"
      className="icon-btn"
      data-tip={text}
      data-tip-key={keys[0] ? formatAccelerator(keys[0]) : undefined}
      aria-label={text}
      aria-pressed={checked}
      disabled={!isEnabled(cmd, c)}
      onClick={() => runCommand(id)}
    >
      {Icon && <Icon size={18} />}
      {showLabel && <span className="btn-label">{text}</span>}
    </button>
  );
}

function PageInput({ c }: { c: DocumentController }) {
  const t = useT();
  const page = useDocState(c, (s) => s.page, 1);
  const label = useDocState(c, (s) => s.pageLabel, null);
  const hasLabels = useDocState(c, (s) => s.hasPageLabels, false);
  const numPages = useDocState(c, (s) => s.numPages, 0);
  const shown = hasLabels && label ? label : String(page);
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [shown]);
  return (
    <div className="page-input">
      <input
        className="input small"
        aria-label={t("toolbar.pageNumber")}
        value={draft ?? shown}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            if (draft !== null && !c.goToPageInput(draft)) setDraft(null);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
        onBlur={() => setDraft(null)}
      />
      <span>{hasLabels && label ? `(${page} / ${numPages})` : `/ ${numPages}`}</span>
    </div>
  );
}

const ZOOM_PRESETS = [50, 75, 100, 125, 150, 200, 300, 400];

function ZoomControl({ c }: { c: DocumentController }) {
  const t = useT();
  const scale = useDocState(c, (s) => s.scale, 1);
  const [draft, setDraft] = useState<string | null>(null);
  const percent = `${Math.round(scale * 100)}%`;
  const entries: MenuEntry[] = [
    { type: "command", id: "view.autoZoom" },
    { type: "command", id: "view.fitPage" },
    { type: "command", id: "view.fitWidth" },
    { type: "command", id: "view.actualSize" },
    { type: "separator" },
    ...ZOOM_PRESETS.map<MenuEntry>((z) => ({
      type: "item",
      label: `${z}%`,
      checked: Math.round(scale * 100) === z,
      onSelect: () => c.setZoom(z / 100),
    })),
  ];
  return (
    <div className="toolbar-group">
      <CmdButton id="view.zoomOut" />
      <input
        className="input small zoom-input"
        aria-label={t("toolbar.zoomLevel")}
        value={draft ?? percent}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const v = Number.parseFloat((draft ?? "").replace("%", ""));
            if (Number.isFinite(v) && v > 0) c.setZoom(v / 100);
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <MenuButton entries={entries} className="icon-btn small" tip={t("toolbar.zoomLevel")}>
        <ChevronDown size={14} />
      </MenuButton>
      <CmdButton id="view.zoomIn" />
    </div>
  );
}

function MoreMenu() {
  const t = useT();
  const entries = (): MenuEntry[] =>
    MENUS.map((m) => ({ type: "submenu", label: t(m.label), items: m.entries }));
  return (
    <MenuButton entries={entries} tip={t("toolbar.moreTools")}>
      <MoreHorizontal size={18} />
    </MenuButton>
  );
}

export function Toolbar() {
  const t = useT();
  const c = useActiveController();
  const ready = useDocState(c, (s) => s.status === "ready", false);
  const tool = useDocState(c, (s) => s.tool, "select");
  const labels = useSettings((s) => s.settings.appearance.toolbarLabels);
  const sidebarRight = useSettings((s) => s.settings.appearance.sidebarPosition === "right");
  const commentTools = useUi((s) => s.commentTools);
  const commentsPane = useUi((s) => s.commentsPane);

  const layoutEntries: MenuEntry[] = [
    { type: "command", id: "view.layout.single" },
    { type: "command", id: "view.layout.continuous" },
    { type: "command", id: "view.layout.twoPage" },
    { type: "command", id: "view.layout.twoPageContinuous" },
    { type: "command", id: "view.layout.horizontal" },
    { type: "command", id: "view.layout.wrapped" },
    { type: "separator" },
    { type: "command", id: "view.coverPage" },
    { type: "separator" },
    { type: "command", id: "view.rotateCw" },
    { type: "command", id: "view.rotateCcw" },
  ];
  const bgEntries: MenuEntry[] = [
    { type: "command", id: "view.bg.normal" },
    { type: "command", id: "view.bg.dark" },
    { type: "command", id: "view.bg.night" },
    { type: "command", id: "view.bg.sepia" },
    { type: "command", id: "view.bg.green" },
    { type: "command", id: "view.bg.custom" },
    { type: "separator" },
    { type: "item", label: `${t("settings.section.pageColors")}…`, onSelect: () => openSettings("pageColors") },
  ];

  return (
    <div className={`toolbar${labels ? " labels" : ""}`} role="toolbar">
      <div className="toolbar-group">
        <CmdButton id="view.sidebar" />
        <CmdButton id="file.open" showLabel={labels} />
        <CmdButton id="file.save" showLabel={labels} />
        <CmdButton id="file.print" />
      </div>
      <div className="toolbar-sep" />
      <div className="toolbar-group">
        <CmdButton id="edit.undo" />
        <CmdButton id="edit.redo" />
      </div>
      {c && ready && (
        <>
          <div className="toolbar-sep" />
          <div className="toolbar-group">
            <button type="button" className="icon-btn" data-tip={t("cmd.go.prev")} onClick={() => runCommand("go.prev")}>
              <ChevronLeft size={18} />
            </button>
            <PageInput c={c} />
            <button type="button" className="icon-btn" data-tip={t("cmd.go.next")} onClick={() => runCommand("go.next")}>
              <ChevronRight size={18} />
            </button>
          </div>
          <div className="toolbar-sep" />
          <ZoomControl c={c} />
          <CmdButton id="view.fitWidth" />
          <CmdButton id="view.fitPage" />
          <div className="toolbar-sep" />
          <div className="toolbar-group">
            <button
              type="button"
              className="icon-btn"
              aria-pressed={tool === "select"}
              data-tip={t("cmd.tool.select")}
              data-tip-key="V"
              onClick={() => c.setTool("select")}
            >
              <MousePointer2 size={18} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-pressed={tool === "hand"}
              data-tip={t("cmd.tool.hand")}
              data-tip-key="H"
              onClick={() => c.setTool("hand")}
            >
              <Hand size={18} />
            </button>
          </div>
          <div className="toolbar-sep" />
          <div className="toolbar-group">
            <button
              type="button"
              className="icon-btn"
              aria-pressed={commentTools}
              data-tip={t("cmd.comment.toolbar")}
              data-tip-key="C"
              onClick={() => runCommand("comment.toolbar")}
            >
              <MessageSquareText size={18} />
              {labels && <span className="btn-label">{t("toolbar.commentMode")}</span>}
            </button>
            <CmdButton id="tool.signature" />
            <CmdButton id="page.organize" />
          </div>
        </>
      )}
      <div className="spacer" />
      {c && ready && (
        <div className="toolbar-group">
          <MenuButton entries={layoutEntries} tip={t("menu.pageDisplay")}>
            <LayoutTemplate size={18} />
          </MenuButton>
          <MenuButton entries={bgEntries} tip={t("menu.pageBackground")}>
            <Moon size={18} />
          </MenuButton>
          <CmdButton id="view.readMode" />
          <CmdButton id="tool.snapshot" />
          <CmdButton id="tool.ocrRegion" />
          <button
            type="button"
            className="icon-btn"
            data-tip={t("cmd.edit.find")}
            data-tip-key="Ctrl+F"
            onClick={() => runCommand("edit.find")}
          >
            <Search size={18} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-pressed={commentsPane}
            data-tip={t("sidebar.annotations")}
            onClick={() => useUi.setState((s) => ({ commentsPane: !s.commentsPane }))}
          >
            {sidebarRight ? <PanelLeft size={18} /> : <PanelRight size={18} />}
          </button>
        </div>
      )}
      <div className="toolbar-sep" />
      <button type="button" className="icon-btn" data-tip={t("start.settings")} data-tip-key="Ctrl+," onClick={() => openSettings()}>
        <SettingsIcon size={18} />
      </button>
      <MoreMenu />
    </div>
  );
}
