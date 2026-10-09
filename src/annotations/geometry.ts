/**
 * Geometry helpers for annotations, all in PDF user space (y up).
 */
import type { LineEnding } from "./dto";
import { boundsOfPoints, normalizeRect, type Annotation, type Rect } from "./model";

export type Point = [number, number];

const f = (n: number) => (Math.round(n * 100) / 100).toString();

/** SVG path of the quads (UL, UR, LL, LR order). */
export function quadsPath(quads: number[]): string {
  let d = "";
  for (let i = 0; i + 7 < quads.length; i += 8) {
    const [x1, y1, x2, y2, x3, y3, x4, y4] = quads.slice(i, i + 8);
    d += `M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}L${f(x4)} ${f(y4)}L${f(x3)} ${f(y3)}Z`;
  }
  return d;
}

export interface MarkupLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
}

/** Underline / strike-out lines for each quad. `position` 0 = bottom, 0.5 = middle. */
export function markupLines(quads: number[], position: number): MarkupLine[] {
  const out: MarkupLine[] = [];
  for (let i = 0; i + 7 < quads.length; i += 8) {
    const [ulx, uly, , , llx, lly, lrx, lry] = quads.slice(i, i + 8);
    const h = Math.hypot(ulx - llx, uly - lly);
    const t = Math.max(0.5, h / 14);
    // Unit vector from bottom edge towards the top edge.
    const ux = h ? (ulx - llx) / h : 0;
    const uy = h ? (uly - lly) / h : 1;
    const off = position === 0 ? t * 1.2 : h * position;
    out.push({ x1: llx + ux * off, y1: lly + uy * off, x2: lrx + ux * off, y2: lry + uy * off, width: t });
  }
  return out;
}

/** Zig-zag path along the bottom of each quad (squiggly underline). */
export function squigglyPath(quads: number[]): { d: string; width: number } {
  let d = "";
  let width = 0.5;
  for (let i = 0; i + 7 < quads.length; i += 8) {
    const [ulx, uly, , , llx, lly, lrx, lry] = quads.slice(i, i + 8);
    const h = Math.hypot(ulx - llx, uly - lly);
    const len = Math.hypot(lrx - llx, lry - lly);
    if (!len || !h) continue;
    const vx = (lrx - llx) / len;
    const vy = (lry - lly) / len;
    const ux = (ulx - llx) / h;
    const uy = (uly - lly) / h;
    const period = Math.max(1.5, h / 4);
    const amp = h / 14;
    width = Math.max(0.5, h / 18);
    const steps = Math.max(2, Math.ceil(len / (period / 2)));
    for (let s = 0; s <= steps; s++) {
      const along = Math.min(len, (s * period) / 2);
      const up = s % 2 === 0 ? amp : amp * 2.4;
      const x = llx + vx * along + ux * up;
      const y = lly + vy * along + uy * up;
      d += `${s === 0 ? "M" : "L"}${f(x)} ${f(y)}`;
    }
  }
  return { d, width };
}

/** Smooth path through ink points (quadratic curves through midpoints). */
export function inkPath(points: number[]): string {
  const n = points.length / 2;
  if (n === 0) return "";
  if (n === 1) {
    const [x, y] = points;
    return `M${f(x)} ${f(y)}l0.01 0`;
  }
  if (n === 2) return `M${f(points[0])} ${f(points[1])}L${f(points[2])} ${f(points[3])}`;
  let d = `M${f(points[0])} ${f(points[1])}`;
  for (let i = 1; i < n - 1; i++) {
    const x = points[i * 2];
    const y = points[i * 2 + 1];
    const mx = (x + points[i * 2 + 2]) / 2;
    const my = (y + points[i * 2 + 3]) / 2;
    d += `Q${f(x)} ${f(y)} ${f(mx)} ${f(my)}`;
  }
  d += `L${f(points[(n - 1) * 2])} ${f(points[(n - 1) * 2 + 1])}`;
  return d;
}

function perpendicularDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Ramer–Douglas–Peucker simplification of a flat point list. */
export function simplify(points: number[], epsilon: number): number[] {
  const n = points.length / 2;
  if (n <= 2 || epsilon <= 0) return points;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = perpendicularDistance(points[i * 2], points[i * 2 + 1], points[a * 2], points[a * 2 + 1], points[b * 2], points[b * 2 + 1]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > epsilon) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i * 2], points[i * 2 + 1]);
  return out;
}

/** Exponential smoothing of raw pointer samples (strength 0..1). */
export function smoothPoints(points: number[], strength: number): number[] {
  if (strength <= 0 || points.length < 6) return points;
  const alpha = 1 - Math.min(0.85, strength * 0.85);
  const out = [points[0], points[1]];
  let x = points[0];
  let y = points[1];
  for (let i = 2; i < points.length; i += 2) {
    x += alpha * (points[i] - x);
    y += alpha * (points[i + 1] - y);
    out.push(x, y);
  }
  // Keep the true end point.
  out[out.length - 2] = points[points.length - 2];
  out[out.length - 1] = points[points.length - 1];
  return out;
}

/** Arrow-head / line ending path at `tip`, pointing away from `from`. */
export function lineEndingPath(kind: LineEnding, tip: Point, from: Point, width: number): { d: string; closed: boolean } | null {
  if (kind === "None") return null;
  const size = Math.max(6, width * 3);
  let dx = tip[0] - from[0];
  let dy = tip[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const px = -dy;
  const py = dx;
  const at = (along: number, side: number): Point => [tip[0] + dx * along + px * side, tip[1] + dy * along + py * side];
  const p = (pt: Point) => `${f(pt[0])} ${f(pt[1])}`;
  switch (kind) {
    case "OpenArrow":
    case "ClosedArrow": {
      const a = at(-size, size / 2);
      const b = at(-size, -size / 2);
      return { d: `M${p(a)}L${p(tip)}L${p(b)}${kind === "ClosedArrow" ? "Z" : ""}`, closed: kind === "ClosedArrow" };
    }
    case "ROpenArrow":
    case "RClosedArrow": {
      const a = at(size, size / 2);
      const b = at(size, -size / 2);
      return { d: `M${p(a)}L${p(tip)}L${p(b)}${kind === "RClosedArrow" ? "Z" : ""}`, closed: kind === "RClosedArrow" };
    }
    case "Circle": {
      const r = size / 2;
      return { d: `M${f(tip[0] - r)} ${f(tip[1])}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`, closed: true };
    }
    case "Square": {
      const h = size / 2;
      const a = at(h, h);
      const b = at(h, -h);
      const c = at(-h, -h);
      const d = at(-h, h);
      return { d: `M${p(a)}L${p(b)}L${p(c)}L${p(d)}Z`, closed: true };
    }
    case "Diamond": {
      const h = size / 2;
      return { d: `M${p(at(h, 0))}L${p(at(0, -h))}L${p(at(-h, 0))}L${p(at(0, h))}Z`, closed: true };
    }
    case "Butt":
      return { d: `M${p(at(0, size / 2))}L${p(at(0, -size / 2))}`, closed: false };
    case "Slash": {
      const h = size / 2;
      return { d: `M${p(at(h * 0.5, h))}L${p(at(-h * 0.5, -h))}`, closed: false };
    }
    default:
      return null;
  }
}

/** Bounding box that encloses a line including its endings. */
export function lineRect(line: [number, number, number, number], width: number, endings: [LineEnding, LineEnding]): Rect {
  const pad = Math.max(width, endings.some((e) => e !== "None") ? Math.max(6, width * 3) : width) + 2;
  return [Math.min(line[0], line[2]) - pad, Math.min(line[1], line[3]) - pad, Math.max(line[0], line[2]) + pad, Math.max(line[1], line[3]) + pad];
}

/** Translate every geometric field of an annotation. */
export function translateAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  const shift = (pts: number[]) => pts.map((v, i) => (i % 2 === 0 ? v + dx : v + dy));
  return {
    ...a,
    rect: [a.rect[0] + dx, a.rect[1] + dy, a.rect[2] + dx, a.rect[3] + dy],
    quadPoints: shift(a.quadPoints),
    inkList: a.inkList.map(shift),
    vertices: shift(a.vertices),
    line: a.line ? [a.line[0] + dx, a.line[1] + dy, a.line[2] + dx, a.line[3] + dy] : null,
  };
}

