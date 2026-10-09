/**
 * Command registry. Every user action is a command with an id, a localised label, an optional
 * icon and default keyboard shortcuts. Menus, toolbars, the command palette and the shortcut
 * editor are all generated from this list.
 */
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpToLine,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Circle,
  ClipboardCopy,
  Columns2,
  Command as CommandIcon,
  Copy,
  Eraser,
  Expand,
  FileDown,
  FileInput,
  FileOutput,
  FilePlus,
  FileText,
  FileX,
  FolderOpen,
  Hand,
  Highlighter,
  ImagePlus,
  Info,
  Keyboard,
  Layers,
  ListTree,
  Maximize,
  Minus,
  Moon,
  MousePointer2,
  MoveRight,
  Paperclip,
  PenLine,
  PenTool,
  Pentagon,
  Presentation,
  Printer,
  Redo2,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Save,
  SaveAll,
  ScrollText,
  Search,
  Settings as SettingsIcon,
  Spline,
  Square,
  Stamp,
  StickyNote,
  Strikethrough,
  Sun,
  Trash,
  Type,
  Underline,
  Undo2,
  Volume2,
  WavesHorizontal,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
  GalleryVertical,
  MessageSquareText,
  PanelLeft,
  Pause,
  Square as StopIcon,
  ScanText,
  Sparkles,
  TextAlignJustify,
  Pin,
  Camera,
  LayoutGrid,
  FlipHorizontal2,
  FlipVertical2,
  Replace,
  Scissors,
  Droplets,
  Lock,
  LockOpen,
  TextSelect,
  CircleHelp,
  FileScan,
  PartyPopper,
} from "lucide-react";
import type { MessageKey } from "../i18n";
import { t } from "../i18n";
import type { DocumentController } from "../document/DocumentController";
import { useSettings, settings } from "../settings/store";
import type { PageMode } from "../settings/defaults";
import { confirm, openDialog, openSettings, useUi, toast } from "../state/ui";
import { toAppError } from "../lib/errors";
import { checkForUpdatesNow } from "../state/updater";
import { showWhatsNew } from "../state/whatsNew";
import {
  activeController,
  closeAll,
  closeOthers,
  closeTab,
  cycleTab,
  reopenClosed,
  useTabs,
  activateTab,
} from "../state/tabs";
import {
  copyPath,
  exportText,
  openFileDialog,
  pickImage,
  revertController,
  saveController,
  saveControllerAs,
  showInFolder,
} from "../document/fileActions";
import { enterPresentation, exitPresentation, isPresenting, toggleFullscreen } from "../document/presentation";
import { toggleAutoScroll, useAutoScroll } from "../document/autoScroll";
import { readAloud, stopReading, togglePauseReading, useReadAloud } from "../document/readAloud";
import type { ToolId } from "../annotations/tools";
import { copyAnnotations, annotationsForPaste, hasCopiedAnnotations } from "../state/clipboard";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../lib/ipc";

export type Ctx = DocumentController | null;

export interface CommandDef {
  id: string;
  label: MessageKey;
  icon?: LucideIcon;
  /** Default accelerators (see `keys.ts` for the format). */
  keys?: string[];
  /** May fire while focus is in a text field. */
  global?: boolean;
  /** Requires a loaded document. */
  needsDoc?: boolean;
  /** Return `false` when the command did not handle the event (default action proceeds). */
  run: (c: Ctx) => unknown;
  enabled?: (c: Ctx) => boolean;
  checked?: (c: Ctx) => boolean;
  /** Shown in the command palette (default true). */
  palette?: boolean;
}

const setSetting = (path: string, value: unknown) => useSettings.getState().set(path, value);
const ready = (c: Ctx): c is DocumentController => !!c && c.isReady;
const canEdit = (c: Ctx) => ready(c) && c.canAnnotate;
const canAssemble = (c: Ctx) =>
  ready(c) && (!settings().saving.respectRestrictions || c.state.permissions.assemble || c.state.permissions.modify);

function tool(id: ToolId, label: MessageKey, icon: LucideIcon, keys?: string[]): CommandDef {
  return {
    id: `tool.${id}`,
    label,
    icon,
    keys,
    needsDoc: true,
    run: (c) => {
      if (!c) return;
      const ui = useUi.getState();
      if (id !== "select" && id !== "hand" && !ui.commentTools) useUi.setState({ commentTools: true });
      c.setTool(c.state.tool === id && id !== "select" ? "select" : id);
    },
    enabled: (c) => ready(c) && (id === "select" || id === "hand" || c.canAnnotate),
    checked: (c) => c?.state.tool === id,
  };
}

function pageMode(mode: PageMode, label: MessageKey): CommandDef {
  return {
    id: `view.bg.${mode}`,
    label,
    run: () => setSetting("pageColors.mode", mode),
    checked: () => settings().pageColors.mode === mode,
    palette: true,
  };
}

function layout(id: string, value: Parameters<DocumentController["setLayout"]>[0], label: MessageKey, icon?: LucideIcon): CommandDef {
  return {
    id: `view.layout.${id}`,
    label,
    icon,
    needsDoc: true,
    run: (c) => c?.setLayout(value),
    checked: (c) => c?.state.layout === value,
  };
}

