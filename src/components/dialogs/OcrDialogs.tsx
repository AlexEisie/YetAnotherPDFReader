/** Text recognition dialogs: the text of a region, and making a whole document searchable. */
import { useEffect, useRef, useState } from "react";
import { Copy, ScanText } from "lucide-react";
import { Dialog } from "../common/Dialog";
import { Segmented, Select } from "../common/controls";
import { RangeInput } from "./DocumentDialogs";
import { useT } from "../../i18n";
import { getController } from "../../state/tabs";
import { dismissToast, setBusy, toast } from "../../state/ui";
import { isCancellation, toAppError } from "../../lib/errors";
import { formatPageRange, parsePageRange } from "../../document/print";
import { OCR_DPI, ocrPages, type OcrDpi } from "../../document/ocr";

export function OcrResultDialog({ text: initial, confidence, done }: { text: string; confidence: number; done: () => void }) {
  const t = useT();
  const [text, setText] = useState(initial);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => area.current?.select(), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast("success", t("ocr.copied"));
      done();
    } catch {
      area.current?.select();
      document.execCommand("copy");
      toast("success", t("ocr.copied"));
      done();
    }
  };
  const lines = text.split("\n").length;
  return (
    <Dialog
      title={t("ocr.resultTitle")}
      icon={ScanText}
      size="wide"
      onClose={done}
      footer={
        <>
          <span className="dialog-footer-note muted">
            {t("ocr.resultSummary", { lines, chars: text.replace(/\s/g, "").length })}
            {confidence > 0 && confidence < 0.8 ? ` · ${t("ocr.lowConfidence")}` : ""}
          </span>
          <button type="button" className="btn" onClick={done}>
            {t("common.close")}
          </button>
          <button type="button" className="btn primary" onClick={() => void copy()}>
            <Copy size={15} /> {t("ocr.copy")}
          </button>
        </>
      }
    >
      <p className="dialog-lead muted">{t("ocr.resultLead")}</p>
      <textarea ref={area} className="input ocr-text" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} data-autofocus />
    </Dialog>
  );
}

export function OcrDocumentDialog({ tabId, pages: initialPages, done }: { tabId: string; pages?: number[]; done: () => void }) {
  const t = useT();
  const c = getController(tabId);
  const n = c?.state.numPages ?? 1;
  const [scope, setScope] = useState<"all" | "current" | "range">(initialPages?.length ? "range" : "all");
  const [range, setRange] = useState(initialPages?.length ? formatPageRange(initialPages) : `1-${n}`);
  const [skipText, setSkipText] = useState(true);
  const [dpi, setDpi] = useState<OcrDpi>(200);
  const [working, setWorking] = useState(false);
  const abort = useRef<AbortController | null>(null);
  if (!c) return null;
  const pages = scope === "all" ? Array.from({ length: n }, (_, i) => i + 1) : scope === "current" ? [c.state.page] : parsePageRange(range, n);

  const run = async () => {
    if (!pages?.length) return;
    const controller = new AbortController();
    abort.current = controller;
    if (c.ocrSuggestion !== null) dismissToast(c.ocrSuggestion);
    setWorking(true);
    const started = performance.now();
    try {
      const result = await ocrPages(
        c,
        pages,
        { dpi, skipText },
        (p) => {
          const left = p.done > 0 ? ((performance.now() - started) / p.done) * (p.total - p.done) : 0;
          setBusy(
            t("ocr.progress", { done: p.done, total: p.total, remaining: left > 0 ? Math.max(1, Math.round(left / 1000)) : "…" }),
            p.total ? p.done / p.total : null,
            () => controller.abort(),
          );
        },
        controller.signal,
      );
      if (!result.recognized) {
        toast("info", result.skipped ? t("ocr.allHadText") : t("ocr.nothing"));
      } else {
        toast("success", t("ocr.done", { count: result.recognized }), {
          detail: t("ocr.doneDetail", { lines: result.lines, skipped: result.skipped }),
          action: { label: t("cmd.edit.undo"), run: () => void c.undo() },
          timeout: 9000,
        });
      }
      done();
    } catch (err) {
      if (isCancellation(err)) toast("info", t("ocr.cancelled"));
      else toast("error", t("ocr.failed"), { detail: toAppError(err).message });
    } finally {
      setBusy(null);
      setWorking(false);
    }
  };

  return (
    <Dialog
      title={t("ocr.title")}
      icon={ScanText}
      onClose={done}
      onSubmit={() => !!pages?.length && !working && void run()}
      footer={
        <>
          <button type="button" className="btn" onClick={done}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn primary" disabled={!pages?.length || working} onClick={() => void run()}>
            <ScanText size={15} /> {t("ocr.start", { count: pages?.length ?? 0 })}
          </button>
        </>
      }
    >
      <p className="dialog-lead muted">{t("ocr.lead")}</p>
      <div className="field">
        <label>{t("pageops.pages")}</label>
        <Segmented
          value={scope}
          onChange={setScope}
          options={[
            { value: "all", label: t("print.range.all") },
            { value: "current", label: t("print.range.current") },
            { value: "range", label: t("print.range.custom") },
          ]}
        />
        {scope === "range" && <RangeInput value={range} onChange={setRange} invalid={!pages} />}
      </div>
      <div className="field">
        <label>{t("ocr.quality")}</label>
        <Select
          value={dpi}
          onChange={setDpi}
          options={OCR_DPI.map((v) => ({ value: v, label: t(`ocr.quality.${v}`) }))}
        />
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={skipText} onChange={(e) => setSkipText(e.target.checked)} /> {t("ocr.skipText")}
      </label>
      <p className="muted small">{t("ocr.languages")}</p>
    </Dialog>
  );
}
