/**
 * Extension settings, stored in `chrome.storage.sync`.
 *
 * Defaults deliberately match the desktop app's, so the two feel like one
 * product rather than two things that happen to share a name.
 */

import type { ReaderFont } from "./reader-core/fonts";

export type ReaderTheme =
  | "focus"
  | "paper"
  | "sepia"
  | "contrast"
  | "slate"
  | "mist"
  | "nocturne"
  | "lyric"
  | "caption"
  | "custom";

/**
 * How the words are put on screen.
 *
 * `focusline` rather than `focus`, which is already a theme. Two unions with a
 * shared member name is how `settings.theme === "focus"` gets written where
 * `settings.mode` was meant, and the compiler would accept it.
 */
export type ReadingMode =
  "rsvp" | "rsvp-bionic" | "bionic" | "plain" | "highlight" | "focusline";

/**
 * What each mode is called on the settings page.
 *
 * A record keyed by the union rather than a hand-written list, mirroring
 * `FONT_LABELS`: a mode added to the type and forgotten here fails to build
 * instead of quietly never appearing in the picker.
 */
export const MODE_LABELS: Record<ReadingMode, string> = {
  rsvp: "RSVP — one word at a fixed point",
  "rsvp-bionic": "RSVP + Bionic — pinned word, bolded context",
  bionic: "Bionic — bold leading letters",
  plain: "Plain — a caption line with nothing marked",
  highlight: "Highlighter — a block on the current word",
  focusline: "Focus line — one word, plainly centred",
};

/**
 * How the window advances.
 *
 * An axis of its own, not a mode. "Static" used to be baked into the `plain`
 * mode, which conflated two independent questions — how the window moves, and
 * how the current word is marked — and meant Bionic could only ever slide.
 * Separated, "Bionic held still" is just a combination rather than a new mode.
 *
 * Only the line modes can hold still: RSVP and Focus line show one word at a
 * time, so there is no line to hold, and Highlighter's block needs a current
 * word to sit on. See `readsWholeLine`.
 */
export type Motion = "dynamic" | "static";

export const MOTION_LABELS: Record<Motion, string> = {
  dynamic: "Dynamic — the window slides, a word at a time",
  static: "Static — a whole line, held still",
};

export const THEME_LABELS: Record<ReaderTheme, string> = {
  focus: "Focus (dark)",
  paper: "Paper (light)",
  sepia: "Sepia",
  contrast: "High contrast",
  slate: "Slate (neutral grey)",
  mist: "Mist (neutral light)",
  nocturne: "Nocturne (deep blue-grey)",
  lyric: "Lyric (gold on a blue band)",
  caption: "Caption (white on solid black)",
  custom: "Custom (your own colours)",
};

