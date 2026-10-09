/**
 * Per-document annotation store (vanilla zustand so the imperative controller and React share it).
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Change, ModelSnapshot } from "./history";
import { isReply, visualChanged, type Annotation } from "./model";

export interface AnnotationState {
  items: Record<string, Annotation>;
  /** Snapshot of the annotations stored in the file (the base of every save). */
  pristine: Record<string, Annotation>;
  /** Annotation ids grouped by page, in z-order. Derived from `items`. */
  byPage: Record<number, string[]>;
  loaded: boolean;
  loadError: string | null;
  selection: string[];
  hover: string | null;
  /** Annotation whose text is being edited inline (free text) or whose note pop-up is open. */
  editing: string | null;
  /** Monotonic counter, bumped on every model change. */
  version: number;
  /** Transient geometry while dragging / resizing (not part of the model or history). */
  preview: Record<string, Annotation> | null;
}

export type AnnotationStore = StoreApi<AnnotationState>;

export function indexByPage(items: Record<string, Annotation>): Record<number, string[]> {
  const byPage: Record<number, string[]> = {};
  for (const a of Object.values(items)) {
    (byPage[a.page] ??= []).push(a.id);
  }
  return byPage;
}

export function createAnnotationStore(): AnnotationStore {
  return createStore<AnnotationState>(() => ({
    items: {},
    pristine: {},
    byPage: {},
    loaded: false,
    loadError: null,
    selection: [],
    hover: null,
    editing: null,
    version: 0,
    preview: null,
  }));
}

/** Apply a list of replacements to the store. */
export function applyChanges(store: AnnotationStore, changes: Change[]): void {
  const state = store.getState();
  const items = { ...state.items };
  for (const c of changes) {
    if (c.after) items[c.id] = c.after;
    else delete items[c.id];
  }
  const selection = state.selection.filter((id) => items[id]);
  store.setState({
    items,
    byPage: indexByPage(items),
    selection,
    editing: state.editing && items[state.editing] ? state.editing : null,
    hover: state.hover && items[state.hover] ? state.hover : null,
    version: state.version + 1,
  });
}

export function snapshot(store: AnnotationStore): ModelSnapshot {
  const { items, pristine } = store.getState();
  return { items, pristine };
}

export function restoreSnapshot(store: AnnotationStore, snap: ModelSnapshot): void {
  store.setState((s) => ({
    items: snap.items,
    pristine: snap.pristine,
    byPage: indexByPage(snap.items),
    selection: [],
    editing: null,
    hover: null,
    loaded: true,
    version: s.version + 1,
  }));
}

/**
 * Object references that pdf.js must not draw: deleted or visually modified file annotations
 * (the app draws the modified version itself) and replies (shown in comment threads instead).
 */
export function computeHiddenRefs(state: AnnotationState, showAnnotations: boolean): Set<string> {
  const hidden = new Set<string>();
  for (const [id, original] of Object.entries(state.pristine)) {
    if (!original.ref) continue;
    const current = state.items[id];
    if (!showAnnotations || !current || isReply(original) || (current.editable && visualChanged(current, original))) {
      hidden.add(original.ref);
      if (original.popupRef) hidden.add(original.popupRef);
    }
  }
  return hidden;
}

/** Is this annotation drawn by the app (rather than by pdf.js from the file's appearance)? */
export function drawnByApp(state: AnnotationState, a: Annotation): boolean {
  const original = state.pristine[a.id];
  if (!original) return true;
  return a.editable && visualChanged(a, original);
}

/** Replies of an annotation (direct children), oldest first. */
export function repliesOf(state: AnnotationState, id: string): Annotation[] {
  return Object.values(state.items)
    .filter((a) => a.inReplyTo === id && a.replyType !== "Group")
    .sort((a, b) => (a.created ?? a.modified ?? "").localeCompare(b.created ?? b.modified ?? ""));
}

/** The annotation plus all transitive replies (used for deletion). */
export function withDescendants(state: AnnotationState, ids: string[]): string[] {
  const out = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of Object.values(state.items)) {
      if (a.inReplyTo && out.has(a.inReplyTo) && !out.has(a.id)) {
        out.add(a.id);
        grew = true;
      }
    }
  }
  return [...out];
}
