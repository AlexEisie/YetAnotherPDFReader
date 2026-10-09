/**
 * Settings store: reactive (zustand), persisted through the Rust JSON store with debounced,
 * crash-safe writes, and always sanitised against {@link DEFAULT_SETTINGS}.
 */
import { create } from "zustand";
import { api } from "../lib/ipc";
import { createLogger } from "../lib/log";
import { COLOR_PATH, DEFAULT_SETTINGS, ENUMS, RANGES, SETTINGS_VERSION, type Settings } from "./defaults";

const log = createLogger("settings");
const STORE_NAME = "settings";
const SAVE_DELAY_MS = 400;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Deep-merge `raw` over `defaults`, keeping only keys that exist in the defaults and whose type
 * matches. Enumerations, numeric ranges and colours are validated by path. Free-form maps
 * (`shortcuts`) are validated separately.
 */
function sanitizeNode(defaults: unknown, raw: unknown, path: string): unknown {
  if (isPlainObject(defaults)) {
    const out: Record<string, unknown> = {};
    const src = isPlainObject(raw) ? raw : {};
    for (const key of Object.keys(defaults)) {
      out[key] = sanitizeNode(defaults[key], src[key], path ? `${path}.${key}` : key);
    }
    return out;
  }
  if (raw === undefined) return defaults;
  if (COLOR_PATH.test(path)) {
    if (raw === null && defaults === null) return null;
    if (raw === null && path.match(/(fill|borderColor)$/)) return null;
    return typeof raw === "string" && HEX_COLOR.test(raw) ? raw.toLowerCase() : defaults;
  }
  if (Array.isArray(defaults)) {
    return Array.isArray(raw) ? raw.filter((v) => typeof v === "string").slice(0, 200) : defaults;
  }
  if (typeof defaults === "number") {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return defaults;
    const range = RANGES[path];
    return range ? Math.min(range[1], Math.max(range[0], raw)) : raw;
  }
  if (typeof defaults === "string") {
    if (typeof raw !== "string") return defaults;
    const allowed = ENUMS[path];
    if (allowed && !allowed.includes(raw)) return defaults;
    return raw.slice(0, 1000);
  }
  if (typeof defaults === "boolean") return typeof raw === "boolean" ? raw : defaults;
  return defaults;
}

function sanitizeShortcuts(raw: unknown): Record<string, string[]> {
  if (!isPlainObject(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [id, keys] of Object.entries(raw)) {
    if (!/^[a-zA-Z0-9.]+$/.test(id) || !Array.isArray(keys)) continue;
    out[id] = keys.filter((k): k is string => typeof k === "string" && k.length < 40).slice(0, 4);
  }
  return out;
}

export function sanitizeSettings(raw: unknown): Settings {
  const migrated = migrate(raw);
  const settings = sanitizeNode(DEFAULT_SETTINGS, migrated, "") as Settings;
  settings.version = SETTINGS_VERSION;
  settings.shortcuts = sanitizeShortcuts(isPlainObject(migrated) ? migrated.shortcuts : undefined);
  return settings;
}

/** Upgrade older settings files. Version 1 is the first format, so nothing to do yet. */
function migrate(raw: unknown): unknown {
  if (!isPlainObject(raw)) return {};
  return raw;
}

// --- path helpers ------------------------------------------------------------------------------

export type SettingPath = string;

export function getPath(obj: unknown, path: SettingPath): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function setPathImmutable<T>(obj: T, path: SettingPath, value: unknown): T {
  const [head, ...rest] = path.split(".");
  const node = (isPlainObject(obj) ? obj : {}) as Record<string, unknown>;
  return {
    ...node,
    [head]: rest.length ? setPathImmutable(node[head], rest.join("."), value) : value,
  } as T;
}

// --- store ---------------------------------------------------------------------------------

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  /** No settings file existed: the first start after installing. */
  firstRun: boolean;
  /** Load from disk; returns whether the file had to be recovered. */
  load: () => Promise<"ok" | "recovered" | "reset">;
  set: (path: SettingPath, value: unknown) => void;
  update: (fn: (s: Settings) => Settings) => void;
  resetSection: (section: keyof Settings) => void;
  resetAll: () => void;
  replaceAll: (raw: unknown) => void;
  flush: () => Promise<void>;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave: Promise<void> | null = null;

function scheduleSave(get: () => SettingsState) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    pendingSave = api
      .storeWrite(STORE_NAME, get().settings as unknown as Json)
      .catch((err) => log.error("failed to save settings", err))
      .finally(() => {
        pendingSave = null;
      });
  }, SAVE_DELAY_MS);
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  firstRun: false,

  load: async () => {
    try {
      const read = await api.storeRead<unknown>(STORE_NAME);
      const settings = sanitizeSettings(read.value ?? {});
      set({ settings, loaded: true, firstRun: read.value == null && !read.recovered });
      if (read.recovered) {
        scheduleSave(get);
        return read.value ? "recovered" : "reset";
      }
      return "ok";
    } catch (err) {
      log.error("failed to load settings, using defaults", err);
      set({ settings: DEFAULT_SETTINGS, loaded: true });
      return "reset";
    }
  },

  set: (path, value) => {
    const next = sanitizeSettings(setPathImmutable(get().settings, path, value));
    set({ settings: next });
    scheduleSave(get);
  },

  update: (fn) => {
    set({ settings: sanitizeSettings(fn(get().settings)) });
    scheduleSave(get);
  },

  resetSection: (section) => {
    const defaults = structuredClone(DEFAULT_SETTINGS[section]);
    set({ settings: { ...get().settings, [section]: defaults } });
    scheduleSave(get);
  },

  resetAll: () => {
    const { shortcuts, ui } = get().settings;
    set({ settings: { ...structuredClone(DEFAULT_SETTINGS), shortcuts, ui } });
    scheduleSave(get);
  },

  replaceAll: (raw) => {
    set({ settings: sanitizeSettings(raw) });
    scheduleSave(get);
  },

  flush: async () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      await api.storeWrite(STORE_NAME, get().settings as unknown as Json).catch((err) => log.error(err));
    }
    if (pendingSave) await pendingSave;
  },
}));

/** Non-reactive accessor for code outside React. */
export function settings(): Settings {
  return useSettings.getState().settings;
}

/** Subscribe to a selected slice of the settings outside React. */
export function onSettingsChange<T>(select: (s: Settings) => T, listener: (value: T, prev: T) => void): () => void {
  let prev = select(useSettings.getState().settings);
  return useSettings.subscribe((state) => {
    const value = select(state.settings);
    if (value !== prev) {
      const old = prev;
      prev = value;
      listener(value, old);
    }
  });
}
