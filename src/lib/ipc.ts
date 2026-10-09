/**
 * Typed bridge to the Rust commands (see `src-tauri/src/commands.rs`).
 *
 * Large binary payloads use a compact frame instead of JSON:
 * `u32 metaLen | u32 blobCount | u64 blobLen × blobCount | meta JSON | blobs...` (little endian).
 */
import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "./errors";
import type {
  DocumentChanges,
  DocumentFont,
  ExistingAnnotation,
  OcrLine,
  PageOp,
  SecurityInfo,
  SecuritySettings,
} from "../annotations/dto";

async function call<T>(cmd: string, args?: Parameters<typeof invoke>[1]): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    throw toAppError(err);
  }
}

const encoder = new TextEncoder();

export function encodeFrame(meta: unknown, blobs: Uint8Array[]): Uint8Array {
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const headerLen = 8 + blobs.length * 8;
  const total = headerLen + metaBytes.length + blobs.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, metaBytes.length, true);
  view.setUint32(4, blobs.length, true);
  blobs.forEach((b, i) => view.setBigUint64(8 + i * 8, BigInt(b.length), true));
  out.set(metaBytes, headerLen);
  let offset = headerLen + metaBytes.length;
  for (const b of blobs) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}

export interface DocInfo {
  sessionId: number;
  path: string;
  fileName: string;
  size: number;
  modifiedMs: number | null;
  readOnly: boolean;
}

export interface DiskStatus {
  exists: boolean;
  changed: boolean;
}

export interface SaveResult {
  path: string;
  size: number;
  modifiedMs: number | null;
  backupPath: string | null;
}

export interface FileStat {
  exists: boolean;
  isFile: boolean;
  size: number;
  modifiedMs: number | null;
  readOnly: boolean;
}

export interface StoreRead<T> {
  value: T | null;
  recovered: boolean;
}

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
  debug: boolean;
  dataDir: string;
  logDir: string;
  /** Operating-system user name (default comment author). */
  userName: string;
  launchFiles: string[];
}

export const api = {
  // Documents ---------------------------------------------------------------------------------
  docOpen: (path: string) => call<DocInfo>("doc_open", { path }),
  docRead: (sessionId: number, begin: number, end: number) =>
    call<ArrayBuffer>("doc_read", { sessionId, begin, end }),
  docReadAll: (sessionId: number) => call<ArrayBuffer>("doc_read_all", { sessionId }),
  docClose: (sessionId: number) => call<boolean>("doc_close", { sessionId }),
  docCheck: (sessionId: number) => call<DiskStatus>("doc_check", { sessionId }),
  docAnnotations: (sessionId: number, password: string | null) =>
    call<ExistingAnnotation[]>("doc_annotations", { sessionId, password }),

  // PDF writing -------------------------------------------------------------------------------
  /**
   * Write `document` + `changes` to `target`. When `sourceSession` is given the Rust side reads
   * the original file itself and `document` may be empty.
   */
  pdfSave: (
    meta: {
      target: string;
      sourceSession: number | null;
      password: string | null;
      changes: DocumentChanges;
      keepBackup: boolean;
    },
    document: Uint8Array,
    images: Uint8Array[],
  ) => call<SaveResult>("pdf_save", encodeFrame(meta, [document, ...images])),
  pdfReadAnnotations: (document: Uint8Array, password: string | null) =>
    call<ExistingAnnotation[]>("pdf_read_annotations", encodeFrame({ password }, [document])),
  /** Fonts of the document in `sourceSession`, or of `document` when no session is given. */
  pdfFonts: (meta: { sourceSession: number | null; password: string | null }, document: Uint8Array) =>
    call<DocumentFont[]>("pdf_fonts", encodeFrame(meta, [document])),
  pdfBuild: async (
    meta: { password: string | null; changes: DocumentChanges },
    document: Uint8Array,
    images: Uint8Array[],
  ) => new Uint8Array(await call<ArrayBuffer>("pdf_build", encodeFrame(meta, [document, ...images]))),
  pdfPageOps: async (
    meta: { password: string | null; ops: PageOp[] },
    document: Uint8Array,
    sources: Uint8Array[],
  ) => new Uint8Array(await call<ArrayBuffer>("pdf_page_ops", encodeFrame(meta, [document, ...sources]))),
  pdfExtract: (meta: { password: string | null; pages: number[]; target: string }, document: Uint8Array) =>
    call<SaveResult>("pdf_extract", encodeFrame(meta, [document])),
  pdfPageCount: (path: string, password: string | null) => call<number>("pdf_page_count", { path, password }),
  /** Recognise text in RGBA pixels (OCR). */
  ocrRecognize: (width: number, height: number, rgba: Uint8Array) => call<OcrLine[]>("ocr_recognize", encodeFrame({ width, height }, [rgba])),
  pdfSecurityInfo: (meta: { password: string | null }, document: Uint8Array) =>
    call<SecurityInfo>("pdf_security_info", encodeFrame(meta, [document])),
  /** Apply (`settings`) or remove (`settings: null`) password protection. */
  pdfSecurity: async (
    meta: { password: string | null; ownerPassword: string | null; settings: SecuritySettings | null },
    document: Uint8Array,
  ) => new Uint8Array(await call<ArrayBuffer>("pdf_security", encodeFrame(meta, [document]))),

  // Files -------------------------------------------------------------------------------------
  fsStat: (path: string) => call<FileStat>("fs_stat", { path }),
  fsRead: async (path: string, maxBytes?: number) =>
    new Uint8Array(await call<ArrayBuffer>("fs_read", { path, maxBytes: maxBytes ?? null })),
  fsWrite: (path: string, data: Uint8Array, keepBackup = false) =>
    call<void>("fs_write", encodeFrame({ path, keepBackup }, [data])),
  fsCopy: (from: string, to: string) => call<SaveResult>("fs_copy", { from, to }),
  /** Put `width * height` RGBA pixels on the system clipboard. */
  clipboardWriteImage: (width: number, height: number, rgba: Uint8Array) =>
    call<void>("clipboard_write_image", encodeFrame({ width, height }, [rgba])),

  // Store -------------------------------------------------------------------------------------
  storeRead: <T>(name: string) => call<StoreRead<T>>("store_read", { name }),
  storeWrite: (name: string, value: unknown) => call<void>("store_write", { name, value }),
  storeRemove: (name: string) => call<void>("store_remove", { name }),

  // Application -------------------------------------------------------------------------------
  appReady: () => call<AppInfo>("app_ready"),
  appTakePendingFiles: () => call<string[]>("app_take_pending_files"),
  appLog: (level: "error" | "warn" | "info" | "debug", message: string) => call<void>("app_log", { level, message }),
  appOpenFolder: (kind: "data" | "logs") => call<void>("app_open_folder", { kind }),
};

export const OPEN_FILES_EVENT = "app://open-files";
