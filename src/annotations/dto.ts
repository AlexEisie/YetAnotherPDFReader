/**
 * TypeScript mirror of `crates/yapr-pdf/src/dto.rs` — the wire format between the annotation
 * model and the Rust PDF writer. Keep both files in sync.
 *
 * All geometry is in PDF user space of the unrotated page (origin bottom-left, y up).
 */

export type Rgb = [number, number, number];
export type Rect = [number, number, number, number];

export type AnnotKind =
  | "highlight"
  | "underline"
  | "strikeout"
  | "squiggly"
  | "note"
  | "freetext"
  | "ink"
  | "square"
  | "circle"
  | "line"
  | "polygon"
  | "polyline"
  | "stamp";

export type BorderStyle = "solid" | "dashed" | "cloudy";

export type LineEnding =
  | "None"
  | "Square"
  | "Circle"
  | "Diamond"
  | "OpenArrow"
  | "ClosedArrow"
  | "Butt"
  | "ROpenArrow"
  | "RClosedArrow"
  | "Slash";

export type TextAlign = "left" | "center" | "right";

export interface StampImageDto {
  /** Index into the request's image blobs (0 = first image). */
  blob: number;
  width: number;
  height: number;
}

export interface AnnotationDto {
  kind: AnnotKind;
  pageIndex: number;
  rect: Rect;
  color?: Rgb | null;
  interiorColor?: Rgb | null;
  opacity?: number;
  borderWidth?: number;
  borderStyle?: BorderStyle;
  dash?: number[];
  contents?: string;
  author?: string;
  subject?: string | null;
  nm?: string;
  created?: string | null;
  modified?: string | null;
  hidden?: boolean;
  print?: boolean;
  locked?: boolean;
  quadPoints?: number[];
  inkList?: number[][];
  vertices?: number[];
  line?: [number, number, number, number] | null;
  lineEndings?: [LineEnding, LineEnding];
  icon?: string | null;
  fontSize?: number;
  fontColor?: Rgb | null;
  textAlign?: TextAlign;
  stampLabel?: string | null;
  stampSublabel?: string | null;
  stampImage?: StampImageDto | null;
  inReplyToRef?: string | null;
  inReplyToNm?: string | null;
  state?: string | null;
  stateModel?: string | null;
  open?: boolean;
}

export interface AnnotationModify {
  ref: string;
  annotation: AnnotationDto;
  regenerateAppearance: boolean;
}

export interface AnnotationChanges {
  add: AnnotationDto[];
  modify: AnnotationModify[];
  delete: string[];
}

export interface InfoUpdate {
  title?: string | null;
  author?: string | null;
  subject?: string | null;
  keywords?: string | null;
  creator?: string | null;
}

export interface DocumentChanges {
  annotations: AnnotationChanges;
  info?: InfoUpdate | null;
  cjkHint?: string | null;
  modDate?: string | null;
}

export interface ExistingAnnotation {
  ref: string;
  pageIndex: number;
  subtype: string;
  annotation: AnnotationDto | null;
  rect: Rect;
  hasAppearance: boolean;
  popupRef: string | null;
  inReplyToRef: string | null;
  replyType: string | null;
  flags: number;
  contents: string;
  author: string;
  modified: string | null;
}

export type PageOp =
  | { op: "rotate"; pages: number[]; delta: number }
  | { op: "delete"; pages: number[] }
  | { op: "reorder"; order: number[] }
  | { op: "insertBlank"; at: number; count: number; width: number; height: number }
  | { op: "insertFromBlob"; at: number; blob: number; password?: string | null; pages?: number[] | null }
  | { op: "insertImages"; at: number; images: PageImage[]; pageSize?: [number, number] | null; margin?: number }
  | { op: "flip"; pages: number[]; horizontal: boolean }
  | { op: "duplicate"; pages: number[]; at: number }
  | { op: "watermark"; pages: number[]; watermark: WatermarkSpec };

/** A picture in a request blob: a JPEG file as is, or RGBA8 pixels (top row first). */
export interface PageImage {
  blob: number;
  format: "jpeg" | "rgba";
  width: number;
  height: number;
}

export type WatermarkPosition =
  | "center"
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "topLeft"
  | "topRight"
  | "bottomLeft"
  | "bottomRight"
  | "tile";

export interface WatermarkSpec {
  text: string | null;
  fontSize: number;
  bold: boolean;
  color: Rgb;
  image: PageImage | null;
  /** Picture width as a fraction of the page width. */
  imageScale: number;
  opacity: number;
  /** Counter-clockwise, degrees. */
  rotation: number;
  position: WatermarkPosition;
  layer: "above" | "below";
  cjkHint: string | null;
}

export interface DocumentPermissions {
  print: boolean;
  printHighQuality: boolean;
  copy: boolean;
  modify: boolean;
  annotate: boolean;
  fillForms: boolean;
  assemble: boolean;
}

export interface SecuritySettings {
  openPassword: string;
  permissionsPassword: string;
  permissions: DocumentPermissions;
}

export interface SecurityInfo {
  encrypted: boolean;
  method: string | null;
  openPassword: boolean;
  restricted: boolean;
  permissions: DocumentPermissions;
  ownerAccess: boolean;
}

export function emptyChanges(): DocumentChanges {
  return { annotations: { add: [], modify: [], delete: [] } };
}

export function hasChanges(c: DocumentChanges): boolean {
  const a = c.annotations;
  return a.add.length > 0 || a.modify.length > 0 || a.delete.length > 0 || !!c.info;
}

/** A font used by the document (`yapr_pdf::DocumentFont`). */
export interface DocumentFont {
  name: string;
  subset: boolean;
  kind: string;
  encoding: string | null;
  embedded: boolean;
  firstPage: number;
  pageCount: number;
}
