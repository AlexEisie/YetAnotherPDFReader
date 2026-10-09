/**
 * Annotation overlay of one page.
 *
 * Renders (via portals into the layers managed by PageLayerManager):
 *  - markup layer: app-drawn highlights (multiply blend, inside the page colour filter)
 *  - content layer: all other app-drawn annotations
 *  - ui layer: hit targets for every comment (including those pdf.js draws), selection chrome,
 *    drafts of the active drawing tool, and the inline free-text editor.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PageViewport } from "pdfjs-dist";
import type { DocumentController } from "../../document/DocumentController";
import type { PageLayers } from "../../document/pageLayers";
import { useAnnotState, useDocState, shallowEqual } from "../../hooks/useDoc";
import { drawnByApp } from "../../annotations/store";
import {
  blankAnnotation,
  isReply,
  isTextMarkup,
  kindLabelKey,
  normalizeRect,
  nowIso,
  rgbToCss,
  type Annotation,
  type Rect,
} from "../../annotations/model";
import {
  distanceToPolyline,
  fitRect,
  inkPath,
  lineRect,
  quadsPath,
  rectFromPoints,
  resizeAnnotation,
  simplify,
  smoothPoints,
  snapAngle,
  translateAnnotation,
  type Point,
} from "../../annotations/geometry";
import { capturesPointer, createStyled, type ToolId } from "../../annotations/tools";
import { fitImage } from "../../annotations/images";
import { stampSize } from "../../annotations/stamps";
import { settings } from "../../settings/store";
import { clampToPage, snapshotScale, snapshotSize } from "../../document/snapshot";
import { t } from "../../i18n";
import type { Change } from "../../annotations/history";
import { ContentShape, FreeTextBox, MarkupShape } from "./shapes";
import { capturePointer } from "../../lib/dom";

const EMPTY: string[] = [];

interface Geometry {
  width: number;
  height: number;
  transform: string;
  vp: PageViewport;
  /** CSS pixels per PDF unit at the current zoom. */
  pxPerUnit: number;
}

function usePageGeometry(c: DocumentController, pageNumber: number): Geometry | null {
  const layoutVersion = useDocState(c, (s) => s.layoutVersion, 0);
  const scale = useDocState(c, (s) => s.scale, 1);
  const view = c.layers?.pageView(pageNumber);
  const pdfPage = view?.pdfPage ?? null;
  const rotation = view?.viewport.rotation ?? 0;
  return useMemo(() => {
    if (!pdfPage || !view) return null;
    const vp = pdfPage.getViewport({ scale: 1, rotation });
    const [a, b, cc, d, e, f] = vp.transform;
    return {
      width: vp.width,
      height: vp.height,
      transform: `matrix(${a} ${b} ${cc} ${d} ${e} ${f})`,
      vp,
      pxPerUnit: view.viewport.scale,
    };
  }, [pdfPage, rotation, scale, layoutVersion]);
}

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type Drag =
  | { mode: "move"; ids: string[]; start: Point; moved: boolean }
  | { mode: "resize"; id: string; handle: Handle; start: Point; origin: Rect; keepAspect: boolean; moved: boolean }
  | { mode: "vertex"; id: string; index: number; start: Point; moved: boolean };

type Draft =
  | { kind: "ink"; points: number[] }
  | { kind: "rect"; tool: ToolId; start: Point; end: Point }
  | { kind: "line"; tool: ToolId; start: Point; end: Point }
  | { kind: "poly"; tool: ToolId; points: number[]; hover: Point | null }
  | { kind: "erase"; point: Point; erased: Record<string, number[][]> };

function canResize(a: Annotation): boolean {
  return ["freetext", "square", "circle", "stamp", "ink", "polygon", "polyline"].includes(a.kind);
}

function canMove(a: Annotation): boolean {
  return a.editable && !a.locked && !isTextMarkup(a.kind) && a.kind !== "other";
}

function resizeRect(origin: Rect, handle: Handle, p: Point, keepAspect: boolean): Rect {
  let [x1, y1, x2, y2] = origin;
  if (handle.includes("w")) x1 = Math.min(p[0], x2 - 4);
  if (handle.includes("e")) x2 = Math.max(p[0], x1 + 4);
  if (handle.includes("s")) y1 = Math.min(p[1], y2 - 4);
  if (handle.includes("n")) y2 = Math.max(p[1], y1 + 4);
  if (keepAspect && handle.length === 2) {
    const ow = origin[2] - origin[0];
    const oh = origin[3] - origin[1];
    const ratio = ow / (oh || 1);
    const w = x2 - x1;
    const h = y2 - y1;
    if (w / h > ratio) {
      const nw = h * ratio;
      if (handle.includes("w")) x1 = x2 - nw;
      else x2 = x1 + nw;
    } else {
      const nh = w / ratio;
      if (handle.includes("s")) y1 = y2 - nh;
      else y2 = y1 + nh;
    }
  }
  return [x1, y1, x2, y2];
}

