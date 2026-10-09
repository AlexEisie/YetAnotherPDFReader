/** Menu bar structure, built on demand so labels and states are always current. */
import { Clock, FileText, Palette, Trash, type LucideIcon } from "lucide-react";
import type { MenuEntry } from "../common/Menu";
import { t, type MessageKey } from "../../i18n";
import { useLibrary } from "../../state/library";
import { openPaths, activeController } from "../../state/tabs";
import { openSettings, toast } from "../../state/ui";

const cmd = (id: string, label?: string): MenuEntry => ({ type: "command", id, label });
const sep: MenuEntry = { type: "separator" };
const sub = (label: MessageKey, items: MenuEntry[] | (() => MenuEntry[]), icon?: LucideIcon): MenuEntry => ({
  type: "submenu",
  label: t(label),
  items,
  icon,
});

function recentEntries(): MenuEntry[] {
  const recent = useLibrary.getState().recent;
  if (!recent.length) return [{ type: "header", label: t("menu.noRecent") }];
  return [
    ...recent.slice(0, 15).map<MenuEntry>((r, i) => ({
      type: "item",
      label: `${i < 9 ? `${i + 1}  ` : ""}${r.name}`,
      icon: FileText,
      onSelect: () => void openPaths([r.path]),
    })),
    sep,
    {
      type: "item",
      label: t("menu.clearRecent"),
      icon: Trash,
      onSelect: () => {
        useLibrary.getState().clearRecent();
        toast("info", t("toast.recentCleared"));
      },
    },
  ];
}

function undoLabel(kind: "undo" | "redo"): string | undefined {
  const c = activeController();
  const label = kind === "undo" ? c?.state.history.undoLabel : c?.state.history.redoLabel;
  if (!label) return undefined;
  return t(kind === "undo" ? "history.undoLabel" : "history.redoLabel", { action: label });
}

export interface TopMenu {
  id: string;
  label: MessageKey;
  entries: () => MenuEntry[];
}