function sidebarPanel(panel: string, label: MessageKey, icon: LucideIcon): CommandDef {
  return {
    id: `view.sidebar.${panel}`,
    label,
    icon,
    needsDoc: true,
    run: (c) => {
      if (!c) return;
      const open = !(c.state.sidebarOpen && c.state.sidebarPanel === panel);
      c.setSidebar(open, panel);
    },
    checked: (c) => !!c && c.state.sidebarOpen && c.state.sidebarPanel === panel,
  };
}

async function placeImage(c: DocumentController) {
  const image = await pickImage();
  if (image) c.setTool("image", { type: "image", image, isSignature: false });
}

function deselect(c: Ctx): boolean {
  if (c?.state.contextMenu) {
    c.closeContextMenu();
    return true;
  }
  const ui = useUi.getState();
  if (c?.state.tool === "snapshot") {
    c.endSnapshot();
    return true;
  }
  if (c?.state.organizing) {
    c.setOrganizing(false);
    return true;
  }
  if (isPresenting()) {
    void exitPresentation();
    return true;
  }
  if (c && c.annotations.getState().editing) {
    c.setEditing(null);
    return true;
  }
  if (c && c.annotations.getState().selection.length) {
    c.clearSelection();
    return true;
  }
  if (c && c.state.tool !== settings().navigation.defaultTool) {
    c.setTool(settings().navigation.defaultTool);
    return true;
  }
  if (ui.findOpen) {
    useUi.setState({ findOpen: false });
    c?.closeFind();
    return true;
  }
  if (ui.readMode) {
    useUi.setState({ readMode: false });
    return true;
  }
  if (ui.fullscreen) {
    void toggleFullscreen();
    return true;
  }
  return false;
}

function copy(c: Ctx): boolean {
  if (!c) return false;
  const sel = document.getSelection();
  if (sel && !sel.isCollapsed) return false; // native text copy
  const { selection, items } = c.annotations.getState();
  if (!selection.length) return false;
  copyAnnotations(selection.map((id) => items[id]).filter(Boolean));
  toast("info", t("toast.copied"));
  return true;
}

function paste(c: Ctx): boolean {
  if (!c || !hasCopiedAnnotations() || !c.canAnnotate) return false;
  const pasted = annotationsForPaste(c.state.page - 1, c.author());
  c.commit(
    t("history.paste"),
    pasted.map((a) => ({ id: a.id, before: null, after: a })),
  );
  c.select(pasted.map((a) => a.id));
  return true;
}

function selectAll(c: Ctx): boolean {
  const viewerDiv = c?.scrollContainer?.querySelector(".pdfViewer");
  if (!viewerDiv) return false;
  const sel = document.getSelection();
  sel?.selectAllChildren(viewerDiv);
  return true;
}

async function rotateCurrentPage(c: DocumentController, delta: number) {
  await c.applyPageOps([{ op: "rotate", pages: [c.state.page - 1], delta }], [], t("cmd.page.rotateCw"));
}

const allPages = (c: DocumentController) => Array.from({ length: c.state.numPages }, (_, i) => i);

async function rotateAll(c: DocumentController, delta: number, label: MessageKey) {
  await c.applyPageOps([{ op: "rotate", pages: allPages(c), delta }], [], t(label));
}

async function flipPages(c: DocumentController, all: boolean, horizontal: boolean) {
  const pages = all ? allPages(c) : [c.state.page - 1];
  await c.applyPageOps([{ op: "flip", pages, horizontal }], [], t(horizontal ? "organize.flipH" : "organize.flipV"));
}

async function duplicateCurrentPage(c: DocumentController) {
  const page = c.state.page;
  await c.applyPageOps([{ op: "duplicate", pages: [page - 1], at: page }], [], t("organize.duplicate"));
  c.goToPage(page + 1, { recordHistory: false });
}

/** Remove password protection, asking through the security dialog when owner rights are needed. */
async function removeProtection(c: DocumentController) {
  try {
    const info = await c.securityInfo();
    if (!info.encrypted) {
      toast("info", t("security.notProtected"));
      return;
    }
    if (info.restricted && !info.ownerAccess && !c.hasOwnerAccess) {
      void openDialog("security", { tabId: c.tabId });
      return;
    }
    const answer = await confirm({
      title: t("security.removeTitle"),
      message: t("security.removeMessage"),
      confirmLabel: t("security.remove"),
      danger: true,
    });
    if (answer.choice !== "confirm") return;
    await c.applySecurity(null);
    toast("success", t("security.removed"), { detail: t("security.saveToApply"), action: { label: t("common.save"), run: () => void c.save() } });
  } catch (err) {
    toast("error", toAppError(err).message);
  }
}

async function movePage(c: DocumentController, direction: -1 | 1) {
  const n = c.state.numPages;
  const from = c.state.page - 1;
  const to = from + direction;
  if (to < 0 || to >= n) return;
  const order = Array.from({ length: n }, (_, i) => i);
  [order[from], order[to]] = [order[to], order[from]];
  await c.applyPageOps([{ op: "reorder", order }], [], direction < 0 ? t("cmd.page.moveUp") : t("cmd.page.moveDown"));
  c.goToPage(to + 1, { recordHistory: false });
}

