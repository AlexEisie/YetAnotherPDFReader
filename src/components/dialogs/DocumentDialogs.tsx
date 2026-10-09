/** Print, page operations and image export dialogs. */
import { useRef, useState } from "react";
import { FileDown, FileInput, FileOutput, FilePlus, Printer, Trash } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { Dialog } from "../common/Dialog";
import { Segmented, Select } from "../common/controls";
import { useT } from "../../i18n";
import { getController } from "../../state/tabs";
import { formatPageRange, parsePageRange, printDocument } from "../../document/print";
import { settings } from "../../settings/store";
import { toast, setBusy } from "../../state/ui";
import { toAppError } from "../../lib/errors";
import { api } from "../../lib/ipc";
import { pickPdfFile, dirname, joinPath, stripExtension } from "../../document/fileActions";
import { pdfjs } from "../../pdf/pdfjs";

function RangeInput({ value, onChange, invalid }: { value: string; onChange: (v: string) => void; invalid: boolean }) {
  const t = useT();
  return (
    <input
      className={`input${invalid ? " invalid" : ""}`}
      value={value}
      placeholder={t("print.range.placeholder")}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function PrintDialog({ tabId, done }: { tabId: string; done: () => void }) {
  const t = useT();
  const c = getController(tabId);
  const [mode, setMode] = useState<"all" | "current" | "custom">("all");
  const [range, setRange] = useState(`1-${c?.state.numPages ?? 1}`);
  const [annotations, setAnnotations] = useState(true);
  const [dpi, setDpi] = useState(200);
  const [busy, setBusyState] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  if (!c) return null;
  const n = c.state.numPages;
  const pages = mode === "all" ? Array.from({ length: n }, (_, i) => i + 1) : mode === "current" ? [c.state.page] : parsePageRange(range, n);
  const allowed = !settings().saving.respectRestrictions || c.state.permissions.print;

  const run = async () => {
    if (!pages) return;
    const ac = new AbortController();
    abort.current = ac;
    try {
      await printDocument(c, { pages, dpi, annotations }, (d, total) => setBusyState(t("print.preparing", { page: Math.min(d + 1, total), total })), ac.signal);
      done();
    } catch (err) {
      const e = toAppError(err);
      if (!e.isCancellation) toast("error", t("error.PRINT_ERROR"), { detail: e.message });
      setBusyState(null);
    }
  };

  return (
    <Dialog
      title={t("print.title")}
      icon={Printer}
      onClose={() => {
        abort.current?.abort();
        done();
      }}
      onSubmit={() => void run()}
      footer={
        <>
          <button type="button" className="btn" onClick={() => (busy ? abort.current?.abort() : done())}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn primary" disabled={!pages || !allowed || !!busy} onClick={() => void run()}>
            {t("print.continue")}
          </button>
        </>
      }
    >
      {!allowed && <p style={{ color: "var(--danger)" }}>{t("print.notAllowed")}</p>}
      <div className="field">
        <label>{t("print.range")}</label>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "all", label: t("print.range.all") },
            { value: "current", label: t("print.range.current") },
            { value: "custom", label: t("print.range.custom") },
          ]}
        />
        {mode === "custom" && <RangeInput value={range} onChange={setRange} invalid={!pages} />}
        {mode === "custom" && !pages && <span className="field-error">{t("print.invalidRange")}</span>}
      </div>
      <div className="field">
        <label>{t("print.quality")}</label>
        <Select
          value={dpi}
          onChange={setDpi}
          options={[
            { value: 150, label: t("print.quality.draft") },
            { value: 200, label: t("print.quality.normal") },
            { value: 300, label: t("print.quality.high") },
          ]}
        />
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={annotations} onChange={(e) => setAnnotations(e.target.checked)} />
        {t("print.annotations")}
      </label>
      {busy && (
        <div className="row">
          <div className="spinner" />
          <span>{busy}</span>
        </div>
      )}
    </Dialog>
  );
}

const PAGE_SIZES: { id: string; w: number; h: number }[] = [
  { id: "A4", w: 595.28, h: 841.89 },
  { id: "A3", w: 841.89, h: 1190.55 },
  { id: "A5", w: 419.53, h: 595.28 },
  { id: "Letter", w: 612, h: 792 },
  { id: "Legal", w: 612, h: 1008 },
];

