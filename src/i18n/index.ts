/**
 * Internationalisation runtime.
 *
 * English is bundled; other locales are code-split and loaded on demand, so only the active
 * language occupies memory. Missing keys fall back to English.
 */
import { useCallback } from "react";
import { create } from "zustand";
import en, { type MessageKey } from "./locales/en";
import { formatMessage, type Params } from "./format";

export type { MessageKey } from "./locales/en";
export type Messages = Record<MessageKey, string>;
export type PartialMessages = Partial<Messages>;

export interface LocaleInfo {
  code: string;
  /** Native name, shown in the language picker. */
  name: string;
  load: () => Promise<{ default: PartialMessages }>;
  /** Preferred CJK font collection for PDF text written in this locale. */
  cjk?: "zh-CN" | "zh-TW" | "ja" | "ko";
}

export const LOCALES: LocaleInfo[] = [
  { code: "en", name: "English", load: async () => ({ default: en }) },
  { code: "zh-CN", name: "简体中文", load: () => import("./locales/zh-CN"), cjk: "zh-CN" },
  { code: "zh-TW", name: "繁體中文", load: () => import("./locales/zh-TW"), cjk: "zh-TW" },
  { code: "ja", name: "日本語", load: () => import("./locales/ja"), cjk: "ja" },
  { code: "ko", name: "한국어", load: () => import("./locales/ko"), cjk: "ko" },
  { code: "de", name: "Deutsch", load: () => import("./locales/de") },
  { code: "fr", name: "Français", load: () => import("./locales/fr") },
  { code: "es", name: "Español", load: () => import("./locales/es") },
  { code: "ru", name: "Русский", load: () => import("./locales/ru") },
];

/** Pick the best supported locale for a list of BCP-47 tags (e.g. `navigator.languages`). */
export function negotiateLocale(requested: readonly string[]): string {
  for (const tag of requested) {
    const lower = tag.toLowerCase();
    const exact = LOCALES.find((l) => l.code.toLowerCase() === lower);
    if (exact) return exact.code;
    if (lower.startsWith("zh")) {
      // zh-HK / zh-MO / zh-Hant-* → Traditional; everything else → Simplified.
      return /hant|tw|hk|mo/.test(lower) ? "zh-TW" : "zh-CN";
    }
    const base = lower.split("-")[0];
    const partial = LOCALES.find((l) => l.code.toLowerCase().split("-")[0] === base);
    if (partial) return partial.code;
  }
  return "en";
}

export function systemLocale(): string {
  const langs = typeof navigator !== "undefined" ? navigator.languages ?? [navigator.language] : [];
  return negotiateLocale(langs);
}

interface I18nState {
  locale: string;
  messages: Messages;
  setLocale: (code: string) => Promise<void>;
}

let loadToken = 0;

export const useI18n = create<I18nState>((set) => ({
  locale: "en",
  messages: en,
  setLocale: async (code: string) => {
    const info = LOCALES.find((l) => l.code === code) ?? LOCALES[0];
    const token = ++loadToken;
    let messages: Messages = en;
    if (info.code !== "en") {
      try {
        const mod = await info.load();
        messages = { ...en, ...mod.default };
      } catch (err) {
        console.error(`failed to load locale ${info.code}`, err);
      }
    }
    if (token !== loadToken) return; // a newer request won
    document.documentElement.lang = info.code;
    set({ locale: info.code, messages });
  },
}));

export type TFunction = (key: MessageKey, params?: Params) => string;

function translate(messages: Messages, locale: string, key: MessageKey, params?: Params): string {
  const template = messages[key] ?? en[key] ?? key;
  return formatMessage(template, params, locale);
}

/** Non-reactive translation (for code outside React components). */
export const t: TFunction = (key, params) => {
  const { messages, locale } = useI18n.getState();
  return translate(messages, locale, key, params);
};

/** Reactive translation hook: components re-render when the language changes. */
export function useT(): TFunction {
  const messages = useI18n((s) => s.messages);
  const locale = useI18n((s) => s.locale);
  // Stable identity per language so it can be used in memo / effect dependencies.
  return useCallback<TFunction>((key, params) => translate(messages, locale, key, params), [messages, locale]);
}

export function useLocale(): string {
  return useI18n((s) => s.locale);
}

export function currentLocale(): string {
  return useI18n.getState().locale;
}

export function cjkHintForLocale(code: string): string | null {
  return LOCALES.find((l) => l.code === code)?.cjk ?? null;
}