function nextComment(c: DocumentController, direction: 1 | -1) {
  const { items, selection } = c.annotations.getState();
  const list = Object.values(items)
    .filter((a) => !a.inReplyTo)
    .sort((a, b) => a.page - b.page || b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0]);
  if (!list.length) return;
  const cur = list.findIndex((a) => a.id === selection[0]);
  const next = list[(cur + direction + list.length) % list.length] ?? list[0];
  c.select([next.id]);
  c.scrollToRect(next.page, next.rect);
}

export const COMMANDS: CommandDef[] = [
  // File ---------------------------------------------------------------------------------------
  { id: "file.open", label: "cmd.file.open", icon: FolderOpen, keys: ["Ctrl+O"], global: true, run: () => openFileDialog() },
  {
    id: "file.close",
    label: "cmd.file.close",
    icon: X,
    keys: ["Ctrl+W", "Ctrl+F4"],
    global: true,
    run: () => {
      const id = useTabs.getState().activeId;
      if (id) void closeTab(id);
    },
    enabled: () => !!useTabs.getState().activeId,
  },
  { id: "file.closeAll", label: "cmd.file.closeAll", keys: ["Ctrl+Shift+W"], run: () => closeAll(), enabled: () => useTabs.getState().tabs.length > 0 },
  {
    id: "file.closeOthers",
    label: "cmd.file.closeOthers",
    run: () => {
      const id = useTabs.getState().activeId;
      if (id) void closeOthers(id);
    },
    enabled: () => useTabs.getState().tabs.length > 1,
  },
  { id: "file.reopenClosed", label: "cmd.file.reopenClosed", keys: ["Ctrl+Shift+T"], run: () => reopenClosed(), enabled: () => useTabs.getState().closed.length > 0 },
  {
    id: "file.save",
    label: "cmd.file.save",
    icon: Save,
    keys: ["Ctrl+S"],
    global: true,
    needsDoc: true,
    run: (c) => c && saveController(c),
    enabled: (c) => ready(c) && !c.state.saving,
  },
  {
    id: "file.saveAs",
    label: "cmd.file.saveAs",
    icon: SaveAll,
    keys: ["Ctrl+Shift+S"],
    global: true,
    needsDoc: true,
    run: (c) => c && saveControllerAs(c),
    enabled: (c) => ready(c) && !c.state.saving,
  },
  { id: "file.revert", label: "cmd.file.revert", needsDoc: true, run: (c) => c && revertController(c), enabled: (c) => ready(c) && c.isDirty },
  { id: "file.reload", label: "cmd.file.reload", icon: RefreshCw, keys: ["Ctrl+R"], needsDoc: true, run: (c) => c && revertController(c), enabled: ready },
  {
    id: "file.print",
    label: "cmd.file.print",
    icon: Printer,
    keys: ["Ctrl+P"],
    global: true,
    needsDoc: true,
    run: (c) => c && openDialog("print", { tabId: c.tabId }),
    enabled: ready,
  },
  {
    id: "file.properties",
    label: "cmd.file.properties",
    icon: Info,
    keys: ["Ctrl+D"],
    needsDoc: true,
    run: (c) => c && openDialog("docProps", { tabId: c.tabId }),
    enabled: ready,
  },
  { id: "file.showInFolder", label: "cmd.file.showInFolder", needsDoc: true, run: (c) => c && showInFolder(c), enabled: (c) => !!c?.state.info },
  { id: "file.copyPath", label: "cmd.file.copyPath", icon: ClipboardCopy, needsDoc: true, run: (c) => c && copyPath(c), enabled: (c) => !!c?.state.info },
  {
    id: "file.exportPages",
    label: "cmd.file.exportPages",
    icon: FileOutput,
    needsDoc: true,
    run: (c) => c && openDialog("pageOps", { tabId: c.tabId, mode: "extract" }),
    enabled: ready,
  },
  { id: "file.exportText", label: "cmd.file.exportText", icon: FileText, needsDoc: true, run: (c) => c && exportText(c), enabled: (c) => ready(c) && (!settings().saving.respectRestrictions || c.state.permissions.copy) },
  {
    id: "file.exportImage",
    label: "cmd.file.exportImage",
    icon: FileDown,
    needsDoc: true,
    run: (c) => c && openDialog("exportImage", { tabId: c.tabId }),
    enabled: ready,
  },
  {
    id: "file.exit",
    label: "cmd.file.exit",
    keys: ["Ctrl+Q"],
    global: true,
    run: () => getCurrentWindow().close(),
  },

  // Edit ---------------------------------------------------------------------------------------
  {
    id: "edit.undo",
    label: "cmd.edit.undo",
    icon: Undo2,
    keys: ["Ctrl+Z"],
    needsDoc: true,
    run: (c) => c?.undo(),
    enabled: (c) => !!c?.state.history.canUndo,
  },
  {
    id: "edit.redo",
    label: "cmd.edit.redo",
    icon: Redo2,
    keys: ["Ctrl+Y", "Ctrl+Shift+Z"],
    needsDoc: true,
    run: (c) => c?.redo(),
    enabled: (c) => !!c?.state.history.canRedo,
  },
  { id: "edit.copy", label: "cmd.edit.copy", icon: Copy, keys: ["Ctrl+C"], run: copy, palette: false },
  { id: "edit.paste", label: "history.paste", keys: ["Ctrl+V"], run: paste, palette: false },
  { id: "edit.selectAll", label: "cmd.edit.selectAll", keys: ["Ctrl+A"], needsDoc: true, run: selectAll, enabled: ready },
  {
    id: "edit.delete",
    label: "cmd.edit.delete",
    icon: Trash,
    keys: ["Delete", "Backspace"],
    needsDoc: true,
    run: (c) => {
      const ids = c?.annotations.getState().selection ?? [];
      if (!c || !ids.length) return false;
      c.deleteAnnotations(ids);
      return true;
    },
    enabled: (c) => !!c && c.annotations.getState().selection.length > 0,
    palette: false,
  },
  {
    id: "edit.find",
    label: "cmd.edit.find",
    icon: Search,
    keys: ["Ctrl+F"],
    global: true,
    needsDoc: true,
    run: () => useUi.setState((s) => ({ findOpen: true, findFocus: s.findFocus + 1 })),
    enabled: ready,
  },
  {
    id: "edit.findNext",
    label: "cmd.edit.findNext",
    keys: ["F3"],
    global: true,
    needsDoc: true,
    run: (c) => c?.state.find.query && c.find(c.state.find.query, {}, false, true),
    enabled: (c) => !!c?.state.find.query,
  },
  {
    id: "edit.findPrev",
    label: "cmd.edit.findPrev",
    keys: ["Shift+F3"],
    global: true,
    needsDoc: true,
    run: (c) => c?.state.find.query && c.find(c.state.find.query, {}, true, true),
    enabled: (c) => !!c?.state.find.query,
  },
  {
    id: "edit.search",
    label: "cmd.edit.search",
    icon: ScanText,
    keys: ["Ctrl+Shift+F"],
    global: true,
    needsDoc: true,
    run: (c) => c?.setSidebar(true, "search"),
    enabled: ready,
  },
  { id: "edit.preferences", label: "cmd.edit.preferences", icon: SettingsIcon, keys: ["Ctrl+,"], global: true, run: () => openSettings() },
  { id: "edit.deselect", label: "cmd.edit.deselect", keys: ["Esc"], run: deselect, palette: false },

  // View ---------------------------------------------------------------------------------------
  { id: "view.zoomIn", label: "cmd.view.zoomIn", icon: ZoomIn, keys: ["Ctrl+=", "Ctrl++"], global: true, needsDoc: true, run: (c) => c?.zoomStep(1), enabled: ready },
  { id: "view.zoomOut", label: "cmd.view.zoomOut", icon: ZoomOut, keys: ["Ctrl+-"], global: true, needsDoc: true, run: (c) => c?.zoomStep(-1), enabled: ready },
  { id: "view.actualSize", label: "cmd.view.actualSize", keys: ["Ctrl+1"], needsDoc: true, run: (c) => c?.setZoom("page-actual"), enabled: ready, checked: (c) => c?.state.scaleValue === "page-actual" },
  { id: "view.fitPage", label: "cmd.view.fitPage", icon: Expand, keys: ["Ctrl+0"], needsDoc: true, run: (c) => c?.setZoom("page-fit"), enabled: ready, checked: (c) => c?.state.scaleValue === "page-fit" },
  { id: "view.fitWidth", label: "cmd.view.fitWidth", icon: Columns2, keys: ["Ctrl+2"], needsDoc: true, run: (c) => c?.setZoom("page-width"), enabled: ready, checked: (c) => c?.state.scaleValue === "page-width" },
  { id: "view.autoZoom", label: "cmd.view.autoZoom", keys: ["Ctrl+3"], needsDoc: true, run: (c) => c?.setZoom("auto"), enabled: ready, checked: (c) => c?.state.scaleValue === "auto" },
  { id: "view.rotateCw", label: "cmd.view.rotateCw", icon: RotateCw, keys: ["Ctrl+]"], needsDoc: true, run: (c) => c?.rotateView(90), enabled: ready },
  { id: "view.rotateCcw", label: "cmd.view.rotateCcw", icon: RotateCcw, keys: ["Ctrl+["], needsDoc: true, run: (c) => c?.rotateView(-90), enabled: ready },
  layout("continuous", "continuous", "cmd.view.layout.continuous", GalleryVertical),
  layout("single", "single", "cmd.view.layout.single"),
  layout("twoPageContinuous", "twoPageContinuous", "cmd.view.layout.twoPageContinuous", BookOpen),
  layout("twoPage", "twoPage", "cmd.view.layout.twoPage"),
  layout("horizontal", "horizontal", "cmd.view.layout.horizontal"),
  layout("wrapped", "wrapped", "cmd.view.layout.wrapped"),
  {
    id: "view.coverPage",
    label: "cmd.view.coverPage",
    run: (c) => {
      setSetting("reading.coverPage", !settings().reading.coverPage);
      if (c) c.setLayout(c.state.layout);
    },
    checked: () => settings().reading.coverPage,
  },
  pageMode("normal", "cmd.view.bg.normal"),
  pageMode("dark", "cmd.view.bg.dark"),
  pageMode("night", "cmd.view.bg.night"),
  pageMode("sepia", "cmd.view.bg.sepia"),
  pageMode("green", "cmd.view.bg.green"),
  pageMode("custom", "cmd.view.bg.custom"),
  {
    id: "view.bg.cycle",
    label: "cmd.view.bg.cycle",
    icon: Moon,
    keys: ["Ctrl+Alt+N"],
    run: () => {
      const order: PageMode[] = ["normal", "night", "dark", "sepia", "green"];
      const cur = settings().pageColors.mode;
      setSetting("pageColors.mode", order[(order.indexOf(cur) + 1) % order.length]);
    },
  },
  {
    id: "view.sidebar",
    label: "cmd.view.sidebar",
    icon: PanelLeft,
    keys: ["F4"],
    needsDoc: true,
    run: (c) => c?.setSidebar(!c.state.sidebarOpen),
    checked: (c) => !!c?.state.sidebarOpen,
    enabled: ready,
  },
  sidebarPanel("thumbnails", "cmd.view.sidebar.thumbnails", GalleryVertical),
  sidebarPanel("outline", "cmd.view.sidebar.outline", ListTree),
  sidebarPanel("annotations", "cmd.view.sidebar.annotations", MessageSquareText),
  sidebarPanel("attachments", "cmd.view.sidebar.attachments", Paperclip),
  sidebarPanel("layers", "cmd.view.sidebar.layers", Layers),
  sidebarPanel("search", "cmd.view.sidebar.search", ScanText),
  {
    id: "view.menuBar",
    label: "cmd.view.menuBar",
    run: () => setSetting("appearance.showMenuBar", !settings().appearance.showMenuBar),
    checked: () => settings().appearance.showMenuBar,
  },
  {
    id: "view.statusBar",
    label: "cmd.view.statusBar",
    run: () => setSetting("appearance.showStatusBar", !settings().appearance.showStatusBar),
    checked: () => settings().appearance.showStatusBar,
  },
  {
    id: "view.readMode",
    label: "cmd.view.readMode",
    icon: TextAlignJustify,
    keys: ["Ctrl+H"],
    run: () => useUi.setState((s) => ({ readMode: !s.readMode })),
    checked: () => useUi.getState().readMode,
  },
  { id: "view.fullscreen", label: "cmd.view.fullscreen", icon: Maximize, keys: ["F11"], global: true, run: () => toggleFullscreen(), checked: () => useUi.getState().fullscreen },
  {
    id: "view.presentation",
    label: "cmd.view.presentation",
    icon: Presentation,
    keys: ["F5", "Ctrl+L"],
    global: true,
    needsDoc: true,
    run: (c) => (isPresenting() ? exitPresentation() : c && enterPresentation(c)),
    enabled: ready,
    checked: () => useUi.getState().presentation,
  },
  {
    id: "view.autoScroll",
    label: "cmd.view.autoScroll",
    icon: ArrowDownToLine,
    keys: ["Ctrl+Shift+H"],
    needsDoc: true,
    run: (c) => c && toggleAutoScroll(c),
    enabled: ready,
    checked: () => useAutoScroll.getState().active,
  },
  { id: "view.theme.system", label: "cmd.view.theme.system", run: () => setSetting("appearance.theme", "system"), checked: () => settings().appearance.theme === "system" },
  { id: "view.theme.light", label: "cmd.view.theme.light", icon: Sun, run: () => setSetting("appearance.theme", "light"), checked: () => settings().appearance.theme === "light" },
  { id: "view.theme.dark", label: "cmd.view.theme.dark", icon: Moon, run: () => setSetting("appearance.theme", "dark"), checked: () => settings().appearance.theme === "dark" },
  {
    id: "view.toggleTheme",
    label: "cmd.view.toggleTheme",
    icon: Sparkles,
    keys: ["Ctrl+Shift+L"],
    run: () => setSetting("appearance.theme", document.documentElement.dataset.theme === "dark" ? "light" : "dark"),
  },
  {
    id: "view.alwaysOnTop",
    label: "cmd.view.alwaysOnTop",
    icon: Pin,
    run: async () => {
      const win = getCurrentWindow();
      const next = !alwaysOnTop;
      await win.setAlwaysOnTop(next);
      alwaysOnTop = next;
    },
    checked: () => alwaysOnTop,
  },

  // Go -----------------------------------------------------------------------------------------
  { id: "go.first", label: "cmd.go.first", icon: ArrowUpToLine, keys: ["Home", "Ctrl+Home"], needsDoc: true, run: (c) => c?.firstPage(), enabled: (c) => ready(c) && c.state.page > 1 },
  { id: "go.prev", label: "cmd.go.prev", icon: ChevronUp, keys: ["Alt+Up", "K"], needsDoc: true, run: (c) => c?.previousPage(), enabled: (c) => ready(c) && c.state.page > 1 },
  { id: "go.next", label: "cmd.go.next", icon: ChevronDown, keys: ["Alt+Down", "J"], needsDoc: true, run: (c) => c?.nextPage(), enabled: (c) => ready(c) && c.state.page < c.state.numPages },
  { id: "go.last", label: "cmd.go.last", icon: ArrowDownToLine, keys: ["End", "Ctrl+End"], needsDoc: true, run: (c) => c?.lastPage(), enabled: (c) => ready(c) && c.state.page < c.state.numPages },
  { id: "go.page", label: "cmd.go.page", keys: ["Ctrl+G"], global: true, needsDoc: true, run: (c) => c && openDialog("goToPage", { tabId: c.tabId }), enabled: ready },
  { id: "go.back", label: "cmd.go.back", icon: ArrowLeft, keys: ["Alt+Left"], needsDoc: true, run: (c) => c?.nav.goBack(), enabled: (c) => !!c?.state.canGoBack },
  { id: "go.forward", label: "cmd.go.forward", icon: ArrowRight, keys: ["Alt+Right"], needsDoc: true, run: (c) => c?.nav.goForward(), enabled: (c) => !!c?.state.canGoForward },
  { id: "go.nextTab", label: "cmd.go.nextTab", keys: ["Ctrl+Tab", "Ctrl+PageDown"], global: true, run: () => cycleTab(1), enabled: () => useTabs.getState().tabs.length > 1 },
  { id: "go.prevTab", label: "cmd.go.prevTab", keys: ["Ctrl+Shift+Tab", "Ctrl+PageUp"], global: true, run: () => cycleTab(-1), enabled: () => useTabs.getState().tabs.length > 1 },

  // Tools --------------------------------------------------------------------------------------
  tool("select", "cmd.tool.select", MousePointer2, ["V"]),
  tool("hand", "cmd.tool.hand", Hand, ["H"]),
  tool("note", "cmd.tool.note", StickyNote, ["S", "Ctrl+6"]),
  tool("highlight", "cmd.tool.highlight", Highlighter, ["U"]),
  tool("underline", "cmd.tool.underline", Underline),
  tool("strikeout", "cmd.tool.strikeout", Strikethrough),
  tool("squiggly", "cmd.tool.squiggly", WavesHorizontal),
  tool("freetext", "cmd.tool.freetext", Type, ["T"]),
  tool("ink", "cmd.tool.ink", PenTool, ["D"]),
  tool("eraser", "cmd.tool.eraser", Eraser, ["X"]),
  tool("square", "cmd.tool.square", Square, ["R"]),
  tool("circle", "cmd.tool.circle", Circle, ["O"]),
  tool("line", "cmd.tool.line", Minus, ["L"]),
  tool("arrow", "cmd.tool.arrow", MoveRight, ["A"]),
  tool("polygon", "cmd.tool.polygon", Pentagon),
  tool("polyline", "cmd.tool.polyline", Spline),
  tool("stamp", "cmd.tool.stamp", Stamp),
  {
    id: "tool.signature",
    label: "cmd.tool.signature",
    icon: PenLine,
    needsDoc: true,
    run: () => openDialog("signature", {}),
    enabled: canEdit,
  },
  { id: "tool.image", label: "cmd.tool.image", icon: ImagePlus, needsDoc: true, run: (c) => c && placeImage(c), enabled: canEdit },
  {
    id: "tool.snapshot",
    label: "cmd.tool.snapshot",
    icon: Camera,
    keys: ["Ctrl+Alt+S"],
    needsDoc: true,
    run: (c) => (c?.state.tool === "snapshot" && c.state.snapshotPurpose === "copy" ? c.endSnapshot() : c?.startSnapshot("copy")),
    enabled: ready,
    checked: (c) => c?.state.tool === "snapshot" && c.state.snapshotPurpose === "copy",
  },

  // Comments -----------------------------------------------------------------------------------
  {
    id: "comment.toolbar",
    label: "cmd.comment.toolbar",
    icon: MessageSquareText,
    keys: ["C"],
    run: () => useUi.setState((s) => ({ commentTools: !s.commentTools })),
    checked: () => useUi.getState().commentTools,
  },
  {
    id: "comment.toggleVisibility",
    label: "cmd.comment.toggleVisibility",
    run: () => setSetting("annotations.showAnnotations", !settings().annotations.showAnnotations),
    checked: () => settings().annotations.showAnnotations,
  },
  { id: "comment.next", label: "cmd.comment.next", icon: ChevronDown, needsDoc: true, run: (c) => c && nextComment(c, 1), enabled: ready },
  { id: "comment.prev", label: "cmd.comment.prev", icon: ChevronUp, needsDoc: true, run: (c) => c && nextComment(c, -1), enabled: ready },
  {
    id: "comment.setAuthor",
    label: "cmd.comment.setAuthor",
    run: async () => {
      const name = await openDialog("prompt", {
        title: t("dialog.author.title"),
        message: t("dialog.author.message"),
        label: t("dialog.author.label"),
        value: settings().annotations.author,
        placeholder: t("settings.author.placeholder"),
      });
      if (name !== null) {
        setSetting("annotations.author", name.trim());
        toast("success", t("toast.authorSet"));
      }
    },
  },
  {
    id: "comment.deleteAll",
    label: "cmd.comment.deleteAll",
    icon: FileX,
    needsDoc: true,
    run: async (c) => {
      if (!c) return;
      const ids = Object.values(c.annotations.getState().items)
        .filter((a) => !a.inReplyTo && !a.locked)
        .map((a) => a.id);
      if (!ids.length) return;
      const answer = await confirm({
        title: t("dialog.deleteAll.title"),
        message: t("dialog.deleteAll.message", { count: ids.length }),
        confirmLabel: t("common.delete"),
        danger: true,
      });
      if (answer.choice === "confirm") c.deleteAnnotations(ids);
    },
    enabled: (c) => canEdit(c) && Object.keys(c!.annotations.getState().items).length > 0,
  },

  // Pages --------------------------------------------------------------------------------------
  { id: "page.rotateCw", label: "cmd.page.rotateCw", icon: RotateCw, keys: ["Ctrl+Shift+R"], needsDoc: true, run: (c) => c && rotateCurrentPage(c, 90), enabled: canAssemble },
  { id: "page.rotateCcw", label: "cmd.page.rotateCcw", icon: RotateCcw, needsDoc: true, run: (c) => c && rotateCurrentPage(c, -90), enabled: canAssemble },
  {
    id: "page.organize",
    label: "cmd.page.organize",
    icon: LayoutGrid,
    keys: ["Ctrl+Shift+O"],
    needsDoc: true,
    run: (c) => c?.setOrganizing(!c.state.organizing),
    enabled: ready,
    checked: (c) => !!c?.state.organizing,
  },
  {
    id: "page.rotateAllCw",
    label: "cmd.page.rotateAllCw",
    needsDoc: true,
    run: (c) => c && rotateAll(c, 90, "cmd.page.rotateAllCw"),
    enabled: canAssemble,
  },
  { id: "page.rotateAllCcw", label: "cmd.page.rotateAllCcw", needsDoc: true, run: (c) => c && rotateAll(c, -90, "cmd.page.rotateAllCcw"), enabled: canAssemble },
  { id: "page.rotateAll180", label: "cmd.page.rotateAll180", needsDoc: true, run: (c) => c && rotateAll(c, 180, "cmd.page.rotateAll180"), enabled: canAssemble },
  { id: "page.flipH", label: "cmd.page.flipH", icon: FlipVertical2, needsDoc: true, run: (c) => c && flipPages(c, false, true), enabled: canAssemble },
  { id: "page.flipV", label: "cmd.page.flipV", icon: FlipHorizontal2, needsDoc: true, run: (c) => c && flipPages(c, false, false), enabled: canAssemble },
  { id: "page.flipAllH", label: "cmd.page.flipAllH", needsDoc: true, run: (c) => c && flipPages(c, true, true), enabled: canAssemble },
  { id: "page.flipAllV", label: "cmd.page.flipAllV", needsDoc: true, run: (c) => c && flipPages(c, true, false), enabled: canAssemble },
  { id: "page.duplicate", label: "cmd.page.duplicate", icon: Copy, needsDoc: true, run: (c) => c && duplicateCurrentPage(c), enabled: canAssemble },
  {
    id: "page.replace",
    label: "cmd.page.replace",
    icon: Replace,
    needsDoc: true,
    run: (c) => c && openDialog("replacePages", { tabId: c.tabId, pages: [c.state.page] }),
    enabled: canAssemble,
  },
  { id: "page.split", label: "cmd.page.split", icon: Scissors, needsDoc: true, run: (c) => c && openDialog("splitDocument", { tabId: c.tabId }), enabled: ready },
  { id: "doc.watermark", label: "cmd.doc.watermark", icon: Droplets, needsDoc: true, run: (c) => c && openDialog("watermark", { tabId: c.tabId }), enabled: canAssemble },
  {
    id: "tool.ocrRegion",
    label: "cmd.tool.ocrRegion",
    icon: TextSelect,
    keys: ["Ctrl+Alt+T"],
    needsDoc: true,
    run: (c) => (c?.state.tool === "snapshot" && c.state.snapshotPurpose === "ocr" ? c.endSnapshot() : c?.startSnapshot("ocr")),
    enabled: ready,
    checked: (c) => c?.state.tool === "snapshot" && c.state.snapshotPurpose === "ocr",
  },
  { id: "doc.ocr", label: "cmd.doc.ocr", icon: FileScan, needsDoc: true, run: (c) => c && openDialog("ocrDocument", { tabId: c.tabId }), enabled: canAssemble },
  { id: "doc.security", label: "cmd.doc.security", icon: Lock, needsDoc: true, run: (c) => c && openDialog("security", { tabId: c.tabId }), enabled: ready },
  { id: "doc.removeSecurity", label: "cmd.doc.removeSecurity", icon: LockOpen, needsDoc: true, run: (c) => c && removeProtection(c), enabled: ready },
  {
    id: "page.delete",
    label: "cmd.page.delete",
    icon: Trash,
    keys: ["Ctrl+Shift+D"],
    needsDoc: true,
    run: (c) => c && openDialog("pageOps", { tabId: c.tabId, mode: "delete", pages: [c.state.page] }),
    enabled: (c) => canAssemble(c) && c!.state.numPages > 1,
  },
  {
    id: "page.insertBlank",
    label: "cmd.page.insertBlank",
    icon: FilePlus,
    needsDoc: true,
    run: (c) => c && openDialog("pageOps", { tabId: c.tabId, mode: "insertBlank" }),
    enabled: canAssemble,
  },
  {
    id: "page.insertFile",
    label: "cmd.page.insertFile",
    icon: FileInput,
    needsDoc: true,
    run: (c) => c && openDialog("insertFiles", { tabId: c.tabId, at: c.state.page }),
    enabled: canAssemble,
  },
  {
    id: "page.extract",
    label: "cmd.page.extract",
    icon: FileOutput,
    needsDoc: true,
    run: (c) => c && openDialog("pageOps", { tabId: c.tabId, mode: "extract", pages: [c.state.page] }),
    enabled: ready,
  },
  { id: "page.moveUp", label: "cmd.page.moveUp", needsDoc: true, run: (c) => c && movePage(c, -1), enabled: (c) => canAssemble(c) && c!.state.page > 1 },
  {
    id: "page.moveDown",
    label: "cmd.page.moveDown",
    needsDoc: true,
    run: (c) => c && movePage(c, 1),
    enabled: (c) => canAssemble(c) && c!.state.page < c!.state.numPages,
  },

  // Read out loud ------------------------------------------------------------------------------
  { id: "tts.readPage", label: "cmd.tts.readPage", icon: Volume2, keys: ["Ctrl+Shift+V"], needsDoc: true, run: (c) => c && readAloud(c, c.state.page, false), enabled: ready },
  { id: "tts.readFromHere", label: "cmd.tts.readFromHere", icon: ScrollText, keys: ["Ctrl+Shift+B"], needsDoc: true, run: (c) => c && readAloud(c, c.state.page, true), enabled: ready },
  { id: "tts.pause", label: "cmd.tts.pause", icon: Pause, keys: ["Ctrl+Shift+C"], run: () => togglePauseReading(), enabled: () => useReadAloud.getState().status !== "idle" },
  { id: "tts.stop", label: "cmd.tts.stop", icon: StopIcon, keys: ["Ctrl+Shift+E"], run: () => stopReading(), enabled: () => useReadAloud.getState().status !== "idle" },

  // Help ---------------------------------------------------------------------------------------
  { id: "help.shortcuts", label: "cmd.help.shortcuts", icon: Keyboard, keys: ["Ctrl+/"], global: true, run: () => useUi.setState({ shortcuts: true }) },
  { id: "help.commandPalette", label: "cmd.help.commandPalette", icon: CommandIcon, keys: ["Ctrl+Shift+P", "Ctrl+K"], global: true, run: () => useUi.setState({ palette: true }) },
  { id: "help.logs", label: "cmd.help.logs", run: () => api.appOpenFolder("logs") },
  { id: "help.welcome", label: "cmd.help.welcome", run: () => activateTab(null) },
  { id: "help.about", label: "cmd.help.about", icon: Info, run: () => useUi.setState({ help: "about" }) },
  { id: "help.guide", label: "cmd.help.guide", icon: CircleHelp, keys: ["F1"], global: true, run: () => useUi.setState({ help: "start", settings: null }) },
  { id: "help.checkUpdates", label: "cmd.help.checkUpdates", icon: RefreshCw, run: () => checkForUpdatesNow() },
  { id: "help.whatsNew", label: "cmd.help.whatsNew", icon: PartyPopper, run: () => showWhatsNew() },
];

