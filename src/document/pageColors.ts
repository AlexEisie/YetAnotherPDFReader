/**
 * Page colour modes ("page background" in the UI). Everything is done with CSS on the page
 * canvas wrapper, so switching is instant and nothing is re-rendered:
 *
 * * dark   — invert + hue-rotate (keeps hues, inverts lightness), optional softer intensity
 * * night  — full inversion, then images are re-inverted by `backdrop-filter` patches placed
 *            over the image areas pdf.js reports, so photos keep their natural colours
 * * sepia  — CSS sepia
 * * green  — multiply tint (classic eye-care paper colour), keeps coloured content
 * * custom — duotone SVG filter mapping paper → background colour and ink → text colour
 */
import type { Settings, PageMode } from "../settings/defaults";

export interface PageColorStyle {
  mode: PageMode;
  /** CSS `filter` for the canvas wrapper. */
  filter: string;
  /** Multiply tint drawn over the canvas (empty = none). */
  tint: string;
  /** Colour shown behind pages while they render. */
  pageBackground: string;
  /** Blend mode for text markup (highlights). */
  markupBlend: "multiply" | "screen";
  /** Re-invert image regions. */
  restoreImages: boolean;
  /** Is the resulting page dark (affects UI accents such as selection colours)? */
  isDark: boolean;
}

export const DUOTONE_FILTER_ID = "yapr-duotone";

function hexToRgb01(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) ?? ["", "ff", "ff", "ff"];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb01(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Resolve the mode actually used, taking "use dark pages with the dark theme" into account. */
export function effectivePageMode(pc: Settings["pageColors"], darkTheme: boolean): PageMode {
  if (pc.followTheme && darkTheme && pc.mode === "normal") return pc.darkStyle;
  return pc.mode;
}

export function pageColorStyle(pc: Settings["pageColors"], darkTheme: boolean): PageColorStyle {
  const mode = effectivePageMode(pc, darkTheme);
  const brightness = pc.brightness !== 1 ? ` brightness(${pc.brightness.toFixed(2)})` : "";
  switch (mode) {
    case "dark":
      return {
        mode,
        filter: `invert(${pc.invertIntensity.toFixed(2)}) hue-rotate(180deg)${brightness}`,
        tint: "",
        pageBackground: "#1b1b1d",
        markupBlend: "multiply",
        restoreImages: false,
        isDark: true,
      };
    case "night":
      return {
        mode,
        filter: `invert(1) hue-rotate(180deg)${brightness}`,
        tint: "",
        pageBackground: "#111113",
        markupBlend: "multiply",
        restoreImages: true,
        isDark: true,
      };
    case "sepia":
      return {
        mode,
        filter: `sepia(${pc.sepiaStrength.toFixed(2)}) saturate(1.15)${brightness}`,
        tint: "",
        pageBackground: "#f4ecd8",
        markupBlend: "multiply",
        restoreImages: false,
        isDark: false,
      };
    case "green":
      return {
        mode,
        filter: brightness.trim() || "none",
        tint: "#c7edcc",
        pageBackground: "#c7edcc",
        markupBlend: "multiply",
        restoreImages: false,
        isDark: false,
      };
    case "custom": {
      const dark = luminance(pc.customBackground) < 0.4;
      return {
        mode,
        filter: `url(#${DUOTONE_FILTER_ID})${brightness}`,
        tint: "",
        pageBackground: pc.customBackground,
        markupBlend: dark ? "screen" : "multiply",
        restoreImages: false,
        isDark: dark,
      };
    }
    default:
      return {
        mode: "normal",
        filter: brightness.trim() || "none",
        tint: "",
        pageBackground: "#ffffff",
        markupBlend: "multiply",
        restoreImages: false,
        isDark: false,
      };
  }
}

/**
 * Component-transfer table values for the duotone filter: luminance 0 → text colour,
 * luminance 1 → background colour.
 */
export function duotoneTables(pc: Settings["pageColors"]): { r: string; g: string; b: string } {
  const fg = hexToRgb01(pc.customForeground);
  const bg = hexToRgb01(pc.customBackground);
  const table = (i: number) => `${fg[i].toFixed(3)} ${bg[i].toFixed(3)}`;
  return { r: table(0), g: table(1), b: table(2) };
}

/** Apply the style to a viewer root element. */
export function applyPageColorStyle(root: HTMLElement, style: PageColorStyle): void {
  root.dataset.pageMode = style.mode;
  root.style.setProperty("--yapr-page-filter", style.filter);
  root.style.setProperty("--yapr-page-tint", style.tint || "transparent");
  root.style.setProperty("--page-bg-color", style.pageBackground);
  root.style.setProperty("--yapr-markup-blend", style.markupBlend);
  root.toggleAttribute("data-page-tint", !!style.tint);
  root.toggleAttribute("data-restore-images", style.restoreImages);
  root.toggleAttribute("data-dark-pages", style.isDark);
}
