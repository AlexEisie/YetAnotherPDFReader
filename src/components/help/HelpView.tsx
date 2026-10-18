/**
 * In-app user guide: topics with short explanations and buttons that run the features they
 * describe, a live list of keyboard shortcuts, and "About and updates".
 */
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { BookOpenText, ExternalLink, FileText, FolderOpen, Code2, RefreshCw, Search, Settings2, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { currentLocale, useT, type MessageKey } from "../../i18n";
import { helpTopics, searchHelp, type HelpBlock, type HelpTopic } from "../../help/content";
import { COMMANDS, getCommand, isEnabled, runCommand } from "../../commands/registry";
import { effectiveKeys } from "../../commands/keybindings";
import { formatAccelerator } from "../../commands/keys";
import { openDialog, openSettings, toast, useUi } from "../../state/ui";
import { useSettings } from "../../settings/store";
import { appInfo } from "../../state/app";
import { api } from "../../lib/ipc";
import { RELEASES_URL, type AutoCheck } from "../../lib/updates";
import { toAppError } from "../../lib/errors";
import { Select } from "../common/controls";
import { pdfjs } from "../../pdf/pdfjs";
import logoUrl from "../../assets/logo.png";

const REPO_URL = "https://github.com/AlexEisie/YetAnotherPDFReader";

function inline(text: string): ReactNode[] {
  // `key` → <kbd>, **bold** → <strong>, *emphasis* → <em>
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`")) return <kbd key={i}>{part.slice(1, -1)}</kbd>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

function Body({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let items: string[] = [];
  const flush = () => {
    if (items.length) out.push(<ul key={`l${out.length}`}>{items.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>);
    items = [];
  };
  for (const line of lines) {
    if (line.startsWith("- ")) items.push(line.slice(2));
    else {
      flush();
      if (line.trim()) out.push(<p key={`p${out.length}`}>{inline(line)}</p>);
    }
  }
  flush();
  return <>{out}</>;
}

function shortcutOf(id: string): string | null {
  const keys = effectiveKeys(id);
  return keys.length ? formatAccelerator(keys[0]) : null;
}

function CommandButton({ id, onRun }: { id: string; onRun: () => void }) {
  const t = useT();
  const cmd = getCommand(id);
  if (!cmd) return null;
  const enabled = isEnabled(cmd);
  const keys = shortcutOf(id);
  const Icon = cmd.icon;
  return (
    <button
      type="button"
      className="btn small help-cmd"
      disabled={!enabled}
      data-tip={enabled ? undefined : t("help.needsDocument")}
      onClick={() => {
        onRun();
        // Let the help view close before the command opens its own UI.
        setTimeout(() => runCommand(id), 0);
      }}
    >
      {Icon && <Icon size={14} />}
      {t(cmd.label)}
      {keys && <kbd>{keys}</kbd>}
    </button>
  );
}

function BlockCard({ block, topic, onRun, showTopic }: { block: HelpBlock; topic: HelpTopic; onRun: () => void; showTopic?: boolean }) {
  return (
    <section className="help-block">
      {showTopic && <div className="help-crumb">{topic.title}</div>}
      <h3>{block.title}</h3>
      <Body text={block.body} />
      {block.commands?.length ? (
        <div className="help-actions">
          {block.commands.map((id) => (
            <CommandButton key={id} id={id} onRun={onRun} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

const GROUPS: [string, MessageKey][] = [
  ["file", "menu.file"],
  ["edit", "menu.edit"],
  ["view", "menu.view"],
  ["go", "menu.go"],
  ["comment", "menu.comment"],
  ["tool", "menu.comment"],
  ["page", "menu.document"],
  ["doc", "menu.document"],
  ["tts", "menu.view"],
  ["help", "menu.help"],
];

function ShortcutList({ filter }: { filter: string }) {
  const t = useT();
  const q = filter.trim().toLowerCase();
  const groups = new Map<MessageKey, { label: string; keys: string[] }[]>();
  for (const cmd of COMMANDS) {
    const keys = effectiveKeys(cmd.id);
    if (!keys.length) continue;
    const label = t(cmd.label);
    if (q && !label.toLowerCase().includes(q) && !keys.join(" ").toLowerCase().includes(q)) continue;
    const group = GROUPS.find(([prefix]) => cmd.id.startsWith(`${prefix}.`))?.[1] ?? "menu.help";
    const list = groups.get(group) ?? [];
    list.push({ label, keys: keys.map(formatAccelerator) });
    groups.set(group, list);
  }
  return (
    <>
      <div className="help-actions" style={{ marginBottom: 12 }}>
        <button type="button" className="btn small" onClick={() => openSettings("shortcuts")}>
          <Settings2 size={14} /> {t("help.customizeShortcuts")}
        </button>
      </div>
      {[...groups.entries()].map(([group, items]) => (
        <section key={group} className="help-block">
          <h3>{t(group)}</h3>
          <table className="help-keys">
            <tbody>
              {items.map((item) => (
                <tr key={item.label}>
                  <td>{item.label}</td>
                  <td>
                    {item.keys.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}

function AboutTopic() {
  const t = useT();
  const info = appInfo();
  const mode = useSettings((s) => s.settings.general.updateCheck) as AutoCheck;
  const last = useSettings((s) => s.settings.ui.lastUpdateCheck);
  const set = useSettings((s) => s.set);
  const open = (url: string) => void openUrl(url).catch((err) => toast("error", toAppError(err).message));
  return (
    <>
      <section className="help-block help-about">
        <img src={logoUrl} alt="" width={56} height={56} />
        <div>
          <h3>{t("app.name")}</h3>
          <p>{t("about.version", { version: info?.version ?? "dev" })} · {info ? `${info.platform} ${info.arch}` : ""} · pdf.js {pdfjs.version}</p>
          <p className="muted">{t("about.description")}</p>
        </div>
      </section>
      <section className="help-block">
        <h3>{t("help.updates")}</h3>
        <p>{t("help.updatesLead")}</p>
        <div className="help-actions">
          <button type="button" className="btn primary small" onClick={() => void openDialog("update", {})}>
            <RefreshCw size={14} /> {t("cmd.help.checkUpdates")}
          </button>
          <Select
            value={mode}
            ariaLabel={t("settings.updateCheck")}
            onChange={(v) => set("general.updateCheck", v)}
            options={[
              { value: "off", label: t("settings.updateCheck.off") },
              { value: "daily", label: t("settings.updateCheck.daily") },
              { value: "weekly", label: t("settings.updateCheck.weekly") },
            ]}
          />
        </div>
        <p className="muted small">
          {last ? t("help.lastChecked", { time: new Date(last).toLocaleString(currentLocale()) }) : t("help.neverChecked")}
        </p>
      </section>
      <section className="help-block">
        <h3>{t("help.links")}</h3>
        <div className="help-actions">
          <button type="button" className="btn small" onClick={() => open(REPO_URL)}>
            <Code2 size={14} /> GitHub
          </button>
          <button type="button" className="btn small" onClick={() => open(`${REPO_URL}/issues`)}>
            <ExternalLink size={14} /> {t("help.issues")}
          </button>
          <button type="button" className="btn small" onClick={() => open(`${REPO_URL}/blob/main/CHANGELOG.md`)}>
            <FileText size={14} /> {t("help.changelog")}
          </button>
          <button type="button" className="btn small" onClick={() => open(RELEASES_URL)}>
            <ExternalLink size={14} /> {t("help.releases")}
          </button>
        </div>
        <div className="help-actions">
          <button type="button" className="btn small" onClick={() => void api.appOpenFolder("data")}>
            <FolderOpen size={14} /> {t("help.dataFolder")}
          </button>
          <button type="button" className="btn small" onClick={() => void api.appOpenFolder("logs")}>
            <FolderOpen size={14} /> {t("cmd.help.logs")}
          </button>
          <button type="button" className="btn small" onClick={() => useUi.setState({ help: null, about: true })}>
            <BookOpenText size={14} /> {t("about.licenses")}
          </button>
        </div>
      </section>
      <section className="help-block">
        <h3>{t("help.privacy")}</h3>
        <p>{t("help.privacyText")}</p>
      </section>
    </>
  );
}

export function HelpView() {
  const t = useT();
  const requested = useUi((s) => s.help);
  const locale = useSettings((s) => s.settings.general.language);
  const topics = useMemo(() => helpTopics(currentLocale()), [locale]);
  const [topicId, setTopicId] = useState(requested && requested !== "start" ? requested : topics[0].id);
  const [query, setQuery] = useState("");
  const close = () => useUi.setState({ help: null });
  const topic = topics.find((x) => x.id === topicId) ?? topics[0];

  useEffect(() => {
    if (requested && topics.some((x) => x.id === requested)) setTopicId(requested);
  }, [requested, topics]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !useUi.getState().dialogs.length) {
        e.stopPropagation();
        if (query) setQuery("");
        else close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [query]);

  const results = query.trim() ? searchHelp(topics, query) : null;
  return (
    <div className="settings-view help-view" role="dialog" aria-label={t("help.title")}>
      <nav className="settings-nav">
        <div className="settings-nav-head">
          <h2>{t("help.title")}</h2>
        </div>
        <div className="search-box" style={{ margin: "0 12px 10px" }}>
          <Search size={14} />
          <input className="input" autoFocus value={query} placeholder={t("help.search")} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="settings-nav-list">
          {topics.map((x) => (
            <button
              key={x.id}
              type="button"
              className={`settings-nav-item${x.id === topic.id && !results ? " active" : ""}`}
              onClick={() => {
                setQuery("");
                setTopicId(x.id);
              }}
            >
              <x.icon size={17} />
              {x.title}
            </button>
          ))}
        </div>
      </nav>
      <main className="settings-main">
        <header className="settings-head">
          <div className="crumbs">
            <h1>{results ? t("common.search") : topic.title}</h1>
          </div>
          <span className="spacer" />
          <button type="button" className="icon-btn" aria-label={t("common.close")} onClick={close}>
            <X size={18} />
          </button>
        </header>
        <div className="settings-content help-content" key={results ? "search" : topic.id}>
          {results ? (
            results.length ? (
              results.map((r) => <BlockCard key={`${r.topic.id}-${r.block.title}`} block={r.block} topic={r.topic} onRun={close} showTopic />)
            ) : (
              <>
                <p className="muted">{t("help.noResults")}</p>
                <ShortcutList filter={query} />
              </>
            )
          ) : (
            <>
              <p className="help-summary">{topic.summary}</p>
              {topic.special === "shortcuts" && <ShortcutList filter="" />}
              {topic.special === "about" && <AboutTopic />}
              {topic.blocks.map((b) => (
                <BlockCard key={b.title} block={b} topic={topic} onRun={close} />
              ))}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

