/**
 * Extension settings, stored in `chrome.storage.sync`.
 *
 * Defaults deliberately match the desktop app's, so the two feel like one
 * product rather than two things that happen to share a name.
 */

import type { ReaderFont } from "./reader-core/fonts";

export type ReaderTheme =
  "focus" | "paper" | "sepia" | "contrast" | "slate" | "mist" | "nocturne";
export type ReadingMode = "rsvp" | "bionic";

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
}

export const DEVICE_DEFAULTS: DevicePrefs = {
  statsTracking: true,
  autoReadMode: false,
  // Off: a transcript is by far the largest thing in the file and would bury
  // the notes people mostly open it to reread.
  exportTranscript: false,
};

const DEVICE_KEYS = {
  statsTracking: "prefs.statsTracking",
  autoReadMode: "prefs.autoReadMode",
  exportTranscript: "prefs.exportTranscript",
} as const;

export async function loadDevicePrefs(): Promise<DevicePrefs> {
  try {
    const stored = await chrome.storage.local.get({
      [DEVICE_KEYS.statsTracking]: DEVICE_DEFAULTS.statsTracking,
      [DEVICE_KEYS.autoReadMode]: DEVICE_DEFAULTS.autoReadMode,
      [DEVICE_KEYS.exportTranscript]: DEVICE_DEFAULTS.exportTranscript,
    });
    return {
      statsTracking: Boolean(stored[DEVICE_KEYS.statsTracking]),
      autoReadMode: Boolean(stored[DEVICE_KEYS.autoReadMode]),
      exportTranscript: Boolean(stored[DEVICE_KEYS.exportTranscript]),
    };
  } catch {
    return { ...DEVICE_DEFAULTS };
  }
}

export async function saveDevicePrefs(
  patch: Partial<DevicePrefs>,
): Promise<void> {
  const write: Record<string, boolean> = {};
  for (const [name, value] of Object.entries(patch)) {
    const key = DEVICE_KEYS[name as keyof DevicePrefs];
    if (key !== undefined && typeof value === "boolean") write[key] = value;
  }
  if (Object.keys(write).length > 0) await chrome.storage.local.set(write);
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
