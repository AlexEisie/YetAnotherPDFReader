/**
 * Settings model: types, defaults and the list of allowed values for every enumerated option.
 * Loaded settings are sanitised against this file, so a hand-edited or outdated settings file
 * can never put the app into an invalid state.
 */
import type { LineEnding } from "../annotations/dto";

export const SETTINGS_VERSION = 1;

export type ThemeSetting = "system" | "light" | "dark";
export type PageMode = "normal" | "dark" | "night" | "sepia" | "green" | "custom";
export type ZoomSetting = "auto" | "page-fit" | "page-width" | "actual" | "custom";
export type LayoutSetting = "continuous" | "single" | "twoPageContinuous" | "twoPage" | "horizontal" | "wrapped";

export interface MarkupToolDefaults {
  color: string;
  opacity: number;
}

export interface Settings {
  version: number;
  general: {
    language: string;
    startup: "home" | "restore" | "last";
    rememberView: boolean;
    openInNewTab: boolean;
    focusExisting: boolean;
    confirmCloseMany: boolean;
    recentCount: number;
    watchChanges: boolean;
    showTabsAlways: boolean;
    newTabPosition: "end" | "afterCurrent";
    links: "ask" | "allow" | "block";
  };
  appearance: {
    theme: ThemeSetting;
    accent: string;
    density: "compact" | "comfortable" | "spacious";
    uiScale: "small" | "medium" | "large" | "xlarge";
    showMenuBar: boolean;
    showStatusBar: boolean;
    toolbarLabels: boolean;
    sidebarPosition: "left" | "right";
    sidebarDefault: "remember" | "closed" | "thumbnails" | "outline";
    animations: "full" | "reduced" | "off";
  };
  reading: {
    defaultZoom: ZoomSetting;
    customZoom: number;
    defaultLayout: LayoutSetting;
    coverPage: boolean;
    pageGap: "none" | "small" | "medium" | "large";
    pageShadow: boolean;
    viewerBackground: "default" | "darker" | "lighter" | "black";
    textSelection: boolean;
    highlightLinks: boolean;
    pageIndicator: boolean;
    useSystemFonts: boolean;
    enableXfa: boolean;
    /** Offer text recognition when a document looks scanned. */
    ocrSuggest: boolean;
  };
  pageColors: {
    mode: PageMode;
    followTheme: boolean;
    darkStyle: "dark" | "night" | "custom";
    invertIntensity: number;
    customBackground: string;
    customForeground: string;
    sepiaStrength: number;
    brightness: number;
  };
  navigation: {
    wheelAction: "scroll" | "zoom";
    zoomStep: "fine" | "normal" | "coarse";
    scrollSpeed: number;
    smoothScroll: boolean;
    defaultTool: "select" | "hand";
    middleClickPan: boolean;
    spaceToPan: boolean;
    pageKeysTurnPage: boolean;
    doubleClickZoom: boolean;
    autoScrollSpeed: number;
  };
  snapshot: {
    /** Output resolution: as shown on screen, or a fixed DPI. */
    resolution: "screen" | "150" | "300" | "600";
    annotations: boolean;
    pageColors: boolean;
  };
  annotations: {
    author: string;
    keepTool: boolean;
    hoverPopups: boolean;
    openCommentAfterCreate: boolean;
    showCommentsPane: boolean;
    confirmDeleteReplies: boolean;
    showAnnotations: boolean;
  };
  tools: {
    highlight: MarkupToolDefaults;
    underline: MarkupToolDefaults;
    strikeout: MarkupToolDefaults;
    squiggly: MarkupToolDefaults;
    note: { color: string; icon: string };
    freetext: { fontSize: number; fontColor: string; borderColor: string | null; borderWidth: number; fill: string | null };
    ink: { color: string; width: number; opacity: number; smoothing: number };
    shape: { color: string; width: number; fill: string | null; opacity: number; borderStyle: "solid" | "dashed" | "cloudy" };
    line: { color: string; width: number; opacity: number; startEnding: LineEnding; endEnding: LineEnding };
    stamp: { color: string };
  };
  saving: {
    keepBackup: boolean;
    saveAsFolder: "same" | "last";
    lastFolder: string;
    saveSuffix: string;
    recovery: boolean;
    recoveryInterval: number;
    respectRestrictions: boolean;
  };
  performance: {
    renderQuality: "saver" | "balanced" | "high" | "ultra";
    hardwareAcceleration: boolean;
    freeBackgroundTabsAfter: number;
    thumbnailQuality: "low" | "normal" | "high";
    streamThresholdMb: number;
    prefetchAll: boolean;
  };
  accessibility: {
    ttsVoice: string;
    ttsRate: number;
    ttsPitch: number;
    ttsFollow: boolean;
    highContrast: boolean;
    focusRings: boolean;
    underlineLinks: boolean;
    largeHandles: boolean;
  };
  presentation: {
    advanceOnClick: boolean;
    transition: "none" | "fade" | "slide";
    loop: boolean;
    hideCursor: boolean;
    blackBackground: boolean;
    autoAdvance: number;
  };
  privacy: {
    verboseLogging: boolean;
  };
  /** Keyboard shortcut overrides: command id → list of accelerators (empty list = unbound). */
  shortcuts: Record<string, string[]>;
  /** Persisted UI state (not shown in the settings page). */
  ui: {
    sidebarWidth: number;
    sidebarPanel: string;
    sidebarOpen: boolean;
    commentsPaneWidth: number;
    commentToolsOpen: boolean;
    thumbnailSize: number;
    /** Thumbnail width in the page organizer (CSS px). */
    organizeSize: number;
    dismissedHints: string[];
    recentStamps: string[];
  };
}

