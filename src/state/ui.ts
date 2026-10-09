/**
 * Global UI state: toasts, modal dialogs (promise based), overlays and window modes.
 */
import { create } from "zustand";
import type { AppError } from "../lib/errors";

export type ToastKind = "info" | "success" | "warning" | "error";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  detail?: string;
  action?: ToastAction;
  /** ms; 0 = sticky */
  timeout: number;
}

export interface ConfirmProps {
  title: string;
  message: string;
  detail?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Third button (e.g. "Don't Save"). */
  altLabel?: string;
  danger?: boolean;
  checkboxLabel?: string;
}

export interface ConfirmResult {
  choice: "confirm" | "alt" | "cancel";
  checked: boolean;
}

export interface PromptProps {
  title: string;
  message?: string;
  label: string;
  value: string;
  placeholder?: string;
  confirmLabel?: string;
  validate?: (value: string) => string | null;
}

export interface DialogMap {
  password: { props: { fileName: string; reason: "need" | "incorrect" }; result: string | null };
  confirm: { props: ConfirmProps; result: ConfirmResult };
  prompt: { props: PromptProps; result: string | null };
  error: { props: { title: string; error: AppError }; result: void };
  link: { props: { url: string }; result: { open: boolean; always: boolean } };
  goToPage: { props: { tabId: string }; result: void };
  docProps: { props: { tabId: string }; result: void };
  print: { props: { tabId: string }; result: void };
  pageOps: {
    props: { tabId: string; mode: "delete" | "insertBlank" | "insertFile" | "extract"; pages?: number[] };
    result: void;
  };
  exportImage: { props: { tabId: string }; result: void };
  insertFiles: { props: { tabId: string; at?: number; paths?: string[] }; result: void };
  replacePages: { props: { tabId: string; pages?: number[] }; result: void };
  splitDocument: { props: { tabId: string }; result: void };
  watermark: { props: { tabId: string; pages?: number[] }; result: void };
  security: { props: { tabId: string }; result: void };
  signature: { props: { initials?: boolean }; result: void };
  stampEditor: { props: Record<string, never>; result: void };
}

export type DialogType = keyof DialogMap;

export interface DialogEntry<K extends DialogType = DialogType> {
  id: number;
  type: K;
  props: DialogMap[K]["props"];
  resolve: (value: DialogMap[K]["result"]) => void;
}

export interface SettingsOverlay {
  page: string;
}

interface UiState {
  toasts: Toast[];
  dialogs: DialogEntry[];
  settings: SettingsOverlay | null;
  palette: boolean;
  shortcuts: boolean;
  about: boolean;
  readMode: boolean;
  presentation: boolean;
  fullscreen: boolean;
  /** Menu bar revealed temporarily with Alt while hidden in settings. */
  menuBarPeek: boolean;
  /** Find bar visible; `findFocus` increments to request focus. */
  findOpen: boolean;
  findFocus: number;
  /** Comment tools row visible. */
  commentTools: boolean;
  /** Right-hand comments pane visible. */
  commentsPane: boolean;
  /** Global progress message (e.g. while saving or printing). */
  busy: { message: string; progress: number | null; cancel?: () => void } | null;
}

export const useUi = create<UiState>(() => ({
  toasts: [],
  dialogs: [],
  settings: null,
  palette: false,
  shortcuts: false,
  about: false,
  readMode: false,
  presentation: false,
  fullscreen: false,
  menuBarPeek: false,
  findOpen: false,
  findFocus: 0,
  commentTools: false,
  commentsPane: false,
  busy: null,
}));

let nextId = 1;

const DEFAULT_TIMEOUT: Record<ToastKind, number> = { info: 3500, success: 3000, warning: 6000, error: 9000 };

export function toast(
  kind: ToastKind,
  message: string,
  opts: { detail?: string; action?: ToastAction; timeout?: number } = {},
): number {
  const id = nextId++;
  const entry: Toast = { id, kind, message, detail: opts.detail, action: opts.action, timeout: opts.timeout ?? DEFAULT_TIMEOUT[kind] };
  useUi.setState((s) => ({ toasts: [...s.toasts.slice(-4), entry] }));
  return id;
}

export function dismissToast(id: number) {
  useUi.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function openDialog<K extends DialogType>(type: K, props: DialogMap[K]["props"]): Promise<DialogMap[K]["result"]> {
  return new Promise((resolve) => {
    const entry: DialogEntry<K> = {
      id: nextId++,
      type,
      props,
      resolve: (value) => {
        useUi.setState((s) => ({ dialogs: s.dialogs.filter((d) => d.id !== entry.id) }));
        resolve(value);
      },
    };
    useUi.setState((s) => ({ dialogs: [...s.dialogs, entry as unknown as DialogEntry] }));
  });
}

export async function confirm(props: ConfirmProps): Promise<ConfirmResult> {
  return openDialog("confirm", props);
}

export function setBusy(message: string | null, progress: number | null = null, cancel?: () => void) {
  useUi.setState({ busy: message === null ? null : { message, progress, cancel } });
}

export function openSettings(page = "general") {
  useUi.setState({ settings: { page } });
}
