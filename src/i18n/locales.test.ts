import { describe, it, expect } from "vitest";
import en from "./locales/en";
import zhCN from "./locales/zh-CN";
import zhTW from "./locales/zh-TW";
import ja from "./locales/ja";
import ko from "./locales/ko";
import de from "./locales/de";
import fr from "./locales/fr";
import es from "./locales/es";
import ru from "./locales/ru";
import { formatMessage, type Params } from "./format";
import { LOCALES } from "./index";

type Dict = Record<string, string>;

const TRANSLATIONS: Record<string, Dict> = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  ja,
  ko,
  de,
  fr,
  es,
  ru,
};

const EN: Dict = en;
const EN_KEYS = Object.keys(EN);

// --- A small parser for the message syntax understood by format.ts -----------------------------

interface Plural {
  name: string;
  /** selector (`one`, `few`, `other`, `=0`, …) → branch text */
  branches: Map<string, string>;
}

interface Parsed {
  /** Placeholder names, including plural variables; plural selector words are not included. */
  names: Set<string>;
  plurals: Plural[];
}

function matchBrace(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

function assertBalanced(text: string): void {
  let depth = 0;
  for (const ch of text) {
    if (ch === "{") depth++;
    else if (ch === "}" && --depth < 0) throw new Error("unbalanced '}'");
  }
  if (depth !== 0) throw new Error("unbalanced '{'");
}

const SELECTOR = /\s*(=\d+|zero|one|two|few|many|other)\s*\{/y;

function parseBranches(body: string): Map<string, string> {
  const branches = new Map<string, string>();
  let i = 0;
  while (body.slice(i).trim() !== "") {
    SELECTOR.lastIndex = i;
    const m = SELECTOR.exec(body);
    if (!m) throw new Error(`invalid plural selector near "${body.slice(i).trim()}"`);
    const open = SELECTOR.lastIndex - 1;
    const close = matchBrace(body, open);
    if (branches.has(m[1])) throw new Error(`duplicate plural selector "${m[1]}"`);
    branches.set(m[1], body.slice(open + 1, close));
    i = close + 1;
  }
  if (!branches.has("other")) throw new Error("plural expression without an 'other' branch");
  return branches;
}

function walk(text: string, out: Parsed): void {
  assertBalanced(text);
  let i = text.indexOf("{");
  while (i >= 0) {
    const close = matchBrace(text, i);
    const inner = text.slice(i + 1, close);
    const m = /^\s*([A-Za-z_]\w*)\s*(?:,\s*(\w+)\s*,([\s\S]*))?$/.exec(inner);
    if (!m) throw new Error(`malformed placeholder "{${inner}}"`);
    out.names.add(m[1]);
    if (m[2] !== undefined) {
      if (m[2] !== "plural") throw new Error(`unsupported argument type "${m[2]}"`);
      const branches = parseBranches(m[3]);
      out.plurals.push({ name: m[1], branches });
      for (const branch of branches.values()) walk(branch, out);
    }
    i = text.indexOf("{", close + 1);
  }
}

function parse(template: string): Parsed {
  const out: Parsed = { names: new Set(), plurals: [] };
  walk(template, out);
  return out;
}

const sorted = (values: Iterable<string>) => [...values].sort();

const EN_PARSED = new Map(EN_KEYS.map((k) => [k, parse(EN[k])]));
const PLURAL_VARS = new Set([...EN_PARSED.values()].flatMap((p) => p.plurals.map((pl) => pl.name)));
const ALL_PLACEHOLDERS = new Set([...EN_PARSED.values()].flatMap((p) => [...p.names]));

/** Generic params containing every placeholder name used in en.ts. */
function sampleParams(count: number): Params {
  const params: Params = {};
  for (const name of ALL_PLACEHOLDERS) params[name] = PLURAL_VARS.has(name) ? count : `<${name}>`;
  return params;
}

/** Counts that exercise every plural category (incl. ru few/many and the `=0` branches). */
const SAMPLE_COUNTS = [0, 1, 2, 3, 5, 11, 21, 22, 25, 101, 112, 1.5];

/** Plural categories a locale actually produces for integer counts in everyday ranges. */
function integerCategories(locale: string): Set<string> {
  const rules = new Intl.PluralRules(locale);
  const cats = new Set<string>();
  for (let n = 0; n <= 200; n++) cats.add(rules.select(n));
  return cats;
}

describe("en.ts (reference locale)", () => {
  it("parses and formats every message", () => {
    for (const count of SAMPLE_COUNTS) {
      for (const key of EN_KEYS) {
        const out = formatMessage(EN[key], sampleParams(count), "en");
        expect(out, key).not.toMatch(/[{}]/);
      }
    }
  });
});

describe("LOCALES registry", () => {
  it("lists exactly the tested locales plus English", () => {
    expect(sorted(LOCALES.map((l) => l.code))).toEqual(sorted(["en", ...Object.keys(TRANSLATIONS)]));
  });

  it("loads each locale module", async () => {
    for (const info of LOCALES) {
      if (info.code === "en") continue;
      const mod = await info.load();
      expect(mod.default, info.code).toBe(TRANSLATIONS[info.code]);
    }
  });
});

describe.each(Object.entries(TRANSLATIONS))("locale %s", (code, messages) => {
  it("has exactly the keys of en.ts, in the same order", () => {
    const keys = Object.keys(messages);
    expect(sorted(keys)).toEqual(sorted(EN_KEYS));
    expect(keys).toEqual(EN_KEYS);
  });

  it("translates every key with a non-empty string", () => {
    const bad = EN_KEYS.filter((k) => typeof messages[k] !== "string" || messages[k].trim() === "");
    expect(bad).toEqual([]);
  });

  it("keeps the product names untranslated", () => {
    expect(messages["app.name"]).toBe(EN["app.name"]);
    expect(messages["app.shortName"]).toBe(EN["app.shortName"]);
  });

  it("uses the same placeholder names as en.ts", () => {
    const mismatches: string[] = [];
    for (const key of EN_KEYS) {
      let names: string[];
      try {
        names = sorted(parse(messages[key]).names);
      } catch (err) {
        mismatches.push(`${key}: ${(err as Error).message}`);
        continue;
      }
      const expected = sorted(EN_PARSED.get(key)!.names);
      if (names.join(",") !== expected.join(",")) mismatches.push(`${key}: {${names}} vs en {${expected}}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("has well-formed plural expressions covering the locale's plural categories", () => {
    const needed = integerCategories(code);
    const problems: string[] = [];
    for (const key of EN_KEYS) {
      const enPlurals = EN_PARSED.get(key)!.plurals;
      let plurals: Plural[];
      try {
        plurals = parse(messages[key]).plurals;
      } catch (err) {
        problems.push(`${key}: ${(err as Error).message}`);
        continue;
      }
      expect(sorted(plurals.map((p) => p.name)), key).toEqual(sorted(enPlurals.map((p) => p.name)));
      for (const enPlural of enPlurals) {
        const plural = plurals.find((p) => p.name === enPlural.name);
        if (!plural) continue;
        const exact = (p: Plural) => sorted([...p.branches.keys()].filter((s) => s.startsWith("=")));
        if (exact(plural).join() !== exact(enPlural).join()) {
          problems.push(`${key}: exact branches [${exact(plural)}] vs en [${exact(enPlural)}]`);
        }
        for (const cat of needed) {
          if (!plural.branches.has(cat) && cat !== "other") problems.push(`${key}: missing '${cat}' branch`);
        }
        const enUsesHash = [...enPlural.branches].every(([sel, text]) => sel.startsWith("=") || text.includes("#"));
        for (const [sel, text] of plural.branches) {
          if (enUsesHash && !sel.startsWith("=") && !text.includes("#")) problems.push(`${key}: '${sel}' branch lacks '#'`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("formats every message without leftover placeholders", () => {
    const problems: string[] = [];
    for (const count of SAMPLE_COUNTS) {
      const params = sampleParams(count);
      for (const key of EN_KEYS) {
        const out = formatMessage(messages[key], params, code);
        if (/[{}]/.test(out)) problems.push(`${key} (count=${count}): ${out}`);
        if (out.includes("#") && !formatMessage(EN[key], params, "en").includes("#")) {
          problems.push(`${key} (count=${count}): stray '#': ${out}`);
        }
        for (const name of EN_PARSED.get(key)!.names) {
          if (!PLURAL_VARS.has(name) && !out.includes(`<${name}>`)) problems.push(`${key}: {${name}} not substituted`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