export const ACCENT_PRESETS = [
  "#e5484d",
  "#f76b15",
  "#ffb224",
  "#30a46c",
  "#12a594",
  "#0090ff",
  "#3e63dd",
  "#8e4ec6",
  "#d6409f",
  "#687076",
];

export const COLOR_PRESETS = [
  "#ffd400",
  "#ff9500",
  "#ff3b30",
  "#ff2d92",
  "#af52de",
  "#5856d6",
  "#007aff",
  "#34c759",
  "#00c7be",
  "#8e8e93",
  "#000000",
  "#ffffff",
];

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  general: {
    language: "system",
    startup: "home",
    rememberView: true,
    openInNewTab: true,
    focusExisting: true,
    confirmCloseMany: true,
    recentCount: 20,
    watchChanges: true,
    showTabsAlways: true,
    newTabPosition: "afterCurrent",
    links: "ask",
  },
  appearance: {
    theme: "system",
    accent: "#e5484d",
    density: "comfortable",
    uiScale: "medium",
    showMenuBar: true,
    showStatusBar: true,
    toolbarLabels: false,
    sidebarPosition: "left",
    sidebarDefault: "remember",
    animations: "full",
  },
  reading: {
    defaultZoom: "auto",
    customZoom: 100,
    defaultLayout: "continuous",
    coverPage: false,
    pageGap: "medium",
    pageShadow: true,
    viewerBackground: "default",
    textSelection: true,
    highlightLinks: true,
    pageIndicator: true,
    useSystemFonts: true,
    enableXfa: false,
    ocrSuggest: true,
  },
  pageColors: {
    mode: "normal",
    followTheme: false,
    darkStyle: "night",
    invertIntensity: 0.92,
    customBackground: "#1e1f22",
    customForeground: "#d8d8d8",
    sepiaStrength: 0.55,
    brightness: 1,
  },
  navigation: {
    wheelAction: "scroll",
    zoomStep: "normal",
    scrollSpeed: 1,
    smoothScroll: true,
    defaultTool: "select",
    middleClickPan: true,
    spaceToPan: true,
    pageKeysTurnPage: true,
    doubleClickZoom: false,
    autoScrollSpeed: 40,
  },
  snapshot: {
    resolution: "screen",
    annotations: true,
    pageColors: false,
  },
  annotations: {
    author: "",
    keepTool: false,
    hoverPopups: true,
    openCommentAfterCreate: true,
    showCommentsPane: false,
    confirmDeleteReplies: true,
    showAnnotations: true,
  },
  tools: {
    highlight: { color: "#ffd400", opacity: 0.45 },
    underline: { color: "#007aff", opacity: 1 },
    strikeout: { color: "#ff3b30", opacity: 1 },
    squiggly: { color: "#34c759", opacity: 1 },
    note: { color: "#ffd400", icon: "Comment" },
    freetext: { fontSize: 12, fontColor: "#1c1c1e", borderColor: null, borderWidth: 0, fill: null },
    ink: { color: "#ff3b30", width: 2, opacity: 1, smoothing: 0.5 },
    shape: { color: "#ff3b30", width: 2, fill: null, opacity: 1, borderStyle: "solid" },
    line: { color: "#ff3b30", width: 2, opacity: 1, startEnding: "None", endEnding: "None" },
    stamp: { color: "#d12f2f" },
  },
  saving: {
    keepBackup: false,
    saveAsFolder: "same",
    lastFolder: "",
    saveSuffix: "",
    recovery: true,
    recoveryInterval: 30,
    respectRestrictions: true,
  },
  performance: {
    renderQuality: "balanced",
    hardwareAcceleration: true,
    freeBackgroundTabsAfter: 10,
    thumbnailQuality: "normal",
    streamThresholdMb: 48,
    prefetchAll: true,
  },
  accessibility: {
    ttsVoice: "",
    ttsRate: 1,
    ttsPitch: 1,
    ttsFollow: true,
    highContrast: false,
    focusRings: false,
    underlineLinks: false,
    largeHandles: false,
  },
  presentation: {
    advanceOnClick: true,
    transition: "fade",
    loop: false,
    hideCursor: true,
    blackBackground: true,
    autoAdvance: 0,
  },
  privacy: {
    verboseLogging: false,
  },
  shortcuts: {},
  ui: {
    sidebarWidth: 248,
    sidebarPanel: "thumbnails",
    sidebarOpen: false,
    commentsPaneWidth: 320,
    commentToolsOpen: false,
    thumbnailSize: 1,
    organizeSize: 168,
    dismissedHints: [],
    recentStamps: [],
  },
};

