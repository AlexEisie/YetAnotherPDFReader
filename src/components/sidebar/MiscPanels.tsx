/** Attachments, layers (optional content) and full-text search panels. */
import { useEffect, useRef, useState } from "react";
import { Download, Eye, EyeOff, FileIcon, Layers, Paperclip, RotateCcw, Search, Square } from "lucide-react";
import type { DocumentController } from "../../document/DocumentController";
import { useT, useLocale } from "../../i18n";
import { formatBytes } from "../../i18n/format";
import { saveBytesAs } from "../../document/externalLinks";
import { toast, useUi } from "../../state/ui";
import { toAppError } from "../../lib/errors";
import { searchDocument, type SearchHit } from "../../document/search";

// ------------------------------------------------------------------------------- attachments

interface AttachmentInfo {
  id: string;
  filename: string;
  description: string;
  size: number | null;
}

export function AttachmentsPanel({ c }: { c: DocumentController }) {
  const t = useT();
  const locale = useLocale();
  const [list, setList] = useState<AttachmentInfo[] | null>(null);

  useEffect(() => {
    let alive = true;
    c.pdf
      ?.getAttachments()
      .then((map) => {
        if (!alive) return;
        const out: AttachmentInfo[] = [];
        for (const [id, a] of map ?? []) {
          out.push({ id, filename: a.filename || a.rawFilename || id, description: a.description ?? "", size: a.content?.length ?? null });
        }
        setList(out);
      })
      .catch(() => alive && setList([]));
    return () => {
      alive = false;
    };
  }, [c]);

  const save = async (a: AttachmentInfo) => {
    try {
      const content = await c.pdf?.getAttachmentContent(a.id);
      if (!content) throw new Error("empty attachment");
      const path = await saveBytesAs(content, a.filename);
      if (path) toast("success", t("attach.saved", { path }));
    } catch (err) {
      toast("error", toAppError(err).message);
    }
  };

  if (list === null) return <div className="empty-state"><div className="spinner" /></div>;
  if (!list.length) {
    return (
      <div className="empty-state">
        <Paperclip size={32} />
        {t("attach.empty")}
      </div>
    );
  }
  return (
    <div className="sidebar-body" style={{ padding: 6 }}>
      {list.map((a) => (
        <div key={a.id} className="attachment-row" onDoubleClick={() => void save(a)}>
          <FileIcon size={20} className="faint" />
          <div className="info">
            <div className="name" title={a.filename}>{a.filename}</div>
            <div className="desc">{[a.description, a.size !== null ? formatBytes(a.size, locale) : ""].filter(Boolean).join(" · ")}</div>
          </div>
          <button type="button" className="icon-btn small" data-tip={t("attach.save")} onClick={() => void save(a)}>
            <Download size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------- layers

interface LayerRow {
  id: string;
  name: string;
  depth: number;
  visible: boolean;
  locked: boolean;
}

interface OptionalContentConfigLike {
  getOrder(): unknown[] | null;
  getGroup(id: string): { name?: string | null; visible: boolean; usage?: unknown } | null;
  setVisibility(id: string, visible: boolean, preserveRB?: boolean): void;
  [Symbol.iterator](): IterableIterator<[string, { name?: string | null; visible: boolean }]>;
}

function layerRows(config: OptionalContentConfigLike): LayerRow[] {
  const rows: LayerRow[] = [];
  const seen = new Set<string>();
  const walk = (order: unknown[], depth: number) => {
    for (const entry of order) {
      if (typeof entry === "string") {
        const g = config.getGroup(entry);
        if (!g) continue;
        seen.add(entry);
        rows.push({ id: entry, name: g.name || entry, depth, visible: g.visible, locked: false });
      } else if (entry && typeof entry === "object" && "order" in (entry as object)) {
        const e = entry as { name?: string | null; order: unknown[] };
        if (e.name) rows.push({ id: `label:${rows.length}`, name: e.name, depth, visible: true, locked: true });
        walk(e.order, depth + 1);
      } else if (Array.isArray(entry)) {
        walk(entry, depth + 1);
      }
    }
  };
  const order = config.getOrder();
  if (order) walk(order, 0);
  for (const [id, g] of config) {
    if (!seen.has(id)) rows.push({ id, name: g.name || id, depth: 0, visible: g.visible, locked: false });
  }
  return rows;
}

export function LayersPanel({ c }: { c: DocumentController }) {
  const t = useT();
  const [config, setConfig] = useState<OptionalContentConfigLike | null>(null);
  const [rows, setRows] = useState<LayerRow[] | null>(null);

  const load = async (fresh: boolean) => {
    const viewer = c.viewer as unknown as { optionalContentConfigPromise: Promise<OptionalContentConfigLike> } | null;
    if (!viewer || !c.pdf) return;
    const cfg = fresh
      ? ((await c.pdf.getOptionalContentConfig()) as unknown as OptionalContentConfigLike)
      : await viewer.optionalContentConfigPromise;
    if (fresh) viewer.optionalContentConfigPromise = Promise.resolve(cfg);
    setConfig(cfg);
    setRows(layerRows(cfg));
  };

  useEffect(() => {
    void load(false).catch(() => setRows([]));
  }, [c]); // `load` only depends on `c`

  if (rows === null) return <div className="empty-state"><div className="spinner" /></div>;
  if (!rows.length) {
    return (
      <div className="empty-state">
        <Layers size={32} />
        {t("layers.empty")}
      </div>
    );
  }
  const toggle = (row: LayerRow) => {
    if (!config || row.locked) return;
    config.setVisibility(row.id, !row.visible);
    const viewer = c.viewer as unknown as { optionalContentConfigPromise: Promise<OptionalContentConfigLike> };
    viewer.optionalContentConfigPromise = Promise.resolve(config);
    setRows(layerRows(config));
  };
  return (
    <div className="col" style={{ height: "100%", gap: 0 }}>
      <div className="panel-toolbar">
        <span className="spacer" />
        <button type="button" className="icon-btn small" data-tip={t("layers.reset")} onClick={() => void load(true)}>
          <RotateCcw size={14} />
        </button>
      </div>
      <div className="sidebar-body" style={{ padding: 6 }}>
        {rows.map((row) => (
          <div key={row.id} className={`layer-row${row.locked ? " locked" : ""}`} style={{ paddingLeft: 10 + row.depth * 16 }}>
            {row.locked ? (
              <Square size={14} className="faint" />
            ) : (
              <button type="button" className="icon-btn small" aria-pressed={row.visible} onClick={() => toggle(row)}>
                {row.visible ? <Eye size={15} /> : <EyeOff size={15} />}
              </button>
            )}
            <span className={row.visible ? "" : "faint"}>{row.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------- search

export function SearchPanel({ c }: { c: DocumentController }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWords, setWholeWords] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [progress, setProgress] = useState<{ page: number; total: number } | null>(null);
  const [active, setActive] = useState(-1);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    return () => abortRef.current?.abort();
  }, []);

  const run = async () => {
    abortRef.current?.abort();
    const q = query.trim();
    if (!q || !c.pdf) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setHits([]);
    setActive(-1);
    try {
      await searchDocument(c.pdf, q, { matchCase, wholeWords }, ac.signal, (found, page, total) => {
        setHits((h) => [...(h ?? []), ...found]);
        setProgress({ page, total });
      });
    } catch (err) {
      if (!toAppError(err).isCancellation) toast("error", toAppError(err).message);
    } finally {
      if (abortRef.current === ac) setProgress(null);
    }
  };


  return (
    <div className="col" style={{ height: "100%", gap: 0 }}>
      <form
        className="panel-toolbar"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div className="search-box">
          <Search size={13} />
          <input ref={inputRef} className="input small" value={query} placeholder={t("search.placeholder")} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="row" style={{ fontSize: "var(--fs-xs)", gap: 12 }}>
          <label className="checkbox">
            <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} />
            {t("search.matchCase")}
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={wholeWords} onChange={(e) => setWholeWords(e.target.checked)} />
            {t("search.wholeWords")}
          </label>
          <span className="spacer" />
          {progress ? (
            <button type="button" className="btn small" onClick={() => abortRef.current?.abort()}>
              {t("search.stop")}
            </button>
          ) : (
            <button type="submit" className="btn small primary" disabled={!query.trim()}>
              {t("common.search")}
            </button>
          )}
        </div>
      </form>
      <div className="sidebar-body search-results" data-keys="local">
        {progress && (
          <div className="faint" style={{ fontSize: "var(--fs-xs)", padding: "6px 8px" }}>
            {t("search.searching", { page: progress.page, total: progress.total })}
          </div>
        )}
        {hits === null && <div className="empty-state">{t("search.hint")}</div>}
        {hits !== null && !progress && <div className="faint" style={{ fontSize: "var(--fs-xs)", padding: "6px 8px" }}>{t("search.results", { count: hits.length })}</div>}
        {(hits ?? []).map((h, i) => (
          <div
            key={`${h.page}-${h.offset}`}
            className={`search-result${active === i ? " active" : ""}`}
            onClick={() => {
              setActive(i);
              c.goToPage(h.page);
              c.find(query.trim(), { caseSensitive: matchCase, entireWord: wholeWords });
              useUi.setState({ findOpen: true });
            }}
          >
            <div className="faint" style={{ fontSize: "var(--fs-xs)" }}>{t("common.page", { page: h.page })}</div>
            <span>{h.before}</span>
            <mark>{h.match}</mark>
            <span>{h.after}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
