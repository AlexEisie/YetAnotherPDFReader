/** Application shell: layout, theming, global keyboard handling, drag & drop, window lifecycle. */
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ChevronLeft, ChevronRight, FileUp, Minimize2, ZoomIn, ZoomOut } from "lucide-react";
import { useSettings } from "./settings/store";
import { useT } from "./i18n";
import { useUi, toast } from "./state/ui";
import { allControllers, confirmQuit, openPaths, sessionPaths, useTabs, getController } from "./state/tabs";
import { flushLibrary, saveSession } from "./state/library";
import { dispatchKeydown } from "./commands/keybindings";
import { useActiveController, useDocState } from "./hooks/useDoc";
import { MenuBar } from "./components/shell/MenuBar";
import { TabBar } from "./components/shell/TabBar";
import { Toolbar } from "./components/shell/Toolbar";
import { StatusBar } from "./components/shell/StatusBar";
import { StartPage } from "./components/shell/StartPage";
import { CommentToolbar } from "./components/annotations/CommentToolbar";
import { Sidebar, CommentsPane } from "./components/sidebar/Sidebar";
import { DocumentView } from "./components/viewer/DocumentView";
import { FindBar } from "./components/viewer/FindBar";
import { DialogHost } from "./components/dialogs/DialogHost";
import { AboutDialog, CommandPalette, ShortcutsDialog } from "./components/dialogs/Overlays";
import { SettingsView } from "./components/settings/SettingsView";
import { Toasts } from "./components/common/Toasts";
import { TooltipHost } from "./components/common/Tooltip";
import { DUOTONE_FILTER_ID, duotoneTables, pageColorStyle } from "./document/pageColors";
import { createLogger, setLogLevel } from "./lib/log";
import type { DocumentController } from "./document/DocumentController";

const log = createLogger("app");

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return 0;
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(parseInt(m[1], 16)) + 0.7152 * lin(parseInt(m[2], 16)) + 0.0722 * lin(parseInt(m[3], 16));
}

/** Apply theme, accent, density and other appearance settings to the document root. */
function useAppearance() {
  const appearance = useSettings((s) => s.settings.appearance);
  const a11y = useSettings((s) => s.settings.accessibility);
  const pageColors = useSettings((s) => s.settings.pageColors);
  const verbose = useSettings((s) => s.settings.privacy.verboseLogging);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const forced = window.matchMedia("(forced-colors: active)");
    const on = () => setSystemDark(mq.matches);
    const onForced = () => allControllers().forEach((c) => c.applyPageColors());
    mq.addEventListener("change", on);
    forced.addEventListener("change", onForced);
    return () => {
      mq.removeEventListener("change", on);
      forced.removeEventListener("change", onForced);
    };
  }, []);

  const dark = appearance.theme === "dark" || (appearance.theme === "system" && systemDark);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = dark ? "dark" : "light";
    root.dataset.density = appearance.density;
    root.dataset.uiScale = appearance.uiScale;
    const reduce = appearance.animations === "full" && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduced" : appearance.animations;
    root.dataset.animations = reduce;
    root.style.setProperty("--accent", appearance.accent);
    root.style.setProperty("--accent-text", luminance(appearance.accent) > 0.45 ? "#111111" : "#ffffff");
    root.toggleAttribute("data-focus-rings", a11y.focusRings);
    root.toggleAttribute("data-underline-links", a11y.underlineLinks);
    void getCurrentWindow()
      .setTheme(appearance.theme === "system" ? null : appearance.theme)
      .catch(() => undefined);
    for (const c of allControllers()) c.applyPageColors();
  }, [dark, appearance, a11y]);

  // Thumbnails keep their real colours but are dimmed while a page colour mode is active.
  useEffect(() => {
    const style = pageColorStyle(pageColors, dark);
    document.documentElement.dataset.pageTone = style.mode === "normal" ? "normal" : style.isDark ? "dark" : "tinted";
  }, [pageColors, dark]);

  useEffect(() => setLogLevel(verbose ? "debug" : "info"), [verbose]);
}

function DuotoneFilter() {
  const pc = useSettings((s) => s.settings.pageColors);
  const tables = duotoneTables(pc);
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <filter id={DUOTONE_FILTER_ID} colorInterpolationFilters="sRGB">
        <feColorMatrix type="matrix" values="0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0" />
        <feComponentTransfer>
          <feFuncR type="table" tableValues={tables.r} />
          <feFuncG type="table" tableValues={tables.g} />
          <feFuncB type="table" tableValues={tables.b} />
        </feComponentTransfer>
      </filter>
    </svg>
  );
}

