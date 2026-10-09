import { describe, expect, it } from "vitest";
import { formatMessage, formatBytes } from "../i18n/format";
import { negotiateLocale } from "../i18n";
import { sanitizeSettings } from "../settings/store";
import { DEFAULT_SETTINGS } from "../settings/defaults";
import { normalizeAccelerator } from "../commands/keys";
import { formatPageRange, parsePageRange } from "../document/pageRange";
import { layoutToModes, modesToLayout, nextZoomLevel } from "../document/layout";
import { markupLines, resizeAnnotation, simplify, snapAngle, translateAnnotation } from "../annotations/geometry";
import { blankAnnotation, fromExisting, hexToRgb, rgbToHex, visualChanged } from "../annotations/model";
import { serializeChanges } from "../annotations/serialize";
import { History, invertChanges } from "../annotations/history";
import { computeHiddenRefs, indexByPage, withDescendants, type AnnotationState } from "../annotations/store";
import { pageColorStyle, effectivePageMode } from "../document/pageColors";
import { toAppError } from "./errors";

describe("formatMessage", () => {
  it("replaces placeholders and plurals", () => {
    expect(formatMessage("Hello {name}", { name: "A" }, "en")).toBe("Hello A");
    const tpl = "{count, plural, =0 {none} one {# page} other {# pages}}";
    expect(formatMessage(tpl, { count: 0 }, "en")).toBe("none");
    expect(formatMessage(tpl, { count: 1 }, "en")).toBe("1 page");
    expect(formatMessage(tpl, { count: 1200 }, "en")).toBe("1,200 pages");
    expect(formatMessage("Page {page} of {total}", { page: 2, total: 9 }, "en")).toBe("Page 2 of 9");
  });

  it("leaves unknown placeholders and plain text alone", () => {
    expect(formatMessage("Hi {who}", { name: "x" }, "en")).toBe("Hi {who}");
    expect(formatMessage("No params", undefined, "en")).toBe("No params");
  });

  it("formats bytes", () => {
    expect(formatBytes(512, "en")).toBe("512 B");
    expect(formatBytes(1536, "en")).toBe("1.5 KB");
  });
});

describe("negotiateLocale", () => {
  it("maps Chinese variants and partial matches", () => {
    expect(negotiateLocale(["zh-HK"])).toBe("zh-TW");
    expect(negotiateLocale(["zh-Hans-CN"])).toBe("zh-CN");
    expect(negotiateLocale(["de-AT"])).toBe("de");
    expect(negotiateLocale(["xx"])).toBe("en");
  });
});

describe("sanitizeSettings", () => {
  it("fills defaults and drops invalid values", () => {
    const s = sanitizeSettings({
      general: { startup: "nonsense", recentCount: 5000, unknownKey: 1 },
      appearance: { accent: "red", theme: "dark" },
      tools: { shape: { fill: null }, freetext: { borderColor: "#ABCDEF" } },
      shortcuts: { "file.open": ["Ctrl+O", 3], "bad id!": ["X"] },
    });
    expect(s.general.startup).toBe(DEFAULT_SETTINGS.general.startup);
    expect(s.general.recentCount).toBe(100);
    expect((s.general as Record<string, unknown>).unknownKey).toBeUndefined();
    expect(s.appearance.accent).toBe(DEFAULT_SETTINGS.appearance.accent);
    expect(s.appearance.theme).toBe("dark");
    expect(s.tools.shape.fill).toBeNull();
    expect(s.tools.freetext.borderColor).toBe("#abcdef");
    expect(s.shortcuts).toEqual({ "file.open": ["Ctrl+O"] });
  });

  it("accepts garbage", () => {
    expect(sanitizeSettings(null)).toEqual(sanitizeSettings({}));
    expect(sanitizeSettings("x").general.language).toBe("system");
  });
});

