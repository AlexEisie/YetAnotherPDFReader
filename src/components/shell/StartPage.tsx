/** Start page: open button, recent documents with covers, quick tips. */
import { useEffect, useState } from "react";
import { Clock, FileText, FolderOpen, Keyboard, Lightbulb, Moon, Search, MessageSquareText, Settings as SettingsIcon, X, Trash } from "lucide-react";
import { useT, useLocale } from "../../i18n";
import { formatRelativeTime } from "../../i18n/format";
import { useLibrary, type RecentEntry } from "../../state/library";
import { openPaths } from "../../state/tabs";
import { openFileDialog } from "../../document/fileActions";
import { openSettings, toast, useUi } from "../../state/ui";
import { api } from "../../lib/ipc";
import { effectiveKeys } from "../../commands/keybindings";
import { formatAccelerator } from "../../commands/keys";
import logoUrl from "../../assets/logo.svg";

function RecentCard({ r, missing }: { r: RecentEntry; missing: boolean }) {
  const t = useT();
  const locale = useLocale();
  const remove = useLibrary((s) => s.removeRecent);
  return (
    <button
      type="button"
      className={`recent-card${missing ? " missing" : ""}`}
      title={r.path}
      onClick={() => {
        if (missing) toast("warning", `${t("start.missing")}: ${r.path}`);
        else void openPaths([r.path]);
      }}
    >
      <div className="thumb">{r.thumb ? <img src={r.thumb} alt="" draggable={false} /> : <FileText size={46} />}</div>
      <div className="meta">
        <span className="name">{r.name}</span>
        <span className="sub">
          {missing ? t("start.missing") : t("start.lastOpened", { time: formatRelativeTime(r.openedAt, locale) })}
          {r.pages ? ` · ${t("common.pages", { count: r.pages })}` : ""}
        </span>
      </div>
      <span
        role="button"
        tabIndex={0}
        className="icon-btn small remove"
        data-tip={t("start.removeRecent")}
        onClick={(e) => {
          e.stopPropagation();
          remove(r.path);
        }}
      >
        <X size={14} />
      </span>
    </button>
  );
}

function keyOf(id: string): string {
  const k = effectiveKeys(id)[0];
  return k ? formatAccelerator(k) : "";
}

export function StartPage() {
  const t = useT();
  const recent = useLibrary((s) => s.recent);
  const clear = useLibrary((s) => s.clearRecent);
  const [missing, setMissing] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    Promise.all(recent.map((r) => api.fsStat(r.path).then((st) => (st.isFile ? null : r.path)).catch(() => r.path))).then((res) => {
      if (alive) setMissing(new Set(res.filter((x): x is string => !!x)));
    });
    return () => {
      alive = false;
    };
  }, [recent]);

  const tips = [
    { icon: Search, text: t("start.tip.palette", { key: keyOf("help.commandPalette") }) },
    { icon: Moon, text: t("start.tip.dark", { key: keyOf("view.bg.cycle") }) },
    { icon: Lightbulb, text: t("start.tip.find", { key: keyOf("edit.find") }) },
    { icon: MessageSquareText, text: t("start.tip.tools", { key: keyOf("comment.toolbar") }) },
  ];

  return (
    <div className="start-page">
      <div className="start-inner">
        <div className="start-hero">
          <img className="logo" src={logoUrl} alt="" />
          <div>
            <h1>{t("app.name")}</h1>
            <p>{t("start.subtitle")}</p>
          </div>
        </div>
        <div className="start-actions">
          <button type="button" className="btn primary large" onClick={() => void openFileDialog()}>
            <FolderOpen size={18} /> {t("start.open")}
          </button>
          <button type="button" className="btn large" onClick={() => openSettings()}>
            <SettingsIcon size={18} /> {t("start.settings")}
          </button>
          <button type="button" className="btn large ghost" onClick={() => useUi.setState({ shortcuts: true })}>
            <Keyboard size={18} /> {t("cmd.help.shortcuts")}
          </button>
          <span className="faint">{t("start.dropHint")}</span>
        </div>
        <section className="start-section">
          <h3>
            <Clock size={16} /> {t("start.recent")}
            <span className="spacer" />
            {recent.length > 0 && (
              <button type="button" className="btn small ghost" onClick={clear}>
                <Trash size={14} /> {t("start.clearRecent")}
              </button>
            )}
          </h3>
          {recent.length === 0 ? (
            <div className="empty-state" style={{ alignItems: "flex-start", padding: "8px 0" }}>
              {t("start.noRecent")}
            </div>
          ) : (
            <div className="recent-grid">
              {recent.map((r) => (
                <RecentCard key={r.path} r={r} missing={missing.has(r.path)} />
              ))}
            </div>
          )}
        </section>
        <section className="start-section">
          <h3>
            <Lightbulb size={16} /> {t("start.tips")}
          </h3>
          <div className="tips">
            {tips.map((tip, i) => (
              <div key={i} className="tip">
                <tip.icon size={18} />
                <span>{tip.text}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
