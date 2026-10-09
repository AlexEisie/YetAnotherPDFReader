/** Modal dialog shell: backdrop, focus trap, Esc to close, Enter to confirm. */
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X, type LucideIcon } from "lucide-react";
import { useT } from "../../i18n";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  title: ReactNode;
  icon?: LucideIcon;
  iconTone?: "accent" | "danger" | "warning";
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  /** Called on Enter (outside of textareas). */
  onSubmit?: () => void;
  size?: "normal" | "wide" | "xwide";
  /** Clicking the backdrop closes the dialog (default true). */
  dismissible?: boolean;
  className?: string;
  bodyClassName?: string;
  hideClose?: boolean;
}

export function Dialog({
  title,
  icon: Icon,
  iconTone = "accent",
  children,
  footer,
  onClose,
  onSubmit,
  size = "normal",
  dismissible = true,
  className = "",
  bodyClassName = "",
  hideClose = false,
}: DialogProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<Element | null>(null);

  useEffect(() => {
    previousFocus.current = document.activeElement;
    const el = ref.current;
    // Prefer an explicit target, then the first control of the body, then the footer.
    const auto =
      el?.querySelector<HTMLElement>("[data-autofocus]") ??
      el?.querySelector<HTMLElement>(`.dialog-body :is(${FOCUSABLE})`) ??
      el?.querySelector<HTMLElement>(`.dialog-footer :is(${FOCUSABLE})`) ??
      el?.querySelector<HTMLElement>(FOCUSABLE);
    auto?.focus();
    // Keep focus inside the topmost dialog even if something else tries to take it.
    const onFocusIn = (e: FocusEvent) => {
      const dialogs = document.querySelectorAll(".dialog");
      if (!el || dialogs[dialogs.length - 1] !== el || el.contains(e.target as Node)) return;
      (el.querySelector<HTMLElement>("[data-autofocus]") ?? el.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    };
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      (previousFocus.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "Enter" && onSubmit && !(e.target as HTMLElement).closest("textarea, button, select")) {
      e.preventDefault();
      onSubmit();
      return;
    }
    if (e.key === "Tab") {
      const nodes = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((n) => n.offsetParent !== null);
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    e.stopPropagation();
  };

  return createPortal(
    <div
      className="dialog-backdrop"
      onPointerDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`dialog ${size === "wide" ? "wide" : size === "xwide" ? "xwide" : ""} ${className}`}
        role="dialog"
        aria-modal="true"
        onKeyDown={onKeyDown}
        onContextMenu={(e) => {
          if (!(e.target as HTMLElement).closest("input, textarea")) e.preventDefault();
        }}
      >
        <div className="dialog-header">
          {Icon && (
            <div className={`dialog-icon ${iconTone === "accent" ? "" : iconTone}`}>
              <Icon size={18} />
            </div>
          )}
          <h2>{title}</h2>
          {!hideClose && (
            <button type="button" className="icon-btn small" aria-label={t("common.close")} onClick={onClose}>
              <X size={16} />
            </button>
          )}
        </div>
        <div className={`dialog-body ${bodyClassName}`}>{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
