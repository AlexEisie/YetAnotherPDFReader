/** React bindings for document controllers. */
import { useCallback, useRef, useSyncExternalStore } from "react";
import type { StoreApi } from "zustand/vanilla";
import type { DocState, DocumentController } from "../document/DocumentController";
import type { AnnotationState } from "../annotations/store";
import { getController, useTabs } from "../state/tabs";

const noopSubscribe = () => () => {};

/** Subscribe to a selected slice of a (possibly absent) vanilla store. */
function useOptionalStore<S, T>(store: StoreApi<S> | null | undefined, selector: (s: S) => T, fallback: T, equal = Object.is): T {
  const last = useRef<{ value: T } | null>(null);
  // The fallback is frequently an inline literal; keep the first one so snapshots stay stable.
  const fallbackRef = useRef(fallback);
  const getSnapshot = useCallback(() => {
    if (!store) return fallbackRef.current;
    const next = selector(store.getState());
    if (last.current && equal(last.current.value, next)) return last.current.value;
    last.current = { value: next };
    return next;
  }, [store, selector]);
  return useSyncExternalStore(store ? store.subscribe : noopSubscribe, getSnapshot, getSnapshot);
}

export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

export function useActiveController(): DocumentController | null {
  const id = useTabs((s) => s.activeId);
  return getController(id);
}

export function useDocState<T>(c: DocumentController | null | undefined, selector: (s: DocState) => T, fallback: T, equal?: (a: T, b: T) => boolean): T {
  return useOptionalStore(c?.store, selector, fallback, equal);
}

export function useAnnotState<T>(
  c: DocumentController | null | undefined,
  selector: (s: AnnotationState) => T,
  fallback: T,
  equal?: (a: T, b: T) => boolean,
): T {
  return useOptionalStore(c?.annotations, selector, fallback, equal);
}
