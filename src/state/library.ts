/**
 * User library data persisted by the Rust store: recent documents, per-document view state,
 * the last session (for "reopen documents from last session") and recovery snapshots.
 */
import { create } from "zustand";
import { api } from "../lib/ipc";
import { createLogger } from "../lib/log";

const log = createLogger("library");

export interface RecentEntry {
  path: string;
  name: string;
  openedAt: number;
  pages: number | null;
  /** Small JPEG data URL of the first page, if available. */
  thumb: string | null;
}

export interface ViewStateEntry {
  page: number;
  scaleValue: string;
  layout: string;
  rotation: number;
  sidebarOpen: boolean;
  sidebarPanel: string;
  /** pdf.js destination used to restore the exact scroll position. */
  dest: unknown[] | null;
  updatedAt: number;
}

export interface SessionEntry {
  tabs: string[];
  active: number;
}

const MAX_VIEW_STATES = 500;
const MAX_RECENT_HARD_LIMIT = 100;

/**
 * Normalised key for a file path, so different spellings of the same file match: separators,
 * repeated separators, `.` / `..` segments, the `\\?\` prefix and (on Windows) letter case.
 */
export function pathKey(path: string, windows = navigator.userAgent.includes("Windows")): string {
  let p = windows ? path.replace(/\//g, "\\") : path;
  const sep = windows ? "\\" : "/";
  if (windows) p = p.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
  const unc = p.startsWith(sep + sep);
  const out: string[] = [];
  for (const part of p.split(sep)) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length > (unc ? 2 : 1)) out.pop();
    else if (part !== "..") out.push(part);
  }
  const head = unc ? sep + sep : !windows && p.startsWith("/") ? "/" : "";
  const key = head + out.join(sep);
  return windows ? key.toLowerCase() : key;
}

/** Keep one entry per file (the most recently opened), newest first. */
export function dedupeRecent(list: RecentEntry[], windows?: boolean): RecentEntry[] {
  const seen = new Set<string>();
  return [...list]
    .sort((a, b) => b.openedAt - a.openedAt)
    .filter((r) => {
      const key = pathKey(r.path, windows);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

interface LibraryState {
  recent: RecentEntry[];
  viewStates: Record<string, ViewStateEntry>;
  loaded: boolean;
  load: () => Promise<void>;
  addRecent: (entry: Omit<RecentEntry, "openedAt">, limit: number) => void;
  removeRecent: (path: string) => void;
  clearRecent: () => void;
  getViewState: (path: string) => ViewStateEntry | null;
  setViewState: (path: string, state: Omit<ViewStateEntry, "updatedAt">) => void;
  clearViewStates: () => void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function persist(name: string, value: () => unknown, delay = 800) {
  const prev = timers.get(name);
  if (prev) clearTimeout(prev);
  timers.set(
    name,
    setTimeout(() => {
      timers.delete(name);
      api.storeWrite(name, value()).catch((err) => log.error(`failed to save ${name}`, err));
    }, delay),
  );
}

/** Write any pending library data immediately (before the window closes). */
export async function flushLibrary(): Promise<void> {
  const state = useLibrary.getState();
  const pending = [...timers.keys()];
  for (const name of pending) {
    clearTimeout(timers.get(name));
    timers.delete(name);
  }
  await Promise.all(
    pending.map((name) =>
      api
        .storeWrite(name, name === "recent" ? state.recent : state.viewStates)
        .catch((err) => log.error(`failed to save ${name}`, err)),
    ),
  );
}

function isRecent(v: unknown): v is RecentEntry {
  const e = v as RecentEntry;
  return !!e && typeof e.path === "string" && typeof e.name === "string" && typeof e.openedAt === "number";
}

export const useLibrary = create<LibraryState>((set, get) => ({
  recent: [],
  viewStates: {},
  loaded: false,

  load: async () => {
    const [recent, views] = await Promise.all([
      api.storeRead<unknown[]>("recent").catch(() => ({ value: null, recovered: false })),
      api.storeRead<Record<string, ViewStateEntry>>("viewstates").catch(() => ({ value: null, recovered: false })),
    ]);
    set({
      recent: Array.isArray(recent.value) ? dedupeRecent(recent.value.filter(isRecent)).slice(0, MAX_RECENT_HARD_LIMIT) : [],
      viewStates: views.value && typeof views.value === "object" ? views.value : {},
      loaded: true,
    });
  },

  addRecent: (entry, limit) => {
    if (limit <= 0) return;
    const key = pathKey(entry.path);
    const prev = get().recent.find((r) => pathKey(r.path) === key);
    const next: RecentEntry = {
      ...entry,
      thumb: entry.thumb ?? prev?.thumb ?? null,
      pages: entry.pages ?? prev?.pages ?? null,
      openedAt: Date.now(),
    };
    const recent = dedupeRecent([next, ...get().recent.filter((r) => pathKey(r.path) !== key)]).slice(0, limit);
    set({ recent });
    persist("recent", () => get().recent);
  },

  removeRecent: (path) => {
    const key = pathKey(path);
    set({ recent: get().recent.filter((r) => pathKey(r.path) !== key) });
    persist("recent", () => get().recent, 0);
  },

  clearRecent: () => {
    set({ recent: [] });
    persist("recent", () => [], 0);
  },

  getViewState: (path) => get().viewStates[pathKey(path)] ?? null,

  setViewState: (path, state) => {
    const viewStates = { ...get().viewStates, [pathKey(path)]: { ...state, updatedAt: Date.now() } };
    const keys = Object.keys(viewStates);
    if (keys.length > MAX_VIEW_STATES) {
      keys
        .sort((a, b) => viewStates[a].updatedAt - viewStates[b].updatedAt)
        .slice(0, keys.length - MAX_VIEW_STATES)
        .forEach((k) => delete viewStates[k]);
    }
    set({ viewStates });
    persist("viewstates", () => get().viewStates, 1500);
  },

  clearViewStates: () => {
    set({ viewStates: {} });
    persist("viewstates", () => ({}), 0);
  },
}));

// --- session ---------------------------------------------------------------------------------

export async function loadSession(): Promise<SessionEntry | null> {
  try {
    const read = await api.storeRead<SessionEntry>("session");
    const v = read.value;
    if (v && Array.isArray(v.tabs)) return { tabs: v.tabs.filter((t) => typeof t === "string"), active: Number(v.active) || 0 };
  } catch (err) {
    log.warn("failed to read last session", err);
  }
  return null;
}

export function saveSession(session: SessionEntry): Promise<void> {
  return api.storeWrite("session", session).catch((err) => log.error("failed to save session", err));
}

// --- recovery ----------------------------------------------------------------------------------

export interface RecoveryEntry {
  path: string;
  fileSize: number;
  fileModifiedMs: number | null;
  savedAt: number;
  /** Serialised annotation model (see DocumentController.recoveryPayload). */
  payload: unknown;
}

export function recoveryName(path: string): string {
  // Store entry names are restricted to [a-z0-9_-]; hash the path.
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  const key = pathKey(path);
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return `recovery-${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

export async function readRecovery(path: string): Promise<RecoveryEntry | null> {
  try {
    const read = await api.storeRead<RecoveryEntry>(recoveryName(path));
    return read.value && read.value.path ? read.value : null;
  } catch {
    return null;
  }
}

export function writeRecovery(entry: RecoveryEntry): Promise<void> {
  return api.storeWrite(recoveryName(entry.path), entry).catch((err) => log.warn("failed to write recovery", err));
}

export function removeRecovery(path: string): Promise<void> {
  return api.storeRemove(recoveryName(path)).catch(() => undefined);
}
