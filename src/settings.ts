/**
 * Extension settings, stored in `chrome.storage.sync`.
 *
 * Defaults deliberately match the desktop app's, so the two feel like one
 * product rather than two things that happen to share a name.
 */

import type { ReaderFont } from "./reader-core/fonts";

export type ReaderTheme = "focus" | "paper" | "sepia" | "contrast";
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
  /** Preferred caption language, as a BCP-47 prefix. */
  language: string;
}

export const DEFAULTS: Settings = {
  enabled: true,
  mode: "rsvp",
  theme: "focus",
  font: "geist_mono",
  fontSize: 34,
  letterSpacing: 0,
  autoScale: true,
  verticalPosition: 8,
  boxWidth: 62,
  contextBefore: 1,
  contextAfter: 3,
  contextOpacity: 0.38,
  showPivotGuides: true,
  removeFillers: true,
  hideNativeCaptions: true,
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

export function onSettingsChanged(handler: (settings: Settings) => void): () => void {
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