/** Transparent shape used for hit testing an annotation. */
function HitShape({ a, onDown, onDouble, onEnter, onLeave }: {
  a: Annotation;
  onDown: (e: React.PointerEvent, a: Annotation) => void;
  onDouble: (a: Annotation) => void;
  onEnter: (a: Annotation) => void;
  onLeave: () => void;
}) {
  const common = {
    "data-annot-id": a.id,
    className: `annot-hit${isTextMarkup(a.kind) ? " markup" : ""}${a.locked ? " locked" : ""}`,
    onPointerDown: (e: React.PointerEvent) => onDown(e, a),
    onDoubleClick: () => onDouble(a),
    onPointerEnter: () => onEnter(a),
    onPointerLeave: onLeave,
  };
  if (isTextMarkup(a.kind) && a.quadPoints.length >= 8) return <path d={quadsPath(a.quadPoints)} {...common} />;
  if (a.kind === "ink") {
    return (
      <g {...common} style={{ fill: "none" }}>
        {a.inkList.map((s, i) => (
          <path key={i} d={inkPath(s)} style={{ strokeWidth: Math.max(10, a.borderWidth), strokeLinecap: "round", stroke: "transparent", vectorEffect: "non-scaling-stroke" }} />
        ))}
      </g>
    );
  }
  if (a.kind === "line" && a.line) {
    return (
      <line
        x1={a.line[0]}
        y1={a.line[1]}
        x2={a.line[2]}
        y2={a.line[3]}
        {...common}
        style={{ strokeWidth: 12, stroke: "transparent", vectorEffect: "non-scaling-stroke" }}
      />
    );
  }
  if (a.kind === "polyline" && a.vertices.length >= 4) {
    const points = a.vertices.reduce((s, v, i) => s + (i % 2 === 0 ? `${v},` : `${v} `), "");
    return <polyline points={points} {...common} style={{ fill: "none", strokeWidth: 12, stroke: "transparent", vectorEffect: "non-scaling-stroke" }} />;
  }
  const r = normalizeRect(a.rect);
  return <rect x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]} {...common} />;
}

function Outline({ a, hover }: { a: Annotation; hover?: boolean }) {
  const cls = `annot-outline${hover ? " hover" : ""}`;
  if (isTextMarkup(a.kind) && a.quadPoints.length >= 8) return <path d={quadsPath(a.quadPoints)} className={cls} />;
  const r = normalizeRect(a.rect);
  return <rect x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]} className={cls} />;
}

interface OverlayProps {
  c: DocumentController;
  pageNumber: number;
  layers: PageLayers;
}

