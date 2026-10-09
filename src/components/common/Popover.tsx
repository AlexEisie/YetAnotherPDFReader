/** Anchored floating panel that closes on outside click / Esc. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Popover({
  anchor,
  onClose,
  children,
  className = "",
  placement = "below",
}: {
  anchor: DOMRect;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  placement?: "below" | "above";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let top = placement === "below" ? anchor.bottom + 6 : anchor.top - h - 6;
    if (top + h > window.innerHeight - 6) top = anchor.top - h - 6;
    if (top < 6) top = anchor.bottom + 6;
    const left = Math.max(6, Math.min(window.innerWidth - w - 6, anchor.left + anchor.width / 2 - w / 2));
    setPos({ left, top });
  }, [anchor, placement]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current && !ref.current.contains(target) && !(target as HTMLElement).closest?.(".menu")) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return createPortal(
    <div ref={ref} className={`popover ${className}`} style={pos ?? { left: -9999, top: -9999 }} data-keys="local">
      {children}
    </div>,
    document.body,
  );
}

/** Button toggling a popover. */
export function PopoverButton({
  children,
  content,
  className = "icon-btn",
  tip,
  disabled,
  popoverClassName,
}: {
  children: ReactNode;
  content: (close: () => void) => ReactNode;
  className?: string;
  tip?: string;
  disabled?: boolean;
  popoverClassName?: string;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <button
        type="button"
        className={className}
        data-tip={anchor ? undefined : tip}
        aria-expanded={!!anchor}
        disabled={disabled}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
      >
        {children}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} className={popoverClassName}>
          {content(() => setAnchor(null))}
        </Popover>
      )}
    </>
  );
}
