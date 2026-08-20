/**
 * The Chrome Web Store listing cards.
 *
 * Four annotated 1280x800 images: what the reading modes are, what the caption
 * styles look like, what Read Mode does, and what the library records.
 *
 * The caption samples are drawn by the real `ReaderOverlay` rather than by
 * hand-written markup that imitates it. A listing image is the one picture most
 * people ever see of the product, and an imitation drifts the moment the reader
 * changes — this cannot, because it *is* the reader.
 *
 * Rendered by `scripts/store-cards.py`, which screenshots each at exactly the
 * size the store demands.
 */

import { ReaderOverlay } from "../content/overlay";
import { buildLines, readsWholeLine } from "../content/lines";
import { classify } from "../reader-core/words";
import { BUILT_IN_PROFILES } from "../profiles";
import { DEFAULTS, type Settings } from "../settings";

declare global {
  interface Window {
    __ready?: boolean;
  }
}

const SENTENCE =
  "the exact position your brain uses to identify a whole word at once";
const WORDS = SENTENCE.split(" ").map(classify);
const AT = 5;

function viewFor(settings: Settings) {
  if (readsWholeLine(settings)) {
    const line = buildLines(WORDS, settings.lineWords)[0];
    return {
      key: "line:0",
      current: line.words[0],
      previous: [],
      upcoming: line.words.slice(1),
    };
  }
  return {
    current: WORDS[AT],
    previous: WORDS.slice(Math.max(0, AT - settings.contextBefore), AT),
    upcoming: WORDS.slice(AT + 1, AT + 1 + settings.contextAfter),
  };
}

