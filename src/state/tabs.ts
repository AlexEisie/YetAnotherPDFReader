/**
 * Document tabs. Each tab owns a {@link DocumentController}; this module manages their
 * lifecycle (open, activate, reorder, close with unsaved-changes handling) and background-tab
 * memory release.
 */
import { create } from "zustand";
import { DocumentController } from "../document/DocumentController";
import { pathKey } from "./library";
import { settings, useSettings } from "../settings/store";
import { saveController } from "../document/fileActions";
import { confirm, toast } from "./ui";
import { t } from "../i18n";
import { createLogger } from "../lib/log";

const log = createLogger("tabs");

export interface TabInfo {
  id: string;
  path: string;
}

interface TabsState {
  tabs: TabInfo[];
  /** `null` shows the start page. */
  activeId: string | null;
  /** Recently closed paths (most recent last). */
  closed: string[];
}

export const useTabs = create<TabsState>(() => ({ tabs: [], activeId: null, closed: [] }));

const controllers = new Map<string, DocumentController>();
const suspendTimers = new Map<string, ReturnType<typeof setTimeout>>();
let tabCounter = 0;

export function getController(id: string | null | undefined): DocumentController | null {
  return id ? (controllers.get(id) ?? null) : null;
}

export function activeController(): DocumentController | null {
  return getController(useTabs.getState().activeId);
}

export function allControllers(): DocumentController[] {
  return useTabs
    .getState()
    .tabs.map((tab) => controllers.get(tab.id))
    .filter((c): c is DocumentController => !!c);
}

function findTabByPath(path: string): TabInfo | undefined {
  const key = pathKey(path);
  return useTabs.getState().tabs.find((tab) => pathKey(getController(tab.id)?.filePath ?? tab.path) === key);
}

export function activateTab(id: string | null): void {
  const prev = useTabs.getState().activeId;
  if (prev === id) return;
  useTabs.setState({ activeId: id });
  const current = getController(id);
  if (id) {
    const timer = suspendTimers.get(id);
    if (timer) clearTimeout(timer);
    suspendTimers.delete(id);
    current?.resume();
  }
  const previous = getController(prev);
  if (prev && previous) scheduleSuspend(prev, previous);
}

function scheduleSuspend(id: string, controller: DocumentController) {
  const minutes = settings().performance.freeBackgroundTabsAfter;
  if (minutes <= 0) return;
  const old = suspendTimers.get(id);
  if (old) clearTimeout(old);
  suspendTimers.set(
    id,
    setTimeout(
      () => {
        suspendTimers.delete(id);
        if (useTabs.getState().activeId !== id) void controller.suspend();
      },
      minutes * 60_000,
    ),
  );
}

/** Open documents; already open ones are focused. Returns the ids of the tabs. */
export async function openPaths(paths: string[]): Promise<string[]> {
  const ids: string[] = [];
  const s = settings();
  for (const path of paths) {
    const existing = findTabByPath(path);
    if (existing && s.general.focusExisting) {
      activateTab(existing.id);
      ids.push(existing.id);
      if (paths.length === 1) toast("info", t("toast.alreadyOpen", { name: getController(existing.id)?.state.fileName ?? path }));
      continue;
    }
    ids.push(openTab(path));
  }
  return ids;
}

function openTab(path: string): string {
  const s = settings();
  const id = `tab-${++tabCounter}-${Date.now().toString(36)}`;
  const controller = new DocumentController(id, path);
  controllers.set(id, controller);
  const state = useTabs.getState();
  const tabs = [...state.tabs];
  const replace =
    !s.general.openInNewTab && state.activeId && !getController(state.activeId)?.isDirty ? state.activeId : null;
  const activeIndex = tabs.findIndex((tab) => tab.id === state.activeId);
  const insertAt = s.general.newTabPosition === "afterCurrent" && activeIndex >= 0 ? activeIndex + 1 : tabs.length;
  tabs.splice(insertAt, 0, { id, path });
  useTabs.setState({ tabs });
  activateTab(id);
  if (replace) void destroyTab(replace);

  void controller.open().then(() => {
    if (controller.state.status === "cancelled") void destroyTab(id);
  });
  return id;
}

async function destroyTab(id: string, discardRecovery = true): Promise<void> {
  const controller = controllers.get(id);
  const state = useTabs.getState();
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  let activeId = state.activeId;
  if (activeId === id) activeId = tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
  const closed = controller && controller.state.status === "ready" ? [...state.closed, controller.filePath].slice(-20) : state.closed;
  useTabs.setState({ tabs, activeId, closed });
  getController(activeId)?.resume();
  const timer = suspendTimers.get(id);
  if (timer) clearTimeout(timer);
  suspendTimers.delete(id);
  controllers.delete(id);
  try {
    controller?.saveViewState();
    await controller?.destroy(discardRecovery);
  } catch (err) {
    log.warn("error while closing tab", err);
  }
}

