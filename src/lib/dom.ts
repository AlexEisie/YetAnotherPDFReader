/** Small DOM helpers. */

/**
 * Capture the pointer on `target` if possible. Capture can legitimately fail (the pointer was
 * already released, a pen left the digitiser, synthetic events) and must never abort a gesture.
 */
export function capturePointer(target: EventTarget | null, pointerId: number): void {
  try {
    (target as Element | null)?.setPointerCapture?.(pointerId);
  } catch {
    // Not capturable: window-level listeners still receive the events.
  }
}