/** Scale an annotation from its current rect into `target`. */
export function resizeAnnotation(a: Annotation, target: Rect): Annotation {
  const src = normalizeRect(a.rect);
  const dst = normalizeRect(target);
  const sw = src[2] - src[0] || 1;
  const sh = src[3] - src[1] || 1;
  const kx = (dst[2] - dst[0]) / sw;
  const ky = (dst[3] - dst[1]) / sh;
  const map = (pts: number[]) => pts.map((v, i) => (i % 2 === 0 ? dst[0] + (v - src[0]) * kx : dst[1] + (v - src[1]) * ky));
  return {
    ...a,
    rect: dst,
    inkList: a.inkList.map(map),
    vertices: map(a.vertices),
    line: a.line ? (map([...a.line]) as [number, number, number, number]) : null,
  };
}

/** Recompute the rect from the geometry (after editing vertices / line ends). */
export function fitRect(a: Annotation): Rect {
  if (a.kind === "ink") return boundsOfPoints(a.inkList, a.borderWidth / 2 + 1);
  if (a.kind === "polygon" || a.kind === "polyline") {
    const pad = a.borderWidth / 2 + (a.kind === "polyline" && a.lineEndings.some((e) => e !== "None") ? Math.max(6, a.borderWidth * 3) : 1);
    return boundsOfPoints([a.vertices], pad);
  }
  if (a.kind === "line" && a.line) return lineRect(a.line, a.borderWidth, a.lineEndings);
  return a.rect;
}

/** Distance from point to the polyline `pts`. */
export function distanceToPolyline(x: number, y: number, pts: number[]): number {
  if (pts.length === 2) return Math.hypot(x - pts[0], y - pts[1]);
  let best = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    best = Math.min(best, perpendicularDistance(x, y, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]));
  }
  return best;
}

/** Snap the end point so the line is horizontal, vertical or 45° (Shift while drawing). */
export function snapAngle(start: Point, end: Point): Point {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const angle = Math.atan2(dy, dx);
  const step = Math.PI / 4;
  const snapped = Math.round(angle / step) * step;
  const len = Math.hypot(dx, dy);
  return [start[0] + Math.cos(snapped) * len, start[1] + Math.sin(snapped) * len];
}

export function rectFromPoints(a: Point, b: Point, square = false): Rect {
  if (!square) return normalizeRect([a[0], a[1], b[0], b[1]]);
  const size = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
  return normalizeRect([a[0], a[1], a[0] + Math.sign(b[0] - a[0] || 1) * size, a[1] + Math.sign(b[1] - a[1] || 1) * size]);
}

/** Path of a "cloudy" rectangle border (approximation used for on-screen drawing). */
export function cloudyRectPath(r: Rect, intensity = 1): string {
  const [x1, y1, x2, y2] = normalizeRect(r);
  const radius = 4 * intensity + 2;
  let d = "";
  const edge = (ax: number, ay: number, bx: number, by: number) => {
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(len / (radius * 1.6)));
    for (let i = 0; i < n; i++) {
      const sx = ax + ((bx - ax) * i) / n;
      const sy = ay + ((by - ay) * i) / n;
      const ex = ax + ((bx - ax) * (i + 1)) / n;
      const ey = ay + ((by - ay) * (i + 1)) / n;
      d += `${d ? "" : `M${f(sx)} ${f(sy)}`}A${f(radius)} ${f(radius)} 0 0 1 ${f(ex)} ${f(ey)}`;
    }
  };
  edge(x1, y2, x2, y2);
  edge(x2, y2, x2, y1);
  edge(x2, y1, x1, y1);
  edge(x1, y1, x1, y2);
  return `${d}Z`;
}