function PageOverlayImpl({ c, pageNumber, layers }: OverlayProps) {
  const geom = usePageGeometry(c, pageNumber);
  const pageIndex = pageNumber - 1;
  const ids = useAnnotState(c, (s) => s.byPage[pageIndex] ?? EMPTY, EMPTY);
  const items = useAnnotState(c, (s) => s.items, {} as Record<string, Annotation>);
  const pristine = useAnnotState(c, (s) => s.pristine, {} as Record<string, Annotation>);
  const preview = useAnnotState(c, (s) => s.preview, null);
  const selection = useAnnotState(c, (s) => s.selection, EMPTY, shallowEqual);
  const hover = useAnnotState(c, (s) => s.hover, null);
  const editing = useAnnotState(c, (s) => s.editing, null);
  const tool = useDocState(c, (s) => s.tool, "select");
  const payload = useDocState(c, (s) => s.payload, null);
  const uiSvg = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const [pendingText, setPendingText] = useState<Annotation | null>(null);
  const rafRef = useRef(0);

  const updateDraft = (d: Draft | null) => {
    draftRef.current = d;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => setDraft(draftRef.current));
  };

  // Cancel drafts when the tool changes.
  useEffect(() => {
    draftRef.current = null;
    setDraft(null);
  }, [tool]);

  const toPdf = useCallback(
    (clientX: number, clientY: number): Point => {
      const svg = uiSvg.current;
      if (!svg || !geom) return [0, 0];
      const r = svg.getBoundingClientRect();
      const x = ((clientX - r.left) / r.width) * geom.width;
      const y = ((clientY - r.top) / r.height) * geom.height;
      const [px, py] = geom.vp.convertToPdfPoint(x, y);
      return [px, py];
    },
    [geom],
  );

  const annotations = useMemo(() => {
    const list: Annotation[] = [];
    for (const id of ids) {
      const a = preview?.[id] ?? items[id];
      if (a && !isReply(a)) list.push(a);
    }
    return list;
  }, [ids, items, preview]);

  const state = { items, pristine } as Parameters<typeof drawnByApp>[0];
  const appDrawn = annotations.filter((a) => (preview?.[a.id] ? true : drawnByApp(state, a)) && a.id !== pendingText?.id);

  // ---------------------------------------------------------------- interactions: selection

  /** Latest drag geometry, kept synchronously (rendering of the preview is rAF-throttled). */
  const dragPreview = useRef<Record<string, Annotation> | null>(null);

  const finishDrag = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    const pv = dragPreview.current;
    dragPreview.current = null;
    c.annotations.setState({ preview: null });
    if (!d || !d.moved || !pv) return;
    const st = c.annotations.getState();
    const changes: Change[] = [];
    for (const [id, after] of Object.entries(pv)) {
      const before = st.items[id];
      if (before) changes.push({ id, before, after: { ...after, modified: nowIso() } });
    }
    if (!changes.length) return;
    const kind = t(kindLabelKey(changes[0].before!));
    c.commit(d.mode === "move" ? t("history.move", { kind }) : t("history.resize", { kind }), changes);
  }, [c]);

  const beginDrag = (e: React.PointerEvent, next: Drag) => {
    e.stopPropagation();
    e.preventDefault();
    capturePointer(e.target, e.pointerId);
    drag.current = next;
    dragPreview.current = null;
    const startClient: Point = [e.clientX, e.clientY];
    const onMove = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (!d.moved && Math.hypot(ev.clientX - startClient[0], ev.clientY - startClient[1]) < 3) return;
      d.moved = true;
      const p = toPdf(ev.clientX, ev.clientY);
      const st = c.annotations.getState();
      const pv: Record<string, Annotation> = {};
      if (d.mode === "move") {
        const dx = p[0] - d.start[0];
        const dy = p[1] - d.start[1];
        for (const id of d.ids) {
          const a = st.items[id];
          if (a && canMove(a)) pv[id] = translateAnnotation(a, dx, dy);
        }
      } else if (d.mode === "resize") {
        const a = st.items[d.id];
        if (a) {
          const rect = resizeRect(d.origin, d.handle, p, d.keepAspect !== ev.shiftKey);
          pv[d.id] = resizeAnnotation(a, rect);
        }
      } else {
        const a = st.items[d.id];
        if (a) {
          let next: Annotation;
          if (a.kind === "line" && a.line) {
            const line = [...a.line] as [number, number, number, number];
            const other: Point = d.index === 0 ? [line[2], line[3]] : [line[0], line[1]];
            const q = ev.shiftKey ? snapAngle(other, p) : p;
            line[d.index * 2] = q[0];
            line[d.index * 2 + 1] = q[1];
            next = { ...a, line };
          } else {
            const vertices = [...a.vertices];
            vertices[d.index * 2] = p[0];
            vertices[d.index * 2 + 1] = p[1];
            next = { ...a, vertices };
          }
          pv[d.id] = { ...next, rect: fitRect(next) };
        }
      }
      dragPreview.current = pv;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => c.annotations.setState({ preview: dragPreview.current }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      cancelAnimationFrame(rafRef.current);
      finishDrag();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onHitDown = (e: React.PointerEvent, a: Annotation) => {
    if (e.button !== 0) return;
    if (tool !== "select" && tool !== "hand") return;
    const cur = c.annotations.getState().selection;
    let nextSel: string[];
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      nextSel = cur.includes(a.id) ? cur.filter((id) => id !== a.id) : [...cur, a.id];
    } else {
      nextSel = cur.includes(a.id) ? cur : [a.id];
    }
    c.select(nextSel);
    window.getSelection()?.removeAllRanges();
    const movable = nextSel.map((id) => c.getAnnotation(id)).filter((x): x is Annotation => !!x && canMove(x));
    if (movable.length && c.canAnnotate) {
      beginDrag(e, { mode: "move", ids: movable.map((x) => x.id), start: toPdf(e.clientX, e.clientY), moved: false });
    } else {
      e.stopPropagation();
    }
  };

  const onHitDouble = (a: Annotation) => {
    if (a.locked) return;
    c.setEditing(a.id);
  };

  // ---------------------------------------------------------------- interactions: creation tools

  const author = c.author();
  const create = (a: Annotation | null, opts: { edit?: boolean } = {}) => {
    if (!a) return;
    c.addAnnotation(a, { select: true, edit: opts.edit });
    c.toolDone();
  };

  const placeWithPayload = (rect: Rect | null, at: Point) => {
    if (!payload) return;
    const s = settings();
    let a: Annotation | null;
    if (payload.type === "textStamp") {
      const [w, h] = stampSize(payload.label, !!payload.sublabel);
      const r = rect ?? [at[0] - w / 2, at[1] - h / 2, at[0] + w / 2, at[1] + h / 2];
      a = createStyled("stamp", pageIndex, r, s, author);
      if (a) {
        a.stampLabel = payload.label;
        a.stampSublabel = payload.sublabel;
        a.color = [parseInt(payload.color.slice(1, 3), 16) / 255, parseInt(payload.color.slice(3, 5), 16) / 255, parseInt(payload.color.slice(5, 7), 16) / 255];
        a.subject = payload.label;
      }
    } else {
      const maxW = payload.isSignature ? 180 : 280;
      const maxH = payload.isSignature ? 80 : 280;
      let w: number;
      let h: number;
      if (rect && rect[2] - rect[0] > 8) {
        w = rect[2] - rect[0];
        h = (w * payload.image.height) / payload.image.width;
      } else {
        [w, h] = fitImage(payload.image, maxW, maxH);
      }
      const x = rect ? rect[0] : at[0] - w / 2;
      const y = rect ? rect[3] - h : at[1] - h / 2;
      a = createStyled(payload.isSignature ? "signature" : "image", pageIndex, [x, y, x + w, y + h], s, author);
      if (a) {
        a.stampImage = payload.image;
        a.subject = payload.isSignature ? t("kind.signature") : null;
      }
    }
    create(a);
  };

  const finishPoly = useCallback(() => {
    const d = draftRef.current;
    if (!d || d.kind !== "poly") return;
    updateDraft(null);
    const minPoints = d.tool === "polygon" ? 6 : 4;
    if (d.points.length < minPoints) return;
    const a = createStyled(d.tool, pageIndex, [0, 0, 0, 0], settings(), author);
    if (!a) return;
    a.vertices = d.points;
    a.rect = fitRect(a);
    create(a);
  }, [pageIndex, author]);

  // Enter / Esc / Backspace while drawing polygons.
  useEffect(() => {
    if (tool !== "polygon" && tool !== "polyline") return;
    const onKey = (e: KeyboardEvent) => {
      const d = draftRef.current;
      if (!d || d.kind !== "poly") return;
      if (e.key === "Enter") finishPoly();
      else if (e.key === "Escape") updateDraft(null);
      else if (e.key === "Backspace") updateDraft({ ...d, points: d.points.slice(0, -2) });
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [tool, finishPoly]);

  const eraseAt = (p: Point, erased: Record<string, number[][]>) => {
    const radius = 8 / (geom?.pxPerUnit ?? 1);
    const st = c.annotations.getState();
    for (const id of st.byPage[pageIndex] ?? []) {
      const a = st.items[id];
      if (!a || a.kind !== "ink" || a.locked || !a.editable) continue;
      const strokes = erased[id] ?? a.inkList;
      const keep = strokes.filter((s) => distanceToPolyline(p[0], p[1], s) > radius + a.borderWidth / 2);
      if (keep.length !== strokes.length) erased[id] = keep;
    }
  };

  const onLayerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !capturesPointer(tool) || (tool !== "snapshot" && !c.canAnnotate)) return;
    if ((e.target as Element).closest(".annot-freetext-editor")) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as Element;
    capturePointer(target, e.pointerId);
    const p = toPdf(e.clientX, e.clientY);
    const startClient: Point = [e.clientX, e.clientY];

    if (tool === "polygon" || tool === "polyline") {
      const d = draftRef.current;
      if (d && d.kind === "poly") {
        // Double click (two clicks on the same spot) finishes.
        const n = d.points.length;
        const near = n >= 2 && Math.hypot(d.points[n - 2] - p[0], d.points[n - 1] - p[1]) * (geom?.pxPerUnit ?? 1) < 5;
        if (near || e.detail >= 2) finishPoly();
        else updateDraft({ ...d, points: [...d.points, p[0], p[1]] });
      } else {
        updateDraft({ kind: "poly", tool, points: [p[0], p[1]], hover: null });
      }
      return;
    }

    if (tool === "note") {
      const a = createStyled("note", pageIndex, [p[0] - 10, p[1] - 10, p[0] + 10, p[1] + 10], settings(), author);
      create(a, { edit: settings().annotations.openCommentAfterCreate });
      return;
    }

    let current: Draft | null =
      tool === "ink"
        ? { kind: "ink", points: [p[0], p[1]] }
        : tool === "eraser"
          ? { kind: "erase", point: p, erased: {} }
          : tool === "line" || tool === "arrow"
            ? { kind: "line", tool, start: p, end: p }
            : { kind: "rect", tool, start: p, end: p };
    if (current.kind === "erase") eraseAt(p, current.erased);
    updateDraft(current);

    const onMove = (ev: PointerEvent) => {
      if (!current) return;
      const q = toPdf(ev.clientX, ev.clientY);
      if (current.kind === "ink") {
        const pts = current.points;
        const lastX = pts[pts.length - 2];
        const lastY = pts[pts.length - 1];
        if (Math.hypot(q[0] - lastX, q[1] - lastY) * (geom?.pxPerUnit ?? 1) < 1.2) return;
        current = { kind: "ink", points: [...pts, q[0], q[1]] };
      } else if (current.kind === "erase") {
        const erased = { ...current.erased };
        eraseAt(q, erased);
        current = { kind: "erase", point: q, erased };
      } else if (current.kind === "line") {
        current = { ...current, end: ev.shiftKey ? snapAngle(current.start, q) : q };
      } else if (current.kind === "rect") {
        current = { ...current, end: q };
      }
      updateDraft(current);
      if (current.kind === "erase") {
        const st = c.annotations.getState();
        const pv: Record<string, Annotation> = {};
        for (const [id, strokes] of Object.entries(current.erased)) {
          const a = st.items[id];
          if (a) pv[id] = { ...a, inkList: strokes };
        }
        c.annotations.setState({ preview: pv });
      }
    };

    // Esc abandons a rectangle or line that is being dragged out.
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !current || (current.kind !== "rect" && current.kind !== "line")) return;
      ev.preventDefault();
      ev.stopPropagation();
      stop();
      current = null;
      updateDraft(null);
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey, true);
    };

    const onUp = (ev: PointerEvent) => {
      stop();
      const d = current;
      current = null;
      updateDraft(null);
      if (!d) return;
      const s = settings();
      const clickOnly = Math.hypot(ev.clientX - startClient[0], ev.clientY - startClient[1]) < 4;
      const q = toPdf(ev.clientX, ev.clientY);
      switch (d.kind) {
        case "ink": {
          const eps = 0.6 / (geom?.pxPerUnit ?? 1);
          const smoothed = smoothPoints(d.points, s.tools.ink.smoothing);
          c.addInkStroke(pageIndex, simplify(smoothed, eps));
          break;
        }
        case "erase": {
          c.annotations.setState({ preview: null });
          const st = c.annotations.getState();
          const changes: Change[] = [];
          for (const [id, strokes] of Object.entries(d.erased)) {
            const before = st.items[id];
            if (!before) continue;
            if (!strokes.length) changes.push({ id, before, after: null });
            else {
              const after = { ...before, inkList: strokes, modified: nowIso() };
              changes.push({ id, before, after: { ...after, rect: fitRect(after) } });
            }
          }
          if (changes.length) c.commit(t("history.erase"), changes);
          break;
        }
        case "line": {
          if (clickOnly) break;
          const a = createStyled(d.tool, pageIndex, [0, 0, 0, 0], s, author);
          if (!a) break;
          a.line = [d.start[0], d.start[1], d.end[0], d.end[1]];
          a.rect = lineRect(a.line, a.borderWidth, a.lineEndings);
          create(a);
          break;
        }
        case "rect": {
          const rect = clickOnly ? null : rectFromPoints(d.start, d.end, ev.shiftKey && d.tool !== "freetext");
          if (d.tool === "snapshot") {
            // One-shot: leave snapshot mode as soon as a region was chosen.
            if (rect) {
              const purpose = c.state.snapshotPurpose;
              c.endSnapshot();
              void (purpose === "ocr" ? c.recognizeRegionText(pageIndex, rect) : c.copyRegionImage(pageIndex, rect));
            }
            break;
          }
          if (d.tool === "stamp" || d.tool === "signature" || d.tool === "image") {
            placeWithPayload(rect, q);
            break;
          }
          if (d.tool === "freetext") {
            const fs = s.tools.freetext.fontSize;
            const r: Rect = rect && rect[2] - rect[0] > 12 ? rect : [q[0], q[1] - fs * 1.4 - 6, q[0] + 200, q[1]];
            const a = createStyled("freetext", pageIndex, r, s, author);
            if (a) {
              setPendingText(a);
              c.select([]);
            }
            break;
          }
          const r: Rect = rect ?? [q[0] - 50, q[1] - 35, q[0] + 50, q[1] + 35];
          create(createStyled(d.tool, pageIndex, r, s, author));
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey, true);
  };

  const onLayerMove = (e: React.PointerEvent) => {
    const d = draftRef.current;
    if (d && d.kind === "poly") updateDraft({ ...d, hover: toPdf(e.clientX, e.clientY) });
  };

  // ---------------------------------------------------------------- inline free text editing

  const editingAnnotation =
    pendingText ?? (editing && items[editing]?.kind === "freetext" && items[editing]?.page === pageIndex ? items[editing] : null);

  const finishText = useCallback(
    (text: string, rect: Rect) => {
      if (pendingText) {
        const a = pendingText;
        setPendingText(null);
        if (text.trim()) {
          c.addAnnotation({ ...a, contents: text, rect }, { select: true });
          c.toolDone();
        }
        return;
      }
      const id = c.annotations.getState().editing;
      const a = id ? c.getAnnotation(id) : null;
      c.setEditing(null);
      if (!a) return;
      if (!text.trim()) c.deleteAnnotations([a.id]);
      else if (text !== a.contents || rect[1] !== a.rect[1]) c.updateAnnotation(a.id, { contents: text, rect });
    },
    [c, pendingText],
  );

  if (!geom) return null;

  const svgProps = {
    viewBox: `0 0 ${geom.width} ${geom.height}`,
    preserveAspectRatio: "none" as const,
  };
  const handleSize = (settings().accessibility.largeHandles ? 13 : 8) / geom.pxPerUnit;
  const selected = selection.map((id) => preview?.[id] ?? items[id]).filter((a): a is Annotation => !!a && a.page === pageIndex);
  const hovered = hover && !selection.includes(hover) ? (items[hover]?.page === pageIndex ? items[hover] : null) : null;
  const single = selected.length === 1 ? selected[0] : null;
  const showHandles = !!single && single.editable && !single.locked && c.canAnnotate && tool === "select";

  return (
    <>
      {createPortal(
        <svg {...svgProps}>
          <g transform={geom.transform}>
            {appDrawn.map((a) => (
              <MarkupShape key={a.id} a={a} />
            ))}
          </g>
        </svg>,
        layers.markup,
      )}
      {createPortal(
        <svg {...svgProps}>
          <g transform={geom.transform}>
            {appDrawn.map((a) => (
              <ContentShape key={a.id} a={a} hideText={editingAnnotation?.id === a.id} />
            ))}
          </g>
        </svg>,
        layers.content,
      )}
      {createPortal(
        <svg
          {...svgProps}
          ref={uiSvg}
          style={{ pointerEvents: capturesPointer(tool) ? "all" : "none" }}
          onPointerDown={onLayerDown}
          onPointerMove={onLayerMove}
        >
          <g transform={geom.transform}>
            {annotations.map((a) =>
              a.hidden ? null : (
                <HitShape
                  key={a.id}
                  a={a}
                  onDown={onHitDown}
                  onDouble={onHitDouble}
                  onEnter={(x) => c.setHover(x.id)}
                  onLeave={() => c.setHover(null)}
                />
              ),
            )}
            {hovered && <Outline a={hovered} hover />}
            {selected.map((a) => (
              <Outline key={a.id} a={a} />
            ))}
            {showHandles && single && <SelectionHandles a={single} size={handleSize} beginDrag={beginDrag} toPdf={toPdf} />}
            {draft && !(draft.kind === "rect" && draft.tool === "snapshot") && <DraftShape draft={draft} pxPerUnit={geom.pxPerUnit} />}
            {editingAnnotation && (
              <FreeTextEditor key={editingAnnotation.id} a={editingAnnotation} pxPerUnit={geom.pxPerUnit} onDone={finishText} />
            )}
          </g>
          {tool === "snapshot" && (
            <SnapshotShade c={c} pageNumber={pageNumber} geom={geom} region={draft?.kind === "rect" && draft.tool === "snapshot" ? draft : null} />
          )}
        </svg>,
        layers.ui,
      )}
    </>
  );
}

