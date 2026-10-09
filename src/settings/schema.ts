/**
 * Declarative description of the settings pages. The settings view renders this schema, the
 * settings search indexes it, and "reset this page" uses each page's `sections`.
 */
import type { LucideIcon } from "lucide-react";
import {
  Accessibility,
  BookOpen,
  Gauge,
  Info,
  Keyboard,
  MessageSquareText,
  MousePointerClick,
  Palette,
  Presentation,
  Save,
  Settings2,
  ShieldCheck,
  SwatchBook,
  Brush,
  Camera,
} from "lucide-react";
import type { MessageKey } from "../i18n";
import type { Settings } from "./defaults";

export type Opt = { value: string | number; label: MessageKey | string; raw?: boolean };

export type SettingItem =
  | { kind: "toggle"; path: string; label: MessageKey; desc?: MessageKey; visible?: (s: Settings) => boolean }
  | { kind: "select"; path: string; label: MessageKey; desc?: MessageKey; options: Opt[] | "languages" | "voices"; visible?: (s: Settings) => boolean }
  | { kind: "segmented"; path: string; label: MessageKey; desc?: MessageKey; options: Opt[]; visible?: (s: Settings) => boolean }
  | {
      kind: "slider";
      path: string;
      label: MessageKey;
      desc?: MessageKey;
      min: number;
      max: number;
      step: number;
      format: "percent" | "times" | "pt" | "seconds" | "minutes" | "mb" | "plain" | "speed";
      visible?: (s: Settings) => boolean;
    }
  | { kind: "color"; path: string; label: MessageKey; desc?: MessageKey; allowNone?: boolean; presets?: string[]; visible?: (s: Settings) => boolean }
  | { kind: "text"; path: string; label: MessageKey; desc?: MessageKey; placeholder?: MessageKey; visible?: (s: Settings) => boolean }
  | { kind: "link"; page: string; label: MessageKey; desc?: MessageKey }
  | { kind: "action"; id: string; label: MessageKey; desc?: MessageKey; button: MessageKey; danger?: boolean }
  | { kind: "custom"; id: string; label: MessageKey; desc?: MessageKey };

export interface SettingGroup {
  title: MessageKey;
  items: SettingItem[];
}

export interface SettingPage {
  id: string;
  title: MessageKey;
  icon: LucideIcon;
  /** Parent page for stacked sub pages. */
  parent?: string;
  /** Settings sections reset by "Reset this page". */
  sections: (keyof Settings)[];
  groups: SettingGroup[];
}

const o = (value: string | number, label: MessageKey): Opt => ({ value, label });