describe("accelerators", () => {
  it("normalises human input", () => {
    expect(normalizeAccelerator("shift + ctrl + s")).toBe("Ctrl+Shift+S");
    expect(normalizeAccelerator("Ctrl++")).toBe("Ctrl++");
    expect(normalizeAccelerator("alt+left")).toBe("Alt+Left");
  });
});

describe("page ranges", () => {
  it("parses and formats", () => {
    expect(parsePageRange("1-3, 5, 8-", 10)).toEqual([1, 2, 3, 5, 8, 9, 10]);
    expect(parsePageRange("3-1", 5)).toEqual([3, 2, 1]);
    expect(parsePageRange("0", 5)).toBeNull();
    expect(parsePageRange("11", 10)).toBeNull();
    expect(parsePageRange("abc", 10)).toBeNull();
    expect(formatPageRange([5, 1, 2, 3, 9])).toBe("1-3, 5, 9");
  });
});

describe("layout", () => {
  it("round-trips layouts", () => {
    for (const l of ["continuous", "single", "twoPageContinuous", "twoPage", "horizontal", "wrapped"] as const) {
      const { scroll, spread } = layoutToModes(l, false);
      expect(modesToLayout(scroll, spread)).toBe(l);
    }
  });

  it("steps through zoom levels", () => {
    expect(nextZoomLevel(1, 1)).toBeCloseTo(1.1);
    expect(nextZoomLevel(1, -1)).toBeCloseTo(0.9);
    expect(nextZoomLevel(30, 1)).toBeCloseTo(24);
  });
});

describe("geometry", () => {
  it("translates and resizes", () => {
    const a = { ...blankAnnotation("ink", 0, [0, 0, 10, 10]), inkList: [[0, 0, 10, 10]] };
    const moved = translateAnnotation(a, 5, -5);
    expect(moved.rect).toEqual([5, -5, 15, 5]);
    expect(moved.inkList[0]).toEqual([5, -5, 15, 5]);
    const big = resizeAnnotation(a, [0, 0, 20, 40]);
    expect(big.inkList[0]).toEqual([0, 0, 20, 40]);
  });

  it("simplifies collinear points", () => {
    expect(simplify([0, 0, 1, 1, 2, 2, 3, 3], 0.1)).toEqual([0, 0, 3, 3]);
  });

  it("snaps angles", () => {
    const [x, y] = snapAngle([0, 0], [10, 1]);
    expect(Math.round(x)).toBe(10);
    expect(Math.round(y)).toBe(0);
  });

  it("puts underlines near the bottom of quads", () => {
    const [line] = markupLines([0, 10, 50, 10, 0, 0, 50, 0], 0);
    expect(line.y1).toBeGreaterThan(0);
    expect(line.y1).toBeLessThan(3);
  });
});

describe("colours", () => {
  it("converts hex and rgb", () => {
    expect(rgbToHex(hexToRgb("#ff8000"))).toBe("#ff8000");
    expect(hexToRgb("nope")).toBeNull();
  });
});

function state(items: AnnotationState["items"], pristine: AnnotationState["pristine"]): AnnotationState {
  return {
    items,
    pristine,
    byPage: indexByPage(items),
    loaded: true,
    loadError: null,
    selection: [],
    hover: null,
    editing: null,
    version: 0,
    preview: null,
  };
}

