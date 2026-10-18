/** Command palette, keyboard shortcut editor and About dialog. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Command as CommandIcon, Hash, Info, Keyboard, Plus, RotateCcw, Search, X } from "lucide-react";
import { Dialog } from "../common/Dialog";
import { useT, type MessageKey } from "../../i18n";
import { COMMANDS, isEnabled, runCommand, type CommandDef } from "../../commands/registry";
import { commandForAccelerator, effectiveKeys, resetAllShortcuts, setShortcuts } from "../../commands/keybindings";
import { eventToAccelerator, formatAccelerator } from "../../commands/keys";
import { useUi } from "../../state/ui";
import { activeController } from "../../state/tabs";
import { useSettings } from "../../settings/store";
import { appInfo } from "../../state/app";
import { pdfjs } from "../../pdf/pdfjs";
import logoUrl from "../../assets/logo.png";

function score(label: string, query: string): number {
  const l = label.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 1;
  const idx = l.indexOf(q);
  if (idx === 0) return 100;
  if (idx > 0) return 60 - idx;
  // Subsequence match.
  let i = 0;
  for (const ch of l) if (ch === q[i]) i++;
  return i === q.length ? 20 : 0;
}

export function CommandPalette() {
  const t = useT();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => useUi.setState({ palette: false });
  const c = activeController();

  const results = useMemo(() => {
    const page = /^\d+$/.test(query.trim()) ? Number(query.trim()) : null;
    const items: { id: string; label: string; cmd?: CommandDef; enabled: boolean; keys?: string }[] = [];
    if (page && c && page >= 1 && page <= c.state.numPages) {
      items.push({ id: `page:${page}`, label: t("palette.goToPage", { page }), enabled: true });
    }
    const scored = COMMANDS.filter((cmd) => cmd.palette !== false)
      .map((cmd) => {
        const label = t(cmd.label);
        return { cmd, label, s: Math.max(score(label, query.trim()), score(cmd.id, query.trim()) * 0.5) };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.label.localeCompare(b.label))
      .slice(0, 60);
    for (const { cmd, label } of scored) {
      const keys = effectiveKeys(cmd.id)[0];
      items.push({ id: cmd.id, label, cmd, enabled: isEnabled(cmd), keys: keys ? formatAccelerator(keys) : undefined });
    }
    return items;
  }, [query, t, c]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = (i: number) => {
    const item = results[i];
    if (!item || !item.enabled) return;
    close();
    if (item.id.startsWith("page:")) c?.goToPage(Number(item.id.slice(5)));
    else requestAnimationFrame(() => runCommand(item.id));
  };

  return (
    <Dialog title={t("cmd.help.commandPalette")} icon={CommandIcon} size="wide" onClose={close} className="palette">
      <div className="search-box">
        <Search size={15} />
        <input
          className="input"
          data-autofocus
          value={query}
          placeholder={t("palette.placeholder")}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setIndex((i) => Math.min(results.length - 1, i + 1));
            else if (e.key === "ArrowUp") setIndex((i) => Math.max(0, i - 1));
            else if (e.key === "Enter") run(index);
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
      </div>
      <div ref={listRef} style={{ maxHeight: 380, overflowY: "auto", margin: "0 -8px" }}>
        {results.length === 0 && <div className="empty-state">{t("palette.empty")}</div>}
        {results.map((item, i) => {
          const Icon = item.cmd?.icon ?? (item.id.startsWith("page:") ? Hash : undefined);
          return (
            <div
              key={item.id}
              data-i={i}
              className={`list-item${i === index ? " selected" : ""}`}
              style={{ opacity: item.enabled ? 1 : 0.45 }}
              onMouseEnter={() => setIndex(i)}
              onClick={() => run(i)}
            >
              <span style={{ width: 18, display: "inline-flex" }}>{Icon && <Icon size={16} />}</span>
              <span style={{ flex: 1, color: "var(--text)" }}>{item.label}</span>
              {item.keys && <kbd>{item.keys}</kbd>}
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}

const CATEGORY_LABEL: Record<string, MessageKey> = {
  file: "menu.file",
  edit: "menu.edit",
  view: "menu.view",
  go: "menu.go",
  tool: "menu.commentTools",
  comment: "menu.comment",
  page: "menu.pages",
  tts: "menu.readAloud",
  help: "menu.help",
};

export function ShortcutsDialog() {
  const t = useT();
  useSettings((s) => s.settings.shortcuts);
  const [filter, setFilter] = useState("");
  const [recording, setRecording] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ id: string; acc: string; owner: string } | null>(null);
  const close = () => useUi.setState({ shortcuts: false });

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      const acc = eventToAccelerator(e);
      if (!acc) return;
      const owner = commandForAccelerator(acc);
      if (owner && owner !== recording) {
        setConflict({ id: recording, acc, owner });
      } else {
        setShortcuts(recording, [...new Set([...effectiveKeys(recording), acc])]);
      }
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const map = new Map<string, CommandDef[]>();
    for (const cmd of COMMANDS) {
      if (cmd.palette === false && !cmd.keys) continue;
      const label = t(cmd.label);
      const keys = effectiveKeys(cmd.id).join(" ").toLowerCase();
      if (q && !label.toLowerCase().includes(q) && !keys.includes(q)) continue;
      const cat = cmd.id.split(".")[0];
      map.set(cat, [...(map.get(cat) ?? []), cmd]);
    }
    return [...map.entries()];
  }, [filter, t]);

  return (
    <Dialog title={t("shortcuts.title")} icon={Keyboard} size="xwide" onClose={() => (recording ? setRecording(null) : close())}>
      <div className="row">
        <div className="search-box" style={{ flex: 1 }}>
          <Search size={14} />
          <input className="input" data-autofocus value={filter} placeholder={t("shortcuts.search")} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <button type="button" className="btn" onClick={() => resetAllShortcuts()}>
          <RotateCcw size={14} /> {t("shortcuts.resetAll")}
        </button>
      </div>
      {conflict && (
        <div className="row" style={{ padding: "8px 10px", borderRadius: 8, background: "var(--accent-softer)", color: "var(--text)" }}>
          <span style={{ flex: 1 }}>
            <kbd>{formatAccelerator(conflict.acc)}</kbd> {t("shortcuts.conflict", { command: t(COMMANDS.find((x) => x.id === conflict.owner)!.label) })}
          </span>
          <button
            type="button"
            className="btn small primary"
            onClick={() => {
              setShortcuts(conflict.owner, effectiveKeys(conflict.owner).filter((k) => k !== conflict.acc));
              setShortcuts(conflict.id, [...effectiveKeys(conflict.id), conflict.acc]);
              setConflict(null);
            }}
          >
            {t("common.apply")}
          </button>
          <button type="button" className="btn small" onClick={() => setConflict(null)}>
            {t("common.cancel")}
          </button>
        </div>
      )}
      <div style={{ maxHeight: "60vh", overflowY: "auto", margin: "0 -8px", padding: "0 8px" }}>
        {groups.map(([cat, cmds]) => (
          <div key={cat} style={{ marginBottom: 12 }}>
            <div className="menu-header" style={{ padding: "8px 0 4px" }}>{CATEGORY_LABEL[cat] ? t(CATEGORY_LABEL[cat]) : cat}</div>
            {cmds.map((cmd) => {
              const keys = effectiveKeys(cmd.id);
              const customized = !!useSettings.getState().settings.shortcuts[cmd.id];
              return (
                <div key={cmd.id} className="list-item" style={{ cursor: "default" }}>
                  <span style={{ flex: 1, color: "var(--text)" }}>
                    {t(cmd.label)}
                    {customized && <span className="badge" style={{ marginLeft: 8 }}>{t("shortcuts.customized")}</span>}
                  </span>
                  {keys.map((k) => (
                    <span key={k} className="row" style={{ gap: 2 }}>
                      <kbd>{formatAccelerator(k)}</kbd>
                      <button type="button" className="icon-btn small" aria-label={t("shortcuts.remove")} onClick={() => setShortcuts(cmd.id, keys.filter((x) => x !== k))}>
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                  {recording === cmd.id ? (
                    <span className="badge accent">{t("shortcuts.pressKeys")}</span>
                  ) : (
                    <button type="button" className="icon-btn small" data-tip={t("shortcuts.add")} onClick={() => setRecording(cmd.id)}>
                      <Plus size={14} />
                    </button>
                  )}
                  {customized && (
                    <button type="button" className="icon-btn small" data-tip={t("shortcuts.reset")} onClick={() => setShortcuts(cmd.id, null)}>
                      <RotateCcw size={13} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Dialog>
  );
}

export function AboutDialog() {
  const t = useT();
  const info = appInfo();
  const close = () => useUi.setState({ about: false });
  const components = [
    ["pdf.js", `${pdfjs.version}`, "Apache-2.0"],
    ["Tauri", "2", "MIT / Apache-2.0"],
    ["React", "19", "MIT"],
    ["lopdf", "0.45", "MIT"],
    ["Lucide", "1.x", "ISC"],
    ["zustand", "5", "MIT"],
  ];
  return (
    <Dialog title={t("about.title")} icon={Info} onClose={close} footer={<button type="button" className="btn primary" onClick={close}>{t("common.close")}</button>}>
      <div className="row" style={{ gap: 16 }}>
        <img src={logoUrl} alt="" width={64} height={64} />
        <div className="col" style={{ gap: 2 }}>
          <strong style={{ fontSize: "var(--fs-lg)", color: "var(--text)" }}>{t("app.name")}</strong>
          <span>{t("about.version", { version: info?.version ?? "dev" })}</span>
          <span className="faint">{t("about.description")}</span>
        </div>
      </div>
      <table style={{ width: "100%", fontSize: "var(--fs-sm)" }}>
        <tbody>
          <tr>
            <td className="faint">{t("about.platform")}</td>
            <td>{info ? `${info.platform} ${info.arch}` : "—"}</td>
          </tr>
          <tr>
            <td className="faint">{t("about.engine")}</td>
            <td>pdf.js {pdfjs.version}</td>
          </tr>
        </tbody>
      </table>
      <div className="field-label">{t("about.licenses")}</div>
      <table style={{ width: "100%", fontSize: "var(--fs-sm)" }}>
        <tbody>
          {components.map(([name, version, license]) => (
            <tr key={name}>
              <td>{name}</td>
              <td className="faint">{version}</td>
              <td className="faint">{license}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}
