/**
 * Saved reading profiles.
 *
 * A profile is a complete look and feel under one name. The motivation is that
 * the right settings depend on what is on screen: a bright talking-head video
 * wants a light palette, a dark documentary wants Nocturne, skimming wants no
 * context words and studying wants several. Reassembling that from five sliders
 * every time is why nobody does it.
 *
 * Profiles live in their own storage keys rather than inside `Settings`. The
 * content script only ever needs resolved settings, and giving it the profile
 * list too would mean parsing data it has no use for on every video.
 */

import { DEFAULTS, saveSettings, type Settings } from "./settings";

/**
 * The slice of `Settings` a profile carries.
 *
 * `enabled` and `language` are about *this user*, not about a reading style.
 * Switching profile must never silently turn the reader off or change which
 * caption track it picks — those would look like bugs, not like a theme change.
 */
export type ProfileSettings = Omit<Settings, "enabled" | "language">;

/**
 * Every key a profile owns.
 *
 * Written as a record keyed by `keyof ProfileSettings` rather than as an array,
 * because that makes the compiler enforce completeness: add a field to
 * `Settings` and forget it here and this fails to build, instead of shipping a
 * profile switch that silently changes only some of what you see.
 */
const PROFILE_FIELDS: Record<keyof ProfileSettings, true> = {
  mode: true,
  theme: true,
  font: true,
  fontSize: true,
  letterSpacing: true,
  autoScale: true,
  verticalPosition: true,
  boxWidth: true,
  contextBefore: true,
  contextAfter: true,
  contextOpacity: true,
  bionicAccent: true,
  backgroundOpacity: true,
  customBackground: true,
  customText: true,
  customFaded: true,
  customAccent: true,
  fontStyle: true,
  textCase: true,
  textWeight: true,
  textOutline: true,
  lineWords: true,
  showPivotGuides: true,
  removeFillers: true,
  hideNativeCaptions: true,
  readerInReadMode: true,
};

export const PROFILE_KEYS = Object.keys(PROFILE_FIELDS) as Array<
  keyof ProfileSettings
>;

export interface Profile {
  id: string;
  name: string;
  /** One line, shown under the picker, saying when you would reach for it. */
  blurb: string;
  /** Built-ins ship with the extension and are never written to. */
  builtIn: boolean;
  settings: ProfileSettings;
}

/** Narrow a full settings object down to just what a profile stores. */
function only(settings: Settings | ProfileSettings): ProfileSettings {
  const out: Partial<ProfileSettings> = {};
  for (const key of PROFILE_KEYS) {
    // `Object.assign` rather than `out[key] =`: the loop erases which value type
    // belongs to which key, and a direct write is rejected for that reason.
    Object.assign(out, { [key]: settings[key] });
  }
  return out as ProfileSettings;
}

/**
 * The Custom theme's colours, for the profiles that do not use it.
 *
 * All four are profile fields, so a profile that omitted them would leave the
 * previous profile's palette behind on switching — which only shows up once
 * someone has actually built a custom theme, and reads as a ghost. Spread from
 * one place rather than restated seven times, where four hex codes that mean
 * nothing would look like they meant something.
 */
type Palette = Pick<
  ProfileSettings,
  "customBackground" | "customText" | "customFaded" | "customAccent"
>;

/**
 * Typography a profile does not deliberately style.
 *
 * Spread into every profile that predates these settings, so each keeps exactly
 * the appearance it shipped with rather than quietly gaining italics or an
 * outline on the day the setting was added.
 */
type Typography = Pick<
  ProfileSettings,
  "fontStyle" | "textCase" | "textWeight" | "textOutline" | "lineWords"
>;

const PLAIN_TYPE: Typography = {
  fontStyle: DEFAULTS.fontStyle,
  textCase: DEFAULTS.textCase,
  textWeight: DEFAULTS.textWeight,
  textOutline: DEFAULTS.textOutline,
  lineWords: DEFAULTS.lineWords,
};

const UNUSED_PALETTE: Palette = {
  customBackground: DEFAULTS.customBackground,
  customText: DEFAULTS.customText,
  customFaded: DEFAULTS.customFaded,
  customAccent: DEFAULTS.customAccent,
};

/* ── the built-ins ──────────────────────────────────────────────────────── */

