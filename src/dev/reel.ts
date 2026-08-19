/**
 * The reader, steppable, for recording.
 *
 * A README can describe RSVP for three paragraphs and still not land it. One
 * animation of a word swapping at a fixed point does the whole job — so this
 * page renders the real overlay and exposes a step function, and
 * `scripts/reel.py` drives it a frame at a time and assembles the result.
 *
 * Stepped rather than timed on purpose. Recording a self-animating page means
 * screenshotting whatever happens to be on screen when the capture lands, which
 * drops and duplicates frames at random; driving it explicitly means frame *n*
 * of the file is word *n* of the sentence, every time.
 */

import { ReaderOverlay } from "../content/overlay";
import { buildLines } from "../content/lines";
import { classify } from "../reader-core/words";
import { BUILT_IN_PROFILES } from "../profiles";
import {
  DEFAULTS,
  MODE_LABELS,
  type ReadingMode,
  type Settings,
} from "../settings";

declare global {
  interface Window {
    __ready?: boolean;
    __steps?: number;
    __step?: (index: number) => void;
  }
}

const SENTENCE =
  "the highlighted letter marks the optimal recognition point the exact position your brain uses to identify a whole word at once";
const WORDS = SENTENCE.split(" ").map(classify);

const params = new URLSearchParams(window.location.search);
const wanted = params.get("profile");
const grid = params.get("grid") === "1";

function profileSettings(id: string): Partial<Settings> {
  const found = BUILT_IN_PROFILES.find((p) => p.id === id);
  if (!found) throw new Error(`no built-in profile "${id}"`);
  return found.settings;
}

/**
 * The view the real render loop would build at this word.
 *
 * Static mode is a line rather than a window, exactly as in `content/index.ts`
 * — recording it as a sliding window would show something the reader never
 * actually does.
 */
function viewFor(settings: Settings, index: number) {
  if (settings.mode === "plain") {
    const lines = buildLines(WORDS, settings.lineWords);
    const line =
      lines.find((l) => index >= l.startIndex && index < l.endIndex) ??
      lines[0];
    return {
      key: `line:${line.startIndex}`,
      current: line.words[0],
      previous: [],
      upcoming: line.words.slice(1),
    };
  }
  return {
    current: WORDS[index],
    previous: WORDS.slice(Math.max(0, index - settings.contextBefore), index),
    upcoming: WORDS.slice(index + 1, index + 1 + settings.contextAfter),
  };
}

interface Strip {
  settings: Settings;
  overlay: ReaderOverlay;
}

const strips: Strip[] = [];

function strip(label: string, patch: Partial<Settings>, height: number): void {
  const row = document.createElement("section");
  row.className = "strip";

  const name = document.createElement("h2");
  name.textContent = label;
  row.append(name);

  const player = document.createElement("div");
  player.className = "player";
  player.style.height = `${height}px`;
  row.append(player);

  const settings: Settings = { ...DEFAULTS, autoScale: false, ...patch };
  const overlay = new ReaderOverlay(settings);
  overlay.mount(player);
  strips.push({ settings, overlay });

  document.body.append(row);
}

async function main(): Promise<void> {
  if (grid) {
    // Every mode, reading the same sentence at the same instant. Seeing them
    // together is the only way to judge which one you actually want.
    for (const mode of Object.keys(MODE_LABELS) as ReadingMode[]) {
      strip(
        MODE_LABELS[mode],
        { mode, fontSize: 19, boxWidth: 94, contextBefore: 2, contextAfter: 3 },
        104,
      );
    }
  } else if (wanted) {
    strip("", { ...profileSettings(wanted), autoScale: false }, 190);
  } else {
    // Tuned so the neighbours fit whole rather than being trimmed at the mask.
    // The trimming is real and correct in use, where the words are moving and
    // the fade reads as depth; frozen in a screenshot it just looks broken.
    strip(
      "",
      {
        mode: "rsvp",
        fontSize: 27,
        boxWidth: 88,
        contextBefore: 2,
        contextAfter: 2,
      },
      190,
    );
  }

  window.__steps = WORDS.length;
  window.__step = (index: number): void => {
    for (const s of strips) s.overlay.render(viewFor(s.settings, index));
  };
  window.__step(0);

  await document.fonts.ready;
  window.__ready = true;
}

void main();
