/**
 * Page editing dialogs: insert files (PDFs and pictures), replace pages, split the document,
 * watermark and password protection.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Droplets,
  Eye,
  EyeOff,
  FileImage,
  FilePlus2,
  FileText,
  FolderOpen,
  ImagePlus,
  Lock,
  LockOpen,
  Replace,
  Scissors,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Dialog } from "../common/Dialog";
import { ColorPicker, Segmented, Select, Slider, Switch } from "../common/controls";
import { PAGE_SIZES, RangeInput } from "./DocumentDialogs";
import { currentLocale, t as translate, useT } from "../../i18n";
import { getController } from "../../state/tabs";
import { confirm, openDialog, setBusy, toast } from "../../state/ui";
import { setFileDropTarget } from "../../state/fileDrop";
import { toAppError } from "../../lib/errors";
import { api } from "../../lib/ipc";
import { formatPageRange, parsePageRange } from "../../document/print";
import { dirname, joinPath, stripExtension } from "../../document/fileActions";
import { hexToRgb } from "../../annotations/model";
import type { DocumentPermissions, SecurityInfo, WatermarkPosition, WatermarkSpec } from "../../annotations/dto";
import {
  isPdfPath,
  isPicturePath,
  loadSource,
  passwordStrength,
  pickSourceFiles,
  planInsertion,
  planReplace,
  planSplit,
  preparePicture,
  releaseSource,
  sourcePageCount,
  splitFileNames,
  watermarkPlacements,
  type PictureLayout,
  type SourceFile,
  type SplitMode,
} from "../../document/pageEditing";
import type { DocumentController } from "../../document/DocumentController";

// ------------------------------------------------------------------------------------ shared

type LayoutChoice = "original" | "current" | "A4" | "Letter" | "A3" | "A5" | "Legal";
type MarginChoice = "none" | "narrow" | "normal";
const MARGINS: Record<MarginChoice, number> = { none: 0, narrow: 18, normal: 36 };

function pictureLayout(c: DocumentController, choice: LayoutChoice, margin: MarginChoice): PictureLayout {
  if (choice === "original") return { pageSize: null, margin: MARGINS[margin] };
  if (choice === "current") {
    const size = c.state.pageSize ?? [595.28, 841.89];
    return { pageSize: [Math.min(size[0], size[1]), Math.max(size[0], size[1])], margin: MARGINS[margin] };
  }
  const preset = PAGE_SIZES.find((p) => p.id === choice) ?? PAGE_SIZES[0];
  return { pageSize: [preset.w, preset.h], margin: MARGINS[margin] };
}

function PictureLayoutFields({
  layout,
  margin,
  onLayout,
  onMargin,
}: {
  layout: LayoutChoice;
  margin: MarginChoice;
  onLayout: (v: LayoutChoice) => void;
  onMargin: (v: MarginChoice) => void;
}) {
  const t = useT();
  return (
    <div className="row wrap">
      <div className="field" style={{ flex: 1, minWidth: 200 }}>
        <label>{t("insert.pictureSize")}</label>
        <Select
          value={layout}
          onChange={onLayout}
          options={[
            { value: "current", label: t("insert.size.current") },
            { value: "original", label: t("insert.size.original") },
            ...(["A4", "Letter", "A3", "A5", "Legal"] as const).map((id) => ({ value: id, label: id })),
          ]}
        />
      </div>
      <div className="field">
        <label>{t("insert.margin")}</label>
        <Segmented
          value={margin}
          onChange={onMargin}
          options={[
            { value: "none", label: t("insert.margin.none") },
            { value: "narrow", label: t("insert.margin.narrow") },
            { value: "normal", label: t("insert.margin.normal") },
          ]}
        />
      </div>
    </div>
  );
}

async function askSourcePassword(name: string, retry: boolean): Promise<string | null> {
  return openDialog("password", { fileName: name, reason: retry ? "incorrect" : "need" });
}

/** List of files to insert, with reordering, page ranges and removal. */
function SourceList({ sources, onChange }: { sources: SourceFile[]; onChange: (next: SourceFile[]) => void }) {
  const t = useT();
  const [ranges, setRanges] = useState<Record<string, string>>({});
  const swap = (i: number, j: number) => {
    const next = [...sources];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <ul className="source-list">
      {sources.map((s, i) => {
        const key = `${s.path}#${i}`;
        const rangeText = ranges[key] ?? (s.kind === "pdf" ? (s.pages ? formatPageRange(s.pages) : "") : "");
        const invalid = s.kind === "pdf" && rangeText.trim() !== "" && !parsePageRange(rangeText, s.pageCount);
        return (
          <li key={key} className="source-item">
            <div className="source-icon">
              {s.kind === "picture" && s.preview ? <img src={s.preview} alt="" /> : s.kind === "picture" ? <FileImage size={22} /> : <FileText size={22} />}
            </div>
            <div className="source-main">
              <div className="source-name" title={s.path}>
                {s.name}
              </div>
              {s.kind === "pdf" ? (
                <div className="source-meta">
                  <span className="muted">{t("common.pages", { count: s.pageCount })}</span>
                  <input
                    className={`input small${invalid ? " invalid" : ""}`}
                    placeholder={t("insert.allPages")}
                    value={rangeText}
                    aria-label={t("pageops.sourcePages")}
                    onChange={(e) => {
                      const text = e.target.value;
                      setRanges((r) => ({ ...r, [key]: text }));
                      const pages = text.trim() ? parsePageRange(text, s.pageCount) : null;
                      if (text.trim() && !pages) return;
                      onChange(sources.map((x, j) => (j === i && x.kind === "pdf" ? { ...x, pages } : x)));
                    }}
                  />
                </div>
              ) : (
                <div className="source-meta muted">
                  {t("insert.picture")} · {s.image.width} × {s.image.height}
                </div>
              )}
            </div>
            <div className="source-actions">
              <button type="button" className="icon-btn small" disabled={i === 0} aria-label={t("insert.moveUp")} onClick={() => swap(i, i - 1)}>
                <ArrowUp size={15} />
              </button>
              <button type="button" className="icon-btn small" disabled={i === sources.length - 1} aria-label={t("insert.moveDown")} onClick={() => swap(i, i + 1)}>
                <ArrowDown size={15} />
              </button>
              <button
                type="button"
                className="icon-btn small"
                aria-label={t("common.remove")}
                onClick={() => {
                  releaseSource(s);
                  onChange(sources.filter((_, j) => j !== i));
                }}
              >
                <X size={15} />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Load `paths` as sources, reporting files that cannot be used. */
async function loadSources(paths: string[]): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  const skipped: string[] = [];
  for (const path of paths) {
    if (!isPdfPath(path) && !isPicturePath(path)) {
      skipped.push(path.split(/[\\/]/).pop() ?? path);
      continue;
    }
    try {
      const source = await loadSource(path, askSourcePassword);
      if (source) out.push(source);
    } catch (err) {
      toast("error", toAppError(err).message, { detail: path });
    }
  }
  if (skipped.length) toast("warning", translate("insert.unsupported", { names: skipped.join(", ") }));
  return out;
}

/** Hook: the sources of a dialog, accepting files dropped onto the window. */
function useSources(initial: string[] | undefined, kinds: "both" | "pdf" = "both") {
  const [sources, setSources] = useState<SourceFile[]>([]);
  const [loading, setLoading] = useState(false);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const add = async (paths: string[]) => {
    if (!paths.length) return;
    setLoading(true);
    try {
      const loaded = await loadSources(kinds === "pdf" ? paths.filter(isPdfPath) : paths);
      setSources((s) => [...s, ...loaded]);
    } finally {
      setLoading(false);
    }
  };
  // Load the initial files once (effects run twice in development).
  const loadedInitial = useRef(false);
  useEffect(() => {
    if (initial?.length && !loadedInitial.current) {
      loadedInitial.current = true;
      void add(initial);
    }
    const remove = setFileDropTarget({
      label: () => translate("insert.dropHint"),
      over: () => undefined,
      leave: () => undefined,
      drop: (paths) => void add(paths),
    });
    return () => {
      remove();
      sourcesRef.current.forEach(releaseSource);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { sources, setSources, loading, add };
}

// ------------------------------------------------------------------------------ insert files

export function InsertFilesDialog({ tabId, at, paths, done }: { tabId: string; at?: number; paths?: string[]; done: () => void }) {
  const t = useT();
  const c = getController(tabId);
  const n = c?.state.numPages ?? 1;
  const initialAt = at ?? c?.state.page ?? n;
  const [position, setPosition] = useState<"start" | "after" | "end">(initialAt <= 0 ? "start" : initialAt >= n ? "end" : "after");
  const [anchor, setAnchor] = useState(Math.max(1, Math.min(n, initialAt)));
  const [layout, setLayout] = useState<LayoutChoice>("current");
  const [margin, setMargin] = useState<MarginChoice>("none");
  const [working, setWorking] = useState(false);
  const { sources, setSources, loading, add } = useSources(paths);
  if (!c) return null;
  const insertAt = position === "start" ? 0 : position === "end" ? n : anchor;
  const total = sources.reduce((sum, s) => sum + sourcePageCount(s), 0);
  const hasPictures = sources.some((s) => s.kind === "picture");

  const run = async () => {
    setWorking(true);
    setBusy(t("pageops.working"));
    try {
      const { ops, blobs } = planInsertion(sources, insertAt, pictureLayout(c, layout, margin));
      await c.applyPageOps(ops, blobs, t("cmd.page.insertFile"));
      if (!c.state.organizing) c.goToPage(insertAt + 1, { recordHistory: false });
      toast("success", t("insert.done", { count: total }));
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
      title={t("insert.title")}
      icon={FilePlus2}
      size="wide"
      onClose={done}
      onSubmit={() => total > 0 && !working && void run()}
      footer={
        <>
          <span className="dialog-footer-note muted">{total > 0 ? t("insert.summary", { count: total, files: sources.length }) : ""}</span>
          <button type="button" className="btn" onClick={done}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn primary" disabled={!total || working || loading} onClick={() => void run()}>
            {t("insert.insert")}
          </button>
        </>
      }
    >
      <p className="dialog-lead muted">{t("insert.lead")}</p>
      {sources.length > 0 ? (
        <SourceList sources={sources} onChange={setSources} />
      ) : (
        <button type="button" className="drop-zone" onClick={async () => add(await pickSourceFiles())}>
          <FilePlus2 size={30} />
          <strong>{loading ? t("insert.loading") : t("insert.choose")}</strong>
          <span className="muted">{t("insert.dropOrChoose")}</span>
        </button>
      )}
      {sources.length > 0 && (
        <button type="button" className="btn ghost small add-more" disabled={loading} onClick={async () => add(await pickSourceFiles())}>
          <FilePlus2 size={15} /> {loading ? t("insert.loading") : t("insert.addMore")}
        </button>
      )}
      <div className="field">
        <label>{t("pageops.position")}</label>
        <div className="row">
          <Select
            value={position}
            onChange={setPosition}
            options={[
              { value: "start", label: t("pageops.atStart") },
              { value: "after", label: t("pageops.after") },
              { value: "end", label: t("pageops.atEnd") },
            ]}
          />
          {position === "after" && (
            <input className="input" type="number" min={1} max={n} style={{ width: 90 }} value={anchor} onChange={(e) => setAnchor(Math.max(1, Math.min(n, Number(e.target.value) || 1)))} />
          )}
        </div>
      </div>
      {hasPictures && <PictureLayoutFields layout={layout} margin={margin} onLayout={setLayout} onMargin={setMargin} />}
    </Dialog>
  );
}

// ------------------------------------------------------------------------------ replace pages

export function ReplacePagesDialog({ tabId, pages, done }: { tabId: string; pages?: number[]; done: () => void }) {
  const t = useT();
  const c = getController(tabId);
  const n = c?.state.numPages ?? 1;
  const [range, setRange] = useState(pages?.length ? formatPageRange(pages) : String(c?.state.page ?? 1));
  const [layout, setLayout] = useState<LayoutChoice>("current");
  const [margin, setMargin] = useState<MarginChoice>("none");
  const [working, setWorking] = useState(false);
  const { sources, setSources, loading, add } = useSources(undefined);
  if (!c) return null;
  const targets = parsePageRange(range, n);
  const total = sources.reduce((sum, s) => sum + sourcePageCount(s), 0);
  const replacingAll = !!targets && targets.length >= n && total === 0;

  const run = async () => {
    if (!targets) return;
    setWorking(true);
    setBusy(t("pageops.working"));
    try {
      const plan = planReplace(targets, (at) => ({ ...planInsertion(sources, at, pictureLayout(c, layout, margin)), count: total }));
      await c.applyPageOps(plan.ops, plan.blobs, t("organize.replace"));
      toast("success", t("replace.done", { count: targets.length, inserted: total }));
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
      title={t("replace.title")}
      icon={Replace}
      size="wide"
      onClose={done}
      onSubmit={() => !!targets && total > 0 && !working && void run()}
      footer={
        <>
          <button type="button" className="btn" onClick={done}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn primary" disabled={!targets || !total || working || loading || replacingAll} onClick={() => void run()}>
            {t("replace.replace")}
          </button>
        </>
      }
    >
      <div className="field">
        <label>{t("replace.targets")}</label>
        <RangeInput value={range} onChange={setRange} invalid={!targets} />
        <span className="field-hint">{t("common.pages", { count: n })}</span>
      </div>
      <div className="field">
        <label>{t("replace.with")}</label>
        {sources.length > 0 ? (
          <SourceList sources={sources} onChange={setSources} />
        ) : (
          <button type="button" className="drop-zone small" onClick={async () => add(await pickSourceFiles())}>
            <FilePlus2 size={24} />
            <strong>{loading ? t("insert.loading") : t("insert.choose")}</strong>
            <span className="muted">{t("insert.dropOrChoose")}</span>
          </button>
        )}
      </div>
      {sources.some((s) => s.kind === "picture") && <PictureLayoutFields layout={layout} margin={margin} onLayout={setLayout} onMargin={setMargin} />}
      {targets && total > 0 && <p className="muted">{t("replace.summary", { from: targets.length, to: total })}</p>}
    </Dialog>
  );
}

// -------------------------------------------------------------------------------- split

export function SplitDialog({ tabId, done }: { tabId: string; done: () => void }) {
  const t = useT();
  const c = getController(tabId);
  const n = c?.state.numPages ?? 1;
  const [mode, setMode] = useState<SplitMode>("every");
  const [every, setEvery] = useState(Math.max(1, Math.min(10, Math.ceil(n / 2))));
  const [parts, setParts] = useState(Math.min(2, n));
  const [ranges, setRanges] = useState(n > 1 ? `1-${Math.ceil(n / 2)}, ${Math.ceil(n / 2) + 1}-${n}` : "1");
  const [folder, setFolder] = useState(c ? dirname(c.filePath) : "");
  const [working, setWorking] = useState(false);
  if (!c) return null;
  const groups = planSplit(n, mode, mode === "every" ? every : mode === "parts" ? parts : ranges);
  const base = stripExtension(c.state.fileName);
  const names = groups ? splitFileNames(base, groups) : [];

  const run = async () => {
    if (!groups) return;
    const targets = names.map((name) => joinPath(folder, name));
    const existing = (await Promise.all(targets.map((p) => api.fsStat(p).then((s) => s.exists).catch(() => false)))).filter(Boolean).length;
    if (existing) {
      const answer = await confirm({
        title: t("split.overwriteTitle"),
        message: t("split.overwrite", { count: existing }),
        confirmLabel: t("split.overwriteConfirm"),
        danger: true,
      });
      if (answer.choice !== "confirm") return;
    }
    setWorking(true);
    try {
      setBusy(t("split.working", { done: 0, total: groups.length }), 0);
      const bytes = await c.buildCurrentBytes();
      for (let i = 0; i < groups.length; i++) {
        const [a, b] = groups[i];
        const pages = Array.from({ length: b - a + 1 }, (_, k) => a - 1 + k);
        await api.pdfExtract({ password: c.documentPassword, pages, target: targets[i] }, bytes);
        setBusy(t("split.working", { done: i + 1, total: groups.length }), (i + 1) / groups.length);
      }
      toast("success", t("split.done", { count: groups.length }), {
        action: { label: t("split.showFiles"), run: () => void revealItemInDir(targets[0]).catch(() => undefined) },
        timeout: 8000,
      });
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
      title={t("split.title")}
      icon={Scissors}
      onClose={done}
      onSubmit={() => !!groups && !working && void run()}
      footer={
        <>
          <button type="button" className="btn" onClick={done}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn primary" disabled={!groups || working || groups.length < 1} onClick={() => void run()}>
            {t("split.split", { count: groups?.length ?? 0 })}
          </button>
        </>
      }
    >
      <div className="field">
        <label>{t("split.how")}</label>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "every", label: t("split.mode.every") },
            { value: "parts", label: t("split.mode.parts") },
            { value: "ranges", label: t("split.mode.ranges") },
          ]}
        />
      </div>
      {mode === "every" && (
        <div className="field">
          <label>{t("split.everyLabel")}</label>
          <input className="input" type="number" min={1} max={n} style={{ width: 110 }} value={every} onChange={(e) => setEvery(Number(e.target.value) || 1)} />
        </div>
      )}
      {mode === "parts" && (
        <div className="field">
          <label>{t("split.partsLabel")}</label>
          <input className="input" type="number" min={1} max={n} style={{ width: 110 }} value={parts} onChange={(e) => setParts(Number(e.target.value) || 1)} />
        </div>
      )}
      {mode === "ranges" && (
        <div className="field">
          <label>{t("split.rangesLabel")}</label>
          <input className={`input${groups ? "" : " invalid"}`} value={ranges} onChange={(e) => setRanges(e.target.value)} placeholder="1-3, 4-8, 9-" />
          <span className="field-hint">{t("split.rangesHint")}</span>
        </div>
      )}
      <div className="field">
        <label>{t("split.folder")}</label>
        <div className="row">
          <input className="input" style={{ flex: 1 }} readOnly value={folder} />
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const dir = await open({ directory: true, multiple: false, defaultPath: folder || undefined });
              if (typeof dir === "string") setFolder(dir);
            }}
          >
            <FolderOpen size={15} /> {t("common.browse")}
          </button>
        </div>
      </div>
      <div className="field">
        <label>{t("split.preview")}</label>
        {groups ? (
          <ul className="split-preview">
            {names.slice(0, 8).map((name, i) => (
              <li key={name}>
                <FileText size={14} /> <span>{name}</span>
                <span className="muted">{t("common.pages", { count: groups[i][1] - groups[i][0] + 1 })}</span>
              </li>
            ))}
            {names.length > 8 && <li className="muted">{t("split.more", { count: names.length - 8 })}</li>}
          </ul>
        ) : (
          <span className="field-hint error">{t("split.invalid")}</span>
        )}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------ watermark

interface WatermarkDraft {
  kind: "text" | "picture";
  text: string;
  fontSize: number;
  bold: boolean;
  color: string;
  imageScale: number;
  opacity: number;
  rotation: number;
  position: WatermarkPosition;
  layer: "above" | "below";
}

const WATERMARK_KEY = "yapr.watermark";

function loadDraft(defaultText: string): WatermarkDraft {
  const fallback: WatermarkDraft = {
    kind: "text",
    text: defaultText,
    fontSize: 60,
    bold: true,
    color: "#e5484d",
    imageScale: 0.4,
    opacity: 0.25,
    rotation: 45,
    position: "center",
    layer: "above",
  };
  try {
    const saved = JSON.parse(localStorage.getItem(WATERMARK_KEY) ?? "null") as Partial<WatermarkDraft> | null;
    return saved ? { ...fallback, ...saved } : fallback;
  } catch {
    return fallback;
  }
}

/** Render `page` (1-based) to a data URL about `width` pixels wide, with its displayed size in points. */
async function renderPreview(c: DocumentController, page: number, width: number): Promise<{ url: string; w: number; h: number } | null> {
  const pdf = c.pdf;
  if (!pdf) return null;
  const p = await pdf.getPage(page);
  const base = p.getViewport({ scale: 1 });
  const viewport = p.getViewport({ scale: (width * (window.devicePixelRatio || 1)) / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await p.render({ canvas, canvasContext: ctx, viewport }).promise;
  const url = canvas.toDataURL("image/jpeg", 0.85);
  canvas.width = canvas.height = 0;
  return { url, w: base.width, h: base.height };
}

const POSITIONS: Exclude<WatermarkPosition, "tile">[] = ["topLeft", "top", "topRight", "left", "center", "right", "bottomLeft", "bottom", "bottomRight"];

function WatermarkPreview({ c, page, draft, picture }: { c: DocumentController; page: number; draft: WatermarkDraft; picture: { url: string; width: number; height: number } | null }) {
  const [shot, setShot] = useState<{ url: string; w: number; h: number } | null>(null);
  useEffect(() => {
    let alive = true;
    void renderPreview(c, page, 300).then((r) => alive && setShot(r));
    return () => {
      alive = false;
    };
  }, [c, page]);
  const block = useMemo(() => {
    if (draft.kind === "picture") {
      if (!picture || !shot) return null;
      const w = draft.imageScale * shot.w;
      return { w, h: (w * picture.height) / picture.width, lines: [] as string[] };
    }
    const lines = draft.text.split("\n").slice(0, 20);
    const canvas = document.createElement("canvas").getContext("2d");
    const size = draft.fontSize;
    if (canvas) canvas.font = `${draft.bold ? "bold " : ""}${size}px Helvetica, Arial, "Microsoft YaHei", sans-serif`;
    const w = Math.max(1, ...lines.map((l) => canvas?.measureText(l).width ?? l.length * size * 0.6));
    return { w, h: lines.length * size * 1.25, lines };
  }, [draft, picture, shot]);
  if (!shot) return <div className="wm-preview loading" />;
  const spots = block ? watermarkPlacements(draft.position, shot.w, shot.h, block.w, block.h, draft.rotation) : [];
  return (
    <div className="wm-preview">
      <img src={shot.url} alt="" />
      <svg
        viewBox={`0 0 ${shot.w} ${shot.h}`}
        preserveAspectRatio="none"
        style={draft.layer === "below" ? { mixBlendMode: "multiply" } : undefined}
        aria-hidden
      >
        <defs>
          <clipPath id="wm-clip">
            <rect x={0} y={0} width={shot.w} height={shot.h} />
          </clipPath>
        </defs>
        <g clipPath="url(#wm-clip)" opacity={draft.opacity}>
          {block &&
            spots.map(([x, y], i) => (
              // PDF y grows upwards; the SVG is drawn top-down.
              <g key={i} transform={`translate(${x} ${shot.h - y}) rotate(${-draft.rotation})`}>
                {draft.kind === "picture" && picture ? (
                  <image href={picture.url} x={-block.w / 2} y={-block.h / 2} width={block.w} height={block.h} preserveAspectRatio="none" />
                ) : (
                  block.lines.map((line, k) => (
                    <text
                      key={k}
                      x={0}
                      y={-block.h / 2 + (k + 1) * draft.fontSize * 1.25 - draft.fontSize * 0.35}
                      textAnchor="middle"
                      fontSize={draft.fontSize}
                      fontWeight={draft.bold ? 700 : 400}
                      fill={draft.color}
                      fontFamily='Helvetica, Arial, "Microsoft YaHei", sans-serif'
                    >
                      {line}
                    </text>
                  ))
                )}
              </g>
            ))}
        </g>
      </svg>
    </div>
  );
}

export function WatermarkDialog({ tabId, pages: initialPages, done }: { tabId: string; pages?: number[]; done: () => void }) {
  const t = useT();
  const c = getController(tabId);
  const n = c?.state.numPages ?? 1;
  const [draft, setDraft] = useState<WatermarkDraft>(() => loadDraft(t("watermark.defaultText")));
  const [scope, setScope] = useState<"all" | "selected" | "range">(initialPages?.length ? "selected" : "all");
  const [range, setRange] = useState(initialPages?.length ? formatPageRange(initialPages) : `1-${n}`);
  const [picture, setPicture] = useState<{ bytes: Uint8Array; image: { format: "jpeg" | "rgba"; width: number; height: number }; url: string; name: string } | null>(null);
  const [working, setWorking] = useState(false);
  const update = (patch: Partial<WatermarkDraft>) => setDraft((d) => ({ ...d, ...patch }));
  useEffect(() => () => void (picture && URL.revokeObjectURL(picture.url)), [picture]);
  if (!c) return null;
  const pages = scope === "all" ? Array.from({ length: n }, (_, i) => i + 1) : scope === "selected" ? initialPages ?? [] : parsePageRange(range, n);
  const previewPage = pages?.[0] ?? c.state.page;
  const ready = !!pages?.length && (draft.kind === "text" ? draft.text.trim().length > 0 : !!picture);

  const choosePicture = async () => {
    const [path] = await pickSourceFiles("picture", false);
    if (!path) return;
    try {
      const raw = await api.fsRead(path);
      const url = URL.createObjectURL(new Blob([raw as BlobPart]));
      const prepared = await preparePicture(raw);
      if (prepared.preview) URL.revokeObjectURL(prepared.preview);
      setPicture({ bytes: prepared.bytes, image: prepared.image, url, name: path.split(/[\\/]/).pop() ?? path });
      update({ kind: "picture" });
    } catch (err) {
      toast("error", toAppError(err).message);
    }
  };

  const run = async () => {
    if (!pages?.length) return;
    setWorking(true);
    setBusy(t("pageops.working"));
    try {
      const spec: WatermarkSpec = {
        text: draft.kind === "text" ? draft.text : null,
        fontSize: draft.fontSize,
        bold: draft.bold,
        color: hexToRgb(draft.color) ?? [0.5, 0.5, 0.5],
        image: draft.kind === "picture" && picture ? { blob: 0, ...picture.image } : null,
        imageScale: draft.imageScale,
        opacity: draft.opacity,
        rotation: draft.rotation,
        position: draft.position,
        layer: draft.layer,
        cjkHint: currentLocale(),
      };
      await c.applyPageOps([{ op: "watermark", pages: pages.map((p) => p - 1), watermark: spec }], picture && draft.kind === "picture" ? [picture.bytes] : [], t("watermark.title"));
      try {
        localStorage.setItem(WATERMARK_KEY, JSON.stringify({ ...draft, kind: "text" }));
      } catch {
        // Remembering the last watermark is a convenience only.
      }
      toast("success", t("watermark.done", { count: pages.length }), { action: { label: t("cmd.edit.undo"), run: () => void c.undo() } });
      done();
    } catch (err) {
      toast("error", toAppError(err).message);
    } finally {
      setWorking(false);
      setBusy(null);
    }
  };

  const tile = draft.position === "tile";
  return (
    <Dialog
      title={t("watermark.title")}
      icon={Droplets}
      size="xwide"
      onClose={done}
      footer={
        <>
          <span className="dialog-footer-note muted">{t("watermark.undoNote")}</span>
          <button type="button" className="btn" onClick={done}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn primary" disabled={!ready || working} onClick={() => void run()}>
            {t("watermark.apply", { count: pages?.length ?? 0 })}
          </button>
        </>
      }
    >
      <div className="wm-layout">
        <div className="wm-form">
          <Segmented
            value={draft.kind}
            onChange={(kind) => (kind === "picture" && !picture ? void choosePicture() : update({ kind }))}
            options={[
              { value: "text", label: t("watermark.text") },
              { value: "picture", label: t("watermark.picture") },
            ]}
          />
          {draft.kind === "text" ? (
            <>
              <div className="field">
                <label>{t("watermark.textLabel")}</label>
                <textarea className="input" rows={2} value={draft.text} maxLength={500} onChange={(e) => update({ text: e.target.value })} data-autofocus />
              </div>
              <div className="row wrap">
                <div className="field" style={{ flex: 1, minWidth: 180 }}>
                  <label>{t("watermark.fontSize")}</label>
                  <Slider value={draft.fontSize} min={12} max={200} step={2} onChange={(v) => update({ fontSize: v })} format={(v) => `${v} pt`} />
                </div>
                <div className="field">
                  <label>{t("watermark.bold")}</label>
                  <Switch checked={draft.bold} onChange={(bold) => update({ bold })} />
                </div>
              </div>
              <div className="field">
                <label>{t("watermark.color")}</label>
                <ColorPicker value={draft.color} onChange={(color) => color && update({ color })} presets={["#e5484d", "#808080", "#000000", "#1f6feb", "#2da44e", "#bf8700"]} />
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label>{t("watermark.pictureLabel")}</label>
                <div className="row">
                  <span className="wm-picture-name">{picture?.name ?? t("watermark.noPicture")}</span>
                  <button type="button" className="btn" onClick={() => void choosePicture()}>
                    <ImagePlus size={15} /> {t("common.browse")}
                  </button>
                </div>
              </div>
              <div className="field">
                <label>{t("watermark.scale")}</label>
                <Slider value={Math.round(draft.imageScale * 100)} min={5} max={100} onChange={(v) => update({ imageScale: v / 100 })} format={(v) => `${v}%`} />
              </div>
            </>
          )}
          <div className="field">
            <label>{t("watermark.opacity")}</label>
            <Slider value={Math.round(draft.opacity * 100)} min={5} max={100} onChange={(v) => update({ opacity: v / 100 })} format={(v) => `${v}%`} />
          </div>
          <div className="field">
            <label>{t("watermark.rotation")}</label>
            <Segmented
              value={draft.rotation}
              onChange={(rotation) => update({ rotation })}
              options={[0, 30, 45, 90, -30, -45].map((v) => ({ value: v, label: `${v}°` }))}
            />
          </div>
          <div className="row wrap" style={{ alignItems: "flex-start" }}>
            <div className="field">
              <label>{t("watermark.position")}</label>
              <div className={`wm-positions${tile ? " disabled" : ""}`} role="radiogroup">
                {POSITIONS.map((p) => (
                  <button key={p} type="button" role="radio" aria-checked={draft.position === p} aria-label={t(`watermark.pos.${p}`)} data-tip={t(`watermark.pos.${p}`)} onClick={() => update({ position: p })}>
                    <span />
                  </button>
                ))}
              </div>
              <label className="checkbox">
                <input type="checkbox" checked={tile} onChange={(e) => update({ position: e.target.checked ? "tile" : "center" })} /> {t("watermark.tile")}
              </label>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>{t("watermark.layer")}</label>
              <Segmented
                value={draft.layer}
                onChange={(layer) => update({ layer })}
                options={[
                  { value: "above", label: t("watermark.above") },
                  { value: "below", label: t("watermark.below") },
                ]}
              />
              <span className="field-hint">{draft.layer === "below" ? t("watermark.belowHint") : t("watermark.aboveHint")}</span>
            </div>
          </div>
          <div className="field">
            <label>{t("watermark.pages")}</label>
            <Segmented
              value={scope}
              onChange={setScope}
              options={[
                { value: "all", label: t("print.range.all") },
                ...(initialPages?.length ? [{ value: "selected" as const, label: t("watermark.selected", { count: initialPages.length }) }] : []),
                { value: "range", label: t("print.range.custom") },
              ]}
            />
            {scope === "range" && <RangeInput value={range} onChange={setRange} invalid={!pages} />}
          </div>
        </div>
        <div className="wm-side">
          <WatermarkPreview c={c} page={previewPage} draft={draft} picture={picture ? { url: picture.url, width: picture.image.width, height: picture.image.height } : null} />
          <span className="muted small">{t("watermark.previewOf", { page: previewPage })}</span>
        </div>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------ security

function PasswordField({
  label,
  value,
  onChange,
  confirmValue,
  onConfirm,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  confirmValue: string;
  onConfirm: (v: string) => void;
  autoFocus?: boolean;
}) {
  const t = useT();
  const [show, setShow] = useState(false);
  const strength = passwordStrength(value);
  const mismatch = confirmValue.length > 0 && confirmValue !== value;
  return (
    <div className="password-fields">
      <div className="field">
        <label>{label}</label>
        <div className="input-with-button">
          <input className="input" type={show ? "text" : "password"} value={value} autoComplete="new-password" onChange={(e) => onChange(e.target.value)} data-autofocus={autoFocus || undefined} />
          <button type="button" className="icon-btn small" aria-label={show ? t("security.hide") : t("security.show")} onClick={() => setShow(!show)}>
            {show ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
        {value && (
          <div className={`strength s${strength}`}>
            <span />
            <span />
            <span />
            <em>{t(`security.strength.${strength}`)}</em>
          </div>
        )}
      </div>
      <div className="field">
        <label>{t("security.confirm")}</label>
        <input className={`input${mismatch ? " invalid" : ""}`} type={show ? "text" : "password"} value={confirmValue} autoComplete="new-password" onChange={(e) => onConfirm(e.target.value)} />
        {mismatch && <span className="field-hint error">{t("security.mismatch")}</span>}
      </div>
    </div>
  );
}

function permissionSummary(t: ReturnType<typeof useT>, p: DocumentPermissions): string {
  const denied = [
    !p.print && t("security.perm.print"),
    !p.copy && t("security.perm.copy"),
    !p.annotate && t("security.perm.annotate"),
    !p.modify && t("security.perm.modify"),
  ].filter(Boolean);
  return denied.length ? t("security.denied", { list: denied.join(t("security.listSeparator")) }) : t("security.noRestrictions");
}

export function SecurityDialog({ tabId, done }: { tabId: string; done: () => void }) {
  const t = useT();
  const c = getController(tabId);
  const [info, setInfo] = useState<SecurityInfo | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [unlock, setUnlock] = useState("");
  const [unlockError, setUnlockError] = useState(false);
  const [needOpen, setNeedOpen] = useState(true);
  const [openPw, setOpenPw] = useState("");
  const [openPw2, setOpenPw2] = useState("");
  const [restrict, setRestrict] = useState(false);
  const [ownerPw, setOwnerPw] = useState("");
  const [ownerPw2, setOwnerPw2] = useState("");
  const [print, setPrint] = useState<"none" | "low" | "high">("high");
  const [copy, setCopy] = useState(false);
  const [annotate, setAnnotate] = useState(true);
  const [modify, setModify] = useState(false);
  const [working, setWorking] = useState(false);

  const refresh = () => {
    if (!c) return;
    void c
      .securityInfo()
      .then((i) => {
        setInfo(i);
        if (i.encrypted) {
          setNeedOpen(i.openPassword);
          setRestrict(i.restricted);
          setPrint(!i.permissions.print ? "none" : i.permissions.printHighQuality ? "high" : "low");
          setCopy(i.permissions.copy);
          setAnnotate(i.permissions.annotate);
          setModify(i.permissions.modify);
        }
      })
      .catch((err) => setFailed(toAppError(err).message));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refresh, [c]);
  if (!c) return null;

  const locked = !!info?.restricted && !info.ownerAccess && !c.hasOwnerAccess;
  const errors: string[] = [];
  if (!needOpen && !restrict) errors.push(t("security.chooseOne"));
  if (needOpen && !openPw) errors.push(t("security.enterOpen"));
  if (needOpen && openPw !== openPw2) errors.push(t("security.mismatch"));
  if (restrict && !ownerPw) errors.push(t("security.enterOwner"));
  if (restrict && ownerPw !== ownerPw2) errors.push(t("security.mismatch"));
  if (restrict && needOpen && ownerPw && ownerPw === openPw) errors.push(t("security.samePasswords"));
  const valid = errors.length === 0;

  const apply = async () => {
    setWorking(true);
    setBusy(t("security.working"));
    try {
      const permissions: DocumentPermissions = restrict
        ? { print: print !== "none", printHighQuality: print === "high", copy, modify, annotate, fillForms: annotate || modify, assemble: modify }
        : { print: true, printHighQuality: true, copy: true, modify: true, annotate: true, fillForms: true, assemble: true };
      await c.applySecurity({ openPassword: needOpen ? openPw : "", permissionsPassword: restrict ? ownerPw : "", permissions });
      toast("success", t("security.applied"), {
        detail: t("security.saveToApply"),
        action: { label: t("common.save"), run: () => void c.save() },
        timeout: 9000,
      });
      done();
    } catch (err) {
      toast("error", toAppError(err).message);
    } finally {
      setWorking(false);
      setBusy(null);
    }
  };

  const remove = async () => {
    const answer = await confirm({
      title: t("security.removeTitle"),
      message: t("security.removeMessage"),
      confirmLabel: t("security.remove"),
      danger: true,
    });
    if (answer.choice !== "confirm") return;
    setWorking(true);
    setBusy(t("security.working"));
    try {
      await c.applySecurity(null);
      toast("success", t("security.removed"), {
        detail: t("security.saveToApply"),
        action: { label: t("common.save"), run: () => void c.save() },
        timeout: 9000,
      });
      done();
    } catch (err) {
      toast("error", toAppError(err).message);
    } finally {
      setWorking(false);
      setBusy(null);
    }
  };

  const tryUnlock = async () => {
    setWorking(true);
    const ok = await c.unlockPermissions(unlock);
    setWorking(false);
    if (!ok) {
      setUnlockError(true);
      return;
    }
    toast("success", t("security.unlocked"));
    refresh();
  };

  return (
    <Dialog
      title={t("security.title")}
      icon={ShieldCheck}
      size="wide"
      onClose={done}
      onSubmit={() => (locked ? void tryUnlock() : valid && !working && void apply())}
      footer={
        locked ? (
          <>
            <button type="button" className="btn" onClick={done}>
              {t("common.close")}
            </button>
            <button type="button" className="btn primary" disabled={!unlock || working} onClick={() => void tryUnlock()}>
              <LockOpen size={15} /> {t("security.unlock")}
            </button>
          </>
        ) : (
          <>
            {info?.encrypted && (
              <button type="button" className="btn danger ghost" disabled={working} onClick={() => void remove()}>
                <Trash2 size={15} /> {t("security.remove")}
              </button>
            )}
            <span className="spacer" />
            <button type="button" className="btn" onClick={done}>
              {t("common.cancel")}
            </button>
            <button type="button" className="btn primary" disabled={!valid || working || !info} onClick={() => void apply()}>
              <Lock size={15} /> {info?.encrypted ? t("security.update") : t("security.protect")}
            </button>
          </>
        )
      }
    >
      <div className={`security-status${info?.encrypted ? " on" : ""}`}>
        {info?.encrypted ? <Lock size={20} /> : <LockOpen size={20} />}
        <div>
          <strong>{failed ? t("security.unknown") : !info ? t("common.loading") : info.encrypted ? t("security.statusOn", { method: info.method ?? "" }) : t("security.statusOff")}</strong>
          {info?.encrypted && (
            <span className="muted">
              {info.openPassword ? t("security.needsOpen") : t("security.opensFreely")} · {permissionSummary(t, info.permissions)}
            </span>
          )}
          {failed && <span className="muted">{failed}</span>}
        </div>
      </div>

      {locked ? (
        <div className="field">
          <p>{t("security.lockedLead")}</p>
          <label>{t("security.ownerPassword")}</label>
          <input
            className={`input${unlockError ? " invalid" : ""}`}
            type="password"
            value={unlock}
            data-autofocus
            onChange={(e) => {
              setUnlock(e.target.value);
              setUnlockError(false);
            }}
          />
          {unlockError && <span className="field-hint error">{t("error.OWNER_PASSWORD")}</span>}
        </div>
      ) : (
        <>
          <section className="security-section">
            <label className="checkbox strong">
              <input type="checkbox" checked={needOpen} onChange={(e) => setNeedOpen(e.target.checked)} />
              {t("security.requireOpen")}
            </label>
            <p className="muted small">{t("security.requireOpenHint")}</p>
            {needOpen && <PasswordField label={t("security.openPassword")} value={openPw} onChange={setOpenPw} confirmValue={openPw2} onConfirm={setOpenPw2} autoFocus />}
          </section>
          <section className="security-section">
            <label className="checkbox strong">
              <input type="checkbox" checked={restrict} onChange={(e) => setRestrict(e.target.checked)} />
              {t("security.restrict")}
            </label>
            <p className="muted small">{t("security.restrictHint")}</p>
            {restrict && (
              <>
                <PasswordField label={t("security.ownerPassword")} value={ownerPw} onChange={setOwnerPw} confirmValue={ownerPw2} onConfirm={setOwnerPw2} />
                <div className="permission-grid">
                  <div className="field">
                    <label>{t("security.perm.print")}</label>
                    <Select
                      value={print}
                      onChange={setPrint}
                      options={[
                        { value: "none", label: t("security.print.none") },
                        { value: "low", label: t("security.print.low") },
                        { value: "high", label: t("security.print.high") },
                      ]}
                    />
                  </div>
                  <label className="checkbox">
                    <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} /> {t("security.allowCopy")}
                  </label>
                  <label className="checkbox">
                    <input type="checkbox" checked={annotate} onChange={(e) => setAnnotate(e.target.checked)} /> {t("security.allowAnnotate")}
                  </label>
                  <label className="checkbox">
                    <input type="checkbox" checked={modify} onChange={(e) => setModify(e.target.checked)} /> {t("security.allowModify")}
                  </label>
                </div>
              </>
            )}
          </section>
          <div className="callout warning">
            <ShieldCheck size={16} />
            <span>{t("security.warning")}</span>
          </div>
          {(!needOpen && !restrict) || (restrict && needOpen && ownerPw && ownerPw === openPw) ? (
            <span className="field-hint error">{!needOpen && !restrict ? t("security.chooseOne") : t("security.samePasswords")}</span>
          ) : null}
        </>
      )}
    </Dialog>
  );
}

