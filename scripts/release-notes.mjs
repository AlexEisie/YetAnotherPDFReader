/**
 * Release notes for GitHub from CHANGELOG.md and the release files.
 *
 *   node scripts/release-notes.mjs v0.4.1 checksums.txt           # notes (Markdown)
 *   node scripts/release-notes.mjs v0.4.1 checksums.txt --title   # release title
 *
 * `checksums.txt` has `sha256  file-name` lines (the output of sha256sum). The changes come from
 * the version's sections in CHANGELOG.md (both languages); `docs/releases/vX.Y.Z.md`, when it
 * exists, is put above them (for a picture, say).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = "AlexEisie/YetAnotherPDFReader";
const [tag, sumsFile, flag] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+/.test(tag ?? "") || !sumsFile) {
  console.error("usage: node scripts/release-notes.mjs vX.Y.Z checksums.txt [--title]");
  process.exit(2);
}
const version = tag.slice(1);
const root = resolve(import.meta.dirname, "..");

/** The "### vX.Y.Z — title" section under the "## <language>" heading of the changelog. */
function section(changelog, language) {
  const lang = changelog.split(/^## /m).find((s) => s.startsWith(language));
  if (!lang) return null;
  const part = lang.split(/^### /m).find((s) => s.startsWith(`v${version} `) || s.startsWith(`v${version}\n`));
  if (!part) return null;
  const [heading, ...body] = part.split("\n");
  const title = heading.replace(/^v\S+\s*(—\s*)?/, "").trim();
  // Links relative to the repository point at the tagged files.
  const text = body
    .join("\n")
    .trim()
    .replace(/\]\((?!https?:|#)([^)]+)\)/g, `](https://github.com/${REPO}/blob/${tag}/$1)`);
  return { title, text };
}

const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
const zh = section(changelog, "简体中文");
const en = section(changelog, "English");
if (!zh || !en) {
  console.error(`CHANGELOG.md has no v${version} section in both languages`);
  process.exit(1);
}

if (flag === "--title") {
  console.log(`YetAnotherPDFReader ${tag} — ${zh.title} · ${en.title}`);
  process.exit(0);
}

const sums = readFileSync(sumsFile, "utf8")
  .split("\n")
  .map((l) => l.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/))
  .filter(Boolean)
  .map((m) => ({ hash: m[1], name: m[2].replace(/^.*[\\/]/, "") }));

const ROWS = [
  [/_x64-setup\.exe$/, "", "**Windows 安装版（推荐）**，无需管理员权限 · **Windows installer (recommended)**, no admin rights"],
  [/_x64(_en-US)?\.msi$/, "", "Windows MSI 安装包 · Windows MSI package"],
  [/_x64_portable\.zip$/, "", "**Windows 便携版**：解压即用 · **Windows portable**: unzip and run"],
  [/_(macos_arm64|aarch64)\.dmg$/, "🍎 ", "**macOS（Apple 芯片）**：打开后拖到「应用程序」· **macOS (Apple silicon)**: open and drag to *Applications*"],
  [/_x64\.dmg$/, "🍎 ", "macOS（Intel）· macOS (Intel)"],
  [/_(linux_x64|amd64)\.deb$/, "🐧 ", (f) => `Debian / Ubuntu / Linux Mint：\`sudo apt install ./${f}\``],
  [/(_linux_x64|\.x86_64)\.rpm$/, "🐧 ", (f) => `Fedora / openSUSE：\`sudo dnf install ./${f}\``],
  [/_(linux_x64|amd64)\.AppImage$/, "🐧 ", "任意发行版，`chmod +x` 后直接运行 · any distribution: `chmod +x` and run"],
  [/_(linux_)?arm64\.deb$/, "🐧 ", (f) => `ARM64（树莓派 OS 64 位、Ubuntu 等 · Raspberry Pi OS 64-bit, Ubuntu, …）：\`sudo apt install ./${f}\``],
  [/(_linux_arm64|\.aarch64)\.rpm$/, "🐧 ", (f) => `ARM64 Fedora / openSUSE：\`sudo dnf install ./${f}\``],
  [/_(linux_arm64|aarch64)\.AppImage$/, "🐧 ", "ARM64 任意发行版 · ARM64, any distribution"],
];
const files = [];
for (const [re, icon, note] of ROWS) {
  for (const s of sums.filter((x) => re.test(x.name))) {
    files.push({ ...s, row: `| ${icon}\`${s.name}\` | ${typeof note === "function" ? note(s.name) : note} |` });
  }
}
const unknown = sums.filter((s) => !files.some((f) => f.name === s.name));
for (const s of unknown) files.push({ ...s, row: `| \`${s.name}\` | |` });

const has = (re) => files.some((f) => re.test(f.name));
const extra = resolve(root, "docs", "releases", `${tag}.md`);
const out = [];
if (existsSync(extra)) out.push(readFileSync(extra, "utf8").trim(), "");
out.push(
  `**${zh.title}** · *${en.title}*`,
  "",
  "## ✨ 更新内容",
  "",
  zh.text,
  "",
  "## ✨ What's new",
  "",
  en.text,
  "",
  `完整更新日志 · Full changelog：[CHANGELOG.md](https://github.com/${REPO}/blob/${tag}/CHANGELOG.md)`,
  "",
  "## 📥 下载 · Downloads",
  "",
  "| 文件 · File | 说明 · Notes |",
  "| --- | --- |",
  ...files.map((f) => f.row),
  "",
);
const req = [];
if (has(/\.(exe|msi|zip)$/)) req.push("Windows 10 / 11 x64（Microsoft Edge WebView2）");
if (has(/\.dmg$/)) req.push("macOS 13.4+");
if (has(/\.(deb|rpm|AppImage)$/)) req.push("Linux x86_64 / ARM64，glibc 2.35+（Ubuntu 22.04、Debian 12、Fedora 36 及更新版本），WebKitGTK 4.1");
out.push(`系统要求 · Requirements：${req.join("；")}。`, "");
if (has(/\.(exe|msi|zip)$/)) {
  out.push(
    "> 安装包暂未签名，如出现 SmartScreen 提示，请点「更多信息」→「仍要运行」· Not code-signed yet; on SmartScreen choose \"More info\" → \"Run anyway\".",
  );
}
if (has(/\.dmg$/)) {
  out.push(
    ">",
    "> macOS 版本未经 Apple 公证：首次打开被阻止时，到「系统设置 ▸ 隐私与安全性」点「仍要打开」；如提示「已损坏」，运行 `xattr -dr com.apple.quarantine /Applications/YetAnotherPDFReader.app`。",
    "> The macOS app is not notarized: if the first launch is blocked, choose *Open Anyway* in *System Settings ▸ Privacy & Security*; if macOS says it \"is damaged\", run `xattr -dr com.apple.quarantine /Applications/YetAnotherPDFReader.app`.",
  );
}
out.push("", "## 🔐 SHA-256", "", "```", ...files.map((f) => `${f.hash}  ${f.name}`), "```", "");
process.stdout.write(out.join("\n"));
