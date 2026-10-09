/**
 * Page editing helpers shared by the page organizer and the page dialogs: loading source files
 * (PDFs and pictures), planning multi-step page operations and splitting documents.
 *
 * Page numbers are 1-based in this module's public API (as shown to the user); the operations
 * sent to the PDF core use 0-based indices.
 */
import { open } from "@tauri-apps/plugin-dialog";
import type { PageImage, PageOp } from "../annotations/dto";
import { api } from "../lib/ipc";
import { AppError, toAppError } from "../lib/errors";
import { t } from "../i18n";

/** Pictures that can become pages (decoded by the WebView). */
export const PICTURE_EXTENSIONS = ["jpg", "jpeg", "jfif", "png", "webp", "gif", "bmp"];
const PDF_EXTENSIONS = ["pdf"];
/** Pictures larger than this are scaled down before embedding (JPEG files are kept as is). */
const MAX_PICTURE_PIXELS = 40_000_000;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;

export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function isPdfPath(path: string): boolean {
  return PDF_EXTENSIONS.includes(extensionOf(path));
}

export function isPicturePath(path: string): boolean {
  return PICTURE_EXTENSIONS.includes(extensionOf(path));
}

/** Let the user choose PDFs and / or pictures. */
export async function pickSourceFiles(kind: "both" | "pdf" | "picture" = "both", multiple = true): Promise<string[]> {
  const filters =
    kind === "pdf"
      ? [{ name: "PDF", extensions: PDF_EXTENSIONS }]
      : kind === "picture"
        ? [{ name: t("pageEdit.pictures"), extensions: PICTURE_EXTENSIONS }]
        : [
            { name: t("pageEdit.pdfAndPictures"), extensions: [...PDF_EXTENSIONS, ...PICTURE_EXTENSIONS] },
            { name: "PDF", extensions: PDF_EXTENSIONS },
            { name: t("pageEdit.pictures"), extensions: PICTURE_EXTENSIONS },
          ];
  const selected = await open({ multiple, directory: false, filters, title: t("pageEdit.chooseFiles") });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

// ------------------------------------------------------------------------------------ sources

/** A file to insert, as prepared for the insert dialog / organizer. */
export type SourceFile =
  | {
      kind: "pdf";
      path: string;
      name: string;
      bytes: Uint8Array;
      pageCount: number;
      password: string | null;
      /** Pages to insert (1-based); all when null. */
      pages: number[] | null;
    }
  | {
      kind: "picture";
      path: string;
      name: string;
      bytes: Uint8Array;
      image: Omit<PageImage, "blob">;
      /** Small preview (object URL), revoked with {@link releaseSource}. */
      preview: string | null;
    };

export function releaseSource(source: SourceFile): void {
  if (source.kind === "picture" && source.preview) URL.revokeObjectURL(source.preview);
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** Decode a picture: JPEG files are embedded unchanged, others become RGBA pixels. */
export async function preparePicture(bytes: Uint8Array): Promise<{ bytes: Uint8Array; image: Omit<PageImage, "blob">; preview: string | null }> {
  const blob = new Blob([bytes as BlobPart]);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (err) {
    throw new AppError("INVALID_ARGUMENT", t("pageEdit.badPicture"), toAppError(err).message);
  }
  try {
    const preview = await previewUrl(bitmap);
    if (isJpeg(bytes)) {
      // The size shown is after the EXIF orientation; the PDF core reads the file's own header.
      return { bytes, image: { format: "jpeg", width: bitmap.width, height: bitmap.height }, preview };
    }
    const scale = Math.min(1, Math.sqrt(MAX_PICTURE_PIXELS / (bitmap.width * bitmap.height)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2D canvas unavailable");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const rgba = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    const out = { bytes: rgba, image: { format: "rgba" as const, width: canvas.width, height: canvas.height }, preview };
    canvas.width = canvas.height = 0;
    return out;
  } finally {
    bitmap.close();
  }
}

async function previewUrl(bitmap: ImageBitmap, size = 160): Promise<string | null> {
  const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
  canvas.width = canvas.height = 0;
  return blob ? URL.createObjectURL(blob) : null;
}

/**
 * Read a PDF or picture for insertion. `askPassword` is called for protected PDFs and may
 * return null to skip the file.
 */
export async function loadSource(path: string, askPassword: (name: string, retry: boolean) => Promise<string | null>): Promise<SourceFile | null> {
  const name = fileNameOf(path);
  const bytes = await api.fsRead(path, MAX_SOURCE_BYTES);
  if (isPicturePath(path) && !isPdfBytes(bytes)) {
    const picture = await preparePicture(bytes);
    return { kind: "picture", path, name, ...picture };
  }
  let password: string | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      const pageCount = await api.pdfPageCount(path, password);
      return { kind: "pdf", path, name, bytes, pageCount, password, pages: null };
    } catch (err) {
      const e = toAppError(err);
      if (e.code !== "PASSWORD") throw e;
      password = await askPassword(name, attempt > 0);
      if (password === null) return null;
    }
  }
}

function isPdfBytes(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

// ------------------------------------------------------------------------------------ planning

export interface PictureLayout {
  /** Target page size in points; null keeps each picture's own size. */
  pageSize: [number, number] | null;
  margin: number;
}

/** Number of pages a source adds. */
export function sourcePageCount(source: SourceFile): number {
  return source.kind === "picture" ? 1 : (source.pages?.length ?? source.pageCount);
}

/**
 * Operations inserting `sources` in order before 0-based index `at`. Consecutive pictures are
 * grouped into one operation. Returns the operations and their blobs.
 */
export function planInsertion(sources: SourceFile[], at: number, layout: PictureLayout): { ops: PageOp[]; blobs: Uint8Array[] } {
  const ops: PageOp[] = [];
  const blobs: Uint8Array[] = [];
  let position = at;
  let pictures: PageImage[] = [];
  const flushPictures = () => {
    if (!pictures.length) return;
    ops.push({ op: "insertImages", at: position, images: pictures, pageSize: layout.pageSize, margin: layout.margin });
    position += pictures.length;
    pictures = [];
  };
  for (const source of sources) {
    blobs.push(source.bytes);
    const blob = blobs.length - 1;
    if (source.kind === "picture") {
      pictures.push({ blob, ...source.image });
      continue;
    }
    flushPictures();
    ops.push({
      op: "insertFromBlob",
      at: position,
      blob,
      password: source.password,
      pages: source.pages ? source.pages.map((p) => p - 1) : null,
    });
    position += sourcePageCount(source);
  }
  flushPictures();
  return { ops, blobs };
}

/**
 * Replace the 1-based `targets` by new pages: the new pages are inserted where the first target
 * was, then the targets are deleted.
 */
export function planReplace(targets: number[], insert: (at: number) => { ops: PageOp[]; blobs: Uint8Array[]; count: number }): { ops: PageOp[]; blobs: Uint8Array[] } {
  const sorted = [...new Set(targets)].sort((a, b) => a - b);
  const at = sorted[0] - 1;
  const { ops, blobs, count } = insert(at);
  const shifted = sorted.map((p) => (p - 1 >= at ? p - 1 + count : p - 1));
  return { ops: [...ops, { op: "delete", pages: shifted }], blobs };
}

/** New order (0-based permutation) moving the 1-based `moving` pages before 0-based `target`. */
export function orderMoving(numPages: number, moving: number[], target: number): number[] | null {
  const set = new Set(moving);
  const rest: number[] = [];
  for (let p = 1; p <= numPages; p++) if (!set.has(p)) rest.push(p);
  // `target` counts all pages; translate it into a position within `rest`.
  let insertAt = 0;
  for (let p = 1; p <= Math.min(target, numPages); p++) if (!set.has(p)) insertAt++;
  const order = [...rest.slice(0, insertAt), ...[...set].sort((a, b) => a - b), ...rest.slice(insertAt)];
  return order.every((p, i) => p === i + 1) ? null : order.map((p) => p - 1);
}

export type SplitMode = "every" | "parts" | "ranges";

/** Page groups (1-based, inclusive) for splitting a `numPages` document. */
export function planSplit(numPages: number, mode: SplitMode, value: number | string): [number, number][] | null {
  if (numPages < 1) return null;
  if (mode === "every") {
    const n = Math.floor(Number(value));
    if (!(n >= 1)) return null;
    const out: [number, number][] = [];
    for (let start = 1; start <= numPages; start += n) out.push([start, Math.min(numPages, start + n - 1)]);
    return out;
  }
  if (mode === "parts") {
    const parts = Math.floor(Number(value));
    if (!(parts >= 1) || parts > numPages) return null;
    const out: [number, number][] = [];
    let start = 1;
    for (let i = 0; i < parts; i++) {
      const size = Math.floor(numPages / parts) + (i < numPages % parts ? 1 : 0);
      out.push([start, start + size - 1]);
      start += size;
    }
    return out;
  }
  // "1-3, 4-8, 9-": every comma / semicolon separated item is one file.
  const items = String(value)
    .split(/[,;，；]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!items.length) return null;
  const out: [number, number][] = [];
  for (const item of items) {
    const m = /^(\d*)\s*[-–~]\s*(\d*)$/.exec(item) ?? /^(\d+)()$/.exec(item);
    if (!m) return null;
    const start = m[1] ? Number(m[1]) : 1;
    const end = m[2] ? Number(m[2]) : item.includes("-") || item.includes("–") || item.includes("~") ? numPages : start;
    if (start < 1 || end > numPages || start > end) return null;
    out.push([start, end]);
  }
  return out;
}

/** File names for split parts: `name (1-3).pdf`, …; collisions get a counter. */
export function splitFileNames(base: string, groups: [number, number][]): string[] {
  const seen = new Set<string>();
  return groups.map(([a, b]) => {
    let name = `${base} (${a === b ? a : `${a}-${b}`}).pdf`;
    for (let i = 2; seen.has(name.toLowerCase()); i++) name = `${base} (${a}-${b}) ${i}.pdf`;
    seen.add(name.toLowerCase());
    return name;
  });
}

// ------------------------------------------------------------------------------------ passwords

export type PasswordStrength = 0 | 1 | 2 | 3;

/** Rough password strength: 0 empty / very weak, 1 weak, 2 fair, 3 strong. */
export function passwordStrength(password: string): PasswordStrength {
  if (password.length < 4) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  const score = (password.length >= 8 ? 1 : 0) + (password.length >= 12 ? 1 : 0) + (classes >= 2 ? 1 : 0) + (classes >= 3 ? 1 : 0);
  return score >= 4 ? 3 : score >= 2 ? 2 : 1;
}

// ------------------------------------------------------------------------------------ watermark

/**
 * Centres of the watermark copies on a `pageW`×`pageH` page for a `bw`×`bh` block rotated by
 * `degrees` (counter-clockwise). Mirrors `placements` in crates/yapr-pdf/src/watermark.rs so the
 * dialog preview matches the result.
 */
export function watermarkPlacements(
  position: import("../annotations/dto").WatermarkPosition,
  pageW: number,
  pageH: number,
  bw: number,
  bh: number,
  degrees: number,
): [number, number][] {
  const rad = (degrees * Math.PI) / 180;
  const [sin, cos] = [Math.sin(rad), Math.cos(rad)];
  const hw = (bw * Math.abs(cos) + bh * Math.abs(sin)) / 2;
  const hh = (bw * Math.abs(sin) + bh * Math.abs(cos)) / 2;
  const margin = Math.min(48, Math.max(12, Math.min(pageW, pageH) * 0.06));
  if (position === "tile") {
    const gap = Math.min(96, Math.max(16, bh * 0.8));
    const stepX = bw + gap * 1.5;
    const stepY = bh + gap * 1.5;
    const reach = Math.hypot(pageW, pageH) / 2 + Math.max(bw, bh);
    const cols = Math.min(150, Math.ceil(reach / stepX) + 1);
    const rows = Math.min(150, Math.ceil(reach / stepY) + 1);
    const out: [number, number][] = [];
    for (let row = -rows; row <= rows; row++) {
      const shift = ((row % 2) + 2) % 2 === 1 ? stepX / 2 : 0;
      for (let col = -cols; col <= cols; col++) {
        const lx = col * stepX + shift;
        const ly = row * stepY;
        const x = pageW / 2 + lx * cos - ly * sin;
        const y = pageH / 2 + lx * sin + ly * cos;
        if (x > -hw && x < pageW + hw && y > -hh && y < pageH + hh) out.push([x, y]);
      }
    }
    return out;
  }
  const x = ["left", "topLeft", "bottomLeft"].includes(position)
    ? margin + hw
    : ["right", "topRight", "bottomRight"].includes(position)
      ? pageW - margin - hw
      : pageW / 2;
  const y = ["top", "topLeft", "topRight"].includes(position)
    ? pageH - margin - hh
    : ["bottom", "bottomLeft", "bottomRight"].includes(position)
      ? margin + hh
      : pageH / 2;
  return [[x, y]];
}