function SelectionHandles({
  a,
  size,
  beginDrag,
  toPdf,
}: {
  a: Annotation;
  size: number;
  beginDrag: (e: React.PointerEvent, d: Drag) => void;
  toPdf: (x: number, y: number) => Point;
}) {
  const r = normalizeRect(a.rect);
  const vertexHandles =
    a.kind === "line" && a.line
      ? [
          [a.line[0], a.line[1]],
          [a.line[2], a.line[3]],
        ]
      : a.kind === "polygon" || a.kind === "polyline"
        ? Array.from({ length: a.vertices.length / 2 }, (_, i) => [a.vertices[i * 2], a.vertices[i * 2 + 1]])
        : [];
  const handles: [Handle, number, number, string][] = canResize(a)
    ? [
        ["nw", r[0], r[3], "nwse"],
        ["n", (r[0] + r[2]) / 2, r[3], "ns"],
        ["ne", r[2], r[3], "nesw"],
        ["e", r[2], (r[1] + r[3]) / 2, "ew"],
        ["se", r[2], r[1], "nwse"],
        ["s", (r[0] + r[2]) / 2, r[1], "ns"],
        ["sw", r[0], r[1], "nesw"],
        ["w", r[0], (r[1] + r[3]) / 2, "ew"],
      ]
    : [];
  const keepAspect = a.kind === "stamp";
  return (
    <g>
      {handles.map(([h, x, y, cursor]) => (
        <rect
          key={h}
          className={`annot-handle ${cursor}`}
          x={x - size / 2}
          y={y - size / 2}
          width={size}
          height={size}
          rx={size / 4}
          onPointerDown={(e) => beginDrag(e, { mode: "resize", id: a.id, handle: h, start: toPdf(e.clientX, e.clientY), origin: r, keepAspect, moved: false })}
        />
      ))}
      {vertexHandles.map(([x, y], i) => (
        <circle
          key={`v${i}`}
          className="annot-handle vertex"
          cx={x}
          cy={y}
          r={size / 2}
          onPointerDown={(e) => beginDrag(e, { mode: "vertex", id: a.id, index: i, start: toPdf(e.clientX, e.clientY), moved: false })}
        />
      ))}
    </g>
  );
}

