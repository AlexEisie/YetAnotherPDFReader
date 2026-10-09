/**
 * Presentation mode: full screen, one page fitted to the screen, chrome hidden, keyboard / click
 * navigation, optional automatic advance. Leaving restores the previous view exactly.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { DocumentController } from "./DocumentController";
import type { LayoutSetting } from "../settings/defaults";
import { settings } from "../settings/store";
import { toast, useUi } from "../state/ui";
import { t } from "../i18n";
import { createLogger } from "../lib/log";

const log = createLogger("presentation");

interface Saved {
  controller: DocumentController;
  layout: LayoutSetting;
  scaleValue: string;
  wasFullscreen: boolean;
  sidebarOpen: boolean;
}

let saved: Saved | null = null;
let teardown: (() => void) | null = null;

export function isPresenting(): boolean {
  return saved !== null;
}

export async function enterPresentation(controller: DocumentController): Promise<void> {
  if (saved || !controller.viewer) return;
  const win = getCurrentWindow();
  const wasFullscreen = await win.isFullscreen().catch(() => false);
  saved = {
    controller,
    layout: controller.state.layout,
    scaleValue: controller.state.scaleValue,
    wasFullscreen,
    sidebarOpen: controller.state.sidebarOpen,
  };
  useUi.setState({ presentation: true });
  if (!wasFullscreen) await win.setFullscreen(true).catch((err) => log.warn("fullscreen failed", err));
  controller.setSidebar(false);
  controller.setLayout("single", false);
  // Wait for the container to resize to the full screen before fitting.
  await new Promise((r) => setTimeout(r, 120));
  controller.setZoom("page-fit");
  install(controller);
  toast("info", t("presentation.exitHint"), { timeout: 2500 });
}

export async function exitPresentation(): Promise<void> {
  const s = saved;
  if (!s) return;
  saved = null;
  teardown?.();
  teardown = null;
  useUi.setState({ presentation: false });
  if (!s.wasFullscreen) await getCurrentWindow().setFullscreen(false).catch(() => undefined);
  s.controller.setLayout(s.layout, false);
  s.controller.setSidebar(s.sidebarOpen);
  await new Promise((r) => setTimeout(r, 120));
  const preset = ["auto", "page-fit", "page-width", "page-actual"].includes(s.scaleValue);
  s.controller.setZoom(preset ? (s.scaleValue as "auto") : Number(s.scaleValue) || "auto");
}

function install(controller: DocumentController) {
  const p = settings().presentation;
  const container = controller.scrollContainer;
  if (!container) return;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let advanceTimer: ReturnType<typeof setInterval> | null = null;

  const next = () => {
    const { page, numPages } = controller.state;
    if (page >= numPages) {
      if (p.loop) controller.goToPage(1, { recordHistory: false });
    } else controller.nextPage();
  };
  const prev = () => controller.previousPage();

  const showCursor = () => {
    container.style.cursor = "";
    if (hideTimer) clearTimeout(hideTimer);
    if (p.hideCursor) hideTimer = setTimeout(() => (container.style.cursor = "none"), 2000);
  };

  const onKey = (e: KeyboardEvent) => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
      case "PageDown":
      case " ":
      case "Enter":
      case "n":
        next();
        break;
      case "ArrowLeft":
      case "ArrowUp":
      case "PageUp":
      case "Backspace":
      case "p":
        prev();
        break;
      case "Home":
        controller.goToPage(1, { recordHistory: false });
        break;
      case "End":
        controller.goToPage(controller.state.numPages, { recordHistory: false });
        break;
      case "Escape":
        void exitPresentation();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  const onClick = (e: MouseEvent) => {
    if (!p.advanceOnClick || (e.target as HTMLElement).closest("a, .annotationLayer section")) return;
    if (e.button === 0) next();
  };
  const onContext = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    prev();
  };
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.deltaY > 0) next();
    else if (e.deltaY < 0) prev();
  };
  const onResize = () => controller.setZoom("page-fit");

  window.addEventListener("keydown", onKey, true);
  container.addEventListener("click", onClick);
  container.addEventListener("contextmenu", onContext, true);
  container.addEventListener("wheel", onWheel, { capture: true, passive: false });
  container.addEventListener("pointermove", showCursor);
  window.addEventListener("resize", onResize);
  showCursor();
  if (p.autoAdvance > 0) advanceTimer = setInterval(next, p.autoAdvance * 1000);

  teardown = () => {
    window.removeEventListener("keydown", onKey, true);
    container.removeEventListener("click", onClick);
    container.removeEventListener("contextmenu", onContext, true);
    container.removeEventListener("wheel", onWheel, true);
    container.removeEventListener("pointermove", showCursor);
    window.removeEventListener("resize", onResize);
    if (hideTimer) clearTimeout(hideTimer);
    if (advanceTimer) clearInterval(advanceTimer);
    container.style.cursor = "";
  };
}

export async function toggleFullscreen(): Promise<void> {
  const win = getCurrentWindow();
  const full = await win.isFullscreen().catch(() => false);
  await win.setFullscreen(!full).catch((err) => log.warn("fullscreen failed", err));
  useUi.setState({ fullscreen: !full });
}
