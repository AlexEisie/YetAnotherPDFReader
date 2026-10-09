/** Automatic and manual update checks (see `lib/updates.ts`). */
import { t } from "../i18n";
import { checkDue, checkForUpdates, type AutoCheck, type UpdateResult } from "../lib/updates";
import { createLogger } from "../lib/log";
import { settings, useSettings } from "../settings/store";
import { appInfo } from "./app";
import { openDialog, toast } from "./ui";

const log = createLogger("updater");

/** Check now. Records the time of the check; never throws. */
export async function fetchUpdate(signal?: AbortSignal): Promise<UpdateResult> {
  const info = appInfo();
  const result = await checkForUpdates(
    info?.version ?? "0.0.0",
    { platform: info?.platform ?? "windows", arch: info?.arch ?? "x86_64", installKind: info?.installKind ?? "installer" },
    signal,
  );
  useSettings.getState().set("ui.lastUpdateCheck", Date.now());
  return result;
}

/** Open the update dialog; it checks immediately and shows the result. */
export function checkForUpdatesNow(): void {
  void openDialog("update", {});
}

/** Automatic check on start-up when enabled and due; quiet unless a new version is found. */
export async function autoCheckForUpdates(): Promise<void> {
  const s = settings();
  if (!checkDue(s.general.updateCheck as AutoCheck, s.ui.lastUpdateCheck)) return;
  try {
    const result = await fetchUpdate();
    if (!result.newer || result.latest.version === settings().ui.skippedUpdate) return;
    toast("info", t("update.available", { version: result.latest.version }), {
      detail: t("update.availableDetail"),
      action: { label: t("update.details"), run: () => void openDialog("update", { result }) },
      timeout: 20000,
    });
  } catch (err) {
    // Offline or GitHub unreachable: try again next time.
    log.info("automatic update check failed", err);
  }
}