/**
 * Snapshot mode: the whole page is dimmed; the region being dragged out is cut out of the
 * shade (shown at full brightness) and labelled with the output size in pixels.
 */
function SnapshotShade({ c, pageNumber, geom, region: drag }: { c: DocumentController; pageNumber: number; geom: Geometry; region: { start: Point; end: Point } | null }) {
  const page = `M0 0H${geom.width}V${geom.height}H0Z`;
  if (!drag) {
    return (
      <g className="snapshot-marquee">
        <path className="snapshot-dim" d={page} />
      </g>
    );
  }
  const { start, end } = drag;
  const clampX = (v: number) => Math.min(Math.max(v, 0), geom.width);
  const clampY = (v: number) => Math.min(Math.max(v, 0), geom.height);
  const [ax, ay] = geom.vp.convertToViewportPoint(start[0], start[1]);
  const [bx, by] = geom.vp.convertToViewportPoint(end[0], end[1]);
  const x = clampX(Math.min(ax, bx));
  const y = clampY(Math.min(ay, by));
  const w = clampX(Math.max(ax, bx)) - x;
  const h = clampY(Math.max(ay, by)) - y;
  const region = clampToPage(rectFromPoints(start, end), geom.vp.viewBox);
  const size = region ? snapshotSize(region, snapshotScale(c, pageNumber)) : null;
  const unit = 1 / geom.pxPerUnit;
  const label = size ? t("snapshot.size", { width: size.width, height: size.height }) : "";
  const labelWidth = [...label].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 11.5 : 6.6), 14);
  // Label below the selection, or inside it when there is no room under it.
  const below = y + h + 24 * unit <= geom.height;
  return (
    <g className="snapshot-marquee">
      <path className="snapshot-dim" fillRule="evenodd" d={`${page} M${x} ${y}h${w}v${h}h${-w}Z`} />
      <rect className="marquee snapshot-frame" x={x} y={y} width={w} height={h} />
      {label && w * geom.pxPerUnit > 24 && (
        <g transform={`translate(${x + w} ${below ? y + h + 4 * unit : y + h - 22 * unit}) scale(${unit})`}>
          <rect className="snapshot-size-bg" x={-labelWidth} y={0} width={labelWidth} height={18} rx={4} />
          <text className="snapshot-size" x={-labelWidth / 2} y={13} textAnchor="middle">
            {label}
          </text>
        </g>
      )}
    </g>
  );
}

