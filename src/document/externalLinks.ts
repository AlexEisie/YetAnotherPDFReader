/**
 * Opening web links found in documents, honouring the user's link policy, and saving embedded
 * files (attachments) through a native "Save as" dialog.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/ipc";
import { t } from "../i18n";
import { settings, useSettings } from "../settings/store";
import { openDialog, toast } from "../state/ui";
import { createLogger } from "../lib/log";
import { toAppError } from "../lib/errors";

const log = createLogger("links");

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "ftp:", "ftps:", "tel:"]);

export async function openExternalLink(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    log.warn("ignored malformed link", raw);
    return;
  }
  if (!SAFE_SCHEMES.has(url.protocol)) {
    log.warn("blocked link with unsupported scheme", url.protocol);
    toast("warning", t("toast.linkBlocked"));
    return;
  }
  const policy = settings().general.links;
  if (policy === "block") {
    toast("info", t("toast.linkBlocked"));
    return;
  }
  if (policy === "ask") {
    const answer = await openDialog("link", { url: url.href });
    if (!answer.open) return;
    if (answer.always) useSettings.getState().set("general.links", "allow");
  }
  try {
    await openUrl(url.href);
  } catch (err) {
    log.error("failed to open link", err);
    toast("error", toAppError(err).message);
  }
}

/** Ask where to save `data` and write it there. Returns the chosen path or null. */
export async function saveBytesAs(data: Uint8Array, suggestedName: string): Promise<string | null> {
  const path = await save({ defaultPath: suggestedName, title: t("attach.save") });
  if (!path) return null;
  await api.fsWrite(path, data);
  return path;
}

/** Minimal implementation of pdf.js' download manager (file attachment annotations). */
export class AttachmentDownloadManager {
  async openOrDownloadData(data: Uint8Array, filename: string): Promise<boolean> {
    await this.download(data, "", filename);
    return false;
  }

  async download(data: Uint8Array | null, _url: string, filename: string): Promise<void> {
    if (!data) return;
    try {
      const path = await saveBytesAs(data, filename || "attachment");
      if (path) toast("success", t("attach.saved", { path }));
    } catch (err) {
      toast("error", toAppError(err).message);
    }
  }

  downloadData(data: Uint8Array, filename: string): void {
    void this.download(data, "", filename);
  }
}