describe("serializeChanges", () => {
  const existing = fromExisting({
    ref: "12R",
    pageIndex: 0,
    subtype: "Square",
    annotation: { kind: "square", pageIndex: 0, rect: [0, 0, 10, 10], color: [1, 0, 0], contents: "c" },
    rect: [0, 0, 10, 10],
    hasAppearance: true,
    popupRef: null,
    inReplyToRef: null,
    replyType: null,
    flags: 4,
    contents: "c",
    author: "A",
    modified: null,
  })!;

  it("reports nothing for an untouched model", () => {
    const { changes } = serializeChanges(state({ "12R": existing }, { "12R": existing }), null, null);
    expect(changes.annotations).toEqual({ add: [], modify: [], delete: [] });
  });

  it("adds, modifies (with or without appearance) and deletes", () => {
    const added = blankAnnotation("note", 1, [5, 5, 25, 25]);
    const reply = { ...blankAnnotation("note", 1, [5, 5, 25, 25]), inReplyTo: added.id, replyType: "R" as const };
    const recolored = { ...existing, color: [0, 0, 1] as [number, number, number] };
    let out = serializeChanges(state({ "12R": recolored, [added.id]: added, [reply.id]: reply }, { "12R": existing }), null, "zh-CN");
    expect(out.changes.annotations.add.map((a) => a.nm)).toEqual([added.nm, reply.nm]);
    expect(out.changes.annotations.add[1].inReplyToNm).toBe(added.nm);
    expect(out.changes.annotations.modify[0]).toMatchObject({ ref: "12R", regenerateAppearance: true });
    const commented = { ...existing, contents: "new" };
    out = serializeChanges(state({ "12R": commented }, { "12R": existing }), null, null);
    expect(out.changes.annotations.modify[0].regenerateAppearance).toBe(false);
    out = serializeChanges(state({}, { "12R": existing }), null, null);
    expect(out.changes.annotations.delete).toEqual(["12R"]);
  });

  it("hides modified and deleted file annotations from pdf.js", () => {
    const moved = translateAnnotation(existing, 1, 1);
    expect(visualChanged(moved, existing)).toBe(true);
    expect(computeHiddenRefs(state({ "12R": moved }, { "12R": existing }), true).has("12R")).toBe(true);
    expect(computeHiddenRefs(state({ "12R": existing }, { "12R": existing }), true).size).toBe(0);
    expect(computeHiddenRefs(state({ "12R": existing }, { "12R": existing }), false).has("12R")).toBe(true);
  });

  it("collects replies transitively", () => {
    const a = blankAnnotation("note", 0, [0, 0, 1, 1]);
    const b = { ...blankAnnotation("note", 0, [0, 0, 1, 1]), inReplyTo: a.id };
    const c = { ...blankAnnotation("note", 0, [0, 0, 1, 1]), inReplyTo: b.id };
    expect(withDescendants(state({ [a.id]: a, [b.id]: b, [c.id]: c }, {}), [a.id]).sort()).toEqual([a.id, b.id, c.id].sort());
  });
});

describe("History", () => {
  it("tracks dirty state, merges and inverts", () => {
    const h = new History();
    const a = blankAnnotation("note", 0, [0, 0, 1, 1]);
    expect(h.dirty).toBe(false);
    h.pushAnnotations("add", [{ id: a.id, before: null, after: a }]);
    expect(h.dirty).toBe(true);
    h.markSaved();
    expect(h.dirty).toBe(false);
    const b = { ...a, contents: "x" };
    const c2 = { ...a, contents: "xy" };
    h.pushAnnotations("edit", [{ id: a.id, before: a, after: b }], "k");
    h.pushAnnotations("edit", [{ id: a.id, before: b, after: c2 }], "k");
    const cmd = h.undo();
    expect(cmd?.type).toBe("annotations");
    if (cmd?.type === "annotations") {
      expect(cmd.changes[0].before).toBe(a);
      expect(cmd.changes[0].after).toBe(c2);
      expect(invertChanges(cmd.changes)[0].after).toBe(a);
    }
    expect(h.dirty).toBe(false);
    h.redo();
    expect(h.dirty).toBe(true);
  });
});

describe("page colours", () => {
  it("follows the dark theme when asked", () => {
    const pc = { ...DEFAULT_SETTINGS.pageColors, followTheme: true, darkStyle: "night" as const };
    expect(effectivePageMode(pc, true)).toBe("night");
    expect(effectivePageMode(pc, false)).toBe("normal");
    expect(pageColorStyle({ ...pc, mode: "dark" }, false).isDark).toBe(true);
    expect(pageColorStyle({ ...pc, mode: "night" }, false).restoreImages).toBe(true);
  });
});

