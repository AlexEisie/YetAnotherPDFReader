/**
 * Convert the DOM text selection (inside pdf.js text layers) into text-markup quads in PDF
 * user space, grouped by page.
 */
import type { ViewerLike } from "../pdf/viewerTypes";

export interface SelectionQuads {
  /** 0-based page index → flat quad points (8 numbers per quad). */
  byPage: Map<number, number[]>;
  text: string;
}

interface Box {
  page: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function textNodesInRange(range: Range): Text[] {
  const root = range.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE) return [root as Text];
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (range.intersectsNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  return nodes;
}

/** Merge boxes that sit on the same line and touch / overlap horizontally. */
function mergeLineBoxes(boxes: Box[]): Box[] {
  const sorted = [...boxes].sort((a, b) => a.page - b.page || b.y2 - a.y2 || a.x1 - b.x1);
  const out: Box[] = [];
  for (const box of sorted) {
    const prev = out.at(-1);
    if (prev && prev.page === box.page) {
      const h = Math.min(prev.y2 - prev.y1, box.y2 - box.y1);
      const overlap = Math.min(prev.y2, box.y2) - Math.max(prev.y1, box.y1);
      const gap = box.x1 - prev.x2;
      if (overlap > h * 0.5 && gap < h * 0.6 && box.x2 > prev.x1 - h * 0.6) {
        prev.x1 = Math.min(prev.x1, box.x1);
        prev.x2 = Math.max(prev.x2, box.x2);
        prev.y1 = Math.min(prev.y1, box.y1);
        prev.y2 = Math.max(prev.y2, box.y2);
        continue;
      }
    }
    out.push({ ...box });
  }
  return out;
}

export function selectionToQuads(viewer: ViewerLike, selection: Selection | null): SelectionQuads | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const boxes: Box[] = [];
  for (let r = 0; r < selection.rangeCount; r++) {
    const range = selection.getRangeAt(r);
    for (const node of textNodesInRange(range)) {
      const pageDiv = node.parentElement?.closest<HTMLElement>(".page");
      const layer = node.parentElement?.closest(".textLayer");
      if (!pageDiv || !layer) continue;
      const pageNumber = Number(pageDiv.dataset.pageNumber);
      const view = viewer.getPageView(pageNumber - 1);
      if (!view) continue;
      const sub = document.createRange();
      sub.setStart(node, node === range.startContainer ? range.startOffset : 0);
      sub.setEnd(node, node === range.endContainer ? range.endOffset : node.length);
      if (sub.collapsed || !sub.toString().trim()) continue;
      const pageRect = pageDiv.getBoundingClientRect();
      // Page div has a border in pdf.js' default style; the viewport starts inside it.
      const style = getComputedStyle(pageDiv);
      const offX = pageRect.left + (parseFloat(style.borderLeftWidth) || 0);
      const offY = pageRect.top + (parseFloat(style.borderTopWidth) || 0);
      for (const rect of sub.getClientRects()) {
        if (rect.width < 0.5 || rect.height < 0.5) continue;
        const corners = [
          view.viewport.convertToPdfPoint(rect.left - offX, rect.top - offY),
          view.viewport.convertToPdfPoint(rect.right - offX, rect.bottom - offY),
        ];
        boxes.push({
          page: pageNumber - 1,
          x1: Math.min(corners[0][0], corners[1][0]),
          x2: Math.max(corners[0][0], corners[1][0]),
          y1: Math.min(corners[0][1], corners[1][1]),
          y2: Math.max(corners[0][1], corners[1][1]),
        });
      }
    }
  }
  if (boxes.length === 0) return null;
  const byPage = new Map<number, number[]>();
  for (const b of mergeLineBoxes(boxes)) {
    const quads = byPage.get(b.page) ?? [];
    // Upper-left, upper-right, lower-left, lower-right (Acrobat order).
    quads.push(b.x1, b.y2, b.x2, b.y2, b.x1, b.y1, b.x2, b.y1);
    byPage.set(b.page, quads);
  }
  return { byPage, text: selection.toString() };
}

export function quadsBounds(quads: number[]): [number, number, number, number] {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (let i = 0; i + 1 < quads.length; i += 2) {
    x1 = Math.min(x1, quads[i]);
    x2 = Math.max(x2, quads[i]);
    y1 = Math.min(y1, quads[i + 1]);
    y2 = Math.max(y2, quads[i + 1]);
  }
  return [x1, y1, x2, y2];
}
