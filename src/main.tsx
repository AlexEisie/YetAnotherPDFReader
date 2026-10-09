/**
 * Boot sequence:
 *   1. load settings (sanitised) and the UI language,
 *   2. load the library (recent files, view states) and saved signatures,
 *   3. render, then tell the Rust side we are ready (shows the window, returns launch files),
 *   4. open launch files or restore the previous session.
 */
import { StrictMode, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import "pdfjs-dist/web/pdf_viewer.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/layout.css";
import "./styles/viewer.css";
import "./styles/annotations.css";
import "./styles/settings.css";
import { App } from "./App";
import { api, OPEN_FILES_EVENT } from "./lib/ipc";
import { createLogger, installGlobalErrorHandlers } from "./lib/log";
import { useSettings, onSettingsChange, settings } from "./settings/store";
import { systemLocale, t, useI18n } from "./i18n";
import { loadSession, useLibrary } from "./state/library";
import { useSignatures } from "./state/signatures";
import { openPaths, activateTab, activeController } from "./state/tabs";
import { toast } from "./state/ui";
import { setAppInfo } from "./state/app";

const log = createLogger("boot");

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    log.error("render crash", error, info.componentStack ?? "");
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="doc-status" style={{ position: "fixed" }}>
        <div className="error-card">
          <h2>{t("dialog.error.title")}</h2>
          <p>{t("error.boundary")}</p>
          <div className="details-box" style={{ width: "100%" }}>{String(this.state.error?.stack ?? this.state.error)}</div>
          <div className="row">
            <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
              {t("error.boundaryContinue")}
            </button>
            <button type="button" className="btn primary" onClick={() => window.location.reload()}>
              {t("error.boundaryReload")}
            </button>
          </div>
        </div>
      </div>
    );
  }
}

async function applyLanguage(code: string) {
  await useI18n.getState().setLocale(code === "system" ? systemLocale() : code);
}

async function boot() {
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    (await import("./dev/mockTauri")).installTauriMock();
  }
  installGlobalErrorHandlers();
  const status = await useSettings.getState().load();
  await applyLanguage(settings().general.language);
  onSettingsChange(
    (s) => s.general.language,
    (code) => void applyLanguage(code),
  );
  await Promise.all([
    useLibrary.getState().load().catch((err) => log.warn("library", err)),
    useSignatures.getState().load().catch((err) => log.warn("signatures", err)),
  ]);

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );

  if (status === "recovered") toast("warning", t("toast.settingsRecovered"));
  if (status === "reset") toast("warning", t("toast.settingsReset"));

  await listen<{ files: string[] }>(OPEN_FILES_EVENT, (event) => {
    if (event.payload.files.length) void openPaths(event.payload.files);
  });

  if (import.meta.env.DEV) {
    // Debug handle for automated end-to-end tests (dev builds only).
    (window as unknown as { yaprDebug: unknown }).yaprDebug = { active: activeController };
  }

  const info = await api.appReady();
  setAppInfo(info);
  log.info(`ready (v${info.version}, ${info.platform})`);

  if (info.launchFiles.length) {
    await openPaths(info.launchFiles);
    return;
  }
  const startup = settings().general.startup;
  if (startup === "restore") {
    const session = await loadSession();
    if (session?.tabs.length) {
      const ids = await openPaths(session.tabs);
      activateTab(ids[Math.min(session.active, ids.length - 1)] ?? null);
    }
  } else if (startup === "last") {
    const last = useLibrary.getState().recent[0];
    if (last) await openPaths([last.path]);
  }
}

boot().catch((err) => {
  log.error("boot failed", err);
  // Make sure the window becomes visible even if something went wrong.
  void api.appReady().catch(() => undefined);
  document.body.textContent = `Startup failed: ${String(err)}`;
});