describe("errors", () => {
  it("normalises Rust and pdf.js errors", () => {
    expect(toAppError({ code: "NOT_FOUND", message: "x", detail: "p" }).code).toBe("NOT_FOUND");
    const pw = new Error("need");
    pw.name = "PasswordException";
    expect(toAppError(pw).code).toBe("PASSWORD");
    expect(toAppError("boom").code).toBe("INTERNAL");
  });
});

describe("recovery snapshots", async () => {
  const { recoveryPayload, restoreRecoveryPayload } = await import("../document/recovery");
  it("round-trips added, modified and deleted comments", async () => {
    const kept = blankAnnotation("square", 0, [0, 0, 10, 10]);
    const removed = blankAnnotation("circle", 0, [0, 0, 10, 10]);
    const pristine = { [kept.id]: kept, [removed.id]: removed };
    const changed = { ...kept, contents: "edited" };
    const added = blankAnnotation("note", 1, [5, 5, 25, 25]);
    const payload = JSON.parse(JSON.stringify(recoveryPayload({ items: { [kept.id]: changed, [added.id]: added }, pristine })));
    const changes = await restoreRecoveryPayload({ items: pristine, pristine }, payload);
    const byId = Object.fromEntries(changes.map((c) => [c.id, c]));
    expect(byId[removed.id].after).toBeNull();
    expect(byId[kept.id].after?.contents).toBe("edited");
    expect(byId[added.id].before).toBeNull();
    expect(await restoreRecoveryPayload({ items: {}, pristine: {} }, { version: 99 })).toEqual([]);
  });
});

describe("snapshot geometry", async () => {
  const { clampToPage, snapshotSize } = await import("../document/snapshot");
  it("clamps the region to the page box and normalises it", () => {
    expect(clampToPage([700, 900, -20, 100], [0, 0, 612, 792])).toEqual([0, 100, 612, 792]);
    expect(clampToPage([700, 900, 800, 1000], [0, 0, 612, 792])).toBeNull();
  });
  it("keeps huge regions inside the pixel budget", () => {
    expect(snapshotSize([0, 0, 100, 50], 2)).toEqual({ width: 200, height: 100, scale: 2 });
    const big = snapshotSize([0, 0, 2000, 2000], 600 / 72);
    expect(big.width * big.height).toBeLessThanOrEqual(40_000_000);
    expect(Math.max(big.width, big.height)).toBeLessThanOrEqual(16384);
  });
});

describe("recent documents", async () => {
  const { pathKey, dedupeRecent } = await import("../state/library");
  const r = String.raw;
  it("gives one key to every spelling of a Windows path", () => {
    const key = pathKey(r`D:\Docs\Report.pdf`, true);
    for (const p of ["d:/docs/report.pdf", r`D:\Docs\.\Sub\..\Report.pdf`, r`D:\\Docs\Report.pdf`, r`\\?\D:\Docs\Report.pdf`]) {
      expect(pathKey(p, true)).toBe(key);
    }
    expect(pathKey(r`\\?\UNC\srv\share\a.pdf`, true)).toBe(pathKey(r`\\srv\share\x\..\a.pdf`, true));
    expect(pathKey("/home/A/x.pdf", false)).not.toBe(pathKey("/home/a/x.pdf", false));
  });

  it("keeps the latest entry per file, newest first", () => {
    const e = (path: string, openedAt: number) => ({ path, name: "x", openedAt, pages: null, thumb: null });
    const list = dedupeRecent([e(r`C:\a.pdf`, 1), e(r`C:\b.pdf`, 5), e("c:/A.pdf", 9), e(r`C:\b.pdf`, 2)], true);
    expect(list.map((x) => [x.path, x.openedAt])).toEqual([
      ["c:/A.pdf", 9],
      [r`C:\b.pdf`, 5],
    ]);
  });
});