export interface Settings {
  /** Master switch, so the extension can be left installed but idle. */
  enabled: boolean;
  mode: ReadingMode;
  theme: ReaderTheme;
  font: ReaderFont;
  fontSize: number;
  letterSpacing: number;
  /** Scale the text with the player, so fullscreen is not tiny. */
  autoScale: boolean;
  /** Distance from the bottom of the player, as a percentage of its height. */
  verticalPosition: number;
  /** Reader width, as a percentage of the player's width. */
  boxWidth: number;
  /** Already-read words kept visible to the left of the pivot. */
  contextBefore: number;
  /** Upcoming words shown to the right of the pivot. */
  contextAfter: number;
  contextOpacity: number;
  /**
   * Colour the bold prefix in Bionic mode.
   *
   * The one rule that makes Bionic loud. Off leaves the emphasis carried by
   * weight alone, which is what people asking for a calmer Bionic mean.
   */
  bionicAccent: boolean;
  /** How opaque the card behind the words is, 0-1. */
  backgroundOpacity: number;
  /**
   * The Custom theme's palette, as hex.
   *
   * Four flat strings rather than one object: `isModified` in `profiles.ts`
   * compares profile values with `!==`, so a nested object would never equal
   * itself and every profile would read as modified the moment it was applied.
   * Ignored unless `theme` is `"custom"`.
   */
  customBackground: string;
  customText: string;
  customFaded: string;
  customAccent: string;
  /**
   * Whether the line slides or holds still. Read only by the line modes; see
   * `readsWholeLine`, which is the single place that decides.
   */
  motion: Motion;
  /** Italic, for the styles where slanted text is the whole character. */
  fontStyle: "normal" | "italic";
  /**
   * Uppercase the words.
   *
   * Applied with `text-transform`, so the DOM text is untouched and the pivot
   * maths still sees the original characters.
   */
  textCase: "none" | "upper";
  /**
   * 400-700. Heavy weights read over busy video where 400 disappears.
   *
   * Not every family ships every weight -- Geist stops at 600 -- and a weight
   * that is not there is synthesised by the browser rather than refused, which
   * looks thinner than the real thing. `fonts.css` is byte-identical to the
   * desktop app, so adding faces means changing both repositories.
   */
  textWeight: number;
  /**
   * An outline around every glyph, in pixels.
   *
   * The one thing that makes text legible over an arbitrary moving picture,
   * and the reason captions burned into video almost always have one.
   */
  textOutline: number;
  /**
   * Words per line in Static mode, before it breaks regardless of punctuation.
   *
   * Low values give the short, punchy captions people use on Shorts; high ones
   * give a full subtitle band.
   */
  lineWords: number;
  showPivotGuides: boolean;
  removeFillers: boolean;
  /** Hide YouTube's own captions while the reader is running. Leaving both on
   *  means reading the same words twice, in two places. */
  hideNativeCaptions: boolean;
  /** Keep the RSVP reader running over the video inside Read Mode. On by
   *  default: Read Mode changes the page around the video, not the video. */
  readerInReadMode: boolean;
  /** Preferred caption language, as a BCP-47 prefix. */
  language: string;
}

/**
 * What a fresh install starts with — and, via `profiles.ts`, the Default profile.
 *
 * Existing installs are unaffected by changes here: `loadSettings` asks storage
 * for these keys and gets back whatever was stored, so a default only reaches
 * someone who never set that field.
 */
export const DEFAULTS: Settings = {
  enabled: true,
  mode: "rsvp",
  theme: "focus",
  font: "geist_mono",
  fontSize: 22,
  letterSpacing: 0,
  autoScale: true,
  verticalPosition: 8,
  boxWidth: 58,
  contextBefore: 3,
  contextAfter: 3,
  contextOpacity: 0.34,
  bionicAccent: true,
  // Matches what `reader.css` used to hardcode, so nothing moves for anyone
  // already using the extension.
  backgroundOpacity: 0.88,
  // The Focus palette, so opening the pickers starts from what is on screen
  // rather than from an arbitrary colour.
  customBackground: "#16181b",
  customText: "#e8e6e3",
  customFaded: "#6e7278",
  customAccent: "#e4572e",
  motion: "dynamic",
  fontStyle: "normal",
  textCase: "none",
  textWeight: 600,
  textOutline: 0,
  lineWords: 12,
  showPivotGuides: true,
  removeFillers: true,
  hideNativeCaptions: true,
  readerInReadMode: true,
  language: "en",
};

