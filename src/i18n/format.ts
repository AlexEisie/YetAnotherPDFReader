/**
 * Minimal message formatter: `{name}` placeholders plus an ICU-like plural subset
 * `{count, plural, one {# page} other {# pages}}` (`#` is replaced by the formatted number).
 */

export type Params = Record<string, string | number>;

const pluralCache = new Map<string, Intl.PluralRules>();

function pluralRules(locale: string): Intl.PluralRules {
  let rules = pluralCache.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralCache.set(locale, rules);
  }
  return rules;
}

/** Find the matching closing brace for the brace at `start`. */
function matchBrace(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

function formatPlural(body: string, value: number, locale: string): string {
  // body: "one {# page} other {# pages}" (optionally "=0 {...}")
  const options = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    let key = "";
    while (i < body.length && body[i] !== "{" && !/\s/.test(body[i])) key += body[i++];
    while (i < body.length && /\s/.test(body[i])) i++;
    if (body[i] !== "{") break;
    const end = matchBrace(body, i);
    if (end < 0) break;
    options.set(key, body.slice(i + 1, end));
    i = end + 1;
  }
  const exact = options.get(`=${value}`);
  const chosen = exact ?? options.get(pluralRules(locale).select(value)) ?? options.get("other") ?? "";
  return chosen.replace(/#/g, value.toLocaleString(locale));
}

export function formatMessage(template: string, params: Params | undefined, locale: string): string {
  if (!params || template.indexOf("{") < 0) return template;
  let out = "";
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{", i);
    if (open < 0) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, open);
    const close = matchBrace(template, open);
    if (close < 0) {
      out += template.slice(open);
      break;
    }
    const inner = template.slice(open + 1, close);
    const comma = inner.indexOf(",");
    if (comma >= 0 && /^\s*plural\s*,/.test(inner.slice(comma + 1))) {
      const name = inner.slice(0, comma).trim();
      const body = inner.slice(inner.indexOf(",", comma + 1) + 1);
      const value = Number(params[name] ?? 0);
      out += formatPlural(body, value, locale);
    } else {
      const name = inner.trim();
      const value = params[name];
      out += value === undefined ? `{${name}}` : typeof value === "number" ? value.toLocaleString(locale) : value;
    }
    i = close + 1;
  }
  return out;
}

export function formatBytes(bytes: number, locale: string): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${value.toLocaleString(locale, { maximumFractionDigits: digits })} ${units[unit]}`;
}

export function formatDateTime(value: Date | string | number | null | undefined, locale: string): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

export function formatRelativeTime(value: number, locale: string, now = Date.now()): string {
  const diff = value - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (abs < minute) return rtf.format(Math.round(diff / 1000), "second");
  if (abs < hour) return rtf.format(Math.round(diff / minute), "minute");
  if (abs < day) return rtf.format(Math.round(diff / hour), "hour");
  if (abs < 30 * day) return rtf.format(Math.round(diff / day), "day");
  return new Date(value).toLocaleDateString(locale, { dateStyle: "medium" });
}
