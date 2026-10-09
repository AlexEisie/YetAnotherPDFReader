/**
 * Auto scroll (Acrobat: View ▸ Page Display ▸ Automatically Scroll). Up / Down change the speed,
 * Esc or any click stops.
 */
import { create } from "zustand";
import type { DocumentController } from "./DocumentController";
import { settings, useSettings } from "../settings/store";

interface AutoScrollState {
  active: boolean;
  speed: number;
}

export const useAutoScroll = create<AutoScrollState>(() => ({ active: false, speed: 40 }));

let raf = 0;
let cleanup: (() => void) | null = null;

export function stopAutoScroll(): void {
  cancelAnimationFrame(raf);
  cleanup?.();
  cleanup = null;
  if (useAutoScroll.getState().active) useAutoScroll.setState({ active: false });
}

export function toggleAutoScroll(controller: DocumentController): void {
  if (useAutoScroll.getState().active) {
    stopAutoScroll();
    return;
  }
  const container = controller.scrollContainer;
  if (!container) return;
  let speed = settings().navigation.autoScrollSpeed;
  useAutoScroll.setState({ active: true, speed });
  let last = performance.now();
  let carry = 0;
  const horizontal = controller.state.layout === "horizontal";

  const step = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    carry += speed * dt;
    const whole = Math.trunc(carry);
    if (whole !== 0) {
      carry -= whole;
      if (horizontal) container.scrollLeft += whole;
      else container.scrollTop += whole;
      const atEnd = horizontal
        ? container.scrollLeft + container.clientWidth >= container.scrollWidth - 1
        : container.scrollTop + container.clientHeight >= container.scrollHeight - 1;
      if (atEnd) {
        stopAutoScroll();
        return;
      }
    }
    raf = requestAnimationFrame(step);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      stopAutoScroll();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      speed = Math.max(5, Math.min(400, Math.round(speed * (e.key === "ArrowDown" ? 1.25 : 0.8))));
      useAutoScroll.setState({ speed });
      useSettings.getState().set("navigation.autoScrollSpeed", speed);
    }
  };
  const onPointer = () => stopAutoScroll();
  window.addEventListener("keydown", onKey, true);
  container.addEventListener("pointerdown", onPointer);
  cleanup = () => {
    window.removeEventListener("keydown", onKey, true);
    container.removeEventListener("pointerdown", onPointer);
  };
  raf = requestAnimationFrame(step);
}
