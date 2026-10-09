/**
 * Settings: full-window view with a section list, stacked sub-pages (breadcrumb navigation),
 * instant search across every option and live-applied changes.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, Keyboard, RotateCcw, Search, X } from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useT, LOCALES, type MessageKey } from "../../i18n";
import { useSettings, getPath } from "../../settings/store";
import { ACCENT_PRESETS, DEFAULT_SETTINGS, type PageMode, type Settings } from "../../settings/defaults";
import { SETTING_PAGES, TOP_PAGES, pageById, trail, type SettingItem, type SettingPage } from "../../settings/schema";
import { ColorPicker, Segmented, Select, Slider, Switch, CommitInput } from "../common/controls";
import { useUi, confirm, toast } from "../../state/ui";
import { useLibrary } from "../../state/library";
import { useSignatures } from "../../state/signatures";
import { api } from "../../lib/ipc";
import { listVoices, ttsAvailable } from "../../document/readAloud";
import { pageColorStyle } from "../../document/pageColors";
import { toAppError } from "../../lib/errors";
import { appInfo } from "../../state/app";
import { pdfjs } from "../../pdf/pdfjs";

type T = ReturnType<typeof useT>;

function formatValue(item: Extract<SettingItem, { kind: "slider" }>, v: number, t: T): string {
  switch (item.format) {
    case "percent":
      return item.max > 2 ? `${Math.round(v)}%` : `${Math.round(v * 100)}%`;
    case "times":
      return `${v.toFixed(2).replace(/\.?0+$/, "")}×`;
    case "pt":
      return `${v} pt`;
    case "seconds":
      return v === 0 ? t("settings.presentationAutoAdvance.off") : t("settings.seconds", { count: v });
    case "minutes":
      return v === 0 ? t("settings.freeBackgroundTabs.never") : t("settings.minutes", { count: v });
    case "mb":
      return t("settings.megabytes", { count: v });
    case "speed":
      return `${v} px/s`;
    default:
      return String(v);
  }
}

function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => listVoices());
  useEffect(() => {
    if (!ttsAvailable()) return;
    const update = () => setVoices(listVoices());
    window.speechSynthesis.addEventListener("voiceschanged", update);
    update();
    return () => window.speechSynthesis.removeEventListener("voiceschanged", update);
  }, []);
  return voices;
}

const PAGE_MODES: PageMode[] = ["normal", "dark", "night", "sepia", "green", "custom"];

function PageModePicker({ settings, set, t }: { settings: Settings; set: (p: string, v: unknown) => void; t: T }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(118px, 1fr))", gap: 10, width: "100%" }}>
      {PAGE_MODES.map((mode) => {
        const style = pageColorStyle({ ...settings.pageColors, mode, followTheme: false }, false);
        const active = settings.pageColors.mode === mode;
        return (
          <button
            key={mode}
            type="button"
            onClick={() => set("pageColors.mode", mode)}
            style={{
              border: `2px solid ${active ? "var(--accent)" : "var(--border)"}`,
              borderRadius: 10,
              padding: 6,
              background: "var(--surface)",
              cursor: "pointer",
              textAlign: "center",
            }}
          >
            <div
              style={{
                height: 64,
                borderRadius: 6,
                background: "#fff",
                filter: style.filter.includes("url(") ? undefined : style.filter,
                position: "relative",
                overflow: "hidden",
                padding: "8px 10px",
                textAlign: "left",
              }}
            >
              <div style={{ height: 6, width: "70%", background: "#222", borderRadius: 3, marginBottom: 6 }} />
              <div style={{ height: 4, width: "90%", background: "#666", borderRadius: 2, marginBottom: 4 }} />
              <div style={{ height: 4, width: "80%", background: "#666", borderRadius: 2, marginBottom: 4 }} />
              <div style={{ position: "absolute", right: 8, bottom: 8, width: 26, height: 18, borderRadius: 3, background: "linear-gradient(135deg, #3a8dde, #f2b134)" }} />
              {style.tint && <div style={{ position: "absolute", inset: 0, background: style.tint, mixBlendMode: "multiply" }} />}
              {mode === "custom" && (
                <div style={{ position: "absolute", inset: 0, background: settings.pageColors.customBackground, mixBlendMode: "normal", opacity: 0.85 }}>
                  <div style={{ margin: "8px 10px", height: 6, width: "70%", background: settings.pageColors.customForeground, borderRadius: 3 }} />
                </div>
              )}
            </div>
            <div style={{ fontSize: "var(--fs-sm)", marginTop: 6, color: active ? "var(--accent)" : "var(--text)" }}>{t(`settings.pageMode.${mode}`)}</div>
          </button>
        );
      })}
    </div>
  );
}

function ItemControl({ item, settings, set, t }: { item: SettingItem; settings: Settings; set: (p: string, v: unknown) => void; t: T }) {
  const voices = useVoices();
  switch (item.kind) {
    case "toggle":
      return <Switch checked={!!getPath(settings, item.path)} onChange={(v) => set(item.path, v)} label={t(item.label)} />;
    case "segmented":
      return (
        <Segmented
          value={getPath(settings, item.path) as string}
          onChange={(v) => set(item.path, v)}
          options={item.options.map((o) => ({ value: String(o.value), label: o.raw ? o.label : t(o.label as MessageKey) }))}
        />
      );
    case "select": {
      let options: { value: string; label: string }[];
      if (item.options === "languages") options = [{ value: "system", label: t("settings.language.system") }, ...LOCALES.map((l) => ({ value: l.code, label: l.name }))];
      else if (item.options === "voices") options = [{ value: "", label: t("settings.ttsVoice.default") }, ...voices.map((v) => ({ value: v.voiceURI, label: `${v.name} (${v.lang})` }))];
      else options = item.options.map((o) => ({ value: String(o.value), label: o.raw ? o.label : t(o.label as MessageKey) }));
      return <Select value={String(getPath(settings, item.path) ?? "")} onChange={(v) => set(item.path, v)} options={options} />;
    }
    case "slider": {
      const value = Number(getPath(settings, item.path));
      return <Slider value={value} min={item.min} max={item.max} step={item.step} onChange={(v) => set(item.path, v)} format={(v) => formatValue(item, v, t)} />;
    }
    case "color":
      return <ColorPicker value={(getPath(settings, item.path) as string | null) ?? null} onChange={(v) => set(item.path, v)} allowNone={item.allowNone} presets={item.presets} />;
    case "text":
      return <CommitInput className="input" value={String(getPath(settings, item.path) ?? "")} placeholder={item.placeholder ? t(item.placeholder) : undefined} onCommit={(v) => set(item.path, v)} />;
    default:
      return null;
  }
}

function useActions(t: T) {
  const replaceAll = useSettings((s) => s.replaceAll);
  const resetAll = useSettings((s) => s.resetAll);
  return async (id: string) => {
    try {
      switch (id) {
        case "clearRecent":
          useLibrary.getState().clearRecent();
          toast("success", t("toast.recentCleared"));
          break;
        case "clearViewStates":
          useLibrary.getState().clearViewStates();
          toast("success", t("toast.dataCleared"));
          break;
        case "clearSignatures": {
          const answer = await confirm({ title: t("settings.clearSignatures"), message: t("settings.clearSignatures"), confirmLabel: t("settings.clearAction"), danger: true });
          if (answer.choice === "confirm") {
            useSignatures.getState().clearSignatures();
            toast("success", t("toast.dataCleared"));
          }
          break;
        }
        case "exportSettings": {
          const path = await save({ defaultPath: "yapr-settings.json", filters: [{ name: "JSON", extensions: ["json"] }] });
          if (!path) return;
          await api.fsWrite(path, new TextEncoder().encode(JSON.stringify(useSettings.getState().settings, null, 2)));
          toast("success", t("toast.settingsExported"));
          break;
        }
        case "importSettings": {
          const path = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
          if (!path || Array.isArray(path)) return;
          const bytes = await api.fsRead(path, 4 * 1024 * 1024);
          replaceAll(JSON.parse(new TextDecoder().decode(bytes)));
          toast("success", t("toast.settingsImported"));
          break;
        }
        case "resetAll": {
          const answer = await confirm({ title: t("settings.resetAll"), message: t("settings.resetAllConfirm"), confirmLabel: t("common.reset"), danger: true });
          if (answer.choice === "confirm") resetAll();
          break;
        }
        case "openData":
          await api.appOpenFolder("data");
          break;
        case "openLogs":
          await api.appOpenFolder("logs");
          break;
      }
    } catch (err) {
      toast("error", toAppError(err).message);
    }
  };
}

function CustomItem({ id, settings, set, t }: { id: string; settings: Settings; set: (p: string, v: unknown) => void; t: T }): ReactNode {
  switch (id) {
    case "accent":
      return <ColorPicker value={settings.appearance.accent} onChange={(v) => v && set("appearance.accent", v)} presets={ACCENT_PRESETS} />;
    case "pageModePreview":
      return <PageModePicker settings={settings} set={set} t={t} />;
    case "shortcuts":
      return (
        <button type="button" className="btn" onClick={() => useUi.setState({ shortcuts: true })}>
          <Keyboard size={15} /> {t("shortcuts.title")}
        </button>
      );
    case "about": {
      const info = appInfo();
      return (
        <div className="col" style={{ gap: 4 }}>
          <strong>{t("app.name")}</strong>
          <span className="muted">{t("about.version", { version: info?.version ?? "dev" })}</span>
          <span className="muted">pdf.js {pdfjs.version} · {info ? `${info.platform} ${info.arch}` : ""}</span>
          <button type="button" className="btn small" style={{ alignSelf: "flex-start", marginTop: 6 }} onClick={() => useUi.setState({ about: true, settings: null })}>
            {t("about.licenses")}
          </button>
        </div>
      );
    }
    default:
      return null;
  }
}

function Row({ item, settings, set, t, go, runAction }: {
  item: SettingItem;
  settings: Settings;
  set: (p: string, v: unknown) => void;
  t: T;
  go: (page: string) => void;
  runAction: (id: string) => void;
}) {
  if ("visible" in item && item.visible && !item.visible(settings)) return null;
  const wide = item.kind === "custom" && (item.id === "pageModePreview" || item.id === "accent");
  const label = (
    <div className="setting-text">
      <div className="setting-label">{t(item.label)}</div>
      {item.desc && <div className="setting-desc">{t(item.desc)}</div>}
    </div>
  );
  if (item.kind === "link") {
    return (
      <button type="button" className="setting-row link" onClick={() => go(item.page)}>
        {label}
        <ChevronRight size={16} className="faint" />
      </button>
    );
  }
  if (item.kind === "action") {
    return (
      <div className="setting-row">
        {label}
        <button type="button" className={`btn small${item.danger ? " danger" : ""}`} onClick={() => runAction(item.id)}>
          {t(item.button)}
        </button>
      </div>
    );
  }
  const isDefault =
    "path" in item && JSON.stringify(getPath(settings, item.path)) === JSON.stringify(getPath(DEFAULT_SETTINGS, item.path));
  return (
    <div className={`setting-row${wide || item.kind === "color" ? " stacked" : ""}`}>
      {label}
      <div className="setting-control">
        {item.kind === "custom" ? <CustomItem id={item.id} settings={settings} set={set} t={t} /> : <ItemControl item={item} settings={settings} set={set} t={t} />}
        {"path" in item && !isDefault && (
          <button type="button" className="icon-btn small reset-one" data-tip={t("common.restoreDefaults")} onClick={() => set(item.path, getPath(DEFAULT_SETTINGS, item.path))}>
            <RotateCcw size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

function PageBody({ page, settings, set, t, go, runAction }: {
  page: SettingPage;
  settings: Settings;
  set: (p: string, v: unknown) => void;
  t: T;
  go: (page: string) => void;
  runAction: (id: string) => void;
}) {
  return (
    <>
      {page.groups.map((g) => (
        <section key={g.title} className="setting-group">
          <h3>{t(g.title)}</h3>
          <div className="setting-card">
            {g.items.map((item, i) => (
              <Row key={i} item={item} settings={settings} set={set} t={t} go={go} runAction={runAction} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

export function SettingsView() {
  const t = useT();
  const requested = useUi((s) => s.settings?.page ?? "general");
  const settings = useSettings((s) => s.settings);
  const set = useSettings((s) => s.set);
  const resetSection = useSettings((s) => s.resetSection);
  const [stack, setStack] = useState<string[]>(() => trail(requested).map((p) => p.id));
  const [query, setQuery] = useState("");
  const runAction = useActions(t);

  useEffect(() => setStack(trail(requested).map((p) => p.id)), [requested]);

  const pageId = stack[stack.length - 1] ?? "general";
  const page = pageById(pageId);
  const go = (id: string) => {
    setQuery("");
    setStack(trail(id).map((p) => p.id));
  };
  const close = () => useUi.setState({ settings: null });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !useUi.getState().dialogs.length && !useUi.getState().shortcuts) {
        e.stopPropagation();
        if (query) setQuery("");
        else if (stack.length > 1) setStack(stack.slice(0, -1));
        else close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [query, stack]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const out: { page: SettingPage; item: SettingItem }[] = [];
    for (const p of SETTING_PAGES) {
      for (const g of p.groups) {
        for (const item of g.items) {
          const text = `${t(item.label)} ${item.desc ? t(item.desc) : ""} ${t(g.title)} ${t(p.title)}`.toLowerCase();
          if (text.includes(q)) out.push({ page: p, item });
        }
      }
    }
    return out;
  }, [query, t]);

  const crumbs = trail(pageId);
  return (
    <div className="settings-view" role="dialog" aria-label={t("settings.title")}>
      <nav className="settings-nav">
        <div className="settings-nav-head">
          <h2>{t("settings.title")}</h2>
        </div>
        <div className="search-box" style={{ margin: "0 12px 10px" }}>
          <Search size={14} />
          <input className="input" autoFocus value={query} placeholder={t("settings.search")} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="settings-nav-list">
          {TOP_PAGES.map((p) => (
            <button key={p.id} type="button" className={`settings-nav-item${crumbs[0]?.id === p.id && !query ? " active" : ""}`} onClick={() => go(p.id)}>
              <p.icon size={17} />
              {t(p.title)}
            </button>
          ))}
        </div>
      </nav>
      <main className="settings-main">
        <header className="settings-head">
          {!query && stack.length > 1 && (
            <button type="button" className="icon-btn" aria-label={t("common.back")} onClick={() => setStack(stack.slice(0, -1))}>
              <ArrowLeft size={18} />
            </button>
          )}
          <div className="crumbs">
            {query ? (
              <h1>{t("common.search")}</h1>
            ) : (
              crumbs.map((p, i) => (
                <span key={p.id} className="row" style={{ gap: 6 }}>
                  {i > 0 && <ChevronRight size={16} className="faint" />}
                  {i < crumbs.length - 1 ? (
                    <button type="button" className="crumb" onClick={() => go(p.id)}>
                      {t(p.title)}
                    </button>
                  ) : (
                    <h1>{t(p.title)}</h1>
                  )}
                </span>
              ))
            )}
          </div>
          <span className="spacer" />
          {!query && page.sections.length > 0 && (
            <button type="button" className="btn small ghost" onClick={() => page.sections.forEach((s) => resetSection(s))}>
              <RotateCcw size={14} /> {t("settings.resetSection")}
            </button>
          )}
          <button type="button" className="icon-btn" aria-label={t("common.close")} onClick={close}>
            <X size={18} />
          </button>
        </header>
        <div className="settings-content" key={query ? "search" : pageId}>
          {results ? (
            results.length === 0 ? (
              <div className="empty-state">{t("settings.noResults", { query })}</div>
            ) : (
              <div className="setting-card">
                {results.map(({ page: p, item }, i) => (
                  <div key={i}>
                    <div className="setting-crumb">{trail(p.id).map((x) => t(x.title)).join(" › ")}</div>
                    <Row item={item} settings={settings} set={set} t={t} go={go} runAction={runAction} />
                  </div>
                ))}
              </div>
            )
          ) : (
            <PageBody page={page} settings={settings} set={set} t={t} go={go} runAction={runAction} />
          )}
        </div>
      </main>
    </div>
  );
}
