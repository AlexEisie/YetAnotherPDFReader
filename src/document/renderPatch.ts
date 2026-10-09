/**
 * Hide selected file annotations from pdf.js page rendering.
 *
 * When the user edits or deletes an annotation stored in the file, the app draws the modified
 * version itself, so pdf.js must stop painting the original appearance. pdf.js only honours
 * per-annotation `noView` overrides when they are part of the annotation storage sent with the
 * render request, which it does not do in the interactive-forms mode we use. This shim injects
 * `{ noView: true }` entries for the hidden references into that request and folds them into
 * the operator-list cache key so pages re-render when the set changes.
 *
 * It relies on the internal `WorkerTransport#getRenderingIntent` of pdfjs-dist 6.x; if the
 * internals change the shim disables itself (annotations are then simply drawn twice).
 */
import type { PDFDocumentProxy } from "pdfjs-dist";
import { createLogger } from "../lib/log";

const log = createLogger("render-patch");

interface Serializable {
  map: Map<string, unknown> | null;
  hash: string;
  transfer?: Transferable[];
}

interface RenderingIntent {
  renderingIntent: number;
  cacheKey: string;
  annotationStorageSerializable: Serializable;
  modifiedIds: unknown;
}

type GetRenderingIntent = (...args: unknown[]) => RenderingIntent;

const PRINT_FLAG = 0x04;

export class HiddenAnnotations {
  private refs = new Set<string>();
  private hash = "";
  private installed = false;

  constructor(pdf: PDFDocumentProxy) {
    const transport = (pdf as unknown as { _transport?: { getRenderingIntent?: GetRenderingIntent } })._transport;
    const original = transport?.getRenderingIntent;
    if (!transport || typeof original !== "function") {
      log.warn("pdf.js internals changed; hiding edited annotations is disabled");
      return;
    }
    transport.getRenderingIntent = (...args: unknown[]) => {
      const result = original.apply(transport, args);
      try {
        return this.inject(result);
      } catch (err) {
        log.error("failed to inject hidden annotations", err);
        return result;
      }
    };
    this.installed = true;
  }

  get supported(): boolean {
    return this.installed;
  }

  /** Replace the hidden set; returns true when it actually changed. */
  set(refs: Set<string>): boolean {
    const sorted = [...refs].sort();
    const hash = sorted.join(",");
    if (hash === this.hash) return false;
    this.refs = new Set(sorted);
    this.hash = hash;
    return true;
  }

  has(ref: string): boolean {
    return this.refs.has(ref);
  }

  private inject(result: RenderingIntent): RenderingIntent {
    if (this.refs.size === 0 || !result || typeof result !== "object") return result;
    // Printing renders from a separately built document; only patch on-screen rendering.
    if ((result.renderingIntent & PRINT_FLAG) !== 0) return result;
    const base = result.annotationStorageSerializable;
    const map = new Map(base?.map ?? []);
    for (const ref of this.refs) {
      const prev = map.get(ref);
      map.set(ref, typeof prev === "object" && prev !== null ? { ...prev, noView: true } : { noView: true });
    }
    return {
      ...result,
      cacheKey: `${result.cacheKey}_h${hashString(this.hash)}`,
      annotationStorageSerializable: { map, hash: `${base?.hash ?? ""}h${this.hash.length}`, transfer: base?.transfer },
    };
  }
}

function hashString(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