let alwaysOnTop = false;

export const COMMAND_MAP = new Map(COMMANDS.map((c) => [c.id, c]));

export function getCommand(id: string): CommandDef | undefined {
  return COMMAND_MAP.get(id);
}

export function isEnabled(cmd: CommandDef, c: Ctx = activeController()): boolean {
  if (cmd.needsDoc && !c) return false;
  try {
    return cmd.enabled ? cmd.enabled(c) : true;
  } catch {
    return false;
  }
}

export function isChecked(cmd: CommandDef, c: Ctx = activeController()): boolean | undefined {
  if (!cmd.checked) return undefined;
  try {
    return cmd.checked(c);
  } catch {
    return false;
  }
}

/** Execute a command by id. Returns false if it was disabled or declined to handle the action. */
export function runCommand(id: string, c: Ctx = activeController()): boolean {
  const cmd = COMMAND_MAP.get(id);
  if (!cmd || !isEnabled(cmd, c)) return false;
  try {
    const result = cmd.run(c);
    if (result instanceof Promise) {
      result.catch((err) => {
        const e = toAppError(err);
        if (!e.isCancellation) void openDialog("error", { title: t(cmd.label), error: e });
      });
      return true;
    }
    return result !== false;
  } catch (err) {
    void openDialog("error", { title: t(cmd.label), error: toAppError(err) });
    return true;
  }
}
