/** Page range strings such as "1-3, 5, 8-" (1-based), used by print, extract and delete. */

/** Parse "1-3, 5, 8-" into 1-based page numbers (in order, without duplicates). */
export function parsePageRange(input: string, numPages: number): number[] | null {
  const out: number[] = [];
  const seen = new Set<number>();
  const parts = input
    .replace(/\s*[-–~]\s*/g, "-")
    .split(/[,，;；\s]+/)
    .filter(Boolean);
  if (!parts.length) return null;
  for (const part of parts) {
    const m = /^(\d*)-(\d*)$/.exec(part);
    let from: number;
    let to: number;
    if (m) {
      from = m[1] ? Number(m[1]) : 1;
      to = m[2] ? Number(m[2]) : numPages;
    } else if (/^\d+$/.test(part)) {
      from = to = Number(part);
    } else {
      return null;
    }
    if (from < 1 || to < 1 || from > numPages || to > numPages) return null;
    const step = from <= to ? 1 : -1;
    for (let p = from; step > 0 ? p <= to : p >= to; p += step) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  return out.length ? out : null;
}

/** Format page numbers back into a compact range string ("1-3, 5"). */
export function formatPageRange(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++;
    parts.push(start === sorted[i] ? String(start) : `${start}-${sorted[i]}`);
  }
  return parts.join(", ");
}
