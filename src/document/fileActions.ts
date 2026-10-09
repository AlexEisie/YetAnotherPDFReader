/**
 * File-level user actions: open / save / save as / revert / export / reveal.
 */
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { t } from "../i18n";
import { api } from "../lib/ipc";
import { toAppError } from "../lib/errors";
import { createLogger } from "../lib/log";
import { settings, useSettings } from "../settings/store";
import { confirm, openDialog, setBusy, toast } from "../state/ui";
import { openPaths } from "../state/tabs";
import type { DocumentController } from "./DocumentController";
import { decodeImageBytes, IMAGE_EXTENSIONS, MAX_IMAGE_BYTES, mimeFromPath } from "../annotations/images";
import type { StampImage } from "../annotations/model";

const log = createLogger("file-actions");

const PDF_FILTER = [{ name: "PDF", extensions: ["pdf", "PDF"] }];

function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i > 0 ? path.slice(0, i) : "";
}

function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

function stripExtension(name: string): string {
  return name.replace(/\.pdf$/i, "");
}

export async function openFileDialog(): Promise<void> {
  const selected = await open({ multiple: true, directory: false, filters: PDF_FILTER, title: t("cmd.file.open") });
  if (!selected) return;
  const paths = Array.isArray(selected) ? selected : [selected];
  if (paths.length) await openPaths(paths);
}

function suggestedSavePath(controller: DocumentController): string {
  const s = settings().saving;
  const current = controller.filePath;
  const folder = s.saveAsFolder === "last" && s.lastFolder ? s.lastFolder : dirname(current);
  const base = stripExtension(controller.state.fileName);
  return joinPath(folder, `${base}${s.saveSuffix}.pdf`);
}

/** Ask for a destination and save there. */
export async function saveControllerAs(controller: DocumentController): Promise<boolean> {
  const target = await save({ defaultPath: suggestedSavePath(controller), filters: PDF_FILTER, title: t("cmd.file.saveAs") });
  if (!target) return false;
  const path = /\.pdf$/i.test(target) ? target : `${target}.pdf`;
  useSettings.getState().set("saving.lastFolder", dirname(path));
  return controller.save(path);
}

/** Save in place (falls back to "Save As" for read-only files). */
export async function saveController(controller: DocumentController): Promise<boolean> {
  if (!controller.isReady) return false;
  const info = controller.state.info;
  if (info?.readOnly) {
    toast("info", t("save.readOnlySaveAs"));
    return saveControllerAs(controller);
  }
  if (!controller.isDirty) return true;
  return controller.save();
}

export async function revertController(controller: DocumentController): Promise<void> {
  if (controller.isDirty) {
    const answer = await confirm({
      title: t("dialog.revert.title"),
      message: t("dialog.revert.message"),
      confirmLabel: t("cmd.file.revert"),
      danger: true,
    });
    if (answer.choice !== "confirm") return;
  }
  await controller.reload();
}

export async function showInFolder(controller: DocumentController): Promise<void> {
  try {
    await revealItemInDir(controller.filePath);
  } catch (err) {
    toast("error", toAppError(err).message);
  }
}

export async function copyPath(controller: DocumentController): Promise<void> {
  await navigator.clipboard.writeText(controller.filePath);
  toast("success", t("toast.pathCopied"));
}

/** Export the plain text of the document. */
export async function exportText(controller: DocumentController): Promise<void> {
  const pdf = controller.pdf;
  if (!pdf) return;
  const target = await save({
    defaultPath: joinPath(dirname(controller.filePath), `${stripExtension(controller.state.fileName)}.txt`),
    filters: [{ name: "Text", extensions: ["txt"] }],
    title: t("export.text.title"),
  });
  if (!target) return;
  let cancelled = false;
  try {
    const parts: string[] = [];
    for (let p = 1; p <= pdf.numPages && !cancelled; p++) {
      setBusy(t("export.working", { progress: `${p}/${pdf.numPages}` }), p / pdf.numPages, () => (cancelled = true));
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      let line = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        line += item.str;
        if (item.hasEOL) line += "\n";
      }
      parts.push(line.trimEnd());
      page.cleanup();
    }
    if (cancelled) return;
    await api.fsWrite(target, new TextEncoder().encode(parts.join("\n\n\f")));
    toast("success", t("export.text.done", { path: target }));
  } catch (err) {
    log.error("text export failed", err);
    void openDialog("error", { title: t("export.text.title"), error: toAppError(err) });
  } finally {
    setBusy(null);
  }
}

/** Let the user pick an image file and return it decoded. */
export async function pickImage(): Promise<StampImage | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }],
    title: t("image.pick"),
  });
  if (!selected || Array.isArray(selected)) return null;
  try {
    const bytes = await api.fsRead(selected, MAX_IMAGE_BYTES);
    return await decodeImageBytes(bytes, mimeFromPath(selected));
  } catch (err) {
    const e = toAppError(err);
    toast("error", e.code === "TOO_LARGE" ? t("image.tooLarge", { max: "40 MB" }) : t("image.invalid"), {
      detail: e.message,
    });
    return null;
  }
}

export async function pickPdfFile(): Promise<string | null> {
  const selected = await open({ multiple: false, directory: false, filters: PDF_FILTER, title: t("pageops.chooseFile") });
  return selected && !Array.isArray(selected) ? selected : null;
}

export { dirname, joinPath, stripExtension };