function profile(id: string): Partial<Settings> {
  const found = BUILT_IN_PROFILES.find((p) => p.id === id);
  if (!found) throw new Error(`no built-in profile "${id}"`);
  return found.settings;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function header(title: string, sub: string): HTMLElement {
  const head = el("header");
  head.append(el("h1", undefined, title), el("p", undefined, sub));
  return head;
}

/** One labelled caption sample over the stand-in player. */
function strip(
  name: string,
  note: string,
  patch: Partial<Settings>,
): HTMLElement {
  const row = el("section", "strip");

  const label = el("div", "label");
  label.append(el("strong", undefined, name), el("span", undefined, note));
  row.append(label);

  const player = el("div", "player");
  row.append(player);

  const settings: Settings = {
    ...DEFAULTS,
    autoScale: false,
    ...patch,
  };
  const overlay = new ReaderOverlay(settings);
  overlay.mount(player);
  overlay.render(viewFor(settings));

  return row;
}

/** A finished screenshot with a caption under it. */
function plate(src: string, note: string): HTMLElement {
  const wrap = el("section", "plate");
  const img = document.createElement("img");
  img.src = src;
  wrap.append(img, el("p", undefined, note));
  return wrap;
}

/**
 * A promo tile: the mechanism, at a glance.
 *
 * One word with its pivot letter picked out and the focal marks bracketing it,
 * because that column is the entire idea and a tile has no room to explain it
 * in words. The reader draws it, so what a shopper sees on the tile is exactly
 * what they get.
 */
function promo(size: "tile" | "marquee"): HTMLElement[] {
  const wrap = el("section", `promo promo--${size}`);

  const player = el("div", "promo-player");
  wrap.append(player);

  const overlay = new ReaderOverlay({
    ...DEFAULTS,
    mode: "rsvp",
    autoScale: false,
    fontSize: size === "marquee" ? 62 : 30,
    boxWidth: 92,
    // Anchored to the bottom of a box sized to the card itself, so the tile has
    // no dead space between the reader and the wordmark under it.
    verticalPosition: 0,
    contextBefore: 1,
    contextAfter: 1,
    // Bright enough that the neighbours are legible, dim enough that the
    // pinned word is unmistakably the one being read.
    contextOpacity: 0.36,
    showPivotGuides: true,
  });
  overlay.mount(player);
  overlay.render({
    current: WORDS[AT],
    previous: [WORDS[AT - 1]],
    upcoming: [WORDS[AT + 1]],
  });

  const words = el("div", "promo-words");
  words.append(
    el("strong", undefined, "TextReadsFast"),
    el("span", undefined, "One word at a time, pinned — so 2x actually works"),
  );
  wrap.append(words);

  return [wrap];
}

const CARDS: Record<string, () => HTMLElement[]> = {
  tile: () => promo("tile"),
  marquee: () => promo("marquee"),

  modes: () => [
    header(
      "Six ways to read the same words",
      "Your eyes stop moving. The words move instead — or hold still, if that suits you better.",
    ),
    ...(
      [
        [
          "RSVP",
          "One word, pinned. The red letter never moves.",
          { mode: "rsvp" },
        ],
        [
          "RSVP + Bionic",
          "The same, with the words either side bolded so you can read ahead.",
          { mode: "rsvp-bionic" },
        ],
        [
          "Bionic",
          "A whole line, leading letters emboldened.",
          { mode: "bionic" },
        ],
        [
          "Highlighter",
          "A block behind the word being spoken.",
          { mode: "highlight" },
        ],
        [
          "Plain",
          "A caption line with nothing marked at all.",
          { mode: "plain" },
        ],
        [
          "Focus line",
          "One word, plainly centred. No coloured letter.",
          { mode: "focusline" },
        ],
      ] as Array<[string, string, Partial<Settings>]>
    ).map(([name, note, patch]) =>
      strip(name, note, {
        fontSize: 22,
        boxWidth: 88,
        contextBefore: 2,
        contextAfter: 3,
        // Brighter than the shipped default. At 0.34 the surrounding words all
        // but vanish in a still image, which hides the very thing these rows
        // exist to show: one word lit, its neighbours receding.
        contextOpacity: 0.55,
        ...patch,
      }),
    ),
  ],

  styles: () => [
    header(
      "Nine profiles, ten palettes, or build your own",
      "Switch the whole look mid-video from the toolbar. Slant, weight, case and outline compose on top of any of them.",
    ),
    ...(
      [
        ["Default", "One word at a fixed point, dark.", "default"],
        [
          "Serif Static",
          "Black on white, held still. Reads like print.",
          "serif-static",
        ],
        ["Black Box", "White on solid black, a line at a time.", "black-box"],
        ["Lyric", "Gold italic on a dark band, low in the frame.", "lyric"],
        ["Obsidian", "A violet block on lilac, over near-black.", "obsidian"],
      ] as Array<[string, string, string]>
    ).map(([name, note, id]) =>
      strip(name, note, {
        ...profile(id),
        autoScale: false,
        fontSize: 21,
        boxWidth: 88,
      }),
    ),
  ],

  readmode: () => [
    header(
      "Read Mode — study the video, don't just watch it",
      "Chapters named from the transcript, an AI summary, and timestamped notes that jump you back to the moment.",
    ),
    plate(
      "/src/dev/cardstock/readmode.jpg",
      "Chapters are taken from YouTube when the video has them, and generated from the transcript when it does not. The assistant summarises what was said and answers questions about it. Notes keep the timestamp they were written at; one click seeks there. Export the lot to a single Markdown file.",
    ),
  ],

  library: () => [
    header(
      "Every session saved. All of it on your device.",
      "Watch time, how much of the timeline you actually covered, and how often you came back.",
    ),
    plate(
      "/src/dev/cardstock/library.jpg",
      "The library keeps each video you studied with its summary, notes and questions — searchable, exportable, and never sent anywhere. Tracking is a single setting, and turning it off stops the recording rather than merely hiding it.",
    ),
  ],
};

async function main(): Promise<void> {
  const which =
    new URLSearchParams(window.location.search).get("card") ?? "modes";
  const build = CARDS[which];
  if (!build) throw new Error(`no card "${which}"`);

  const root = el("main", which);
  for (const node of build()) root.append(node);
  document.body.append(root);

  await document.fonts.ready;
  // Screenshots must not catch a half-decoded backdrop.
  await Promise.all(
    Array.from(document.images).map((img) =>
      img.complete ? Promise.resolve() : img.decode().catch(() => undefined),
    ),
  );
  window.__ready = true;
}

void main();
