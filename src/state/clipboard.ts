/** In-app clipboard for copied annotations (Ctrl+C / Ctrl+V on comments). */
import { newId, newNm, nowIso, type Annotation } from "../annotations/model";

let copied: Annotation[] = [];
let pasteCount = 0;

export function copyAnnotations(items: Annotation[]): void {
  copied = items.filter((a) => a.kind !== "other").map((a) => structuredClone(a));
  pasteCount = 0;
}

export function hasCopiedAnnotations(): boolean {
  return copied.length > 0;
}

function shift(points: number[], dx: number, dy: number): number[] {
  return points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy));
}

/** Clones of the copied annotations, offset a little more on every paste, moved to `page`. */
export function annotationsForPaste(page: number, author: string): Annotation[] {
  pasteCount++;
  const d = 12 * pasteCount;
  return copied.map((a) => ({
    ...structuredClone(a),
    id: newId(),
    ref: null,
    nm: newNm(),
    page,
    author: author || a.author,
    created: nowIso(),
    modified: nowIso(),
    inReplyTo: null,
    replyType: null,
    rect: [a.rect[0] + d, a.rect[1] - d, a.rect[2] + d, a.rect[3] - d],
    quadPoints: shift(a.quadPoints, d, -d),
    inkList: a.inkList.map((s) => shift(s, d, -d)),
    vertices: shift(a.vertices, d, -d),
    line: a.line ? [a.line[0] + d, a.line[1] - d, a.line[2] + d, a.line[3] - d] : null,
    editable: true,
    hasAppearance: false,
    popupRef: null,
  }));
}
