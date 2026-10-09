/** Document properties: editable description, technical details and security / permissions. */
import { useEffect, useState } from "react";
import { FileText, Type } from "lucide-react";
import { Dialog } from "../common/Dialog";
import { useT, useLocale } from "../../i18n";
import { formatBytes, formatDateTime } from "../../i18n/format";
import { getController } from "../../state/tabs";
import { pdfjs } from "../../pdf/pdfjs";
import type { DocumentFont, InfoUpdate } from "../../annotations/dto";
import { toAppError } from "../../lib/errors";

interface Meta {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  created: Date | null;
  modified: Date | null;
  version: string;
  linearized: boolean;
  forms: boolean;
  xfa: boolean;
  language: string;
  encrypted: string | null;
  tagged: boolean;
  js: boolean;
}

function toDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || !raw) return null;
  return pdfjs.PDFDateString.toDateObject(raw) ?? null;
}

export function DocPropsDialog({ tabId, done }: { tabId: string; done: () => void }) {
  const t = useT();
  const locale = useLocale();
  const c = getController(tabId);
  const [tab, setTab] = useState<"description" | "advanced" | "security" | "fonts">("description");
  const [fonts, setFonts] = useState<DocumentFont[] | string | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [edit, setEdit] = useState<InfoUpdate>(c?.state.info_update ?? {});

  useEffect(() => {
    const pdf = c?.pdf;
    if (!pdf) return;
    void Promise.all([pdf.getMetadata(), pdf.getMarkInfo().catch(() => null), pdf.getJSActions().catch(() => null)]).then(([m, mark, js]) => {
      const info = m.info as Record<string, unknown>;
      const xmpTitle = m.metadata?.get("dc:title");
      setMeta({
        title: String(info.Title ?? xmpTitle ?? ""),
        author: String(info.Author ?? ""),
        subject: String(info.Subject ?? ""),
        keywords: String(info.Keywords ?? ""),
        creator: String(info.Creator ?? ""),
        producer: String(info.Producer ?? ""),
        created: toDate(info.CreationDate),
        modified: toDate(info.ModDate),
        version: String(info.PDFFormatVersion ?? ""),
        linearized: !!info.IsLinearized,
        forms: !!info.IsAcroFormPresent,
        xfa: !!info.IsXFAPresent,
        language: String(info.Language ?? ""),
        encrypted: typeof info.EncryptFilterName === "string" ? info.EncryptFilterName : null,
        tagged: !!mark?.Marked,
        js: !!js && js.size > 0,
      });
    });
  }, [c]);

  // Fonts are scanned on demand (the whole file is parsed).
  useEffect(() => {
    if (tab !== "fonts" || fonts !== null || !c) return;
    let alive = true;
    c.listFonts()
      .then((list) => alive && setFonts(list))
      .catch((err) => alive && setFonts(toAppError(err).message));
    return () => {
      alive = false;
    };
  }, [tab, fonts, c]);

  if (!c) return null;
  const s = c.state;
  const fieldValue = (key: keyof InfoUpdate, original: string) => (edit[key] ?? original) as string;
  const setField = (key: keyof InfoUpdate, original: string, value: string) =>
    setEdit((e) => {
      const next = { ...e };
      if (value === original) delete next[key];
      else next[key] = value;
      return next;
    });

  const apply = () => {
    c.setInfoUpdate(Object.keys(edit).length ? edit : null);
    done();
  };
  const yesNo = (v: boolean) => (v ? t("common.yes") : t("common.no"));
  const perms = s.permissions;
  const canEdit = c.canAnnotate || s.permissions.modify;

  const rows = (pairs: [string, string][]) => (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--fs)" }}>
      <tbody>
        {pairs.map(([k, v]) => (
          <tr key={k}>
            <td style={{ padding: "5px 12px 5px 0", color: "var(--text-3)", verticalAlign: "top", whiteSpace: "nowrap" }}>{k}</td>
            <td style={{ padding: "5px 0", color: "var(--text)", wordBreak: "break-all", userSelect: "text" }}>{v || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <Dialog
      title={t("docprops.title")}
      icon={FileText}
      size="wide"
      onClose={done}
      footer={
        <>
          <button type="button" className="btn" onClick={done}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn primary" onClick={apply}>
            {t("common.ok")}
          </button>
        </>
      }
    >
      <div className="tabs" style={{ margin: "0 -22px", padding: "0 22px" }} role="tablist">
        {(["description", "advanced", "security", "fonts"] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {t(`docprops.tab.${id}`)}
          </button>
        ))}
      </div>
      {!meta ? (
        <div className="empty-state">
          <div className="spinner" />
        </div>
      ) : tab === "description" ? (
        <div className="col" style={{ gap: 12, paddingTop: 6 }}>
          {rows([
            [t("docprops.file"), s.fileName],
            [t("docprops.location"), s.info?.path ?? ""],
            [t("docprops.fileSize"), formatBytes(s.info?.size ?? 0, locale)],
          ])}
          {(
            [
              ["title", "docprops.title.field", meta.title],
              ["author", "docprops.author", meta.author],
              ["subject", "docprops.subject", meta.subject],
              ["keywords", "docprops.keywords", meta.keywords],
            ] as const
          ).map(([key, label, original]) => (
            <div key={key} className="field">
              <label>{t(label)}</label>
              <input
                className="input"
                value={fieldValue(key, original)}
                disabled={!canEdit}
                onChange={(e) => setField(key, original, e.target.value)}
              />
            </div>
          ))}
          <span className="field-hint">{t("docprops.editHint")}</span>
          {rows([
            [t("docprops.created"), formatDateTime(meta.created, locale)],
            [t("docprops.modified"), formatDateTime(meta.modified, locale)],
            [t("docprops.creator"), meta.creator],
            [t("docprops.producer"), meta.producer],
          ])}
        </div>
      ) : tab === "advanced" ? (
        rows([
          [t("docprops.version"), meta.version],
          [t("docprops.pageCount"), String(s.numPages)],
          [t("docprops.pageSize"), s.pageSize ? `${s.pageSize[0].toFixed(1)} × ${s.pageSize[1].toFixed(1)} pt` : ""],
          [t("docprops.linearized"), yesNo(meta.linearized)],
          [t("docprops.tagged"), yesNo(meta.tagged)],
          [t("docprops.hasForms"), yesNo(meta.forms)],
          [t("docprops.hasXfa"), yesNo(meta.xfa)],
          [t("docprops.hasJs"), yesNo(meta.js)],
          [t("docprops.language"), meta.language],
        ])
      ) : tab === "fonts" ? (
        <FontList fonts={fonts} />
      ) : (
        <div className="col" style={{ gap: 10 }}>
          {rows([[t("docprops.encrypted"), meta.encrypted ? `${t("docprops.security.password")} (${meta.encrypted})` : t("docprops.security.none")]])}
          <div className="field-label">{t("docprops.permissions")}</div>
          {rows([
            [t("docprops.perm.print"), perms.print ? t("docprops.allowed") : t("docprops.notAllowed")],
            [t("docprops.perm.modify"), perms.modify ? t("docprops.allowed") : t("docprops.notAllowed")],
            [t("docprops.perm.copy"), perms.copy ? t("docprops.allowed") : t("docprops.notAllowed")],
            [t("docprops.perm.annotate"), perms.annotate ? t("docprops.allowed") : t("docprops.notAllowed")],
            [t("docprops.perm.fillForms"), perms.fillForms ? t("docprops.allowed") : t("docprops.notAllowed")],
            [t("docprops.perm.assemble"), perms.assemble ? t("docprops.allowed") : t("docprops.notAllowed")],
          ])}
        </div>
      )}
    </Dialog>
  );
}

function FontList({ fonts }: { fonts: DocumentFont[] | string | null }) {
  const t = useT();
  if (fonts === null) {
    return (
      <div className="empty-state">
        <div className="spinner" />
        {t("docprops.fontsLoading")}
      </div>
    );
  }
  if (typeof fonts === "string") return <div className="empty-state">{fonts}</div>;
  if (!fonts.length) return <div className="empty-state">{t("docprops.fontsEmpty")}</div>;
  return (
    <div className="font-list">
      {fonts.map((f, i) => (
        <div key={i} className="font-row">
          <Type size={16} className="faint" />
          <div className="info">
            <div className="name" title={f.name}>
              {f.name}
              <span className={`badge${f.embedded ? "" : " warn"}`}>
                {f.embedded ? (f.subset ? t("docprops.embeddedSubset") : t("docprops.embedded")) : t("docprops.notEmbedded")}
              </span>
            </div>
            <div className="desc">
              {[f.kind, f.encoding, t("common.pages", { count: f.pageCount })].filter(Boolean).join(" · ")}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