export const BUILT_IN_PROFILES: readonly Profile[] = [
  {
    id: "default",
    name: "Default",
    blurb:
      "One word at a fixed point, dark, with a little context either side.",
    builtIn: true,
    // Derived from DEFAULTS rather than restated, so the two cannot drift.
    settings: only(DEFAULTS),
  },
  {
    id: "peripheral",
    name: "Peripheral",
    blurb:
      "Pinned word with the preview bolded ahead of it, and nothing behind.",
    builtIn: true,
    settings: {
      mode: "rsvp-bionic",
      theme: "focus",
      font: "geist",
      fontSize: 25,
      letterSpacing: 0,
      autoScale: true,
      verticalPosition: 9,
      boxWidth: 38,
      contextBefore: 0,
      contextAfter: 5,
      contextOpacity: 0.5,
      bionicAccent: true,
      backgroundOpacity: 0.82,
      showPivotGuides: true,
      removeFillers: true,
      hideNativeCaptions: true,
      readerInReadMode: true,
      ...UNUSED_PALETTE,
      ...PLAIN_TYPE,
    },
  },
  {
    id: "serif-flow",
    name: "Serif Flow",
    blurb: "A whole line at once, serif in black on white. Reads like print.",
    builtIn: true,
    settings: {
      mode: "bionic",
      theme: "custom",
      font: "source_serif",
      fontSize: 28,
      letterSpacing: 0,
      autoScale: true,
      verticalPosition: 10,
      boxWidth: 55,
      contextBefore: 5,
      contextAfter: 5,
      contextOpacity: 0.82,
      bionicAccent: true,
      backgroundOpacity: 0.88,
      showPivotGuides: false,
      removeFillers: true,
      hideNativeCaptions: true,
      readerInReadMode: true,
      // Paper, not a screen: near-white ground, near-black ink. The accent is
      // the only pure value, and it lands only on Bionic's lead letters, so
      // they darken rather than colour -- emphasis without a second hue.
      customBackground: "#f2f2f2",
      customText: "#303030",
      customFaded: "#babec4",
      customAccent: "#000000",
      fontStyle: "normal",
      textCase: "none",
      textWeight: 600,
      textOutline: 0,
      lineWords: 12,
    },
  },
  {
    id: "clarity-cold",
    name: "Clarity Cold",
    blurb: "Atkinson at full weight on cold light blue, with a blue pivot.",
    builtIn: true,
    settings: {
      mode: "rsvp-bionic",
      theme: "custom",
      font: "atkinson_hyperlegible",
      fontSize: 21,
      letterSpacing: 0.25,
      autoScale: true,
      verticalPosition: 11,
      boxWidth: 55,
      contextBefore: 0,
      contextAfter: 5,
      contextOpacity: 0.5,
      bionicAccent: true,
      backgroundOpacity: 0.94,
      showPivotGuides: true,
      removeFillers: true,
      hideNativeCaptions: true,
      readerInReadMode: true,
      customBackground: "#d1ddeb",
      customText: "#1a1a1a",
      customFaded: "#858585",
      customAccent: "#2f78e4",
      fontStyle: "normal",
      textCase: "none",
      textWeight: 700,
      textOutline: 0,
      lineWords: 12,
    },
  },
  {
    id: "obsidian",
    name: "Obsidian",
    blurb:
      "A violet block on lilac, over near-black. Bright surrounding words.",
    builtIn: true,
    settings: {
      mode: "highlight",
      theme: "custom",
      font: "literata",
      fontSize: 24,
      letterSpacing: 0.25,
      autoScale: true,
      verticalPosition: 9,
      boxWidth: 50,
      contextBefore: 4,
      contextAfter: 4,
      contextOpacity: 0.96,
      bionicAccent: true,
      backgroundOpacity: 0.88,
      showPivotGuides: false,
      removeFillers: true,
      hideNativeCaptions: true,
      readerInReadMode: true,
      customBackground: "#16181b",
      customText: "#c9afd9",
      customFaded: "#a6a0a5",
      customAccent: "#9b80f9",
      fontStyle: "normal",
      textCase: "none",
      textWeight: 600,
      textOutline: 0,
      lineWords: 12,
    },
  },
  {
    id: "black-box",
    name: "Black Box",
    blurb: "White on solid black, a line at a time. Nothing moves.",
    builtIn: true,
    settings: {
      mode: "plain",
      theme: "caption",
      font: "geist",
      fontSize: 22,
      letterSpacing: 0,
      autoScale: true,
      verticalPosition: 10,
      boxWidth: 56,
      contextBefore: 3,
      contextAfter: 4,
      contextOpacity: 0.48,
      bionicAccent: true,
      backgroundOpacity: 0.97,
      showPivotGuides: false,
      removeFillers: true,
      hideNativeCaptions: true,
      readerInReadMode: true,
      ...UNUSED_PALETTE,
      fontStyle: "normal",
      textCase: "none",
      textWeight: 700,
      textOutline: 0,
      lineWords: 7,
    },
  },
  {
    id: "lyric",
    name: "Lyric",
    blurb: "Gold italic on a solid dark band, small and low in the frame.",
    builtIn: true,
    settings: {
      mode: "plain",
      theme: "lyric",
      font: "literata",
      fontSize: 18,
      letterSpacing: -0.75,
      autoScale: true,
      verticalPosition: 6,
      boxWidth: 46,
      contextBefore: 3,
      contextAfter: 4,
      contextOpacity: 0.48,
      bionicAccent: true,
      backgroundOpacity: 1,
      showPivotGuides: false,
      removeFillers: true,
      hideNativeCaptions: true,
      readerInReadMode: true,
      ...UNUSED_PALETTE,
      fontStyle: "italic",
      textCase: "none",
      textWeight: 400,
      textOutline: 0,
      lineWords: 8,
    },
  },
];