describe("page editing plans", async () => {
  const { planInsertion, planReplace, orderMoving, planSplit, splitFileNames, passwordStrength, watermarkPlacements } = await import("../document/pageEditing");
  const pdf = (pageCount: number, pages: number[] | null = null) =>
    ({ kind: "pdf", path: "a.pdf", name: "a.pdf", bytes: new Uint8Array(1), pageCount, password: null, pages }) as const;
  const picture = (w: number, h: number) =>
    ({ kind: "picture", path: "p.png", name: "p.png", bytes: new Uint8Array(1), image: { format: "rgba", width: w, height: h }, preview: null }) as const;

  it("inserts sources in order, grouping consecutive pictures", () => {
    const { ops, blobs } = planInsertion([picture(10, 10), picture(20, 10), pdf(5, [2, 3]), picture(5, 5)], 3, { pageSize: [595, 842], margin: 0 });
    expect(blobs).toHaveLength(4);
    expect(ops.map((o) => [o.op, "at" in o ? o.at : null])).toEqual([
      ["insertImages", 3],
      ["insertFromBlob", 5],
      ["insertImages", 7],
    ]);
    expect(ops[1]).toMatchObject({ blob: 2, pages: [1, 2] });
    expect(ops[0]).toMatchObject({ images: [{ blob: 0 }, { blob: 1 }], pageSize: [595, 842] });
  });

  it("replaces pages by inserting first and deleting the shifted targets", () => {
    const plan = planReplace([5, 3, 4], (at) => ({ ops: [{ op: "insertBlank", at, count: 2, width: 1, height: 1 }], blobs: [], count: 2 }));
    expect(plan.ops).toEqual([
      { op: "insertBlank", at: 2, count: 2, width: 1, height: 1 },
      { op: "delete", pages: [4, 5, 6] },
    ]);
  });

  it("moves selected pages to a gap", () => {
    expect(orderMoving(5, [1, 2], 4)).toEqual([2, 3, 0, 1, 4]);
    expect(orderMoving(5, [5], 0)).toEqual([4, 0, 1, 2, 3]);
    expect(orderMoving(5, [2], 1)).toBeNull();
    expect(orderMoving(5, [2, 4], 5)).toEqual([0, 2, 4, 1, 3]);
  });

  it("plans document splits", () => {
    expect(planSplit(7, "every", 3)).toEqual([
      [1, 3],
      [4, 6],
      [7, 7],
    ]);
    expect(planSplit(10, "parts", 3)).toEqual([
      [1, 4],
      [5, 7],
      [8, 10],
    ]);
    expect(planSplit(10, "ranges", "1-3, 4-8，9-")).toEqual([
      [1, 3],
      [4, 8],
      [9, 10],
    ]);
    expect(planSplit(10, "ranges", "5")).toEqual([[5, 5]]);
    expect(planSplit(10, "ranges", "8-3")).toBeNull();
    expect(planSplit(10, "parts", 11)).toBeNull();
    expect(splitFileNames("doc", [[1, 3], [4, 4]])).toEqual(["doc (1-3).pdf", "doc (4).pdf"]);
  });

  it("rates passwords", () => {
    expect(passwordStrength("abc")).toBe(0);
    expect(passwordStrength("abcdef")).toBe(1);
    expect(passwordStrength("abcdefgh1")).toBe(2);
    expect(passwordStrength("Correct-Horse-9")).toBe(3);
  });

  it("places watermarks like the PDF core", () => {
    const [[x, y]] = watermarkPlacements("topLeft", 600, 800, 200, 40, 0);
    expect(x).toBeCloseTo(36 + 100);
    expect(y).toBeCloseTo(800 - 36 - 20);
    const tiles = watermarkPlacements("tile", 600, 800, 160, 60, 45);
    expect(tiles.length).toBeGreaterThan(6);
  });
});

