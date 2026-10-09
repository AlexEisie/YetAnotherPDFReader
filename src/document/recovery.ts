/**
 * Serialisation of unsaved annotation changes for crash recovery.
 */
import type { Change } from "../annotations/history";
import { annotationChanged, type Annotation, type StampImage } from "../annotations/model";
import type { AnnotationState } from "../annotations/store";
import { decodeImageUrl } from "../annotations/images";

type StoredImage = Omit<StampImage, "rgba">;
type StoredAnnotation = Omit<Annotation, "stampImage"> & { stampImage: StoredImage | null };

interface RecoveryPayload {
  version: 1;
  items: StoredAnnotation[];
  deleted: string[];
}

export function recoveryPayload(state: Pick<AnnotationState, "items" | "pristine">): RecoveryPayload {
  const items: StoredAnnotation[] = [];
  for (const a of Object.values(state.items)) {
    const original = state.pristine[a.id];
    if (original && !annotationChanged(a, original)) continue;
    const { stampImage, ...rest } = a;
    items.push({
      ...rest,
      stampImage: stampImage ? { id: stampImage.id, width: stampImage.width, height: stampImage.height, url: stampImage.url } : null,
    });
  }
  const deleted = Object.keys(state.pristine).filter((id) => !state.items[id]);
  return { version: 1, items, deleted };
}

function isPayload(v: unknown): v is RecoveryPayload {
  const p = v as RecoveryPayload;
  return !!p && p.version === 1 && Array.isArray(p.items) && Array.isArray(p.deleted);
}

export async function restoreRecoveryPayload(
  state: Pick<AnnotationState, "items" | "pristine">,
  payload: unknown,
): Promise<Change[]> {
  if (!isPayload(payload)) return [];
  const changes: Change[] = [];
  for (const id of payload.deleted) {
    const before = state.items[id];
    if (before) changes.push({ id, before, after: null });
  }
  for (const stored of payload.items) {
    if (!stored || typeof stored.id !== "string" || typeof stored.page !== "number") continue;
    let image: StampImage | null = null;
    if (stored.stampImage?.url) {
      const decoded = await decodeImageUrl(stored.stampImage.url).catch(() => null);
      if (!decoded) continue;
      image = { ...decoded, id: stored.stampImage.id };
    }
    const after: Annotation = { ...stored, stampImage: image };
    changes.push({ id: stored.id, before: state.items[stored.id] ?? null, after });
  }
  return changes;
}
