/**
 * One global tooltip for every element with `data-tip` (and optionally `data-tip-key`). Using a
 * single delegated listener keeps hundreds of toolbar buttons cheap.
 */
import { useEffect, useState } from "react";

interface Tip {
  text: string;
  keys: string | null;
  x: number;
  y: number;
  below: boolean;
}

const DELAY_MS = 450;

export function TooltipHost() {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let current: HTMLElement | null = null;
    let warm = false;
    let coolTimer: ReturnType<typeof setTimeout> | null = null;

    const hide = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      current = null;
      setTip(null);
      if (coolTimer) clearTimeout(coolTimer);
      coolTimer = setTimeout(() => (warm = false), 400);
    };

    const show = (el: HTMLElement) => {
      const text = el.dataset.tip;
      if (!text) return;
      const r = el.getBoundingClientRect();
      const below = r.top < 60;
      setTip({ text, keys: el.dataset.tipKey ?? null, x: r.left + r.width / 2, y: below ? r.bottom + 6 : r.top - 6, below });
      warm = true;
    };

    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-tip]") ?? null;
      if (el === current) return;
      if (!el) {
        hide();
        return;
      }
      current = el;
      if (timer) clearTimeout(timer);
      setTip(null);
      timer = setTimeout(() => current === el && el.isConnected && show(el), warm ? 60 : DELAY_MS);
    };

    window.addEventListener("mouseover", onOver);
    window.addEventListener("pointerdown", hide, true);
    window.addEventListener("keydown", hide, true);
    window.addEventListener("wheel", hide, { passive: true, capture: true });
    return () => {
      window.removeEventListener("mouseover", onOver);
      window.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("keydown", hide, true);
      window.removeEventListener("wheel", hide, true);
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!tip) return null;
  return (
    <div
      className="tooltip"
      role="tooltip"
      ref={(el) => {
        if (!el) return;
        const w = el.offsetWidth;
        const left = Math.max(6, Math.min(window.innerWidth - w - 6, tip.x - w / 2));
        el.style.left = `${left}px`;
        el.style.top = tip.below ? `${tip.y}px` : `${tip.y - el.offsetHeight}px`;
      }}
      style={{ left: -9999, top: -9999 }}
    >
      {tip.text}
      {tip.keys && <kbd>{tip.keys}</kbd>}
    </div>
  );
}
