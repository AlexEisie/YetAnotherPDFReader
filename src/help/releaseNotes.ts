/**
 * Short "what's new" notes shown once after an update (one line per feature).
 *
 * Every release needs an entry here, newest first; the unit tests check that the version in
 * package.json has one. Keep each version to a few lines; the full story is in CHANGELOG.md.
 */
import { compareVersions } from "../lib/updates";

export interface ReleaseNote {
  version: string;
  zh: string[];
  en: string[];
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "0.4.0",
    zh: [
      "新增应用内使用说明（F1），可以搜索，并能一键打开对应功能",
      "可以检查更新，并按安装方式给出下载链接（自动检查默认关闭）",
      "更新后首次启动会介绍新版本的主要变化",
    ],
    en: [
      "New in-app user guide (F1) with search and buttons that open each feature",
      "Check for updates, with the right download for your installation (automatic checks are off by default)",
      "After an update, the first start shows what's new",
    ],
  },
  {
    version: "0.3.0",
    zh: [
      "离线文字识别（OCR）：框选区域识别文字（Ctrl+Alt+T）",
      "让扫描件可以搜索、选择和复制",
      "打开扫描文档时自动提示进行识别",
    ],
    en: [
      "Offline text recognition (OCR): recognise text in a region (Ctrl+Alt+T)",
      "Make scanned documents searchable, selectable and copyable",
      "Scanned documents are detected when opened",
    ],
  },
  {
    version: "0.2.0",
    zh: [
      "页面管理（Ctrl+Shift+O）：拖动排序、旋转、翻转、复制、删除页面",
      "合并多个 PDF 和图片，拆分文档",
      "文字或图片水印；设置和移除密码保护",
      "提供 Linux 版本（deb、rpm、AppImage）",
    ],
    en: [
      "Page organizer (Ctrl+Shift+O): reorder, rotate, flip, duplicate and delete pages",
      "Combine PDFs and pictures; split documents",
      "Text or picture watermarks; add or remove password protection",
      "Linux builds (deb, rpm, AppImage)",
    ],
  },
  {
    version: "0.1.0",
    zh: ["首个版本：多标签阅读、批注与签名、框选截图、9 种界面语言"],
    en: ["First release: tabs, comments and signatures, region snapshots, 9 UI languages"],
  },
];

/** The last version before "what's new" existed: settings without a seen version come from it. */
export const FIRST_TRACKED_FROM = "0.3.0";

/** Most versions shown at once after a long gap between updates. */
const MAX_VERSIONS = 5;

const release = (v: string) => v.replace(/[-+].*$/, "");

/** Notes for the versions after `from` up to and including `to`, newest first. */
export function notesBetween(from: string, to: string): ReleaseNote[] {
  return RELEASE_NOTES.filter(
    (n) => compareVersions(n.version, release(from)) > 0 && compareVersions(n.version, release(to)) <= 0,
  ).slice(0, MAX_VERSIONS);
}

/** Notes for `version` and the ones before it (for "What's New" from the Help menu). */
export function recentNotes(version: string, count = 3): ReleaseNote[] {
  return RELEASE_NOTES.filter((n) => compareVersions(n.version, release(version)) <= 0).slice(0, count);
}

export function noteLines(note: ReleaseNote, locale: string): string[] {
  return locale.toLowerCase().startsWith("zh") ? note.zh : note.en;
}

/**
 * What to show on start-up. A fresh install shows nothing; settings from before this feature
 * count as {@link FIRST_TRACKED_FROM}; a downgrade or the same version shows nothing.
 */
export function pendingNotes(current: string, lastSeen: string, firstRun: boolean): { from: string; notes: ReleaseNote[] } {
  if (firstRun) return { from: current, notes: [] };
  const from = lastSeen || FIRST_TRACKED_FROM;
  return { from, notes: notesBetween(from, current) };
}