/** Ask what to do with unsaved changes. Returns false when the user cancelled. */
async function resolveUnsaved(controller: DocumentController): Promise<boolean> {
  if (!controller.isDirty) return true;
  activateTab(controller.tabId);
  const answer = await confirm({
    title: t("dialog.unsaved.title"),
    message: t("dialog.unsaved.message", { name: controller.state.fileName }),
    detail: t("dialog.unsaved.detail"),
    confirmLabel: t("common.save"),
    altLabel: t("common.dontSave"),
    cancelLabel: t("common.cancel"),
  });
  if (answer.choice === "cancel") return false;
  if (answer.choice === "alt") return true;
  return saveController(controller);
}

export async function closeTab(id: string): Promise<boolean> {
  const controller = controllers.get(id);
  if (!controller) {
    await destroyTab(id);
    return true;
  }
  if (!(await resolveUnsaved(controller))) return false;
  await destroyTab(id);
  return true;
}

/** Close several tabs, asking once for confirmation when there are many. */
export async function closeTabs(ids: string[]): Promise<boolean> {
  if (ids.length > 1 && settings().general.confirmCloseMany) {
    const dirty = ids.filter((id) => getController(id)?.isDirty);
    if (dirty.length === 0) {
      const answer = await confirm({
        title: t("dialog.closeMany.title", { count: ids.length }),
        message: t("dialog.closeMany.message", { count: ids.length }),
        confirmLabel: t("common.close"),
        checkboxLabel: t("dialog.closeMany.dontAsk"),
      });
      if (answer.choice !== "confirm") return false;
      if (answer.checked) useSettings.getState().set("general.confirmCloseMany", false);
    }
  }
  for (const id of ids) {
    if (!(await closeTab(id))) return false;
  }
  return true;
}

export function closeOthers(id: string): Promise<boolean> {
  return closeTabs(useTabs.getState().tabs.filter((tab) => tab.id !== id).map((tab) => tab.id));
}

export function closeToRight(id: string): Promise<boolean> {
  const tabs = useTabs.getState().tabs;
  const index = tabs.findIndex((tab) => tab.id === id);
  return closeTabs(tabs.slice(index + 1).map((tab) => tab.id));
}

export function closeAll(): Promise<boolean> {
  return closeTabs(useTabs.getState().tabs.map((tab) => tab.id));
}

export function reopenClosed(): void {
  const closed = [...useTabs.getState().closed];
  const path = closed.pop();
  if (!path) return;
  useTabs.setState({ closed });
  void openPaths([path]);
}

export function moveTab(id: string, toIndex: number): void {
  const tabs = [...useTabs.getState().tabs];
  const from = tabs.findIndex((tab) => tab.id === id);
  if (from < 0) return;
  const [tab] = tabs.splice(from, 1);
  tabs.splice(Math.max(0, Math.min(tabs.length, toIndex)), 0, tab);
  useTabs.setState({ tabs });
}

export function cycleTab(direction: 1 | -1): void {
  const { tabs, activeId } = useTabs.getState();
  if (!tabs.length) return;
  const index = tabs.findIndex((tab) => tab.id === activeId);
  const next = tabs[(index + direction + tabs.length) % tabs.length];
  activateTab(next.id);
}

/**
 * Prepare for quitting: resolve unsaved changes of every tab. Returns false when cancelled.
 * Documents are not destroyed (the window is about to close).
 */
export async function confirmQuit(): Promise<boolean> {
  const dirty = allControllers().filter((c) => c.isDirty);
  if (dirty.length === 0) return true;
  if (dirty.length === 1) return resolveUnsaved(dirty[0]);
  const answer = await confirm({
    title: t("dialog.unsaved.title"),
    message: t("dialog.unsaved.messageMany", { count: dirty.length }),
    detail: t("dialog.unsaved.detail"),
    confirmLabel: t("dialog.unsaved.review"),
    altLabel: t("dialog.unsaved.discardAll"),
    cancelLabel: t("common.cancel"),
  });
  if (answer.choice === "cancel") return false;
  if (answer.choice === "alt") return true;
  for (const c of dirty) {
    if (!(await resolveUnsaved(c))) return false;
  }
  return true;
}

/** Paths of the open documents, for "reopen last session". */
export function sessionPaths(): { tabs: string[]; active: number } {
  const { tabs, activeId } = useTabs.getState();
  return {
    tabs: tabs.map((tab) => getController(tab.id)?.filePath ?? tab.path),
    active: Math.max(0, tabs.findIndex((tab) => tab.id === activeId)),
  };
}
