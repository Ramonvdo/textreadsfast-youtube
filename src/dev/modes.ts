/**
 * Every reading mode, side by side, over a stand-in for the video.
 *
 * The reader is the one part of this extension that cannot be judged from its
 * markup: whether Highlighter reads as a highlight and whether Karaoke's fill
 * tracks the speaker are questions about pixels. This renders all six modes in
 * one page so a person can look at them together, and exposes the one thing a
 * person cannot reliably see — whether a word changes width when it becomes the
 * current one, which would make the whole line twitch once per word.
 */

import { ReaderOverlay } from "../content/overlay";
import { classify } from "../reader-core/words";
import {
  DEFAULTS,
  MODE_LABELS,
  type ReadingMode,
  type Settings,
} from "../settings";

declare global {
  interface Window {
    __ready?: boolean;
    /** Word widths in Highlighter, current and not. See `measureJump`. */
    __jump?: Array<{ text: string; asCurrent: number; asOther: number }>;
  }
}

const SENTENCE =
  "the exact position your brain uses to identify a whole word at once";
const WORDS = SENTENCE.split(" ").map(classify);

/** Enough either side that every mode has a full window to draw. */
const AT = 5;

function viewAt(index: number) {
  return {
    previous: WORDS.slice(Math.max(0, index - 3), index),
    current: WORDS[index],
    upcoming: WORDS.slice(index + 1, index + 4),
  };
}

/**
 * One mode in a box that stands in for the player.
 *
 * `ReaderOverlay` mounts itself inside `#movie_player` and positions against
 * it, so the panel has to be a positioned block of roughly video proportions or
 * the reader lands somewhere meaningless.
 */
function panel(caption: string, settings: Partial<Settings>): HTMLElement {
  const cell = document.createElement("section");
  cell.className = "cell";

  const title = document.createElement("h2");
  title.textContent = caption;
  cell.append(title);

  const player = document.createElement("div");
  player.className = "player";
  cell.append(player);

  const overlay = new ReaderOverlay({
    ...DEFAULTS,
    autoScale: false,
    fontSize: 24,
    boxWidth: 88,
    verticalPosition: 16,
    ...settings,
  });
  overlay.mount(player);
  overlay.render(viewAt(AT));

  return cell;
}

/**
 * The Custom theme, twice.
 *
 * Its five properties are assembled half in the stylesheet and half from
 * settings, which is the one palette that can be wrong in a way no unit test
 * sees: the test asserts that four custom properties are written, not that the
 * `[data-theme="custom"]` block picks them up. Two palettes, because a light
 * one and a dark one exercise the derived `--edge` in both directions.
 */
const CUSTOM_PANELS: Array<[string, Partial<Settings>]> = [
  [
    "Custom — cool dark, low opacity",
    {
      theme: "custom",
      customBackground: "#0f1b1a",
      customText: "#d7f0ea",
      customFaded: "#5c7a75",
      customAccent: "#3ddc97",
      backgroundOpacity: 0.55,
      contextOpacity: 0.5,
    },
  ],
  [
    "Custom — warm light, opaque",
    {
      theme: "custom",
      mode: "highlight",
      customBackground: "#f6efe4",
      customText: "#2a241c",
      customFaded: "#9c8f7c",
      customAccent: "#8c3f1d",
      backgroundOpacity: 0.95,
      contextOpacity: 0.65,
    },
  ],
];

/**
 * Does a word change size when it becomes the current one?
 *
 * The failure this catches: putting Highlighter's block on the current word
 * alone adds padding to one word and to no other, so every word after it slides
 * sideways each time the block advances. A line that jumps once per word is
 * worse than no highlight at all, and it is invisible in a static screenshot —
 * which is why it is measured rather than eyeballed.
 *
 * Rendered off to the side at two adjacent positions; a word that appears in
 * both windows must report the same width in each.
 */
function measureJump(): Window["__jump"] {
  const player = document.createElement("div");
  player.className = "player probe";
  document.body.append(player);

  const overlay = new ReaderOverlay({
    ...DEFAULTS,
    mode: "highlight",
    autoScale: false,
    fontSize: 24,
  });
  overlay.mount(player);

  const widths = (index: number): Map<string, number> => {
    overlay.render(viewAt(index));
    const out = new Map<string, number>();
    for (const span of player.querySelectorAll<HTMLElement>(".trf-lw")) {
      out.set(span.textContent ?? "", span.getBoundingClientRect().width);
    }
    return out;
  };

  const first = widths(AT);
  const second = widths(AT + 1);

  // The word that was current in the first window and merely past in the
  // second. Anything present in both is a valid comparison.
  const out: NonNullable<Window["__jump"]> = [];
  for (const [text, asCurrent] of first) {
    const asOther = second.get(text);
    if (asOther !== undefined) out.push({ text, asCurrent, asOther });
  }

  player.remove();
  return out;
}

async function main(): Promise<void> {
  const grid = document.createElement("div");
  grid.className = "grid";
  for (const mode of Object.keys(MODE_LABELS) as ReadingMode[]) {
    grid.append(panel(MODE_LABELS[mode], { mode }));
  }
  for (const [caption, settings] of CUSTOM_PANELS) {
    grid.append(panel(caption, settings));
  }
  document.body.append(grid);

  await document.fonts.ready;
  // Measured after the faces have loaded, or every width is the fallback's.
  window.__jump = measureJump();
  window.__ready = true;
}

void main();
