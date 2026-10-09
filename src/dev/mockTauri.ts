/**
 * Development-only Tauri mock so the UI can run in a regular browser (`npm run dev` and open
 * http://localhost:1420). Documents come from `dev/samples/` (see scripts/make-sample-pdfs.py).
 * PDF writing is not available in this mode: saves are logged and return the input unchanged.
 *
 * Never bundled in production builds (imported behind `import.meta.env.DEV`).
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import * as pdfjs from "pdfjs-dist";
import type { ExistingAnnotation, AnnotKind } from "../annotations/dto";
import { activeController } from "../state/tabs";
import { useSettings } from "../settings/store";
import { useUi } from "../state/ui";

const SAMPLE_DIR = "C:\\yapr-samples\\";
const sessions = new Map<number, { path: string; bytes: Uint8Array }>();
let nextSession = 1;
let pendingOpen: string[] = [`${SAMPLE_DIR}sample.pdf`];

function urlFor(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return `/dev/samples/${encodeURIComponent(name)}`;
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function parseFrame(body: Uint8Array): { meta: unknown; blobs: Uint8Array[] } {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const metaLen = view.getUint32(0, true);
  const count = view.getUint32(4, true);
  const lengths: number[] = [];
  for (let i = 0; i < count; i++) lengths.push(Number(view.getBigUint64(8 + i * 8, true)));
  let offset = 8 + count * 8;
  const meta = JSON.parse(new TextDecoder().decode(body.subarray(offset, offset + metaLen)));
  offset += metaLen;
  const blobs = lengths.map((len) => {
    const b = body.subarray(offset, offset + len);
    offset += len;
    return b;
  });
  return { meta, blobs };
}

const KIND_BY_TYPE: Record<number, AnnotKind> = {
  1: "note",
  3: "freetext",
  4: "line",
  5: "square",
  6: "circle",
  7: "polygon",
  8: "polyline",
  9: "highlight",
  10: "underline",
  11: "squiggly",
  12: "strikeout",
  13: "stamp",
  15: "ink",
};

/** Approximation of the Rust `read_annotations` using pdf.js (dev mode only). */
async function readAnnotations(bytes: Uint8Array): Promise<ExistingAnnotation[]> {
  const pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const out: ExistingAnnotation[] = [];
  try {
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      for (const a of (await page.getAnnotations()) as Record<string, any>[]) {
        if (!/^\d+R/.test(a.id)) continue;
        const kind = KIND_BY_TYPE[a.annotationType as number];
        const color = a.color ? (Array.from(a.color as Uint8ClampedArray).map((v) => v / 255) as [number, number, number]) : null;
        const quad = (a.quadPoints as Float32Array | undefined) ? Array.from(a.quadPoints as Float32Array) : [];
        out.push({
          ref: a.id,
          pageIndex: p - 1,
          subtype: a.subtype,
          rect: a.rect,
          hasAppearance: !!a.hasAppearance,
          popupRef: a.popupRef ?? null,
          inReplyToRef: a.inReplyTo ?? null,
          replyType: a.replyType ?? null,
          flags: a.annotationFlags ?? 4,
          contents: a.contentsObj?.str ?? "",
          author: a.titleObj?.str ?? "",
          modified: null,
          annotation: kind
            ? {
                kind,
                pageIndex: p - 1,
                rect: a.rect,
                color,
                opacity: a.opacity ?? 1,
                borderWidth: a.borderStyle?.width ?? 1,
                contents: a.contentsObj?.str ?? "",
                author: a.titleObj?.str ?? "",
                quadPoints: quad,
                inkList: (a.inkLists as Float32Array[] | undefined)?.map((s) => Array.from(s)) ?? [],
                vertices: (a.vertices as Float32Array | undefined) ? Array.from(a.vertices as Float32Array) : [],
                line: a.lineCoordinates ? (Array.from(a.lineCoordinates as Float32Array) as [number, number, number, number]) : null,
                icon: a.name ?? null,
                fontSize: a.defaultAppearanceData?.fontSize ?? 12,
              }
            : null,
        });
      }
      page.cleanup();
    }
  } finally {
    await pdf.loadingTask.destroy();
  }
  return out;
}

async function fetchBytes(path: string): Promise<Uint8Array> {
  const res = await fetch(urlFor(path));
  if (!res.ok) throw { code: "NOT_FOUND", message: `file not found: ${path}`, detail: path };
  return new Uint8Array(await res.arrayBuffer());
}

function store(name: string): string {
  return `yapr-store:${name}`;
}