export function PageOpsDialog({
  tabId,
  mode,
  pages: initialPages,
  done,
}: {
  tabId: string;
  mode: "delete" | "insertBlank" | "insertFile" | "extract";
  pages?: number[];
  done: () => void;
}) {
  const t = useT();
  const c = getController(tabId);
  const n = c?.state.numPages ?? 1;
  const current = c?.state.page ?? 1;
  const [range, setRange] = useState(initialPages?.length ? formatPageRange(initialPages) : String(current));
  const [position, setPosition] = useState<"before" | "after" | "start" | "end">("after");
  const [anchor, setAnchor] = useState(initialPages?.length ? Math.max(...initialPages) : current);
  const [count, setCount] = useState(1);
  const [size, setSize] = useState("current");
  const [landscape, setLandscape] = useState(false);
  const [source, setSource] = useState<{ path: string; pages: number } | null>(null);
  const [sourceRange, setSourceRange] = useState("");
  const [working, setWorking] = useState(false);
  if (!c) return null;

  const pages = parsePageRange(range, n);
  const at = position === "start" ? 0 : position === "end" ? n : position === "before" ? anchor - 1 : anchor;

  const titleKey = mode === "delete" ? "pageops.delete.title" : mode === "insertBlank" ? "pageops.insertBlank.title" : mode === "insertFile" ? "pageops.insertFile.title" : "pageops.extract.title";
  const Icon = mode === "delete" ? Trash : mode === "insertBlank" ? FilePlus : mode === "insertFile" ? FileInput : FileOutput;

  const pickSource = async () => {
    const path = await pickPdfFile();
    if (!path) return;
    try {
      const count = await api.pdfPageCount(path, null);
      setSource({ path, pages: count });
      setSourceRange(`1-${count}`);
    } catch (err) {
      toast("error", toAppError(err).message);
    }
  };

  const run = async () => {
    setWorking(true);
    setBusy(t("pageops.working"));
    try {
      if (mode === "delete") {
        if (!pages) return;
        if (pages.length >= n) {
          toast("warning", t("pageops.delete.all"));
          return;
        }
        await c.applyPageOps([{ op: "delete", pages: pages.map((p) => p - 1) }], [], t("cmd.page.delete"));
      } else if (mode === "insertBlank") {
        let w = 595.28;
        let h = 841.89;
        if (size === "current" && c.state.pageSize) [w, h] = c.state.pageSize;
        else {
          const preset = PAGE_SIZES.find((p) => p.id === size);
          if (preset) [w, h] = [preset.w, preset.h];
        }
        if (landscape !== w > h) [w, h] = [h, w];
        await c.applyPageOps([{ op: "insertBlank", at, count: Math.max(1, Math.min(500, count)), width: w, height: h }], [], t("cmd.page.insertBlank"));
        c.goToPage(at + 1, { recordHistory: false });
      } else if (mode === "insertFile") {
        if (!source) return;
        const selected = parsePageRange(sourceRange, source.pages);
        if (!selected) return;
        const bytes = await api.fsRead(source.path);
        await c.applyPageOps(
          [{ op: "insertFromBlob", at, blob: 0, pages: selected.map((p) => p - 1) }],
          [bytes],
          t("cmd.page.insertFile"),
        );
        c.goToPage(at + 1, { recordHistory: false });
      } else {
        if (!pages) return;
        const target = await save({
          defaultPath: joinPath(dirname(c.filePath), `${stripExtension(c.state.fileName)} (${formatPageRange(pages)}).pdf`),
          filters: [{ name: "PDF", extensions: ["pdf"] }],
        });
        if (!target) return;
        const bytes = await c.buildCurrentBytes();
        await api.pdfExtract({ password: c.documentPassword, pages: pages.map((p) => p - 1), target }, bytes);
        toast("success", t("pageops.extracted", { count: pages.length, path: target }));
      }
      done();
    } catch (err) {
      toast("error", toAppError(err).message);
    } finally {
      setWorking(false);
      setBusy(null);
    }
  };

  const positionField = (
    <div className="field">
      <label>{t("pageops.position")}</label>
      <div className="row">
        <Select
          value={position}
          onChange={setPosition}
          options={[
            { value: "before", label: t("pageops.before") },
            { value: "after", label: t("pageops.after") },
            { value: "start", label: t("pageops.atStart") },
            { value: "end", label: t("pageops.atEnd") },
          ]}
        />
        {(position === "before" || position === "after") && (
          <input
            className="input"
            type="number"
            min={1}
            max={n}
            style={{ width: 90 }}
            value={anchor}
            onChange={(e) => setAnchor(Math.max(1, Math.min(n, Number(e.target.value) || 1)))}
          />
        )}
      </div>
    </div>
  );

  const valid =
    mode === "delete" || mode === "extract"
      ? !!pages
      : mode === "insertFile"
        ? !!source && !!parsePageRange(sourceRange, source.pages)
        : count >= 1;

  return (
    <Dialog
      title={t(titleKey)}
      icon={Icon}
      iconTone={mode === "delete" ? "danger" : "accent"}
      onClose={done}
      onSubmit={() => valid && !working && void run()}
      footer={
        <>
          <button type="button" className="btn" onClick={done}>
            {t("common.cancel")}
          </button>
          <button type="button" className={`btn ${mode === "delete" ? "danger" : "primary"}`} disabled={!valid || working} onClick={() => void run()}>
            {mode === "delete" ? t("common.delete") : mode === "extract" ? t("common.save") : t("common.ok")}
          </button>
        </>
      }
    >
      {(mode === "delete" || mode === "extract") && (
        <div className="field">
          <label>{mode === "delete" ? t("pageops.delete.message") : t("pageops.pages")}</label>
          <RangeInput value={range} onChange={setRange} invalid={!pages} />
          <span className="field-hint">{t("common.pages", { count: n })}</span>
        </div>
      )}
      {mode === "insertBlank" && (
        <>
          {positionField}
          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label>{t("pageops.size")}</label>
              <Select value={size} onChange={setSize} options={[{ value: "current", label: t("pageops.size.current") }, ...PAGE_SIZES.map((p) => ({ value: p.id, label: p.id }))]} />
            </div>
            <div className="field">
              <label>{t("pageops.count")}</label>
              <input className="input" type="number" min={1} max={500} style={{ width: 90 }} value={count} onChange={(e) => setCount(Number(e.target.value) || 1)} />
            </div>
          </div>
          <div className="field">
            <label>{t("pageops.orientation")}</label>
            <Segmented
              value={landscape ? "l" : "p"}
              onChange={(v) => setLandscape(v === "l")}
              options={[
                { value: "p", label: t("pageops.portrait") },
                { value: "l", label: t("pageops.landscape") },
              ]}
            />
          </div>
        </>
      )}
      {mode === "insertFile" && (
        <>
          <div className="field">
            <label>{t("pageops.source")}</label>
            <div className="row">
              <input className="input" style={{ flex: 1 }} readOnly value={source?.path ?? ""} placeholder={t("pageops.chooseFile")} />
              <button type="button" className="btn" onClick={() => void pickSource()}>
                {t("common.browse")}
              </button>
            </div>
          </div>
          {source && (
            <div className="field">
              <label>{t("pageops.sourcePages")}</label>
              <RangeInput value={sourceRange} onChange={setSourceRange} invalid={!parsePageRange(sourceRange, source.pages)} />
              <span className="field-hint">{t("common.pages", { count: source.pages })}</span>
            </div>
          )}
          {positionField}
        </>
      )}
    </Dialog>
  );
}