function BusyOverlay() {
  const t = useT();
  const busy = useUi((s) => s.busy);
  if (!busy) return null;
  return (
    <div className="busy-overlay" role="status">
      <div className="spinner" />
      <div className="col" style={{ flex: 1, gap: 6 }}>
        <span>{busy.message}</span>
        <div className={`progress${busy.progress === null ? " indeterminate" : ""}`}>
          <div style={busy.progress === null ? undefined : { width: `${Math.round(busy.progress * 100)}%` }} />
        </div>
      </div>
      {busy.cancel && (
        <button type="button" className="btn small" onClick={busy.cancel}>
          {t("common.cancel")}
        </button>
      )}
    </div>
  );
}

function DropOverlay() {
  const t = useT();
  const [state, setState] = useState<"none" | "pdf" | "other">("none");
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter") {
          setState(p.paths.some((x) => /\.pdf$/i.test(x)) ? "pdf" : "other");
        } else if (p.type === "leave") {
          setState("none");
        } else if (p.type === "drop") {
          setState("none");
          const pdfs = p.paths.filter((x) => /\.pdf$/i.test(x));
          if (pdfs.length) void openPaths(pdfs);
          else if (p.paths.length) toast("warning", t("drop.notPdf"));
        }
      })
      .then((fn) => (unlisten = fn))
      .catch((err) => log.warn("drag & drop unavailable", err));
    return () => unlisten?.();
  }, [t]);
  if (state === "none") return null;
  return (
    <div className="drop-overlay">
      <div className="drop-card">
        <FileUp size={40} />
        <h2>{state === "pdf" ? t("drop.title") : t("drop.notPdf")}</h2>
        {state === "pdf" && <span className="muted">{t("drop.subtitle")}</span>}
      </div>
    </div>
  );
}

function FloatingNav({ c }: { c: DocumentController }) {
  const t = useT();
  const page = useDocState(c, (s) => s.page, 1);
  const numPages = useDocState(c, (s) => s.numPages, 0);
  return (
    <div className="floating-nav">
      <button type="button" className="icon-btn small" onClick={() => c.previousPage()} aria-label={t("cmd.go.prev")}>
        <ChevronLeft size={16} />
      </button>
      <span className="page-label">
        {page} / {numPages}
      </span>
      <button type="button" className="icon-btn small" onClick={() => c.nextPage()} aria-label={t("cmd.go.next")}>
        <ChevronRight size={16} />
      </button>
      <button type="button" className="icon-btn small" onClick={() => c.zoomStep(-1)} aria-label={t("cmd.view.zoomOut")}>
        <ZoomOut size={15} />
      </button>
      <button type="button" className="icon-btn small" onClick={() => c.zoomStep(1)} aria-label={t("cmd.view.zoomIn")}>
        <ZoomIn size={15} />
      </button>
      <button type="button" className="icon-btn small" data-tip={t("cmd.view.readMode")} onClick={() => useUi.setState({ readMode: false })}>
        <Minimize2 size={15} />
      </button>
    </div>
  );
}

function Workspace() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const c = useActiveController();
  const sidebarOpen = useDocState(c, (s) => s.sidebarOpen && s.status === "ready", false);
  const findOpen = useUi((s) => s.findOpen);
  const readMode = useUi((s) => s.readMode);
  const commentsPane = useUi((s) => s.commentsPane);
  const ready = useDocState(c, (s) => s.status === "ready", false);
  const right = useSettings((s) => s.settings.appearance.sidebarPosition === "right");
  return (
    <div className={`workspace${right ? " sidebar-right" : ""}`}>
      {c && sidebarOpen && <Sidebar key={c.tabId} c={c} />}
      <div className="document-area">
        {tabs.map((tab) => {
          const controller = getController(tab.id);
          if (!controller) return null;
          return (
            <div key={tab.id} className="doc-tab-host" hidden={tab.id !== activeId}>
              <DocumentView c={controller} active={tab.id === activeId} />
            </div>
          );
        })}
        {activeId === null && <StartPage />}
        {c && ready && findOpen && <FindBar key={c.tabId} c={c} />}
        {c && ready && readMode && <FloatingNav c={c} />}
      </div>
      {c && ready && commentsPane && <CommentsPane key={c.tabId} c={c} />}
    </div>
  );
}