describe("OCR text assembly", async () => {
  const { linesToText } = await import("../document/ocr");
  const line = (text: string, x: number, y: number, w = 100, h = 20) => ({
    text,
    confidence: 0.99,
    points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] as [[number, number], [number, number], [number, number], [number, number]],
  });
  it("joins boxes of a row and keeps rows in order", () => {
    expect(linesToText([line("world", 120, 2), line("Hello", 0, 0), line("Next line", 0, 40)])).toBe("Hello world\nNext line");
  });
  it("does not insert spaces between CJK boxes", () => {
    expect(linesToText([line("城市夜空", 0, 0), line("观测手册", 110, 1), line("Page 1", 0, 30)])).toBe("城市夜空观测手册\nPage 1");
  });
  it("handles an empty result", () => {
    expect(linesToText([])).toBe("");
  });
});

describe("update check", async () => {
  const { compareVersions, pickAsset, parseRelease, checkDue, noteBlocks } = await import("./updates");
  const assets = [
    "YetAnotherPDFReader_0.4.0_x64-setup.exe",
    "YetAnotherPDFReader_0.4.0_x64_en-US.msi",
    "YetAnotherPDFReader_0.4.0_x64_portable.zip",
    "YetAnotherPDFReader_0.4.0_amd64.deb",
    "YetAnotherPDFReader-0.4.0-1.x86_64.rpm",
    "YetAnotherPDFReader_0.4.0_amd64.AppImage",
  ].map((name) => ({ name, url: `https://github.com/x/${name}`, size: 1 }));

  it("compares versions", () => {
    expect(compareVersions("0.3.0", "0.3.0")).toBe(0);
    expect(compareVersions("v0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.3", "0.3.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0-rc.2")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0-rc.2")).toBeLessThan(0);
  });

  it("offers the package matching the installation", () => {
    expect(pickAsset(assets, "windows", "x86_64", "installer")?.name).toMatch(/setup\.exe$/);
    expect(pickAsset(assets, "windows", "x86_64", "portable")?.name).toMatch(/portable\.zip$/);
    expect(pickAsset(assets, "linux", "x86_64", "deb")?.name).toMatch(/\.deb$/);
    expect(pickAsset(assets, "linux", "x86_64", "rpm")?.name).toMatch(/\.rpm$/);
    expect(pickAsset(assets, "linux", "x86_64", "appimage")?.name).toMatch(/\.AppImage$/);
    expect(pickAsset(assets, "linux", "aarch64", "deb")).toBeNull();
    expect(pickAsset(assets, "macos", "aarch64", "installer")).toBeNull();
  });

  it("parses the GitHub response and ignores foreign links", () => {
    const release = parseRelease({
      tag_name: "v0.4.0",
      name: "v0.4.0 — test",
      body: "## New\n- one",
      html_url: "https://github.com/AlexEisie/YetAnotherPDFReader/releases/tag/v0.4.0",
      published_at: "2026-11-01T00:00:00Z",
      assets: [
        { name: "a.exe", browser_download_url: "https://github.com/a.exe", size: 5 },
        { name: "evil.exe", browser_download_url: "https://example.com/evil.exe", size: 5 },
      ],
    });
    expect(release.version).toBe("0.4.0");
    expect(release.assets.map((a) => a.name)).toEqual(["a.exe"]);
    expect(() => parseRelease({ message: "Not Found" })).toThrow();
    expect(parseRelease({ tag_name: "v1", html_url: "https://evil.example" }).url).toContain("github.com/AlexEisie");
  });

  it("schedules automatic checks", () => {
    const day = 24 * 3600_000;
    expect(checkDue("off", 0)).toBe(false);
    expect(checkDue("daily", 0)).toBe(true);
    expect(checkDue("daily", 1_000_000, 1_000_000 + day - 1)).toBe(false);
    expect(checkDue("weekly", 1_000_000, 1_000_000 + 7 * day)).toBe(true);
  });

  it("renders release notes", () => {
    const blocks = noteBlocks('<p align="center"><img src="x.png"></p>\n**Big** release\n## ✨ New\n- **Organizer**: [docs](https://x)\n  more text\n```\ncode\n```\n| a | b |\n|---|---|');
    expect(blocks).toEqual([
      { kind: "text", text: "Big release" },
      { kind: "heading", text: "✨ New" },
      { kind: "item", text: "Organizer: docs more text" },
    ]);
  });
});

describe("user guide", async () => {
  const { helpTopics, referencedCommands, searchHelp } = await import("../help/content");
  const fs = await import("node:fs");
  const registry = fs.readFileSync(new URL("../commands/registry.ts", import.meta.url), "utf8");

  it("has the same topics in every language", () => {
    const zh = helpTopics("zh-CN");
    const en = helpTopics("en");
    expect(zh.map((t) => t.id)).toEqual(en.map((t) => t.id));
    zh.forEach((t, i) => expect(t.blocks.length).toBe(en[i].blocks.length));
    expect(helpTopics("ja")).toBe(en);
    expect(helpTopics("zh-TW")).toBe(zh);
  });

  it("only refers to existing commands", () => {
    const ids = new Set([...registry.matchAll(/id: "([a-zA-Z.]+)"/g)].map((m) => m[1]));
    for (const m of registry.matchAll(/sidebarPanel\("([a-z]+)"/g)) ids.add(`view.sidebar.${m[1]}`);
    for (const m of registry.matchAll(/pageMode\("([a-z]+)"/g)) ids.add(`view.bg.${m[1]}`);
    const missing = referencedCommands().filter((id) => !ids.has(id));
    expect(missing).toEqual([]);
  });

  it("searches the guide", () => {
    const zh = helpTopics("zh-CN");
    expect(searchHelp(zh, "扫描件").some((r) => r.topic.id === "ocr")).toBe(true);
    expect(searchHelp(helpTopics("en"), "password remove").map((r) => r.block.title)).toContain("Remove a password");
    expect(searchHelp(zh, "")).toEqual([]);
  });
});

describe("what's new", async () => {
  const { RELEASE_NOTES, notesBetween, pendingNotes, recentNotes, FIRST_TRACKED_FROM } = await import("../help/releaseNotes");
  const { compareVersions } = await import("./updates");
  const fs = await import("node:fs");
  const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

  it("has notes for the version being released", () => {
    // Every release must add a short entry to src/help/releaseNotes.ts.
    expect(RELEASE_NOTES.map((n) => n.version)).toContain(pkg.version.replace(/[-+].*$/, ""));
  });

  it("keeps the notes short and in both languages", () => {
    for (const n of RELEASE_NOTES) {
      expect(n.zh.length).toBe(n.en.length);
      expect(n.zh.length).toBeGreaterThan(0);
      expect(n.zh.length).toBeLessThanOrEqual(6);
      for (const line of n.zh) expect(line.length).toBeLessThanOrEqual(45);
      for (const line of n.en) expect(line.length).toBeLessThanOrEqual(110);
    }
    const sorted = [...RELEASE_NOTES].sort((a, b) => compareVersions(b.version, a.version));
    expect(RELEASE_NOTES).toEqual(sorted);
  });

  it("shows the versions since the last one the user ran", () => {
    expect(notesBetween("0.1.0", "0.3.0").map((n) => n.version)).toEqual(["0.3.0", "0.2.0"]);
    expect(notesBetween("0.3.0", "0.3.0")).toEqual([]);
    expect(notesBetween("0.2.0", "0.3.0-dev").map((n) => n.version)).toEqual(["0.3.0"]);
    expect(pendingNotes("0.4.0", "", true).notes).toEqual([]);
    expect(pendingNotes("0.4.0", "", false).from).toBe(FIRST_TRACKED_FROM);
    expect(pendingNotes("0.4.0", "", false).notes.map((n) => n.version)).toEqual(["0.4.0"]);
    expect(pendingNotes("0.4.0", "0.2.0", false).notes.map((n) => n.version)).toEqual(["0.4.0", "0.3.0"]);
    expect(pendingNotes("0.3.0", "0.4.0", false).notes).toEqual([]);
    expect(recentNotes("0.3.0", 2).map((n) => n.version)).toEqual(["0.3.0", "0.2.0"]);
  });
});
