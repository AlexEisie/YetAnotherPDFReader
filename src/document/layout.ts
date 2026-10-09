/** Mapping between the user-facing page layouts and pdf.js scroll / spread modes. */
import type { LayoutSetting } from "../settings/defaults";

export const ScrollMode = { VERTICAL: 0, HORIZONTAL: 1, WRAPPED: 2, PAGE: 3 } as const;
export const SpreadMode = { NONE: 0, ODD: 1, EVEN: 2 } as const;

export function layoutToModes(layout: LayoutSetting, coverPage: boolean): { scroll: number; spread: number } {
  const twoPage = coverPage ? SpreadMode.EVEN : SpreadMode.ODD;
  switch (layout) {
    case "single":
      return { scroll: ScrollMode.PAGE, spread: SpreadMode.NONE };
    case "twoPageContinuous":
      return { scroll: ScrollMode.VERTICAL, spread: twoPage };
    case "twoPage":
      return { scroll: ScrollMode.PAGE, spread: twoPage };
    case "horizontal":
      return { scroll: ScrollMode.HORIZONTAL, spread: SpreadMode.NONE };
    case "wrapped":
      return { scroll: ScrollMode.WRAPPED, spread: SpreadMode.NONE };
    default:
      return { scroll: ScrollMode.VERTICAL, spread: SpreadMode.NONE };
  }
}

export function modesToLayout(scroll: number, spread: number): LayoutSetting {
  const two = spread !== SpreadMode.NONE;
  switch (scroll) {
    case ScrollMode.PAGE:
      return two ? "twoPage" : "single";
    case ScrollMode.HORIZONTAL:
      return "horizontal";
    case ScrollMode.WRAPPED:
      return "wrapped";
    default:
      return two ? "twoPageContinuous" : "continuous";
  }
}

/** Discrete zoom levels used by the zoom buttons (percent). */
export const ZOOM_LEVELS = [10, 25, 33.33, 50, 66.67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500, 600, 800, 1200, 1600, 2400];

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 25;

export function nextZoomLevel(currentScale: number, direction: 1 | -1): number {
  const pct = currentScale * 100;
  if (direction > 0) {
    const next = ZOOM_LEVELS.find((z) => z > pct + 0.5);
    return (next ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1]) / 100;
  }
  const prev = [...ZOOM_LEVELS].reverse().find((z) => z < pct - 0.5);
  return (prev ?? ZOOM_LEVELS[0]) / 100;
}

/** Map the settings' default zoom to a pdf.js scale value. */
export function zoomSettingToScaleValue(zoom: string, customPercent: number): string {
  switch (zoom) {
    case "page-fit":
    case "page-width":
    case "auto":
      return zoom;
    case "actual":
      return "page-actual";
    default:
      return String(Math.max(MIN_SCALE, Math.min(MAX_SCALE, customPercent / 100)));
  }
}
