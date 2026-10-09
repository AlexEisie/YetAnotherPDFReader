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
