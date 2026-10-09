/**
 * Turn the annotation model into the change set understood by the Rust writer. The diff is
 * always computed against the pristine snapshot (the annotations stored in the base bytes).
 */
import type { AnnotationChanges, DocumentChanges, InfoUpdate } from "./dto";
import { annotationChanged, isTextMarkup, rectChanged, toDto, visualChanged, type Annotation } from "./model";
import type { AnnotationState } from "./store";

export interface SerializedChanges {
  changes: DocumentChanges;
  /** Image blobs referenced by `stampImage.blob`. */
  images: Uint8Array[];
}

export function serializeChanges(
  state: Pick<AnnotationState, "items" | "pristine">,
  info: InfoUpdate | null,
  cjkHint: string | null,
): SerializedChanges {
  const { items, pristine } = state;
  const imageIndex = new Map<string, number>();
  const images: Uint8Array[] = [];
  const registerImage = (a: Annotation) => {
    const img = a.stampImage;
    if (img && !imageIndex.has(img.id)) {
      imageIndex.set(img.id, images.length);
      images.push(img.rgba);
    }
  };

  const annotations: AnnotationChanges = { add: [], modify: [], delete: [] };

  for (const [id, original] of Object.entries(pristine)) {
    const current = items[id];
    if (!current) {
      if (original.ref) annotations.delete.push(original.ref);
      continue;
    }
    if (!original.ref || !annotationChanged(current, original)) {
      // Moving a non-editable annotation only rewrites its /Rect.
      if (original.ref && rectChanged(current, original)) {
        annotations.modify.push({
          ref: original.ref,
          annotation: toDto(current, imageIndex, items[current.inReplyTo ?? ""]),
          regenerateAppearance: false,
        });
      }
      continue;
    }
    const regenerate = current.editable && visualChanged(current, original);
    if (regenerate) registerImage(current);
    annotations.modify.push({
      ref: original.ref,
      annotation: toDto(current, imageIndex, items[current.inReplyTo ?? ""]),
      regenerateAppearance: regenerate,
    });
  }

  // New annotations: parents before replies so the writer can resolve `inReplyToNm`.
  const added = Object.values(items).filter((a) => !pristine[a.id]);
  added.sort((a, b) => depth(items, a) - depth(items, b));
  for (const a of added) {
    if (a.kind === "other") continue;
    if (isTextMarkup(a.kind) && a.quadPoints.length < 8) continue;
    registerImage(a);
    annotations.add.push(toDto(a, imageIndex, items[a.inReplyTo ?? ""]));
  }

  return { changes: { annotations, info, cjkHint }, images };
}

function depth(items: Record<string, Annotation>, a: Annotation): number {
  let d = 0;
  let cur: Annotation | undefined = a;
  const seen = new Set<string>();
  while (cur?.inReplyTo && !seen.has(cur.id) && d < 64) {
    seen.add(cur.id);
    cur = items[cur.inReplyTo];
    d++;
  }
  return d;
}

export function countChanges(c: DocumentChanges): number {
  return c.annotations.add.length + c.annotations.modify.length + c.annotations.delete.length + (c.info ? 1 : 0);
}
