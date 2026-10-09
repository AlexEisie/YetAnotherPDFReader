import { useEffect } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { dismissToast, useUi, type Toast } from "../../state/ui";

const ICONS = { success: CheckCircle2, warning: AlertTriangle, error: XCircle, info: Info };

function ToastView({ toast }: { toast: Toast }) {
  useEffect(() => {
    if (!toast.timeout) return;
    const timer = setTimeout(() => dismissToast(toast.id), toast.timeout);
    return () => clearTimeout(timer);
  }, [toast.id, toast.timeout]);
  const Icon = ICONS[toast.kind];
  return (
    <div className={`toast ${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
      <Icon size={18} className="toast-icon" />
      <div className="toast-body">
        <div>{toast.message}</div>
        {toast.detail && <div className="toast-detail">{toast.detail}</div>}
      </div>
      {toast.action && (
        <button
          type="button"
          className="btn small toast-action"
          onClick={() => {
            toast.action?.run();
            dismissToast(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button type="button" className="icon-btn small" onClick={() => dismissToast(toast.id)} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <ToastView key={t.id} toast={t} />
      ))}
    </div>
  );
}