export function ExportImageDialog({ tabId, done }: { tabId: string; done: () => void }) {
  const t = useT();
  const c = getController(tabId);
  const [range, setRange] = useState(String(c?.state.page ?? 1));
  const [format, setFormat] = useState<"png" | "jpeg">("png");
  const [dpi, setDpi] = useState(150);
  const [working, setWorking] = useState(false);
  if (!c) return null;
  const n = c.state.numPages;
  const pages = parsePageRange(range, n);

  const run = async () => {
    if (!pages || !c.pdf) return;
    const base = stripExtension(c.state.fileName);
    const first = await save({
      defaultPath: joinPath(dirname(c.filePath), `${base}-${pages[0]}.${format === "png" ? "png" : "jpg"}`),
      filters: [{ name: format.toUpperCase(), extensions: [format === "png" ? "png" : "jpg"] }],
    });
    if (!first) return;
    setWorking(true);
    let cancelled = false;
    try {
      const dir = dirname(first);
      const stem = stripExtension(first.slice(dir.length + 1)).replace(/\.(png|jpe?g)$/i, "").replace(/-\d+$/, "");
      for (let i = 0; i < pages.length && !cancelled; i++) {
        setBusy(t("export.working", { progress: `${i + 1}/${pages.length}` }), (i + 1) / pages.length, () => (cancelled = true));
        const page = await c.pdf.getPage(pages[i]);
        const viewport = page.getViewport({ scale: dpi / 72, rotation: (page.rotate + c.state.rotation) % 360 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext("2d", { alpha: format === "png" });
        if (!ctx) throw new Error("canvas unavailable");
        if (format === "jpeg") {
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        await page.render({ canvas, canvasContext: ctx, viewport, intent: "print", annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE }).promise;
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, format === "png" ? "image/png" : "image/jpeg", 0.92));
        canvas.width = canvas.height = 0;
        if (!blob) throw new Error("encoding failed");
        const path = pages.length === 1 ? first : joinPath(dir, `${stem}-${pages[i]}.${format === "png" ? "png" : "jpg"}`);
        await api.fsWrite(path, new Uint8Array(await blob.arrayBuffer()));
      }
      if (!cancelled) toast("success", t("export.image.done", { path: pages.length === 1 ? first : dir }));
      done();
    } catch (err) {
      toast("error", toAppError(err).message);
    } finally {
      setWorking(false);
      setBusy(null);
    }
  };

  return (
    <Dialog
      title={t("export.image.title")}
      icon={FileDown}
      onClose={done}
      onSubmit={() => !working && void run()}
      footer={
        <>
          <button type="button" className="btn" onClick={done}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn primary" disabled={!pages || working} onClick={() => void run()}>
            {t("common.export")}
          </button>
        </>
      }
    >
      <div className="field">
        <label>{t("pageops.pages")}</label>
        <RangeInput value={range} onChange={setRange} invalid={!pages} />
      </div>
      <div className="row">
        <div className="field">
          <label>{t("export.image.format")}</label>
          <Segmented value={format} onChange={setFormat} options={[{ value: "png", label: "PNG" }, { value: "jpeg", label: "JPEG" }]} />
        </div>
        <div className="field">
          <label>{t("export.image.resolution")}</label>
          <Select value={dpi} onChange={setDpi} options={[72, 96, 150, 200, 300, 600].map((d) => ({ value: d, label: `${d} dpi` }))} />
        </div>
      </div>
    </Dialog>
  );
}
