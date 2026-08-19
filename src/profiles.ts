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
      "The pivot holds your eye; the words either side are bolded so you can take them in without looking at them.",
    builtIn: true,
    settings: {
      mode: "rsvp-bionic",
      theme: "focus",
      // Monospace, because this mode keeps RSVP's pivot column and a mono face
      // lands it exactly in `ch` units rather than by measurement.
      font: "geist_mono",
      fontSize: 25,
      letterSpacing: 0,
      autoScale: true,
      verticalPosition: 9,
      // Wide enough for the bolded neighbours to actually be there. Trimming
      // them at the edge would defeat the point of emboldening them.
      boxWidth: 72,
      // Asymmetric on purpose: reading *ahead* is what the bold is for, and
      // what has already been said needs far less room than what has not.
      contextBefore: 2,
      contextAfter: 5,
      // Brighter than plain RSVP wants. Context you cannot read is not preview,
      // it is decoration — and the lead letters are lifted above this again.
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
    blurb: "A whole line at once, serif on neutral grey. Reads like a page.",
    builtIn: true,
    settings: {
      mode: "bionic",
      theme: "slate",
      font: "source_serif",
      fontSize: 26,
      letterSpacing: 0,
      autoScale: true,
      verticalPosition: 10,
      boxWidth: 82,
      // Symmetric, so the current word stays near the middle of the window.
      contextBefore: 4,
      contextAfter: 4,
      // Bionic asks you to read the whole window, not just fixate one word, so
      // the surrounding words are nearly as present as the current one.
      contextOpacity: 0.82,
      bionicAccent: true,
      backgroundOpacity: 0.88,
      ...UNUSED_PALETTE,
      ...PLAIN_TYPE,
      showPivotGuides: false,
      removeFillers: true,
      hideNativeCaptions: true,
      readerInReadMode: true,
    },
  },
  {
    id: "reading-room",
    name: "Reading Room",
    blurb: "Light and warm, for daytime and bright video.",
    builtIn: true,
    settings: {
      mode: "rsvp",
      theme: "mist",
      font: "literata",
      fontSize: 24,
      letterSpacing: 0.25,
      autoScale: true,
      verticalPosition: 10,
      boxWidth: 62,
      contextBefore: 2,
      contextAfter: 4,
      contextOpacity: 0.4,
      bionicAccent: true,
      backgroundOpacity: 0.88,
      ...UNUSED_PALETTE,
      ...PLAIN_TYPE,
      showPivotGuides: true,
      removeFillers: true,
      hideNativeCaptions: true,
      readerInReadMode: true,
    },
  },
  {
    id: "night-study",
    name: "Night Study",
    blurb: "Bionic on deep blue-grey, sized to follow a lecture in the dark.",
    builtIn: true,
    settings: {
      mode: "bionic",
      theme: "nocturne",
      font: "literata",
      fontSize: 24,
      letterSpacing: 0,
      autoScale: true,
      verticalPosition: 9,
      boxWidth: 80,
      contextBefore: 4,
      contextAfter: 4,
      contextOpacity: 0.78,
      bionicAccent: true,
      backgroundOpacity: 0.88,
      ...UNUSED_PALETTE,
      ...PLAIN_TYPE,
      showPivotGuides: false,
      removeFillers: true,
      hideNativeCaptions: true,
      readerInReadMode: true,
    },
  },
  {
    id: "sprint",
    name: "Sprint",
    blurb: "Large, narrow, almost no context. For 2x and above.",
    builtIn: true,
    settings: {
      mode: "rsvp",
      theme: "focus",
      font: "geist_mono",
      fontSize: 30,
      letterSpacing: 0,
      autoScale: true,
      verticalPosition: 12,
      boxWidth: 40,
      // Nothing behind and one word ahead: at speed, context is a place for the
      // eye to wander to, which is exactly what the fixed pivot is preventing.
      contextBefore: 0,
      contextAfter: 1,
      contextOpacity: 0.22,
      bionicAccent: true,
      backgroundOpacity: 0.88,
      ...UNUSED_PALETTE,
      ...PLAIN_TYPE,
      showPivotGuides: true,
      removeFillers: true,
      hideNativeCaptions: true,
      readerInReadMode: true,
    },
  },
  {
    id: "clarity",
    name: "Clarity",
    blurb: "Big, high contrast, letter shapes drawn for low vision.",
    builtIn: true,
    settings: {
      mode: "rsvp",
      theme: "contrast",
      font: "atkinson_hyperlegible",
      fontSize: 32,
      letterSpacing: 1,
      autoScale: true,
      verticalPosition: 8,
      boxWidth: 70,
      contextBefore: 1,
      contextAfter: 2,
      contextOpacity: 0.55,
      bionicAccent: true,
      backgroundOpacity: 0.88,
      ...UNUSED_PALETTE,
      ...PLAIN_TYPE,
      showPivotGuides: true,
      removeFillers: true,
      hideNativeCaptions: true,
      readerInReadMode: true,
    },
  },
  {
    id: "quiet-caption",
    name: "Quiet Caption",
    blurb:
      "An ordinary subtitle that holds still and changes a line at a time. Nothing moves.",
    builtIn: true,
    settings: {
      mode: "plain",
      theme: "focus",
      font: "literata",
      fontSize: 26,
      letterSpacing: 0,
      autoScale: true,
      verticalPosition: 8,
      boxWidth: 78,
      // Static mode builds its own line, so neither count is read. Left at
      // sensible values rather than zero, so switching away from this profile
      // to a sliding mode does not land on an empty window.
      contextBefore: 3,
      contextAfter: 4,
      contextOpacity: 0.48,
      bionicAccent: true,
      // Barely a card at all, so the words read as part of the picture rather
      // than as a panel sitting on top of it.
      backgroundOpacity: 0.42,
      showPivotGuides: false,
      removeFillers: true,
      hideNativeCaptions: true,
      readerInReadMode: true,
      ...UNUSED_PALETTE,
      ...PLAIN_TYPE,
    },
  },
  {
    id: "highlighter",
    name: "Highlighter",
    blurb: "A block on the word being spoken. Holds up at speed.",
    builtIn: true,
    settings: {
      mode: "highlight",
      theme: "contrast",
      font: "geist_mono",
      fontSize: 27,
      letterSpacing: 0,
      autoScale: true,
      verticalPosition: 10,
      boxWidth: 74,
      contextBefore: 3,
      contextAfter: 4,
      // Brighter than most: the block is doing the work of marking position,
      // so the words around it do not also need to be faint.
      contextOpacity: 0.62,
      bionicAccent: true,
      backgroundOpacity: 0.55,
      showPivotGuides: false,
      removeFillers: true,
      hideNativeCaptions: true,
      readerInReadMode: true,
      ...UNUSED_PALETTE,
      ...PLAIN_TYPE,
    },
  },
  {
    id: "lyric",
    name: "Lyric",
    blurb:
      "Gold italic serif on a translucent blue band, the width of the picture.",
    builtIn: true,
    settings: {
      mode: "plain",
      theme: "lyric",
      font: "literata",
      fontSize: 21,
      letterSpacing: 0,
      autoScale: true,
      // Low and wide: this style belongs at the very bottom of the frame,
      // spanning it, the way a burned-in lyric line does.
      verticalPosition: 5,
      boxWidth: 96,
      contextBefore: 3,
      contextAfter: 4,
      contextOpacity: 0.48,
      bionicAccent: true,
      // A band you can see the picture through, not a panel sitting on it.
      backgroundOpacity: 0.55,
      showPivotGuides: false,
      removeFillers: true,
      hideNativeCaptions: true,
      readerInReadMode: true,
      ...UNUSED_PALETTE,
      fontStyle: "italic",
      textCase: "none",
      textWeight: 500,
      // Just enough to keep gold legible where the band runs over a bright
      // part of the picture.
      textOutline: 1,
      lineWords: 12,
    },
  },
  {
    id: "caption-box",
    name: "Caption Box",
    blurb: "White on solid black. The plainest, most legible thing there is.",
    builtIn: true,
    settings: {
      mode: "plain",
      theme: "caption",
      font: "geist",
      fontSize: 26,
      letterSpacing: 0,
      autoScale: true,
      verticalPosition: 8,
      boxWidth: 64,
      contextBefore: 3,
      contextAfter: 4,
      contextOpacity: 0.48,
      bionicAccent: true,
      // Effectively solid. The whole point of this style is that the video
      // behind it never competes with the words.
      backgroundOpacity: 0.97,
      showPivotGuides: false,
      removeFillers: true,
      hideNativeCaptions: true,
      readerInReadMode: true,
      ...UNUSED_PALETTE,
      fontStyle: "normal",
      textCase: "none",
      textWeight: 700,
      // None needed: nothing shows through a solid box for it to fight.
      textOutline: 0,
      lineWords: 7,
    },
  },
  {
    id: "pop",
    name: "Pop",
    blurb:
      "Big uppercase over the picture, no card. Two or three words at a time.",
    builtIn: true,
    settings: {
      mode: "plain",
      theme: "pop",
      // Atkinson rather than Geist, because Geist ships no weight above 600 and
      // asking for more only gets synthetic bold, which came out visibly
      // lighter than this style wants. Atkinson has a real 700 -- and being
      // drawn for low vision is no handicap for a caption over video.
      font: "atkinson_hyperlegible",
      fontSize: 38,
      letterSpacing: 0.5,
      autoScale: true,
      verticalPosition: 16,
      boxWidth: 84,
      contextBefore: 3,
      contextAfter: 4,
      contextOpacity: 0.48,
      bionicAccent: true,
      // No card at all. The outline is what makes this readable instead.
      backgroundOpacity: 0,
      showPivotGuides: false,
      removeFillers: true,
      hideNativeCaptions: true,
      readerInReadMode: true,
      ...UNUSED_PALETTE,
      fontStyle: "normal",
      textCase: "upper",
      textWeight: 700,
      // At maximum: with no card behind it the outline is the only thing
      // separating the words from the picture, and it doubles as visual weight.
      textOutline: 4,
      // Short and punchy. A long line in this size would cover the picture.
      lineWords: 3,
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