export const SETTING_PAGES: SettingPage[] = [
  {
    id: "general",
    title: "settings.section.general",
    icon: Settings2,
    sections: ["general"],
    groups: [
      {
        title: "settings.group.language",
        items: [{ kind: "select", path: "general.language", label: "settings.language", desc: "settings.language.desc", options: "languages" }],
      },
      {
        title: "settings.group.startup",
        items: [
          {
            kind: "select",
            path: "general.startup",
            label: "settings.startup",
            options: [o("home", "settings.startup.home"), o("restore", "settings.startup.restore"), o("last", "settings.startup.last")],
          },
          { kind: "toggle", path: "general.rememberView", label: "settings.rememberView" },
        ],
      },
      {
        title: "settings.group.documents",
        items: [
          { kind: "toggle", path: "general.openInNewTab", label: "settings.openInNewTab", desc: "settings.openInNewTab.desc" },
          { kind: "toggle", path: "general.focusExisting", label: "settings.focusExisting" },
          {
            kind: "segmented",
            path: "general.newTabPosition",
            label: "settings.newTabPosition",
            options: [o("afterCurrent", "settings.newTabPosition.afterCurrent"), o("end", "settings.newTabPosition.end")],
          },
          { kind: "toggle", path: "general.confirmCloseMany", label: "settings.confirmCloseMany" },
          { kind: "slider", path: "general.recentCount", label: "settings.recentCount", min: 0, max: 50, step: 1, format: "plain" },
          { kind: "toggle", path: "general.watchChanges", label: "settings.watchChanges" },
        ],
      },
      {
        title: "settings.group.links",
        items: [
          {
            kind: "select",
            path: "general.links",
            label: "settings.links",
            options: [o("ask", "settings.links.ask"), o("allow", "settings.links.allow"), o("block", "settings.links.block")],
          },
        ],
      },
      {
        title: "settings.group.updates",
        items: [
          {
            kind: "select",
            path: "general.updateCheck",
            label: "settings.updateCheck",
            desc: "settings.updateCheck.desc",
            options: [o("off", "settings.updateCheck.off"), o("daily", "settings.updateCheck.daily"), o("weekly", "settings.updateCheck.weekly")],
          },
          { kind: "custom", id: "updateNow", label: "cmd.help.checkUpdates" },
        ],
      },
    ],
  },
  {
    id: "appearance",
    title: "settings.section.appearance",
    icon: Palette,
    sections: ["appearance"],
    groups: [
      {
        title: "settings.group.theme",
        items: [
          {
            kind: "segmented",
            path: "appearance.theme",
            label: "settings.theme",
            options: [o("system", "settings.theme.system"), o("light", "settings.theme.light"), o("dark", "settings.theme.dark")],
          },
          { kind: "custom", id: "accent", label: "settings.accent", desc: "settings.accent.desc" },
          {
            kind: "segmented",
            path: "appearance.density",
            label: "settings.density",
            options: [o("compact", "settings.density.compact"), o("comfortable", "settings.density.comfortable"), o("spacious", "settings.density.spacious")],
          },
          {
            kind: "select",
            path: "appearance.uiScale",
            label: "settings.uiScale",
            options: [o("small", "settings.uiScale.small"), o("medium", "settings.uiScale.medium"), o("large", "settings.uiScale.large"), o("xlarge", "settings.uiScale.xlarge")],
          },
        ],
      },
      {
        title: "settings.group.layout",
        items: [
          { kind: "toggle", path: "appearance.showMenuBar", label: "settings.showMenuBar", desc: "settings.showMenuBar.desc" },
          { kind: "toggle", path: "appearance.showStatusBar", label: "settings.showStatusBar" },
          { kind: "toggle", path: "general.showTabsAlways", label: "settings.showTabsAlways", desc: "settings.showTabsAlways.desc" },
          { kind: "toggle", path: "appearance.toolbarLabels", label: "settings.toolbarLabels" },
          {
            kind: "segmented",
            path: "appearance.sidebarPosition",
            label: "settings.sidebarPosition",
            options: [o("left", "settings.sidebarPosition.left"), o("right", "settings.sidebarPosition.right")],
          },
          {
            kind: "select",
            path: "appearance.sidebarDefault",
            label: "settings.sidebarDefault",
            options: [
              o("remember", "settings.sidebarDefault.remember"),
              o("closed", "settings.sidebarDefault.closed"),
              o("thumbnails", "settings.sidebarDefault.thumbnails"),
              o("outline", "settings.sidebarDefault.outline"),
            ],
          },
        ],
      },
      {
        title: "settings.group.motion",
        items: [
          {
            kind: "segmented",
            path: "appearance.animations",
            label: "settings.animations",
            options: [o("full", "settings.animations.full"), o("reduced", "settings.animations.reduced"), o("off", "settings.animations.off")],
          },
        ],
      },
    ],
  },
  {
    id: "reading",
    title: "settings.section.reading",
    icon: BookOpen,
    sections: ["reading"],
    groups: [
      {
        title: "settings.group.defaultView",
        items: [
          {
            kind: "select",
            path: "reading.defaultZoom",
            label: "settings.defaultZoom",
            options: [o("auto", "settings.zoom.auto"), o("page-fit", "settings.zoom.pageFit"), o("page-width", "settings.zoom.pageWidth"), o("actual", "settings.zoom.actual"), o("custom", "settings.zoom.custom")],
          },
          {
            kind: "slider",
            path: "reading.customZoom",
            label: "settings.customZoom",
            min: 25,
            max: 400,
            step: 5,
            format: "percent",
            visible: (s) => s.reading.defaultZoom === "custom",
          },
          {
            kind: "select",
            path: "reading.defaultLayout",
            label: "settings.defaultLayout",
            options: [
              o("continuous", "settings.layout.continuous"),
              o("single", "settings.layout.single"),
              o("twoPageContinuous", "settings.layout.twoPageContinuous"),
              o("twoPage", "settings.layout.twoPage"),
              o("horizontal", "settings.layout.horizontal"),
              o("wrapped", "settings.layout.wrapped"),
            ],
          },
          { kind: "toggle", path: "reading.coverPage", label: "settings.coverPage" },
        ],
      },
      {
        title: "settings.group.pages",
        items: [
          {
            kind: "segmented",
            path: "reading.pageGap",
            label: "settings.pageGap",
            options: [o("none", "settings.pageGap.none"), o("small", "settings.pageGap.small"), o("medium", "settings.pageGap.medium"), o("large", "settings.pageGap.large")],
          },
          { kind: "toggle", path: "reading.pageShadow", label: "settings.pageShadow" },
          {
            kind: "select",
            path: "reading.viewerBackground",
            label: "settings.viewerBackground",
            options: [o("default", "settings.viewerBackground.default"), o("darker", "settings.viewerBackground.darker"), o("lighter", "settings.viewerBackground.lighter"), o("black", "settings.viewerBackground.black")],
          },
          { kind: "toggle", path: "reading.pageIndicator", label: "settings.pageIndicator" },
          { kind: "link", page: "pageColors", label: "settings.section.pageColors", desc: "settings.pageMode.desc" },
          { kind: "link", page: "navigation", label: "settings.section.navigation" },
          { kind: "link", page: "snapshot", label: "settings.section.snapshot", desc: "settings.section.snapshot.desc" },
          { kind: "link", page: "presentation", label: "settings.section.presentation" },
        ],
      },
      {
        title: "settings.group.text",
        items: [
          { kind: "toggle", path: "reading.textSelection", label: "settings.textSelection" },
          { kind: "toggle", path: "reading.highlightLinks", label: "settings.highlightLinks" },
          { kind: "toggle", path: "reading.useSystemFonts", label: "settings.useSystemFonts" },
          { kind: "toggle", path: "reading.enableXfa", label: "settings.enableXfa", desc: "settings.enableXfa.desc" },
          { kind: "toggle", path: "reading.ocrSuggest", label: "settings.ocrSuggest", desc: "settings.ocrSuggest.desc" },
        ],
      },
    ],
  },
  {
    id: "pageColors",
    parent: "reading",
    title: "settings.section.pageColors",
    icon: SwatchBook,
    sections: ["pageColors"],
    groups: [
      {
        title: "settings.group.background",
        items: [
          { kind: "custom", id: "pageModePreview", label: "settings.pageMode", desc: "settings.pageMode.desc" },
          { kind: "toggle", path: "pageColors.followTheme", label: "settings.followThemePages" },
          {
            kind: "segmented",
            path: "pageColors.darkStyle",
            label: "settings.darkStyle",
            options: [o("night", "settings.pageMode.night"), o("dark", "settings.pageMode.dark"), o("custom", "settings.pageMode.custom")],
            visible: (s) => s.pageColors.followTheme,
          },
          { kind: "slider", path: "pageColors.invertIntensity", label: "settings.invertIntensity", desc: "settings.invertIntensity.desc", min: 0.6, max: 1, step: 0.02, format: "percent" },
          { kind: "slider", path: "pageColors.sepiaStrength", label: "settings.sepiaStrength", min: 0.1, max: 1, step: 0.05, format: "percent" },
          { kind: "slider", path: "pageColors.brightness", label: "settings.brightness", min: 0.5, max: 1.2, step: 0.02, format: "percent" },
        ],
      },
      {
        title: "settings.group.customColors",
        items: [
          { kind: "color", path: "pageColors.customBackground", label: "settings.customBackground", presets: ["#1e1f22", "#000000", "#2b2b2b", "#1a2433", "#f4ecd8", "#e8f5e9", "#fff8e1", "#ffffff"] },
          { kind: "color", path: "pageColors.customForeground", label: "settings.customForeground", presets: ["#d8d8d8", "#ffffff", "#ffd479", "#a6e3a1", "#5b4636", "#1b1b1b", "#000000"] },
        ],
      },
    ],
  },
  {
    id: "navigation",
    parent: "reading",
    title: "settings.section.navigation",
    icon: MousePointerClick,
    sections: ["navigation"],
    groups: [
      {
        title: "settings.group.wheel",
        items: [
          {
            kind: "select",
            path: "navigation.wheelAction",
            label: "settings.wheelAction",
            options: [o("scroll", "settings.wheelAction.scroll"), o("zoom", "settings.wheelAction.zoom")],
          },
          {
            kind: "segmented",
            path: "navigation.zoomStep",
            label: "settings.zoomStep",
            options: [o("fine", "settings.zoomStep.fine"), o("normal", "settings.zoomStep.normal"), o("coarse", "settings.zoomStep.coarse")],
          },
          { kind: "slider", path: "navigation.scrollSpeed", label: "settings.scrollSpeed", min: 0.25, max: 4, step: 0.25, format: "times" },
        ],
      },
      {
        title: "settings.group.scrolling",
        items: [
          {
            kind: "segmented",
            path: "navigation.defaultTool",
            label: "settings.defaultTool",
            options: [o("select", "settings.defaultTool.select"), o("hand", "settings.defaultTool.hand")],
          },
          { kind: "toggle", path: "navigation.smoothScroll", label: "settings.smoothScroll" },
          { kind: "toggle", path: "navigation.middleClickPan", label: "settings.middleClickPan" },
          { kind: "toggle", path: "navigation.spaceToPan", label: "settings.spaceToPan" },
          { kind: "toggle", path: "navigation.pageKeysTurnPage", label: "settings.pageKeysTurnPage" },
          { kind: "toggle", path: "navigation.doubleClickZoom", label: "settings.doubleClickZoom" },
        ],
      },
      {
        title: "settings.group.autoScroll",
        items: [{ kind: "slider", path: "navigation.autoScrollSpeed", label: "settings.autoScrollSpeed", min: 5, max: 400, step: 5, format: "speed" }],
      },
    ],
  },
  {
    id: "snapshot",
    parent: "reading",
    title: "settings.section.snapshot",
    icon: Camera,
    sections: ["snapshot"],
    groups: [
      {
        title: "settings.group.snapshotImage",
        items: [
          {
            kind: "select",
            path: "snapshot.resolution",
            label: "settings.snapshotResolution",
            desc: "settings.snapshotResolution.desc",
            options: [
              o("screen", "settings.snapshotResolution.screen"),
              o("150", "settings.snapshotResolution.150"),
              o("300", "settings.snapshotResolution.300"),
              o("600", "settings.snapshotResolution.600"),
            ],
          },
          { kind: "toggle", path: "snapshot.annotations", label: "settings.snapshotAnnotations", desc: "settings.snapshotAnnotations.desc" },
          { kind: "toggle", path: "snapshot.pageColors", label: "settings.snapshotPageColors", desc: "settings.snapshotPageColors.desc" },
        ],
      },
    ],
  },
  {
    id: "presentation",
    parent: "reading",
    title: "settings.section.presentation",
    icon: Presentation,
    sections: ["presentation"],
    groups: [
      {
        title: "settings.group.presentation",
        items: [
          { kind: "toggle", path: "presentation.advanceOnClick", label: "settings.presentationAdvanceOnClick" },
          {
            kind: "segmented",
            path: "presentation.transition",
            label: "settings.presentationTransition",
            options: [o("none", "settings.presentationTransition.none"), o("fade", "settings.presentationTransition.fade"), o("slide", "settings.presentationTransition.slide")],
          },
          { kind: "toggle", path: "presentation.loop", label: "settings.presentationLoop" },
          { kind: "toggle", path: "presentation.hideCursor", label: "settings.presentationHideCursor" },
          { kind: "toggle", path: "presentation.blackBackground", label: "settings.presentationBlack" },
          { kind: "slider", path: "presentation.autoAdvance", label: "settings.presentationAutoAdvance", min: 0, max: 120, step: 5, format: "seconds" },
        ],
      },
    ],
  },
  {
    id: "annotations",
    title: "settings.section.annotations",
    icon: MessageSquareText,
    sections: ["annotations"],
    groups: [
      {
        title: "settings.group.identity",
        items: [{ kind: "text", path: "annotations.author", label: "settings.author", desc: "settings.author.desc", placeholder: "settings.author.placeholder" }],
      },
      {
        title: "settings.group.behavior",
        items: [
          { kind: "toggle", path: "annotations.keepTool", label: "settings.keepTool" },
          { kind: "toggle", path: "annotations.openCommentAfterCreate", label: "settings.openCommentAfterCreate" },
          { kind: "toggle", path: "annotations.confirmDeleteReplies", label: "settings.confirmDeleteReplies" },
          { kind: "toggle", path: "annotations.showCommentsPane", label: "settings.showCommentsPane" },
        ],
      },
      {
        title: "settings.group.display",
        items: [
          { kind: "toggle", path: "annotations.showAnnotations", label: "settings.showAnnotations" },
          { kind: "toggle", path: "annotations.hoverPopups", label: "settings.hoverPopups" },
          { kind: "link", page: "toolDefaults", label: "settings.section.toolDefaults" },
        ],
      },
    ],
  },
  {
    id: "toolDefaults",
    parent: "annotations",
    title: "settings.section.toolDefaults",
    icon: Brush,
    sections: ["tools"],
    groups: [
      {
        title: "settings.group.markup",
        items: [
          { kind: "color", path: "tools.highlight.color", label: "cmd.tool.highlight" },
          { kind: "slider", path: "tools.highlight.opacity", label: "settings.markupOpacity", min: 0.1, max: 1, step: 0.05, format: "percent" },
          { kind: "color", path: "tools.underline.color", label: "cmd.tool.underline" },
          { kind: "color", path: "tools.strikeout.color", label: "cmd.tool.strikeout" },
          { kind: "color", path: "tools.squiggly.color", label: "cmd.tool.squiggly" },
        ],
      },
      {
        title: "settings.group.drawing",
        items: [
          { kind: "color", path: "tools.ink.color", label: "cmd.tool.ink" },
          { kind: "slider", path: "tools.ink.width", label: "settings.inkWidth", min: 0.5, max: 24, step: 0.5, format: "pt" },
          { kind: "slider", path: "tools.ink.opacity", label: "settings.inkOpacity", min: 0.1, max: 1, step: 0.05, format: "percent" },
          { kind: "slider", path: "tools.ink.smoothing", label: "settings.inkSmoothing", desc: "settings.inkSmoothing.desc", min: 0, max: 1, step: 0.05, format: "percent" },
          { kind: "color", path: "tools.shape.color", label: "cmd.tool.square" },
          { kind: "color", path: "tools.shape.fill", label: "settings.shapeFill", allowNone: true },
          { kind: "slider", path: "tools.shape.width", label: "settings.shapeWidth", min: 0, max: 12, step: 0.5, format: "pt" },
          { kind: "color", path: "tools.line.color", label: "cmd.tool.line" },
        ],
      },
      {
        title: "settings.group.textbox",
        items: [
          { kind: "slider", path: "tools.freetext.fontSize", label: "settings.freetextSize", min: 6, max: 72, step: 1, format: "pt" },
          { kind: "color", path: "tools.freetext.fontColor", label: "settings.freetextColor" },
          { kind: "color", path: "tools.freetext.borderColor", label: "settings.freetextBorder", allowNone: true },
          { kind: "color", path: "tools.note.color", label: "cmd.tool.note" },
          {
            kind: "select",
            path: "tools.note.icon",
            label: "settings.noteIcon",
            options: ["Comment", "Note", "Help", "Insert", "Key", "NewParagraph", "Paragraph", "Check", "Cross", "Star", "Circle"].map((i) => ({ value: i, label: `icon.${i}` as MessageKey })),
          },
          { kind: "color", path: "tools.stamp.color", label: "stamps.color" },
        ],
      },
    ],
  },
  {
    id: "saving",
    title: "settings.section.saving",
    icon: Save,
    sections: ["saving"],
    groups: [
      {
        title: "settings.group.save",
        items: [
          { kind: "toggle", path: "saving.keepBackup", label: "settings.keepBackup", desc: "settings.keepBackup.desc" },
          {
            kind: "segmented",
            path: "saving.saveAsFolder",
            label: "settings.saveAsDefaultFolder",
            options: [o("same", "settings.saveAsDefaultFolder.same"), o("last", "settings.saveAsDefaultFolder.last")],
          },
          { kind: "text", path: "saving.saveSuffix", label: "settings.saveSuffix", desc: "settings.saveSuffix.desc" },
          { kind: "toggle", path: "saving.respectRestrictions", label: "settings.respectRestrictions", desc: "settings.respectRestrictions.desc" },
        ],
      },
      {
        title: "settings.group.recovery",
        items: [
          { kind: "toggle", path: "saving.recovery", label: "settings.recovery", desc: "settings.recovery.desc" },
          { kind: "slider", path: "saving.recoveryInterval", label: "settings.recoveryInterval", min: 10, max: 600, step: 10, format: "seconds", visible: (s) => s.saving.recovery },
        ],
      },
    ],
  },
  {
    id: "performance",
    title: "settings.section.performance",
    icon: Gauge,
    sections: ["performance"],
    groups: [
      {
        title: "settings.group.rendering",
        items: [
          {
            kind: "segmented",
            path: "performance.renderQuality",
            label: "settings.renderQuality",
            desc: "settings.renderQuality.desc",
            options: [o("saver", "settings.renderQuality.saver"), o("balanced", "settings.renderQuality.balanced"), o("high", "settings.renderQuality.high"), o("ultra", "settings.renderQuality.ultra")],
          },
          { kind: "toggle", path: "performance.hardwareAcceleration", label: "settings.hardwareAcceleration" },
          {
            kind: "segmented",
            path: "performance.thumbnailQuality",
            label: "settings.thumbnailQuality",
            options: [o("low", "settings.thumbnailQuality.low"), o("normal", "settings.thumbnailQuality.normal"), o("high", "settings.thumbnailQuality.high")],
          },
        ],
      },
      {
        title: "settings.group.memory",
        items: [{ kind: "slider", path: "performance.freeBackgroundTabsAfter", label: "settings.freeBackgroundTabs", min: 0, max: 60, step: 1, format: "minutes" }],
      },
      {
        title: "settings.group.largeFiles",
        items: [
          { kind: "slider", path: "performance.streamThresholdMb", label: "settings.streamThreshold", desc: "settings.streamThreshold.desc", min: 8, max: 512, step: 8, format: "mb" },
          { kind: "toggle", path: "performance.prefetchAll", label: "settings.prefetchAll" },
        ],
      },
    ],
  },
  {
    id: "keyboard",
    title: "settings.section.keyboard",
    icon: Keyboard,
    sections: [],
    groups: [{ title: "settings.section.keyboard", items: [{ kind: "custom", id: "shortcuts", label: "shortcuts.title" }] }],
  },
  {
    id: "accessibility",
    title: "settings.section.accessibility",
    icon: Accessibility,
    sections: ["accessibility"],
    groups: [
      {
        title: "settings.group.readAloud",
        items: [
          { kind: "select", path: "accessibility.ttsVoice", label: "settings.ttsVoice", options: "voices" },
          { kind: "slider", path: "accessibility.ttsRate", label: "settings.ttsRate", min: 0.5, max: 3, step: 0.1, format: "times" },
          { kind: "slider", path: "accessibility.ttsPitch", label: "settings.ttsPitch", min: 0.5, max: 2, step: 0.1, format: "times" },
          { kind: "toggle", path: "accessibility.ttsFollow", label: "settings.ttsHighlight" },
        ],
      },
      {
        title: "settings.group.contrast",
        items: [
          { kind: "toggle", path: "accessibility.highContrast", label: "settings.highContrast", desc: "settings.highContrast.desc" },
          { kind: "toggle", path: "accessibility.focusRings", label: "settings.focusRings" },
          { kind: "toggle", path: "accessibility.largeHandles", label: "settings.largeCursorHandles" },
          { kind: "toggle", path: "accessibility.underlineLinks", label: "settings.underlineLinks" },
        ],
      },
    ],
  },
  {
    id: "privacy",
    title: "settings.section.privacy",
    icon: ShieldCheck,
    sections: ["privacy"],
    groups: [
      {
        title: "settings.group.history",
        items: [
          { kind: "action", id: "clearRecent", label: "settings.clearRecent", button: "settings.clearAction" },
          { kind: "action", id: "clearViewStates", label: "settings.clearViewStates", button: "settings.clearAction" },
          { kind: "action", id: "clearSignatures", label: "settings.clearSignatures", button: "settings.clearAction", danger: true },
        ],
      },
      {
        title: "settings.group.backup",
        items: [
          { kind: "action", id: "exportSettings", label: "settings.exportSettings", button: "common.export" },
          { kind: "action", id: "importSettings", label: "settings.importSettings", button: "common.import" },
          { kind: "action", id: "resetAll", label: "settings.resetAll", button: "common.reset", danger: true },
        ],
      },
      {
        title: "settings.group.diagnostics",
        items: [
          { kind: "toggle", path: "privacy.verboseLogging", label: "settings.verboseLogging" },
          { kind: "action", id: "openData", label: "settings.openDataFolder", button: "settings.openAction" },
          { kind: "action", id: "openLogs", label: "settings.openLogFolder", button: "settings.openAction" },
        ],
      },
    ],
  },
  {
    id: "about",
    title: "settings.section.about",
    icon: Info,
    sections: [],
    groups: [{ title: "settings.section.about", items: [{ kind: "custom", id: "about", label: "about.title" }] }],
  },
];

export const TOP_PAGES = SETTING_PAGES.filter((p) => !p.parent);

export function pageById(id: string): SettingPage {
  return SETTING_PAGES.find((p) => p.id === id) ?? SETTING_PAGES[0];
}

/** Breadcrumb trail from the top-level page down to `id`. */
export function trail(id: string): SettingPage[] {
  const out: SettingPage[] = [];
  let page: SettingPage | undefined = pageById(id);
  while (page) {
    out.unshift(page);
    page = page.parent ? pageById(page.parent) : undefined;
  }
  return out;
}
