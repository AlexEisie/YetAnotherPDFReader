/** Update check dialog: checks GitHub Releases and offers the matching download. */
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Download, ExternalLink, RefreshCw, Sparkles, WifiOff } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Dialog } from "../common/Dialog";
import { Select } from "../common/controls";
import { currentLocale, useT } from "../../i18n";
import { formatBytes } from "../../i18n/format";
import { noteBlocks, RELEASES_URL, type AutoCheck, type UpdateResult } from "../../lib/updates";
import { toAppError } from "../../lib/errors";
import { appInfo } from "../../state/app";
import { fetchUpdate } from "../../state/updater";
import { useSettings } from "../../settings/store";
import { toast } from "../../state/ui";

type State = { kind: "checking" } | { kind: "done"; result: UpdateResult } | { kind: "error"; message: string };

function AutoCheckField() {
  const t = useT();
  const mode = useSettings((s) => s.settings.general.updateCheck) as AutoCheck;
  const set = useSettings((s) => s.set);
  return (
    <div className="update-auto">
      <span>{t("settings.updateCheck")}</span>
      <Select
        value={mode}
        onChange={(v) => set("general.updateCheck", v)}
        options={[
          { value: "off", label: t("settings.updateCheck.off") },
          { value: "daily", label: t("settings.updateCheck.daily") },
          { value: "weekly", label: t("settings.updateCheck.weekly") },
        ]}
      />
    </div>
  );
}

export function UpdateDialog({ result: initial, done }: { result?: UpdateResult; done: () => void }) {
  const t = useT();
  const [state, setState] = useState<State>(initial ? { kind: "done", result: initial } : { kind: "checking" });
  const set = useSettings((s) => s.set);

  const check = useCallback(() => {
    const controller = new AbortController();
    setState({ kind: "checking" });
    fetchUpdate(controller.signal)
      .then((result) => setState({ kind: "done", result }))
      .catch((err) => {
        if (!controller.signal.aborted) setState({ kind: "error", message: toAppError(err).message });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!initial) return check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = (url: string) => void openUrl(url).catch((err) => toast("error", toAppError(err).message));
  const current = appInfo()?.version ?? "0.0.0";
  const result = state.kind === "done" ? state.result : null;
  const newer = !!result?.newer;
  const date = result?.latest.publishedAt ? new Date(result.latest.publishedAt).toLocaleDateString(currentLocale()) : null;

  const footer =
    state.kind === "checking" ? (
      <button type="button" className="btn" onClick={done}>
        {t("common.cancel")}
      </button>
    ) : newer && result ? (
      <>
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            set("ui.skippedUpdate", result.latest.version);
            toast("info", t("update.skipped", { version: result.latest.version }));
            done();
          }}
        >
          {t("update.skip")}
        </button>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => open(result.latest.url)}>
          <ExternalLink size={15} /> {t("update.releasePage")}
        </button>
        <button type="button" className="btn primary" data-autofocus onClick={() => open(result.asset?.url ?? result.latest.url)}>
          <Download size={15} /> {result.asset ? t("update.download", { size: formatBytes(result.asset.size, currentLocale()) }) : t("update.goDownload")}
        </button>
      </>
    ) : (
      <>
        {state.kind === "error" && (
          <button type="button" className="btn" onClick={() => open(RELEASES_URL)}>
            <ExternalLink size={15} /> {t("update.releasePage")}
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => void check()}>
          <RefreshCw size={15} /> {t("update.checkAgain")}
        </button>
        <button type="button" className="btn primary" onClick={done}>
          {t("common.close")}
        </button>
      </>
    );

  return (
    <Dialog title={t("update.title")} icon={Sparkles} size={newer ? "wide" : "normal"} onClose={done} footer={footer}>
      {state.kind === "checking" && (
        <div className="update-status">
          <RefreshCw size={22} className="spin" />
          <div>
            <strong>{t("update.checking")}</strong>
            <span className="muted">{t("update.privacy")}</span>
          </div>
        </div>
      )}
      {state.kind === "error" && (
        <div className="update-status error">
          <WifiOff size={22} />
          <div>
            <strong>{t("update.failed")}</strong>
            <span className="muted">{state.message}</span>
          </div>
        </div>
      )}
      {result && !newer && (
        <div className="update-status ok">
          <CheckCircle2 size={22} />
          <div>
            <strong>{t("update.upToDate", { version: current })}</strong>
            <span className="muted">{t("update.latestIs", { version: result.latest.version, date: date ?? "" })}</span>
          </div>
        </div>
      )}
      {result && newer && (
        <>
          <div className="update-status new">
            <Sparkles size={22} />
            <div>
              <strong>{t("update.newVersion", { version: result.latest.version })}</strong>
              <span className="muted">
                {t("update.youHave", { version: current })}
                {date ? ` · ${t("update.released", { date })}` : ""}
                {result.asset ? ` · ${result.asset.name}` : ""}
              </span>
            </div>
          </div>
          <div className="update-notes" aria-label={t("update.notes")}>
            {noteBlocks(result.latest.notes).map((b, i) =>
              b.kind === "heading" ? <h4 key={i}>{b.text}</h4> : b.kind === "item" ? <li key={i}>{b.text}</li> : <p key={i}>{b.text}</p>,
            )}
          </div>
          <p className="muted small">{t("update.howTo")}</p>
        </>
      )}
      <AutoCheckField />
    </Dialog>
  );
}