function DraftShape({ draft, pxPerUnit }: { draft: Draft; pxPerUnit: number }) {
  const s = settings().tools;
  switch (draft.kind) {
    case "ink":
      return (
        <path
          className="draft-shape"
          d={inkPath(draft.points)}
          fill="none"
          stroke={s.ink.color}
          strokeWidth={s.ink.width}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={s.ink.opacity}
        />
      );
    case "rect": {
      const r = rectFromPoints(draft.start, draft.end);
      if (draft.tool === "circle") {
        return (
          <ellipse
            className="draft-shape"
            cx={(r[0] + r[2]) / 2}
            cy={(r[1] + r[3]) / 2}
            rx={(r[2] - r[0]) / 2}
            ry={(r[3] - r[1]) / 2}
            fill={s.shape.fill ?? "none"}
            stroke={s.shape.color}
            strokeWidth={s.shape.width}
            opacity={s.shape.opacity}
          />
        );
      }
      if (draft.tool === "square") {
        return (
          <rect
            className="draft-shape"
            x={r[0]}
            y={r[1]}
            width={r[2] - r[0]}
            height={r[3] - r[1]}
            fill={s.shape.fill ?? "none"}
            stroke={s.shape.color}
            strokeWidth={s.shape.width}
            opacity={s.shape.opacity}
          />
        );
      }
      return <rect className="marquee" x={r[0]} y={r[1]} width={r[2] - r[0]} height={r[3] - r[1]} />;
    }
    case "line":
      return (
        <line
          className="draft-shape"
          x1={draft.start[0]}
          y1={draft.start[1]}
          x2={draft.end[0]}
          y2={draft.end[1]}
          stroke={s.line.color}
          strokeWidth={s.line.width}
          strokeLinecap="round"
        />
      );
    case "poly": {
      const pts = [...draft.points, ...(draft.hover ?? [])];
      const points = pts.reduce((acc, v, i) => acc + (i % 2 === 0 ? `${v},` : `${v} `), "");
      const color = draft.tool === "polygon" ? s.shape.color : s.line.color;
      return (
        <g className="draft-shape">
          {draft.tool === "polygon" ? (
            <polygon points={points} fill={s.shape.fill ?? "none"} stroke={color} strokeWidth={s.shape.width} strokeLinejoin="round" />
          ) : (
            <polyline points={points} fill="none" stroke={color} strokeWidth={s.line.width} strokeLinejoin="round" />
          )}
          {Array.from({ length: draft.points.length / 2 }, (_, i) => (
            <circle key={i} cx={draft.points[i * 2]} cy={draft.points[i * 2 + 1]} r={3 / pxPerUnit} fill={color} />
          ))}
        </g>
      );
    }
    case "erase":
      return <circle className="eraser-cursor" cx={draft.point[0]} cy={draft.point[1]} r={8 / pxPerUnit} />;
    default:
      return null;
  }
}

