/**
 * Keyboard accelerators: normalisation of key events into strings such as `Ctrl+Shift+S`.
 *
 * Letters and digits use the physical key (`event.code`) so shortcuts keep working with
 * non-Latin keyboard layouts; other printable keys use the produced character, with Shift
 * folded into it (Shift+= produces "+").
 */

const NAMED: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  " ": "Space",
  Spacebar: "Space",
  Escape: "Esc",
  Esc: "Esc",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Home: "Home",
  End: "End",
  Delete: "Delete",
  Backspace: "Backspace",
  Enter: "Enter",
  Tab: "Tab",
  Insert: "Insert",
  ContextMenu: "Menu",
};

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "OS", "CapsLock"]);

function baseKey(e: KeyboardEvent): { key: string; printable: boolean } | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  if (/^Key[A-Z]$/.test(e.code)) return { key: e.code.slice(3), printable: false };
  if (/^Digit[0-9]$/.test(e.code)) return { key: e.code.slice(5), printable: false };
  if (/^Numpad[0-9]$/.test(e.code)) return { key: e.code.slice(6), printable: false };
  if (e.code === "NumpadAdd") return { key: "+", printable: true };
  if (e.code === "NumpadSubtract") return { key: "-", printable: true };
  if (e.code === "NumpadEnter") return { key: "Enter", printable: false };
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) return { key: e.key, printable: false };
  if (NAMED[e.key]) return { key: NAMED[e.key], printable: false };
  if (e.key.length === 1) return { key: e.key.toUpperCase(), printable: true };
  return null;
}

/** Accelerator string for a keyboard event, or null for lone modifier presses. */
export function eventToAccelerator(e: KeyboardEvent): string | null {
  const base = baseKey(e);
  if (!base) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey && !base.printable) parts.push("Shift");
  parts.push(base.key);
  return parts.join("+");
}

/** Canonical form of an accelerator typed by a human ("ctrl + shift + s" → "Ctrl+Shift+S"). */
export function normalizeAccelerator(raw: string): string {
  const tokens = raw
    .split("+")
    .map((t) => t.trim())
    .filter(Boolean);
  // "Ctrl++" splits into ["Ctrl"] — the trailing plus is the key itself.
  if (raw.trim().endsWith("++") || raw.trim() === "+") tokens.push("+");
  const mods = new Set<string>();
  let key = "";
  for (const tok of tokens) {
    const lower = tok.toLowerCase();
    if (lower === "ctrl" || lower === "control" || lower === "cmd" || lower === "meta") mods.add("Ctrl");
    else if (lower === "alt" || lower === "option") mods.add("Alt");
    else if (lower === "shift") mods.add("Shift");
    else key = tok.length === 1 ? tok.toUpperCase() : tok[0].toUpperCase() + tok.slice(1);
  }
  return [...["Ctrl", "Alt", "Shift"].filter((m) => mods.has(m)), key].join("+");
}

/** Human readable label for display (platform specific symbols on macOS). */
export function formatAccelerator(acc: string): string {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  if (!isMac) return acc.replace("Plus", "+");
  return acc.replace("Ctrl+", "⌘").replace("Alt+", "⌥").replace("Shift+", "⇧");
}

/** Is the event target a text-entry element (where single-key shortcuts must not fire)? */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "range", "color", "reset"].includes(type);
  }
  return false;
}