export const DEFAULT_PROFILE_ID = "default";

/* ── storage ────────────────────────────────────────────────────────────── */

const ACTIVE_KEY = "activeProfileId";
const CUSTOM_KEY = "customProfiles";

const CUSTOM_BLURB = "Saved by you.";

interface StoredProfile {
  name: string;
  settings: ProfileSettings;
}

type StoredProfiles = Record<string, StoredProfile>;

async function readCustom(): Promise<StoredProfiles> {
  try {
    const stored = await chrome.storage.sync.get({ [CUSTOM_KEY]: {} });
    const value = stored[CUSTOM_KEY];
    return value && typeof value === "object" ? (value as StoredProfiles) : {};
  } catch {
    // Storage can be unavailable in a torn-down context during navigation.
    return {};
  }
}

export interface ProfileState {
  activeId: string;
  all: Profile[];
}

export async function loadProfiles(): Promise<ProfileState> {
  const [stored, custom] = await Promise.all([
    chrome.storage.sync
      .get({ [ACTIVE_KEY]: DEFAULT_PROFILE_ID })
      .catch(() => ({})),
    readCustom(),
  ]);

  const all: Profile[] = [
    ...BUILT_IN_PROFILES,
    ...Object.entries(custom).map(([id, entry]) => ({
      id,
      name: entry.name,
      blurb: CUSTOM_BLURB,
      builtIn: false,
      settings: entry.settings,
    })),
  ];

  const wanted = (stored as Record<string, unknown>)[ACTIVE_KEY];
  // A deleted profile leaves a dangling id behind. Falling back beats showing
  // a picker with nothing selected.
  const activeId =
    typeof wanted === "string" && all.some((p) => p.id === wanted)
      ? wanted
      : DEFAULT_PROFILE_ID;

  return { activeId, all };
}

/**
 * Apply a profile: write its settings and record it as active.
 *
 * One `storage.sync.set` for the settings means one change event, so the content
 * script's existing `onSettingsChanged` picks the whole profile up at once
 * rather than redrawing once per field.
 */
export async function applyProfile(profile: Profile): Promise<void> {
  await saveSettings(profile.settings);
  await chrome.storage.sync.set({ [ACTIVE_KEY]: profile.id });
}

/** True when the live settings no longer match the profile they came from. */
export function isModified(profile: Profile, settings: Settings): boolean {
  return PROFILE_KEYS.some((key) => settings[key] !== profile.settings[key]);
}

export async function saveAsProfile(
  name: string,
  settings: Settings,
): Promise<Profile> {
  const custom = await readCustom();
  const id = `custom-${Date.now().toString(36)}`;
  const entry: StoredProfile = {
    name: name.trim() || "Untitled",
    settings: only(settings),
  };
  custom[id] = entry;
  await chrome.storage.sync.set({ [CUSTOM_KEY]: custom, [ACTIVE_KEY]: id });
  return {
    id,
    name: entry.name,
    blurb: CUSTOM_BLURB,
    builtIn: false,
    settings: entry.settings,
  };
}

export async function updateProfile(
  id: string,
  settings: Settings,
): Promise<void> {
  const custom = await readCustom();
  const existing = custom[id];
  if (!existing) return; // built-in, or deleted in another tab
  custom[id] = { name: existing.name, settings: only(settings) };
  await chrome.storage.sync.set({ [CUSTOM_KEY]: custom });
}

export async function deleteProfile(id: string): Promise<void> {
  const custom = await readCustom();
  if (!custom[id]) return;
  delete custom[id];
  await chrome.storage.sync.set({ [CUSTOM_KEY]: custom });
}

/** Watch for profiles changing in another tab or in the popup. */
export function onProfilesChanged(handler: () => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area !== "sync") return;
    if (ACTIVE_KEY in changes || CUSTOM_KEY in changes) handler();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