/** Inline editor for free text annotations; grows downwards as the text gets longer. */
function FreeTextEditor({ a, pxPerUnit, onDone }: { a: Annotation; pxPerUnit: number; onDone: (text: string, rect: Rect) => void }) {
  const [text, setText] = useState(a.contents);
  const [rect, setRect] = useState<Rect>(normalizeRect(a.rect));
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const finish = () => {
    if (done.current) return;
    done.current = true;
    onDone(text, rect);
  };

  // Grow the box when the text overflows.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const neededPx = el.scrollHeight;
    const currentPx = (rect[3] - rect[1]) * pxPerUnit;
    if (neededPx > currentPx + 1) setRect([rect[0], rect[3] - neededPx / pxPerUnit, rect[2], rect[3]]);
  }, [text, pxPerUnit, rect]);

  const shown: Annotation = { ...a, rect };
  return (
    <FreeTextBox a={{ ...shown, interiorColor: shown.interiorColor ?? [1, 1, 1], opacity: 1 }}>
      <textarea
        ref={ref}
        className="annot-freetext-editor"
        value={text}
        placeholder={t("freetext.placeholder")}
        style={{ fontSize: `${a.fontSize}px`, color: rgbToCss(a.fontColor, "#000"), textAlign: a.textAlign }}
        onChange={(e) => setText(e.target.value)}
        onBlur={finish}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
            e.preventDefault();
            finish();
          }
        }}
      />
    </FreeTextBox>
  );
}

export const PageOverlay = memo(PageOverlayImpl);

/** Create a blank note programmatically (context menu "Add note here"). */
export function noteAt(page: number, x: number, y: number, author: string): Annotation {
  const rect: Rect = [x - 10, y - 10, x + 10, y + 10];
  return createStyled("note", page, rect, settings(), author) ?? blankAnnotation("note", page, rect);
}
