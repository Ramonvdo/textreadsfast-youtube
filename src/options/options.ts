/**
 * Settings page.
 *
 * The controls are generated from a schema rather than hand-written markup, so
 * adding a setting is one entry rather than an HTML block plus a wiring block
 * that can silently disagree with each other.
 *
 * The preview runs the real overlay class over a fixed passage: every control
 * here changes something you can only judge by looking at it.
 *
 * Profiles come first on the page, because picking one is the decision that
 * makes most of the rest unnecessary.
 */

import { ReaderOverlay } from "../content/overlay";
import { ProfileBar } from "./profileBar";
import { classify } from "../reader-core/words";
import { FONT_LABELS, type ReaderFont } from "../reader-core/fonts";
import {
  DEFAULTS,
  loadSettings,
  saveSettings,
  type Settings,
} from "../settings";

const SAMPLE =
  "The highlighted letter marks the optimal recognition point, the exact position your brain uses to identify a whole word at once.";

const SAMPLE_WORDS = SAMPLE.split(/\s+/).filter(Boolean).map(classify);

type Group = "reading" | "appearance" | "captions";

interface BaseField {
  key: keyof Settings;
  label: string;
  help?: string;
  group: Group;
}

interface ToggleField extends BaseField {
  kind: "toggle";
}

interface SelectField extends BaseField {
  kind: "select";
  options: Array<{ value: string; label: string }>;
}

interface RangeField extends BaseField {
  kind: "range";
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
}

type Field = ToggleField | SelectField | RangeField;

const FIELDS: Field[] = [
  {
    kind: "toggle",
    key: "enabled",
    group: "reading",
    label: "Enabled",
    help: "Turn the reader off without uninstalling.",
  },
  {
    kind: "select",
    key: "mode",
    group: "reading",
    label: "Reading mode",
    help: "RSVP shows one word at a fixed focal point. Bionic shows a sliding window with the leading letters emphasised.",
    options: [
      { value: "rsvp", label: "RSVP (one word)" },
      { value: "bionic", label: "Bionic (sliding window)" },
    ],
  },
  {
    kind: "range",
    key: "contextBefore",
    group: "reading",
    label: "Words behind",
    help: "How many already-read words stay visible to the left.",
    min: 0,
    max: 5,
    step: 1,
  },
  {
    kind: "range",
    key: "contextAfter",
    group: "reading",
    label: "Words ahead",
    help: "How many upcoming words are visible to the right.",
    min: 0,
    max: 8,
    step: 1,
  },
  {
    kind: "toggle",
    key: "showPivotGuides",
    group: "reading",
    label: "Pivot marks",
    help: "The small marks above and below the focal letter, for the eye to anchor on.",
  },
  {
    kind: "select",
    key: "theme",
    group: "appearance",
    label: "Theme",
    help: "None use pure black or pure white — that contrast is what causes eye strain over a long session.",
    options: [
      { value: "focus", label: "Focus (dark)" },
      { value: "paper", label: "Paper (light)" },
      { value: "sepia", label: "Sepia" },
      { value: "contrast", label: "High contrast" },
      { value: "slate", label: "Slate (neutral grey)" },
      { value: "mist", label: "Mist (neutral light)" },
      { value: "nocturne", label: "Nocturne (deep blue-grey)" },
    ],
  },
  {
    kind: "select",
    key: "font",
    group: "appearance",
    label: "Reading font",
    help: "Monospace aligns the focal letter exactly. Atkinson Hyperlegible is designed for low vision.",
    options: (Object.keys(FONT_LABELS) as ReaderFont[]).map((value) => ({
      value,
      label: FONT_LABELS[value],
    })),
  },
  {
    kind: "range",
    key: "fontSize",
    group: "appearance",
    label: "Text size",
    min: 18,
    max: 72,
    step: 1,
    format: (v) => `${v}px`,
  },
  {
    kind: "toggle",
    key: "autoScale",
    group: "appearance",
    label: "Scale with the player",
    help: "Keep the text the same size relative to the video, so fullscreen does not shrink it into the picture.",
  },
  {
    kind: "range",
    key: "verticalPosition",
    group: "appearance",
    label: "Height above the bottom",
    help: "Where the reader sits over the video.",
    min: 0,
    max: 80,
    step: 1,
    format: (v) => `${v}%`,
  },
  {
    kind: "range",
    key: "boxWidth",
    group: "appearance",
    label: "Reader width",
    help: "As a share of the player's width. Wider shows more surrounding words before they are trimmed.",
    min: 25,
    max: 94,
    step: 1,
    format: (v) => `${v}%`,
  },
  {
    kind: "range",
    key: "letterSpacing",
    group: "appearance",
    label: "Letter spacing",
    min: -1,
    max: 6,
    step: 0.25,
    format: (v) => `${v}px`,
  },
  {
    kind: "range",
    key: "contextOpacity",
    group: "appearance",
    label: "Surrounding word dimness",
    help: "Fainter keeps fixation tighter.",
    min: 0,
    max: 1,
    step: 0.02,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    kind: "toggle",
    key: "removeFillers",
    group: "captions",
    label: "Remove fillers",
    help: "Drop um, uh and similar. They pass unnoticed in speech but interrupt a written stream.",
  },
  {
    kind: "toggle",
    key: "hideNativeCaptions",
    group: "captions",
    label: "Hide YouTube's captions",
    help: "Leaving both on means reading the same words twice, in two places.",
  },
  {
    kind: "select",
    key: "language",
    group: "captions",
    label: "Preferred language",
    help: "Which caption track to pick when a video offers several.",
    options: [
      { value: "en", label: "English" },
      { value: "nl", label: "Nederlands" },
      { value: "de", label: "Deutsch" },
      { value: "fr", label: "Français" },
      { value: "es", label: "Español" },
    ],
  },
];

