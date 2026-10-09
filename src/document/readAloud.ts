/**
 * Read Out Loud — text-to-speech of the document text using the system voices
 * (Web Speech API, backed by the Windows speech engine in WebView2).
 */
import { create } from "zustand";
import type { DocumentController } from "./DocumentController";
import { settings } from "../settings/store";
import { toast } from "../state/ui";
import { t, currentLocale } from "../i18n";
import { createLogger } from "../lib/log";

const log = createLogger("tts");

interface ReadAloudState {
  status: "idle" | "speaking" | "paused";
  page: number | null;
  tabId: string | null;
}

export const useReadAloud = create<ReadAloudState>(() => ({ status: "idle", page: null, tabId: null }));

const MAX_CHUNK = 220;

function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const sentences = normalized.match(/[^.!?。！？;；]+[.!?。！？;；]*\s*/g) ?? [normalized];
  const chunks: string[] = [];
  let current = "";
  for (const s of sentences) {
    if ((current + s).length > MAX_CHUNK && current) {
      chunks.push(current.trim());
      current = "";
    }
    if (s.length > MAX_CHUNK) {
      for (let i = 0; i < s.length; i += MAX_CHUNK) chunks.push(s.slice(i, i + MAX_CHUNK).trim());
    } else {
      current += s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

let session = 0;

export function ttsAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function listVoices(): SpeechSynthesisVoice[] {
  return ttsAvailable() ? window.speechSynthesis.getVoices() : [];
}

function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = listVoices();
  const preferred = settings().accessibility.ttsVoice;
  if (preferred) {
    const v = voices.find((voice) => voice.voiceURI === preferred || voice.name === preferred);
    if (v) return v;
  }
  const base = lang.toLowerCase().split("-")[0];
  return voices.find((v) => v.lang.toLowerCase().startsWith(base)) ?? null;
}

/** Guess the language of a chunk of text so a matching voice is used (CJK documents etc.). */
function detectLang(text: string): string {
  if (/[぀-ヿ]/.test(text)) return "ja-JP";
  if (/[가-힯]/.test(text)) return "ko-KR";
  if (/[一-鿿]/.test(text)) return currentLocale() === "zh-TW" ? "zh-TW" : "zh-CN";
  if (/[Ѐ-ӿ]/.test(text)) return "ru-RU";
  return currentLocale();
}

async function pageText(controller: DocumentController, pageNumber: number): Promise<string> {
  const page = await controller.pdf!.getPage(pageNumber);
  const content = await page.getTextContent();
  let text = "";
  for (const item of content.items) {
    if (!("str" in item)) continue;
    text += item.str;
    text += item.hasEOL ? "\n" : "";
  }
  return text;
}

function speak(chunk: string, lang: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const u = new SpeechSynthesisUtterance(chunk);
    const a = settings().accessibility;
    u.rate = a.ttsRate;
    u.pitch = a.ttsPitch;
    u.lang = lang;
    const voice = pickVoice(lang);
    if (voice) u.voice = voice;
    u.onend = () => resolve();
    u.onerror = (e) => (e.error === "interrupted" || e.error === "canceled" ? resolve() : reject(new Error(e.error)));
    window.speechSynthesis.speak(u);
  });
}

/** Read `startPage` (and following pages when `toEnd`). */
export async function readAloud(controller: DocumentController, startPage: number, toEnd: boolean): Promise<void> {
  if (!ttsAvailable()) {
    toast("warning", t("tts.unavailable"));
    return;
  }
  stopReading();
  const my = ++session;
  const last = toEnd ? controller.state.numPages : startPage;
  try {
    for (let p = startPage; p <= last; p++) {
      if (my !== session) return;
      useReadAloud.setState({ status: "speaking", page: p, tabId: controller.tabId });
      if (settings().accessibility.ttsFollow && controller.state.page !== p) controller.goToPage(p, { recordHistory: false });
      const text = await pageText(controller, p);
      const chunks = splitSentences(text);
      if (!chunks.length) {
        if (!toEnd) toast("info", t("tts.noText"));
        continue;
      }
      for (const chunk of chunks) {
        if (my !== session) return;
        await speak(chunk, detectLang(chunk));
      }
    }
  } catch (err) {
    log.error("speech failed", err);
    toast("error", t("tts.unavailable"), { detail: String(err) });
  } finally {
    if (my === session) useReadAloud.setState({ status: "idle", page: null, tabId: null });
  }
}

export function togglePauseReading(): void {
  if (!ttsAvailable()) return;
  const { status } = useReadAloud.getState();
  if (status === "speaking") {
    window.speechSynthesis.pause();
    useReadAloud.setState({ status: "paused" });
  } else if (status === "paused") {
    window.speechSynthesis.resume();
    useReadAloud.setState({ status: "speaking" });
  }
}

export function stopReading(): void {
  session++;
  if (ttsAvailable()) window.speechSynthesis.cancel();
  useReadAloud.setState({ status: "idle", page: null, tabId: null });
}

/** Speak an arbitrary text (e.g. the current selection). */
export async function speakText(text: string): Promise<void> {
  if (!ttsAvailable()) return;
  stopReading();
  const my = session;
  useReadAloud.setState({ status: "speaking", page: null, tabId: null });
  try {
    for (const chunk of splitSentences(text)) {
      if (my !== session) return;
      await speak(chunk, detectLang(chunk));
    }
  } finally {
    if (my === session) useReadAloud.setState({ status: "idle" });
  }
}
