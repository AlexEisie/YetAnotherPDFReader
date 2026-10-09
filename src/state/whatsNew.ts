/** Shows the release notes once after an update (see `help/releaseNotes.ts`). */
import { pendingNotes, recentNotes } from "../help/releaseNotes";
import { createLogger } from "../lib/log";
import { settings, useSettings } from "../settings/store";
import { useLibrary } from "./library";
import { appInfo } from "./app";
import { openDialog } from "./ui";

const log = createLogger("whats-new");

/** Called once on start-up: show what changed since the version the user last ran. */
export function showWhatsNewAfterUpdate(): void {
  const current = appInfo()?.version;
  if (!current) return;
  // Settings may never have been written by an older version: recent files also mean "used before".
  const firstRun = useSettings.getState().firstRun && useLibrary.getState().recent.length === 0;
  const lastSeen = settings().ui.lastSeenVersion;
  const { from, notes } = pendingNotes(current, lastSeen, firstRun);
  if (lastSeen !== current) useSettings.getState().set("ui.lastSeenVersion", current);
  if (!notes.length) return;
  log.info(`updated from ${from} to ${current}`);
  void openDialog("whatsNew", { notes, updated: true });
}

/** Help ▸ What's New: the notes of this version and the ones before it. */
export function showWhatsNew(): void {
  void openDialog("whatsNew", { notes: recentNotes(appInfo()?.version ?? "0.0.0"), updated: false });
}