const LINE_ENDINGS: LineEnding[] = [
  "None",
  "Square",
  "Circle",
  "Diamond",
  "OpenArrow",
  "ClosedArrow",
  "Butt",
  "ROpenArrow",
  "RClosedArrow",
  "Slash",
];

/** Allowed values of enumerated settings, keyed by dotted path. */
export const ENUMS: Record<string, readonly string[]> = {
  "general.startup": ["home", "restore", "last"],
  "general.newTabPosition": ["end", "afterCurrent"],
  "general.links": ["ask", "allow", "block"],
  "appearance.theme": ["system", "light", "dark"],
  "appearance.density": ["compact", "comfortable", "spacious"],
  "appearance.uiScale": ["small", "medium", "large", "xlarge"],
  "appearance.sidebarPosition": ["left", "right"],
  "appearance.sidebarDefault": ["remember", "closed", "thumbnails", "outline"],
  "appearance.animations": ["full", "reduced", "off"],
  "reading.defaultZoom": ["auto", "page-fit", "page-width", "actual", "custom"],
  "reading.defaultLayout": ["continuous", "single", "twoPageContinuous", "twoPage", "horizontal", "wrapped"],
  "reading.pageGap": ["none", "small", "medium", "large"],
  "reading.viewerBackground": ["default", "darker", "lighter", "black"],
  "pageColors.mode": ["normal", "dark", "night", "sepia", "green", "custom"],
  "pageColors.darkStyle": ["dark", "night", "custom"],
  "navigation.wheelAction": ["scroll", "zoom"],
  "navigation.zoomStep": ["fine", "normal", "coarse"],
  "navigation.defaultTool": ["select", "hand"],
  "snapshot.resolution": ["screen", "150", "300", "600"],
  "tools.shape.borderStyle": ["solid", "dashed", "cloudy"],
  "tools.line.startEnding": LINE_ENDINGS,
  "tools.line.endEnding": LINE_ENDINGS,
  "saving.saveAsFolder": ["same", "last"],
  "performance.renderQuality": ["saver", "balanced", "high", "ultra"],
  "performance.thumbnailQuality": ["low", "normal", "high"],
  "presentation.transition": ["none", "fade", "slide"],
};

/** Numeric ranges `[min, max]`, keyed by dotted path. Values are clamped on load. */
export const RANGES: Record<string, readonly [number, number]> = {
  "general.recentCount": [0, 100],
  "reading.customZoom": [10, 6400],
  "pageColors.invertIntensity": [0.6, 1],
  "pageColors.sepiaStrength": [0.1, 1],
  "pageColors.brightness": [0.5, 1.2],
  "navigation.scrollSpeed": [0.25, 4],
  "navigation.autoScrollSpeed": [5, 400],
  "tools.highlight.opacity": [0.05, 1],
  "tools.underline.opacity": [0.05, 1],
  "tools.strikeout.opacity": [0.05, 1],
  "tools.squiggly.opacity": [0.05, 1],
  "tools.freetext.fontSize": [4, 144],
  "tools.freetext.borderWidth": [0, 12],
  "tools.ink.width": [0.25, 48],
  "tools.ink.opacity": [0.05, 1],
  "tools.ink.smoothing": [0, 1],
  "tools.shape.width": [0, 48],
  "tools.shape.opacity": [0.05, 1],
  "tools.line.width": [0.25, 48],
  "tools.line.opacity": [0.05, 1],
  "saving.recoveryInterval": [5, 3600],
  "performance.freeBackgroundTabsAfter": [0, 1440],
  "performance.streamThresholdMb": [4, 4096],
  "accessibility.ttsRate": [0.25, 4],
  "accessibility.ttsPitch": [0, 2],
  "presentation.autoAdvance": [0, 3600],
  "ui.sidebarWidth": [160, 640],
  "ui.commentsPaneWidth": [240, 640],
  "ui.thumbnailSize": [0.5, 2],
  "ui.organizeSize": [100, 320],
};

/** Paths whose value is a colour string (`#rrggbb`), optionally nullable. */
export const COLOR_PATH = /(^|\.)(color|accent|fontColor|borderColor|fill|customBackground|customForeground)$/;
