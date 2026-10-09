/**
 * Update check against GitHub Releases.
 *
 * The only network access of the application: it happens when the user asks for it, or
 * periodically when automatic checks are enabled in the settings (off by default). Nothing is
 * sent except the request itself; downloads open in the browser.
 */
import { createLogger } from "./log";

const log = createLogger("updates");

export const RELEASES_URL = "https://github.com/AlexEisie/YetAnotherPDFReader/releases";
export const LATEST_API = "https://api.github.com/repos/AlexEisie/YetAnotherPDFReader/releases/latest";
const TIMEOUT_MS = 12_000;

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface ReleaseInfo {
  version: string;
  name: string;
  notes: string;
  url: string;
  publishedAt: string | null;
  assets: ReleaseAsset[];
}

export interface UpdateResult {
  current: string;
  latest: ReleaseInfo;
  newer: boolean;
  /** Package matching this installation, when the release has one. */
  asset: ReleaseAsset | null;
}

/** Numeric parts of a version (`v0.10.2-beta` → [0, 10, 2]) and its pre-release tag. */
function parseVersion(v: string): { parts: number[]; pre: string } {
  const clean = v.trim().replace(/^v/i, "");
  const [core, pre = ""] = clean.split("-", 2);
  return { parts: core.split(".").map((p) => Number.parseInt(p, 10) || 0), pre };
}

/** Negative when `a < b`, 0 when equal, positive when `a > b` (semantic versioning). */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return d;
  }
  // A release is newer than its pre-releases (1.0.0 > 1.0.0-rc.1).
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** The package of `release` that fits this platform and installation kind. */
export function pickAsset(assets: ReleaseAsset[], platform: string, arch: string, installKind: string): ReleaseAsset | null {
  const archOk = (name: string) => (arch === "aarch64" ? /arm64|aarch64/i.test(name) : !/arm64|aarch64/i.test(name));
  const candidates = assets.filter((a) => archOk(a.name));
  const find = (re: RegExp) => candidates.find((a) => re.test(a.name)) ?? null;
  if (platform === "windows") {
    if (installKind === "portable") return find(/portable\.zip$/i);
    return find(/setup\.exe$/i) ?? find(/\.msi$/i);
  }
  if (platform === "linux") {
    if (installKind === "rpm") return find(/\.rpm$/i);
    if (installKind === "deb") return find(/\.deb$/i);
    return find(/\.AppImage$/i);
  }
  if (platform === "macos") return find(/\.dmg$/i);
  return null;
}

/** Convert the GitHub API response into a {@link ReleaseInfo}. */
export function parseRelease(json: unknown): ReleaseInfo {
  const r = json as {
    tag_name?: string;
    name?: string;
    body?: string;
    html_url?: string;
    published_at?: string;
    draft?: boolean;
    prerelease?: boolean;
    assets?: { name?: string; browser_download_url?: string; size?: number }[];
  };
  if (!r || typeof r.tag_name !== "string") throw new Error("unexpected response from GitHub");
  return {
    version: r.tag_name.replace(/^v/i, ""),
    name: r.name || r.tag_name,
    notes: typeof r.body === "string" ? r.body : "",
    url: typeof r.html_url === "string" && r.html_url.startsWith("https://github.com/") ? r.html_url : RELEASES_URL,
    publishedAt: r.published_at ?? null,
    assets: (r.assets ?? [])
      .filter((a) => typeof a.name === "string" && typeof a.browser_download_url === "string" && a.browser_download_url.startsWith("https://github.com/"))
      .map((a) => ({ name: a.name!, url: a.browser_download_url!, size: a.size ?? 0 })),
  };
}

/** Ask GitHub for the latest release and compare it with `current`. */
export async function checkForUpdates(
  current: string,
  env: { platform: string; arch: string; installKind: string },
  signal?: AbortSignal,
): Promise<UpdateResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  signal?.addEventListener("abort", () => controller.abort());
  try {
    const response = await fetch(LATEST_API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText}`);
    const latest = parseRelease(await response.json());
    const newer = compareVersions(latest.version, current) > 0;
    log.info(`update check: current ${current}, latest ${latest.version}${newer ? " (newer)" : ""}`);
    return { current, latest, newer, asset: pickAsset(latest.assets, env.platform, env.arch, env.installKind) };
  } finally {
    clearTimeout(timer);
  }
}

export type AutoCheck = "off" | "daily" | "weekly";

/** Whether an automatic check is due. */
export function checkDue(mode: AutoCheck, lastCheck: number, now = Date.now()): boolean {
  if (mode === "off") return false;
  const interval = mode === "daily" ? 24 * 3600_000 : 7 * 24 * 3600_000;
  return !lastCheck || now - lastCheck >= interval || now < lastCheck;
}

/** Light rendering of release notes (Markdown) into paragraphs, headings and list items. */
export type NoteBlock = { kind: "heading" | "item" | "text"; text: string };

export function noteBlocks(markdown: string): NoteBlock[] {
  const out: NoteBlock[] = [];
  let inCode = false;
  for (const raw of markdown.split(/\r?\n/)) {
    if (raw.trim().startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    // Drop HTML (images, alignment wrappers) and tables.
    const line = raw.replace(/<[^>]+>/g, "").trim();
    if (!line || /^\|/.test(line) || /^[-|: ]+$/.test(line) || line.startsWith(">")) continue;
    const clean = (s: string) =>
      s
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/[*_`]/g, "")
        .trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^[-*+]\s+(.*)$/.exec(line);
    if (heading) out.push({ kind: "heading", text: clean(heading[1]) });
    else if (item) out.push({ kind: "item", text: clean(item[1]) });
    else if (/^\s{2,}\S/.test(raw) && out.length && out[out.length - 1].kind === "item") out[out.length - 1].text += ` ${clean(line)}`;
    else out.push({ kind: "text", text: clean(line) });
  }
  return out.filter((b) => b.text);
}