let settings: Settings = { ...DEFAULTS };
let overlay: ReaderOverlay | null = null;
let profileBar: ProfileBar | null = null;
let previewIndex = 0;

function row(field: Field, onChange: (value: unknown) => void): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "row";

  const text = document.createElement("div");
  const label = document.createElement("label");
  label.textContent = field.label;
  text.append(label);
  if (field.help) {
    const help = document.createElement("p");
    help.textContent = field.help;
    text.append(help);
  }

  const control = document.createElement("div");
  control.className = "control";

  if (field.kind === "toggle") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(settings[field.key]);
    input.addEventListener("change", () => onChange(input.checked));
    label.htmlFor = input.id = `f-${String(field.key)}`;
    control.append(input);
  } else if (field.kind === "select") {
    const select = document.createElement("select");
    for (const option of field.options) {
      const el = document.createElement("option");
      el.value = option.value;
      el.textContent = option.label;
      select.append(el);
    }
    select.value = String(settings[field.key]);
    select.addEventListener("change", () => onChange(select.value));
    label.htmlFor = select.id = `f-${String(field.key)}`;
    control.append(select);
  } else {
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(field.min);
    input.max = String(field.max);
    input.step = String(field.step);
    input.value = String(settings[field.key]);
    const output = document.createElement("output");
    const show = (v: number) =>
      (output.textContent = field.format ? field.format(v) : String(v));
    show(Number(settings[field.key]));
    input.addEventListener("input", () => {
      show(Number(input.value));
      onChange(Number(input.value));
    });
    label.htmlFor = input.id = `f-${String(field.key)}`;
    control.append(input, output);
  }

  wrapper.append(text, control);
  return wrapper;
}

/** Autoscale sizes the text against the *player*, and the preview is not one —
 *  left on, it would scale against the options page and balloon. The preview
 *  therefore always shows the configured size, which is what the slider means. */
const previewSettings = (from: Settings): Settings => ({
  ...from,
  autoScale: false,
});

let pending: Partial<Settings> = {};
let flushHandle = 0;

/**
 * Coalesce writes.
 *
 * A range input fires `input` continuously while dragged, and `chrome.storage
 * .sync` rejects more than 120 writes a minute — one unhurried drag of one
 * slider exceeds that on its own, and the rejection is silent, so the setting
 * simply stops saving. The preview still updates on every frame; only the write
 * waits for the control to settle.
 */
function queueSave(patch: Partial<Settings>): void {
  pending = { ...pending, ...patch };
  window.clearTimeout(flushHandle);
  flushHandle = window.setTimeout(flushSave, 250);
}

function flushSave(): Promise<void> {
  window.clearTimeout(flushHandle);
  if (Object.keys(pending).length === 0) return Promise.resolve();
  const batch = pending;
  pending = {};
  return saveSettings(batch);
}

// Closing the tab mid-drag would otherwise drop the last edit.
window.addEventListener("pagehide", () => void flushSave());

function update(patch: Partial<Settings>): void {
  settings = { ...settings, ...patch };
  queueSave(patch);
  overlay?.apply(previewSettings(settings));
  // The picker shows whether the live settings still match their profile, so it
  // has to hear about every edit — not only about profile switches. Repaints
  // from what it already holds; it does not re-read storage per frame.
  profileBar?.repaint();
}

/** Rebuild every control from `settings`. Cheaper to reason about than patching
 *  each control in place, and there is no state in them worth preserving. */
function renderFields(): void {
  for (const group of ["reading", "appearance", "captions"] as Group[]) {
    const host = document.getElementById(`group-${group}`);
    if (!host) continue;
    host.replaceChildren();
    for (const field of FIELDS.filter((f) => f.group === group)) {
      host.append(
        row(field, (value) =>
          update({ [field.key]: value } as Partial<Settings>),
        ),
      );
    }
  }
}

/** Advance the preview at a readable, fixed pace. There is no queue to react to
 *  here, so the adaptive pacing the desktop app uses would have nothing to do. */
function runPreview(): void {
  const host = document.getElementById("preview");
  if (!host) return;
  overlay = new ReaderOverlay(previewSettings(settings));
  // Reuse the existing markup rather than mounting a second copy.
  host.replaceWith(
    ((): HTMLElement => {
      const mounted = (overlay as unknown as { root: HTMLElement }).root;
      mounted.id = "preview";
      return mounted;
    })(),
  );

  window.setInterval(() => {
    previewIndex = (previewIndex + 1) % SAMPLE_WORDS.length;
    overlay?.render({
      current: SAMPLE_WORDS[previewIndex],
      previous: SAMPLE_WORDS.slice(
        Math.max(0, previewIndex - settings.contextBefore),
        previewIndex,
      ),
      upcoming: SAMPLE_WORDS.slice(
        previewIndex + 1,
        previewIndex + 1 + settings.contextAfter,
      ),
    });
  }, 380);
}

async function main(): Promise<void> {
  settings = await loadSettings();

  const profileHost = document.getElementById("group-profile");
  if (profileHost) {
    profileBar = new ProfileBar(profileHost, {
      settings: () => settings,
      // A slider edit still waiting on its debounce would otherwise land after
      // the profile did, and quietly overwrite one of its values.
      flushPending: flushSave,
      onApplied: (next) => {
        settings = next;
        renderFields();
        overlay?.apply(previewSettings(settings));
      },
    });
    await profileBar.refresh();
  }

  renderFields();
  runPreview();
}

void main();
