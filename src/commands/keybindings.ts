/**
 * Keyboard shortcut resolution and the global key dispatcher.
 */
import { COMMANDS, COMMAND_MAP, runCommand } from "./registry";
import { eventToAccelerator, isEditableTarget, normalizeAccelerator } from "./keys";
import { settings, useSettings } from "../settings/store";
import { useUi } from "../state/ui";

/** Accelerators of a command after applying the user's overrides. */
export function effectiveKeys(id: string, overrides = settings().shortcuts): string[] {
  const custom = overrides[id];
  if (custom) return custom.map(normalizeAccelerator);
  return (COMMAND_MAP.get(id)?.keys ?? []).map(normalizeAccelerator);
}

let cache: { overrides: Record<string, string[]>; map: Map<string, string> } | null = null;

/** accelerator → command id (first registered wins on conflicts). */
export function keymap(): Map<string, string> {
  const overrides = settings().shortcuts;
  if (cache && cache.overrides === overrides) return cache.map;
  const map = new Map<string, string>();
  for (const cmd of COMMANDS) {
    for (const acc of effectiveKeys(cmd.id, overrides)) {
      if (!map.has(acc)) map.set(acc, cmd.id);
    }
  }
  cache = { overrides, map };
  return map;
}

/** Command that currently owns `acc`, if any (used to report conflicts in the editor). */
export function commandForAccelerator(acc: string): string | null {
  return keymap().get(normalizeAccelerator(acc)) ?? null;
}

export function setShortcuts(id: string, keys: string[] | null): void {
  const overrides = { ...settings().shortcuts };
  if (keys === null) delete overrides[id];
  else overrides[id] = keys.map(normalizeAccelerator);
  useSettings.getState().set("shortcuts", overrides);
}

export function resetAllShortcuts(): void {
  useSettings.getState().set("shortcuts", {});
}

function overlayOpen(): boolean {
  const ui = useUi.getState();
  return ui.dialogs.length > 0 || !!ui.settings || ui.palette || ui.shortcuts || ui.about;
}

/** Shortcuts that text fields handle themselves (editing, caret movement, clipboard). */
const TEXT_EDITING = new Set([
  "Ctrl+A",
  "Ctrl+C",
  "Ctrl+V",
  "Ctrl+X",
  "Ctrl+Z",
  "Ctrl+Y",
  "Ctrl+Shift+Z",
  "Ctrl+Left",
  "Ctrl+Right",
  "Ctrl+Up",
  "Ctrl+Down",
  "Ctrl+Home",
  "Ctrl+End",
  "Ctrl+Backspace",
  "Ctrl+Delete",
  "Ctrl+Shift+Left",
  "Ctrl+Shift+Right",
  "Ctrl+Shift+Home",
  "Ctrl+Shift+End",
]);

/** Ctrl / Alt combinations and function keys may fire from text fields unless they edit text. */
function allowedInTextField(acc: string): boolean {
  if (TEXT_EDITING.has(acc)) return false;
  return acc.startsWith("Ctrl+") || /^F\d{1,2}$/.test(acc) || /^Shift\+F\d{1,2}$/.test(acc);
}

const UNMODIFIED_LOCAL = /^(Shift\+)?([A-Z0-9]|Up|Down|Left|Right|Home|End|PageUp|PageDown|Space|Enter|Delete|Backspace)$/;

/** Global keydown handler; returns true when a command consumed the event. */
export function dispatchKeydown(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.isComposing) return false;
  if (overlayOpen()) return false;
  const acc = eventToAccelerator(e);
  if (!acc) return false;
  const id = keymap().get(acc);
  if (!id) return false;
  const cmd = COMMAND_MAP.get(id);
  if (!cmd) return false;
  if (isEditableTarget(e.target) && !cmd.global && !allowedInTextField(acc)) return false;
  // Lists and trees (sidebar panels, menus) handle plain keys themselves.
  const local = (e.target as HTMLElement | null)?.closest?.("[data-keys='local']");
  if (local && UNMODIFIED_LOCAL.test(acc)) return false;
  if (!runCommand(id)) return false;
  e.preventDefault();
  e.stopPropagation();
  return true;
}
