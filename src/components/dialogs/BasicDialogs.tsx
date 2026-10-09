/** Small generic dialogs: password, confirm, prompt, error, external link, go to page. */
import { useState } from "react";
import { AlertTriangle, ExternalLink, Eye, EyeOff, KeyRound, Hash, XCircle, HelpCircle } from "lucide-react";
import { Dialog } from "../common/Dialog";
import { useT } from "../../i18n";
import type { ConfirmProps, ConfirmResult, PromptProps } from "../../state/ui";
import type { AppError } from "../../lib/errors";
import { getController } from "../../state/tabs";

export function PasswordDialog({ fileName, reason, done }: { fileName: string; reason: "need" | "incorrect"; done: (v: string | null) => void }) {
  const t = useT();
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  return (
    <Dialog
      title={t("dialog.password.title")}
      icon={KeyRound}
      onClose={() => done(null)}
      onSubmit={() => value && done(value)}
      dismissible={false}
      footer={
        <>
          <button type="button" className="btn" onClick={() => done(null)}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn primary" disabled={!value} onClick={() => done(value)}>
            {t("common.open")}
          </button>
        </>
      }
    >
      <p>{t("dialog.password.message", { name: fileName })}</p>
      {reason === "incorrect" && <p style={{ color: "var(--danger)" }}>{t("dialog.password.wrong")}</p>}
      <div className="field">
        <label htmlFor="pw">{t("dialog.password.label")}</label>
        <div className="row">
          <input
            id="pw"
            data-autofocus
            className={`input${reason === "incorrect" ? " invalid" : ""}`}
            style={{ flex: 1 }}
            type={show ? "text" : "password"}
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button type="button" className="icon-btn" data-tip={t("dialog.password.show")} onClick={() => setShow(!show)}>
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function ConfirmDialog({ props, done }: { props: ConfirmProps; done: (v: ConfirmResult) => void }) {
  const t = useT();
  const [checked, setChecked] = useState(false);
  const finish = (choice: ConfirmResult["choice"]) => done({ choice, checked });
  return (
    <Dialog
      title={props.title}
      icon={props.danger ? AlertTriangle : HelpCircle}
      iconTone={props.danger ? "danger" : "accent"}
      onClose={() => finish("cancel")}
      onSubmit={() => finish("confirm")}
      footer={
        <>
          {props.altLabel && (
            <button type="button" className="btn left" onClick={() => finish("alt")}>
              {props.altLabel}
            </button>
          )}
          <button type="button" className="btn" onClick={() => finish("cancel")}>
            {props.cancelLabel ?? t("common.cancel")}
          </button>
          <button type="button" data-autofocus className={`btn ${props.danger ? "danger" : "primary"}`} onClick={() => finish("confirm")}>
            {props.confirmLabel}
          </button>
        </>
      }
    >
      <p style={{ color: "var(--text)" }}>{props.message}</p>
      {props.detail && <p>{props.detail}</p>}
      {props.checkboxLabel && (
        <label className="checkbox">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          {props.checkboxLabel}
        </label>
      )}
    </Dialog>
  );
}

export function PromptDialog({ props, done }: { props: PromptProps; done: (v: string | null) => void }) {
  const t = useT();
  const [value, setValue] = useState(props.value);
  const error = props.validate?.(value) ?? null;
  return (
    <Dialog
      title={props.title}
      onClose={() => done(null)}
      onSubmit={() => !error && done(value)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => done(null)}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn primary" disabled={!!error} onClick={() => done(value)}>
            {props.confirmLabel ?? t("common.ok")}
          </button>
        </>
      }
    >
      {props.message && <p>{props.message}</p>}
      <div className="field">
        <label>{props.label}</label>
        <input data-autofocus className={`input${error ? " invalid" : ""}`} value={value} placeholder={props.placeholder} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} />
        {error && <span className="field-error">{error}</span>}
      </div>
    </Dialog>
  );
}

export function ErrorDialog({ title, error, done }: { title: string; error: AppError; done: () => void }) {
  const t = useT();
  const [show, setShow] = useState(false);
  const detail = [error.message, error.detail].filter(Boolean).join("\n\n");
  return (
    <Dialog
      title={title}
      icon={XCircle}
      iconTone="danger"
      onClose={done}
      onSubmit={done}
      footer={
        <>
          {detail && (
            <button type="button" className="btn ghost left" onClick={() => void navigator.clipboard.writeText(`${title}\n${error.code}\n${detail}`)}>
              {t("common.copy")}
            </button>
          )}
          <button type="button" className="btn primary" data-autofocus onClick={done}>
            {t("common.ok")}
          </button>
        </>
      }
    >
      <p style={{ color: "var(--text)" }}>{t(`error.${error.code}` as never)}</p>
      {detail && (
        <>
          <button type="button" className="btn ghost small" style={{ alignSelf: "flex-start" }} onClick={() => setShow(!show)}>
            {show ? t("common.hideDetails") : t("common.showDetails")}
          </button>
          {show && <div className="details-box">{`${error.code}\n${detail}`}</div>}
        </>
      )}
    </Dialog>
  );
}

export function LinkDialog({ url, done }: { url: string; done: (v: { open: boolean; always: boolean }) => void }) {
  const t = useT();
  const [always, setAlways] = useState(false);
  return (
    <Dialog
      title={t("link.title")}
      icon={ExternalLink}
      onClose={() => done({ open: false, always: false })}
      onSubmit={() => done({ open: true, always })}
      footer={
        <>
          <button type="button" className="btn" onClick={() => done({ open: false, always: false })}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn primary" data-autofocus onClick={() => done({ open: true, always })}>
            {t("link.open")}
          </button>
        </>
      }
    >
      <p>{t("link.message")}</p>
      <div className="details-box" style={{ fontSize: "var(--fs-sm)" }}>{url}</div>
      <label className="checkbox">
        <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
        {t("link.alwaysAllow")}
      </label>
    </Dialog>
  );
}

export function GoToPageDialog({ tabId, done }: { tabId: string; done: () => void }) {
  const t = useT();
  const c = getController(tabId);
  const [value, setValue] = useState(String(c?.state.pageLabel ?? c?.state.page ?? 1));
  const [error, setError] = useState(false);
  const total = c?.state.numPages ?? 0;
  const submit = () => {
    if (c?.goToPageInput(value)) done();
    else setError(true);
  };
  return (
    <Dialog
      title={t("dialog.goto.title")}
      icon={Hash}
      onClose={done}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={done}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn primary" onClick={submit}>
            {t("common.ok")}
          </button>
        </>
      }
    >
      <div className="field">
        <label>{t("dialog.goto.label", { total })}</label>
        <input
          data-autofocus
          className={`input${error ? " invalid" : ""}`}
          value={value}
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            setValue(e.target.value);
            setError(false);
          }}
        />
        {error && <span className="field-error">{t("dialog.goto.invalid", { total })}</span>}
      </div>
    </Dialog>
  );
}