export async function loadSettings(): Promise<Settings> {
  try {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    return { ...DEFAULTS, ...stored } as Settings;
  } catch {
    // Storage can be unavailable in a torn-down context during navigation.
    return { ...DEFAULTS };
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.sync.set(patch);
}

export function onSettingsChanged(
  handler: (settings: Settings) => void,
): () => void {
  const listener = (
    _changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area !== "sync") return;
    void loadSettings().then(handler);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/* ── device preferences ─────────────────────────────────────────────────── */

/**
 * Settings that belong to this browser rather than to a reading style.
 *
 * Kept in `chrome.storage.local` and deliberately outside `Settings`: a profile
 * switch must not turn stats tracking off or start opening read mode by itself,
 * and neither belongs in the 120-writes-a-minute sync budget.
 */
export interface DevicePrefs {
  /** Record watch time, coverage and rewatch counts. */
  statsTracking: boolean;
  /** Enter read mode automatically when a video page loads. */
  autoReadMode: boolean;
  /** Append the whole transcript to an exported file. */
  exportTranscript: boolean;
  /**
   * Where exports land, as a folder path *relative to Downloads*.
   *
   * Chrome will not let an extension write to an arbitrary absolute path — a
   * `filename` that escapes the downloads directory is rejected outright. A
   * subfolder is what can be automated; anywhere else needs the save dialog.
   */
  exportFolder: string;
  /**
   * Open the save dialog every time, so any folder on disk can be chosen.
   *
   * The default, and the only route to a folder outside Downloads. When this is
   * on, `exportFolder` does not apply — the dialog decides.
   */
  exportAskWhere: boolean;
}

export const DEVICE_DEFAULTS: DevicePrefs = {
  statsTracking: true,
  autoReadMode: false,
  // Off: a transcript is by far the largest thing in the file and would bury
  // the notes people mostly open it to reread.
  exportTranscript: false,
  exportFolder: "",
  // On by default: it is the only option that can reach a folder outside
  // Downloads, which is where a notes vault usually lives. Chrome remembers the
  // last folder chosen, so after the first export it is one keypress.
  exportAskWhere: true,
};

const DEVICE_KEYS = {
  statsTracking: "prefs.statsTracking",
  autoReadMode: "prefs.autoReadMode",
  exportTranscript: "prefs.exportTranscript",
  exportFolder: "prefs.exportFolder",
  exportAskWhere: "prefs.exportAskWhere",
} as const;

export async function loadDevicePrefs(): Promise<DevicePrefs> {
  try {
    const stored = await chrome.storage.local.get({
      [DEVICE_KEYS.statsTracking]: DEVICE_DEFAULTS.statsTracking,
      [DEVICE_KEYS.autoReadMode]: DEVICE_DEFAULTS.autoReadMode,
      [DEVICE_KEYS.exportTranscript]: DEVICE_DEFAULTS.exportTranscript,
      [DEVICE_KEYS.exportFolder]: DEVICE_DEFAULTS.exportFolder,
      [DEVICE_KEYS.exportAskWhere]: DEVICE_DEFAULTS.exportAskWhere,
    });
    return {
      statsTracking: Boolean(stored[DEVICE_KEYS.statsTracking]),
      autoReadMode: Boolean(stored[DEVICE_KEYS.autoReadMode]),
      exportTranscript: Boolean(stored[DEVICE_KEYS.exportTranscript]),
      exportFolder: String(stored[DEVICE_KEYS.exportFolder] ?? ""),
      exportAskWhere: Boolean(stored[DEVICE_KEYS.exportAskWhere]),
    };
  } catch {
    return { ...DEVICE_DEFAULTS };
  }
}

export async function saveDevicePrefs(
  patch: Partial<DevicePrefs>,
): Promise<void> {
  const write: Record<string, boolean | string> = {};
  for (const [name, value] of Object.entries(patch)) {
    const key = DEVICE_KEYS[name as keyof DevicePrefs];
    if (key === undefined) continue;
    if (typeof value === "boolean" || typeof value === "string") {
      write[key] = value;
    }
  }
  if (Object.keys(write).length > 0) await chrome.storage.local.set(write);
}

/**
 * A download path Chrome will accept.
 *
 * `chrome.downloads` rejects anything that leaves the downloads directory, so
 * absolute paths, drive letters and `..` are stripped rather than passed
 * through to fail at the call site with an opaque error.
 */
export function downloadPath(folder: string, filename: string): string {
  const clean = folder
    .split(/[\\/]+/)
    .map((part) => part.trim())
    // A drive letter, a leading slash or a `..` would all make Chrome
    // reject the whole download rather than clamp it.
    .filter((part) => part && part !== "." && part !== "..")
    .filter((part) => !/^[a-zA-Z]:$/.test(part))
    .join("/");
  return clean ? `${clean}/${filename}` : filename;
}

export function onDevicePrefsChanged(
  handler: (prefs: DevicePrefs) => void,
): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area !== "local") return;
    if (!Object.values(DEVICE_KEYS).some((key) => key in changes)) return;
    void loadDevicePrefs().then(handler);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
