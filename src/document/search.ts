/**
 * Full-text search over the whole document producing a result list with context (the
 * "Advanced Search" panel). Page texts are cached per document.
 */
import type { PDFDocumentProxy } from "../pdf/pdfjs";
import { cancelled } from "../lib/errors";

export interface SearchHit {
  page: number;
  offset: number;
  before: string;
  match: string;
  after: string;
}

const textCache = new WeakMap<PDFDocumentProxy, Map<number, string>>();
const CONTEXT = 40;
const MAX_HITS = 5000;

export async function pageText(pdf: PDFDocumentProxy, pageNumber: number): Promise<string> {
  let cache = textCache.get(pdf);
  if (!cache) {
    cache = new Map();
    textCache.set(pdf, cache);
  }
  const hit = cache.get(pageNumber);
  if (hit !== undefined) return hit;
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  let text = "";
  for (const item of content.items) {
    if (!("str" in item)) continue;
    text += item.str;
    if (item.hasEOL) text += "\n";
  }
  page.cleanup();
  cache.set(pageNumber, text);
  return text;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function searchDocument(
  pdf: PDFDocumentProxy,
  query: string,
  opts: { matchCase: boolean; wholeWords: boolean },
  signal: AbortSignal,
  onPage: (hits: SearchHit[], page: number, total: number) => void,
): Promise<number> {
  const words = query.normalize("NFKC").trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  const source = opts.wholeWords ? `(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])` : words;
  const re = new RegExp(source, opts.matchCase ? "gu" : "giu");
  let total = 0;
  for (let p = 1; p <= pdf.numPages; p++) {
    if (signal.aborted) throw cancelled();
    const raw = (await pageText(pdf, p)).normalize("NFKC");
    const hits: SearchHit[] = [];
    re.lastIndex = 0;
    for (let m = re.exec(raw); m; m = re.exec(raw)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      hits.push({
        page: p,
        offset: start,
        before: (start > CONTEXT ? "…" : "") + raw.slice(Math.max(0, start - CONTEXT), start).replace(/\s+/g, " "),
        match: m[0].replace(/\s+/g, " "),
        after: raw.slice(end, end + CONTEXT).replace(/\s+/g, " ") + (end + CONTEXT < raw.length ? "…" : ""),
      });
      if (total + hits.length >= MAX_HITS) break;
    }
    total += hits.length;
    onPage(hits, p, pdf.numPages);
    if (total >= MAX_HITS) break;
    // Yield to keep the UI responsive.
    if (p % 8 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return total;
}