export const MENUS: TopMenu[] = [
  {
    id: "file",
    label: "menu.file",
    entries: () => [
      cmd("file.open"),
      { type: "submenu", label: t("menu.openRecent"), icon: Clock, items: recentEntries },
      sep,
      cmd("file.save"),
      cmd("file.saveAs"),
      cmd("file.revert"),
      sep,
      sub("menu.export", [cmd("file.exportPages"), cmd("file.exportText"), cmd("file.exportImage")]),
      cmd("file.print"),
      sep,
      cmd("file.properties"),
      cmd("file.showInFolder"),
      cmd("file.copyPath"),
      sep,
      cmd("file.close"),
      cmd("file.closeAll"),
      cmd("file.reopenClosed"),
      sep,
      cmd("file.exit"),
    ],
  },
  {
    id: "edit",
    label: "menu.edit",
    entries: () => [
      cmd("edit.undo", undoLabel("undo")),
      cmd("edit.redo", undoLabel("redo")),
      sep,
      cmd("edit.copy"),
      cmd("edit.selectAll"),
      cmd("tool.snapshot"),
      cmd("tool.ocrRegion"),
      cmd("edit.delete"),
      sep,
      cmd("edit.find"),
      cmd("edit.findNext"),
      cmd("edit.findPrev"),
      cmd("edit.search"),
      sep,
      cmd("edit.preferences"),
    ],
  },
  {
    id: "view",
    label: "menu.view",
    entries: () => [
      sub("menu.zoom", [
        cmd("view.zoomIn"),
        cmd("view.zoomOut"),
        sep,
        cmd("view.actualSize"),
        cmd("view.fitPage"),
        cmd("view.fitWidth"),
        cmd("view.autoZoom"),
      ]),
      sub("menu.rotateView", [cmd("view.rotateCw"), cmd("view.rotateCcw")]),
      sub("menu.pageDisplay", [
        cmd("view.layout.single"),
        cmd("view.layout.continuous"),
        cmd("view.layout.twoPage"),
        cmd("view.layout.twoPageContinuous"),
        cmd("view.layout.horizontal"),
        cmd("view.layout.wrapped"),
        sep,
        cmd("view.coverPage"),
      ]),
      sub("menu.pageBackground", [
        cmd("view.bg.normal"),
        cmd("view.bg.dark"),
        cmd("view.bg.night"),
        cmd("view.bg.sepia"),
        cmd("view.bg.green"),
        cmd("view.bg.custom"),
        sep,
        cmd("view.bg.cycle"),
        { type: "item", label: `${t("settings.section.pageColors")}…`, icon: Palette, onSelect: () => openSettings("pageColors") },
      ]),
      sep,
      sub("menu.sidebar", [
        cmd("view.sidebar"),
        sep,
        cmd("view.sidebar.thumbnails"),
        cmd("view.sidebar.outline"),
        cmd("view.sidebar.annotations"),
        cmd("view.sidebar.attachments"),
        cmd("view.sidebar.layers"),
        cmd("view.sidebar.search"),
      ]),
      sub("menu.showHide", [cmd("view.menuBar"), cmd("comment.toolbar"), cmd("view.statusBar"), cmd("comment.toggleVisibility")]),
      sub("menu.theme", [cmd("view.theme.system"), cmd("view.theme.light"), cmd("view.theme.dark")]),
      sep,
      cmd("view.readMode"),
      cmd("view.fullscreen"),
      cmd("view.presentation"),
      cmd("view.autoScroll"),
      cmd("view.alwaysOnTop"),
      sep,
      sub("menu.readAloud", [cmd("tts.readPage"), cmd("tts.readFromHere"), sep, cmd("tts.pause"), cmd("tts.stop")]),
    ],
  },
  {
    id: "go",
    label: "menu.go",
    entries: () => [
      cmd("go.first"),
      cmd("go.prev"),
      cmd("go.next"),
      cmd("go.last"),
      sep,
      cmd("go.page"),
      sep,
      cmd("go.back"),
      cmd("go.forward"),
      sep,
      cmd("go.nextTab"),
      cmd("go.prevTab"),
    ],
  },
  {
    id: "comment",
    label: "menu.comment",
    entries: () => [
      cmd("comment.toolbar"),
      sep,
      cmd("tool.select"),
      cmd("tool.hand"),
      sep,
      cmd("tool.note"),
      cmd("tool.highlight"),
      cmd("tool.underline"),
      cmd("tool.strikeout"),
      cmd("tool.squiggly"),
      cmd("tool.freetext"),
      cmd("tool.ink"),
      cmd("tool.eraser"),
      sub("menu.shapes", [cmd("tool.square"), cmd("tool.circle"), cmd("tool.line"), cmd("tool.arrow"), cmd("tool.polygon"), cmd("tool.polyline")]),
      cmd("tool.stamp"),
      cmd("tool.signature"),
      cmd("tool.image"),
      sep,
      cmd("comment.next"),
      cmd("comment.prev"),
      cmd("comment.toggleVisibility"),
      sep,
      cmd("comment.setAuthor"),
      cmd("comment.deleteAll"),
    ],
  },
  {
    id: "document",
    label: "menu.document",
    entries: () => [
      cmd("page.organize"),
      sep,
      sub("menu.insertPages", [cmd("page.insertFile"), cmd("page.insertBlank"), cmd("page.duplicate")]),
      sub("menu.rotatePages", [
        cmd("page.rotateCw"),
        cmd("page.rotateCcw"),
        sep,
        cmd("page.rotateAllCw"),
        cmd("page.rotateAllCcw"),
        cmd("page.rotateAll180"),
      ]),
      sub("menu.flipPages", [cmd("page.flipH"), cmd("page.flipV"), sep, cmd("page.flipAllH"), cmd("page.flipAllV")]),
      cmd("page.replace"),
      cmd("page.delete"),
      sep,
      cmd("page.extract"),
      cmd("page.split"),
      sep,
      cmd("page.moveUp"),
      cmd("page.moveDown"),
      sep,
      cmd("doc.watermark"),
      cmd("doc.ocr"),
      sub("menu.protection", [cmd("doc.security"), cmd("doc.removeSecurity")]),
      sep,
      cmd("file.properties"),
    ],
  },
  {
    id: "help",
    label: "menu.help",
    entries: () => [
      cmd("help.commandPalette"),
      cmd("help.shortcuts"),
      sep,
      cmd("help.welcome"),
      cmd("help.logs"),
      sep,
      cmd("help.about"),
    ],
  },
];