async function handle(cmd: string, args: any): Promise<unknown> {
  switch (cmd) {
    case "doc_open": {
      const bytes = await fetchBytes(args.path);
      const id = nextSession++;
      sessions.set(id, { path: args.path, bytes });
      return { sessionId: id, path: args.path, fileName: args.path.split(/[\\/]/).pop(), size: bytes.length, modifiedMs: Date.now(), readOnly: false };
    }
    case "doc_read": {
      const s = sessions.get(args.sessionId);
      if (!s) throw { code: "UNKNOWN_SESSION", message: "unknown session" };
      return buffer(s.bytes.subarray(args.begin, args.end));
    }
    case "doc_read_all": {
      const s = sessions.get(args.sessionId);
      if (!s) throw { code: "UNKNOWN_SESSION", message: "unknown session" };
      return buffer(s.bytes);
    }
    case "doc_close":
      return sessions.delete(args.sessionId);
    case "doc_check":
      return { exists: true, changed: false };
    case "doc_annotations": {
      const s = sessions.get(args.sessionId);
      return s ? readAnnotations(s.bytes) : [];
    }
    case "pdf_read_annotations":
      return readAnnotations(parseFrame(args).blobs[0]);
    case "pdf_fonts":
      // The real scan happens in Rust; enough for exercising the dialog in the browser.
      return [
        { name: "Helvetica", subset: false, kind: "Type 1", encoding: "WinAnsiEncoding", embedded: false, firstPage: 1, pageCount: 12 },
        { name: "NotoSansSC", subset: true, kind: "TrueType (CID)", encoding: "Identity-H", embedded: true, firstPage: 2, pageCount: 1 },
      ];
    case "pdf_save": {
      const { meta } = parseFrame(args);
      console.info("[mock] pdf_save", meta);
      const target = (meta as { target: string }).target;
      return { path: target, size: 0, modifiedMs: Date.now(), backupPath: null };
    }
    case "ocr_recognize": {
      const { meta } = parseFrame(args);
      const { width, height } = meta as { width: number; height: number };
      // Browser mode has no OCR engine: return a plausible two-line result.
      const line = (text: string, y0: number, y1: number) => ({
        text,
        confidence: 0.98,
        points: [[width * 0.05, height * y0], [width * 0.95, height * y0], [width * 0.95, height * y1], [width * 0.05, height * y1]],
      });
      return [line("城市夜空观测手册", 0.1, 0.35), line("Urban night skies (mock OCR)", 0.55, 0.8)];
    }
    case "pdf_security_info":
      return {
        encrypted: false,
        method: null,
        openPassword: false,
        restricted: false,
        permissions: { print: true, printHighQuality: true, copy: true, modify: true, annotate: true, fillForms: true, assemble: true },
        ownerAccess: true,
      };
    case "pdf_build":
    case "pdf_security":
    case "pdf_page_ops": {
      const { meta, blobs } = parseFrame(args);
      console.info(`[mock] ${cmd}`, meta);
      return buffer(blobs[0]);
    }
    case "pdf_extract":
      console.info("[mock] pdf_extract", parseFrame(args).meta);
      return { path: "C:\\yapr-samples\\extracted.pdf", size: 0, modifiedMs: Date.now(), backupPath: null };
    case "pdf_page_count":
      return 1;
    case "fs_stat":
      return { exists: true, isFile: true, size: 1, modifiedMs: Date.now(), readOnly: false };
    case "fs_read":
      return buffer(await fetchBytes(args.path));
    case "fs_write":
      console.info("[mock] fs_write", parseFrame(args).meta);
      return null;
    case "clipboard_write_image":
      console.info("[mock] clipboard_write_image", parseFrame(args).meta);
      return null;
    case "fs_copy":
      return { path: args.to, size: 0, modifiedMs: Date.now(), backupPath: null };
    case "store_read": {
      const raw = localStorage.getItem(store(args.name));
      return { value: raw ? JSON.parse(raw) : null, recovered: false };
    }
    case "store_write":
      localStorage.setItem(store(args.name), JSON.stringify(args.value));
      return null;
    case "store_remove":
      localStorage.removeItem(store(args.name));
      return null;
    case "app_ready":
      return { version: "0.4.0-dev", platform: "browser", arch: "x86_64", debug: true, dataDir: "(localStorage)", logDir: "(console)", userName: "Tester", launchFiles: [], installKind: "installer" };
    case "app_take_pending_files":
      return [];
    case "app_log":
      return null;
    case "app_open_folder":
      console.info("[mock] open folder", args.kind);
      return null;
    case "plugin:dialog|open": {
      const files = pendingOpen;
      pendingOpen = [`${SAMPLE_DIR}sample.pdf`];
      return args?.options?.multiple ? files : files[0];
    }
    case "plugin:dialog|save":
      return args?.options?.defaultPath ?? `${SAMPLE_DIR}saved.pdf`;
    case "plugin:opener|open_url":
      window.open(args.url, "_blank", "noopener");
      return null;
    case "plugin:window|is_fullscreen":
    case "plugin:window|is_visible":
      return cmd.endsWith("is_visible");
    default:
      if (cmd.startsWith("plugin:")) return null;
      console.warn("[mock] unhandled command", cmd, args);
      return null;
  }
}

export function installTauriMock(): void {
  mockWindows("main");
  mockIPC((cmd, args) => handle(cmd, args), { shouldMockEvents: true });
  // Helpers for manual / automated testing from the dev-tools console.
  (window as unknown as { yaprDev: unknown }).yaprDev = {
    /** Make the next "Open" dialog return these sample files (names inside dev/samples). */
    nextOpen: (...names: string[]) => (pendingOpen = names.map((n) => `${SAMPLE_DIR}${n}`)),
    /** The controller of the active tab (for scripted checks). */
    active: () => activeController(),
    /** Change a setting by path (e.g. "pageColors.mode"). */
    setSetting: (path: string, value: unknown) => useSettings.getState().set(path, value),
    /** Patch the UI store (panes, dialogs). */
    setUi: (patch: Record<string, unknown>) => useUi.setState(patch),
  };
  console.info("[mock] Tauri IPC mocked — running in browser mode");
}
