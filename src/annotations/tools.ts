/**
 * Annotation tools and the default styles they create annotations with.
 */
import type { LineEnding } from "./dto";
import { blankAnnotation, hexToRgb, type Annotation, type ModelKind, type Rect, type StampImage } from "./model";
import type { Settings } from "../settings/defaults";

export type ToolId =
  | "select"
  | "hand"
  | "note"
  | "highlight"
  | "underline"
  | "strikeout"
  | "squiggly"
  | "freetext"
  | "ink"
  | "eraser"
  | "square"
  | "circle"
  | "line"
  | "arrow"
  | "polygon"
  | "polyline"
  | "stamp"
  | "signature"
  | "image"
  | "snapshot";

export const MARKUP_TOOLS: ReadonlySet<ToolId> = new Set(["highlight", "underline", "strikeout", "squiggly"]);
export const DRAWING_TOOLS: ReadonlySet<ToolId> = new Set([
  "note",
  "freetext",
  "ink",
  "eraser",
  "square",
  "circle",
  "line",
  "arrow",
  "polygon",
  "polyline",
  "stamp",
  "signature",
  "image",
  "snapshot",
]);

export function isMarkupTool(tool: ToolId): tool is "highlight" | "underline" | "strikeout" | "squiggly" {
  return MARKUP_TOOLS.has(tool);
}

/** Tools that capture pointer input on the page (instead of letting text selection through). */
export function capturesPointer(tool: ToolId): boolean {
  return DRAWING_TOOLS.has(tool);
}

/** What a placement tool (stamp / signature / image) puts on the page. */
export type PlacementPayload =
  | { type: "textStamp"; label: string; sublabel: string | null; color: string; name: string }
  | { type: "image"; image: StampImage; isSignature: boolean };

export interface ToolState {
  tool: ToolId;
  payload: PlacementPayload | null;
}

export function toolKind(tool: ToolId): ModelKind | null {
  switch (tool) {
    case "note":
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly":
    case "freetext":
    case "ink":
    case "square":
    case "circle":
    case "line":
    case "polygon":
    case "polyline":
      return tool;
    case "arrow":
      return "line";
    case "stamp":
    case "signature":
    case "image":
      return "stamp";
    default:
      return null;
  }
}

/** Create a new annotation for `tool` styled with the user's defaults. */
export function createStyled(
  tool: ToolId,
  page: number,
  rect: Rect,
  settings: Settings,
  author: string,
): Annotation | null {
  const kind = toolKind(tool);
  if (!kind) return null;
  const t = settings.tools;
  const a = blankAnnotation(kind, page, rect);
  a.author = author;
  switch (tool) {
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly": {
      const d = t[tool];
      a.color = hexToRgb(d.color);
      a.opacity = d.opacity;
      break;
    }
    case "note":
      a.color = hexToRgb(t.note.color);
      a.icon = t.note.icon;
      break;
    case "freetext":
      a.color = hexToRgb(t.freetext.borderColor);
      a.borderWidth = t.freetext.borderColor ? t.freetext.borderWidth : 0;
      a.interiorColor = hexToRgb(t.freetext.fill);
      a.fontSize = t.freetext.fontSize;
      a.fontColor = hexToRgb(t.freetext.fontColor);
      break;
    case "ink":
      a.color = hexToRgb(t.ink.color);
      a.borderWidth = t.ink.width;
      a.opacity = t.ink.opacity;
      break;
    case "square":
    case "circle":
    case "polygon":
      a.color = hexToRgb(t.shape.color);
      a.borderWidth = t.shape.width;
      a.interiorColor = hexToRgb(t.shape.fill);
      a.opacity = t.shape.opacity;
      a.borderStyle = t.shape.borderStyle;
      a.dash = t.shape.borderStyle === "dashed" ? [3, 3] : [];
      break;
    case "polyline":
    case "line":
    case "arrow": {
      a.color = hexToRgb(t.line.color);
      a.borderWidth = t.line.width;
      a.opacity = t.line.opacity;
      const end: LineEnding = tool === "arrow" ? (t.line.endEnding === "None" ? "OpenArrow" : t.line.endEnding) : t.line.endEnding;
      a.lineEndings = [tool === "arrow" ? "None" : t.line.startEnding, end];
      break;
    }
    case "stamp":
    case "signature":
    case "image":
      a.color = hexToRgb(t.stamp.color);
      a.borderWidth = 0;
      break;
    default:
      break;
  }
  return a;
}