function useWindowTitle() {
  const c = useActiveController();
  const name = useDocState(c, (s) => s.fileName, "");
  const dirty = useDocState(c, (s) => s.history.dirty || s.formsDirty || s.infoDirty, false);
  const t = useT();
  useEffect(() => {
    const title = c ? `${dirty ? "• " : ""}${name} — ${t("app.name")}` : t("app.name");
    document.title = title;
    void getCurrentWindow().setTitle(title).catch(() => undefined);
  }, [c, name, dirty, t]);
}

function useGlobalKeys() {
  useEffect(() => {
    let altAlone = false;
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        altAlone = !e.repeat;
        return;
      }
      altAlone = false;
      dispatchKeydown(e);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "Alt" && altAlone) {
        altAlone = false;
        e.preventDefault();
        if (!useSettings.getState().settings.appearance.showMenuBar) {
          useUi.setState((s) => ({ menuBarPeek: !s.menuBarPeek }));
        } else {
          document.querySelector<HTMLButtonElement>(".menubar-item")?.focus();
        }
      }
    };
    const onContext = (e: MouseEvent) => {
      // The WebView's own context menu is only useful in text fields.
      if (!(e.target as HTMLElement).closest("input, textarea, [contenteditable='true']")) e.preventDefault();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("contextmenu", onContext);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("contextmenu", onContext);
    };
  }, []);
}

/** Check open files for external modifications when the window regains focus. */
function useDiskWatch() {
  useEffect(() => {
    let last = 0;
    const onFocus = () => {
      if (!useSettings.getState().settings.general.watchChanges) return;
      const now = Date.now();
      if (now - last < 1500) return;
      last = now;
      for (const c of allControllers()) if (c.isReady) void c.checkDisk();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
}

function useCloseHandler() {
  useEffect(() => {
    let closing = false;
    let unlisten: (() => void) | null = null;
    const win = getCurrentWindow();
    win
      .onCloseRequested(async (event) => {
        event.preventDefault();
        if (closing) return;
        closing = true;
        try {
          if (!(await confirmQuit())) return;
          const s = useSettings.getState();
          if (s.settings.general.startup !== "home") await saveSession(sessionPaths());
          const controllers = allControllers();
          for (const c of controllers) c.saveViewState();
          // Changes were saved or explicitly discarded: recovery snapshots are obsolete.
          await Promise.all([s.flush(), flushLibrary(), ...controllers.map((c) => c.discardRecovery())]);
          await win.destroy();
        } catch (err) {
          log.error("close failed", err);
          await win.destroy();
        } finally {
          closing = false;
        }
      })
      .then((fn) => (unlisten = fn))
      .catch((err) => log.warn("close handler unavailable", err));
    return () => unlisten?.();
  }, []);
}

export function App() {
  useAppearance();
  useWindowTitle();
  useGlobalKeys();
  useDiskWatch();
  useCloseHandler();
  const appearance = useSettings((s) => s.settings.appearance);
  const showTabsAlways = useSettings((s) => s.settings.general.showTabsAlways);
  const presentationSettings = useSettings((s) => s.settings.presentation);
  const tabCount = useTabs((s) => s.tabs.length);
  const settingsOpen = useUi((s) => !!s.settings);
  const palette = useUi((s) => s.palette);
  const shortcuts = useUi((s) => s.shortcuts);
  const about = useUi((s) => s.about);
  const readMode = useUi((s) => s.readMode);
  const presentation = useUi((s) => s.presentation);
  const menuPeek = useUi((s) => s.menuBarPeek);
  const commentTools = useUi((s) => s.commentTools);
  const c = useActiveController();
  const ready = useDocState(c, (s) => s.status === "ready", false);

  return (
    <div
      className={`app${readMode ? " read-mode" : ""}${presentation ? " presentation" : ""}`}
      data-transition={presentationSettings.transition}
      style={presentation && !presentationSettings.blackBackground ? ({ ["--presentation-bg" as string]: "var(--viewer-bg)" }) : undefined}
    >
      {(appearance.showMenuBar || menuPeek) && <MenuBar />}
      {(showTabsAlways || tabCount > 1) && <TabBar />}
      <Toolbar />
      {commentTools && c && ready && <CommentToolbar />}
      <div className="app-main">
        <Workspace />
      </div>
      {appearance.showStatusBar && <StatusBar />}
      {settingsOpen && <SettingsView />}
      {palette && <CommandPalette />}
      {shortcuts && <ShortcutsDialog />}
      {about && <AboutDialog />}
      <DialogHost />
      <BusyOverlay />
      <DropOverlay />
      <Toasts />
      <TooltipHost />
      <DuotoneFilter />
    </div>
  );
}
