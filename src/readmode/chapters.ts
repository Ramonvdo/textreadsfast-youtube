/**
 * Pulling chapters out of YouTube's page data.
 *
 * Pure: no DOM, no `chrome.*`, no network — so every tier is unit-testable
 * against captured fixtures, the way `captions.ts` is.
 *
 * These object paths are undocumented and YouTube changes them, so this reads
 * like `captions.ts` for the same reason: four tiers tried in order, every level
 * optional-chained, and a shape nobody recognises produces `null` rather than an
 * exception. A video with no chapters is an ordinary answer, not a failure.
 */

import type { Chapter, ChapterSource } from "./model";

export interface ChapterResult {
  chapters: Chapter[];
  source: ChapterSource;
}

/* ── narrowing helpers ──────────────────────────────────────────────────── */

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function at(value: unknown, ...path: string[]): unknown {
  let node: unknown = value;
  for (const key of path) {
    if (!isObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

/** `{ simpleText }` or `{ runs: [{ text }] }` — YouTube uses both, everywhere. */
function readText(value: unknown): string {
  const simple = at(value, "simpleText");
  if (typeof simple === "string") return simple.trim();

  const runs = asArray(at(value, "runs"))
    .map((run) =>
      typeof at(run, "text") === "string" ? String(at(run, "text")) : "",
    )
    .join("");
  return runs.trim();
}

/** Chapters with no title or a negative start are not chapters. */
function clean(chapters: Chapter[]): Chapter[] {
  const seen = new Set<number>();
  return chapters
    .filter(
      (c) => c.title.length > 0 && Number.isFinite(c.startMs) && c.startMs >= 0,
    )
    .filter((c) => {
      if (seen.has(c.startMs)) return false;
      seen.add(c.startMs);
      return true;
    })
    .sort((a, b) => a.startMs - b.startMs);
}

/* ── tier 1: the player bar markers map ─────────────────────────────────── */

/**
 * The most reliable source, and the one the scrubber itself draws from.
 *
 * The doubled `decoratedPlayerBarRenderer` key is real, not a typo here.
 */
function markersMap(data: unknown): unknown[] {
  return asArray(
    at(
      data,
      "playerOverlays",
      "playerOverlayRenderer",
      "decoratedPlayerBarRenderer",
      "decoratedPlayerBarRenderer",
      "playerBar",
      "multiMarkersPlayerBarRenderer",
      "markersMap",
    ),
  );
}

function chaptersOfKey(data: unknown, key: string): Chapter[] {
  const entry = markersMap(data).find(
    (candidate) => at(candidate, "key") === key,
  );
  const raw = asArray(at(entry, "value", "chapters"));

  return clean(
    raw.map((item) => {
      const renderer = at(item, "chapterRenderer");
      const start = at(renderer, "timeRangeStartMillis");
      return {
        title: readText(at(renderer, "title")),
        // A number here, unlike almost everywhere else in this payload.
        startMs: typeof start === "number" ? start : Number(start),
      };
    }),
  );
}

export function chaptersFromMarkersMap(data: unknown): ChapterResult | null {
  const authored = chaptersOfKey(data, "DESCRIPTION_CHAPTERS");
  if (authored.length > 0) return { chapters: authored, source: "description" };

  const auto = chaptersOfKey(data, "AUTO_CHAPTERS");
  if (auto.length > 0) return { chapters: auto, source: "auto" };

  return null;
}

/**
 * Does this video have chapters at all?
 *
 * VERIFIED, and the reason this is not just a null check: on a video with no
 * chapters `decoratedPlayerBarRenderer` still exists, and
 * `multiMarkersPlayerBarRenderer` still exists carrying only `visibleOnLoad` and
 * `trackingParams`. There is simply no `markersMap` key. So the presence of the
 * renderer proves nothing — only a populated entry does.
 */
export function hasChapters(data: unknown): boolean {
  return markersMap(data).some((entry) => {
    const key = at(entry, "key");
    if (key !== "DESCRIPTION_CHAPTERS" && key !== "AUTO_CHAPTERS") return false;
    return asArray(at(entry, "value", "chapters")).length > 0;
  });
}

/* ── tier 2: the chapters engagement panel ──────────────────────────────── */

const PANEL_IDS: Record<string, ChapterSource> = {
  "engagement-panel-macro-markers-description-chapters": "description",
  "engagement-panel-macro-markers-auto-chapters": "auto",
};

export function chaptersFromPanel(data: unknown): ChapterResult | null {
  for (const panel of asArray(at(data, "engagementPanels"))) {
    const section = at(panel, "engagementPanelSectionListRenderer");
    const identifier = at(section, "panelIdentifier");
    if (typeof identifier !== "string") continue;

    const source = PANEL_IDS[identifier];
    if (!source) continue;

    const list = at(section, "content", "macroMarkersListRenderer");
    // A `continuationItemRenderer` instead means the panel is lazy and has not
    // loaded. That is the tier declining, NOT proof that there are no chapters.
    if (!isObject(list)) continue;

    const chapters = clean(
      asArray(at(list, "contents")).map((item) => {
        const renderer = at(item, "macroMarkersListItemRenderer");
        const seconds = at(
          renderer,
          "onTap",
          "watchEndpoint",
          "startTimeSeconds",
        );
        return {
          title: readText(at(renderer, "title")),
          // Integer seconds here. Never parse `timeDescription`, which is a
          // display string and localised.
          startMs:
            typeof seconds === "number"
              ? seconds * 1000
              : Number(seconds) * 1000,
        };
      }),
    );

    if (chapters.length > 0) return { chapters, source };
  }

  return null;
}

/* ── tier 3: timestamps in the description ──────────────────────────────── */

/**
 * YouTube's own rules for turning a description into chapters.
 *
 * Applied here too, because without them any description that merely mentions a
 * time would produce a bogus outline. Three entries minimum, the first at zero,
 * and nothing shorter than ten seconds.
 */
function validateDescriptionChapters(chapters: Chapter[]): Chapter[] {
  if (chapters.length < 3) return [];
  if (chapters[0].startMs !== 0) return [];

  for (let i = 1; i < chapters.length; i += 1) {
    if (chapters[i].startMs - chapters[i - 1].startMs < 10_000) return [];
  }
  return chapters;
}

function parseStamp(text: string): number | null {
  const match = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [, hours, minutes, seconds] = match;
  return (
    ((Number(hours ?? 0) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000
  );
}

/** The structured form, which carries real endpoints rather than guessed text. */
export function chaptersFromAttributedDescription(
  data: unknown,
): ChapterResult | null {
  const description = at(
    data,
    "contents",
    "twoColumnWatchNextResults",
    "results",
    "results",
  );

  let attributed: unknown;
  for (const item of asArray(at(description, "contents"))) {
    const candidate = at(
      item,
      "videoSecondaryInfoRenderer",
      "attributedDescription",
    );
    if (isObject(candidate)) {
      attributed = candidate;
      break;
    }
  }
  if (!attributed) return null;

  const content = at(attributed, "content");
  if (typeof content !== "string") return null;

  const chapters: Chapter[] = [];
  for (const run of asArray(at(attributed, "commandRuns"))) {
    const seconds = at(
      run,
      "onTap",
      "innertubeCommand",
      "watchEndpoint",
      "startTimeSeconds",
    );
    if (typeof seconds !== "number") continue;

    const startIndex = Number(at(run, "startIndex"));
    const length = Number(at(run, "length"));
    if (!Number.isFinite(startIndex) || !Number.isFinite(length)) continue;

    // The run covers the timestamp itself; the title is the rest of that line.
    const lineEnd = content.indexOf("\n", startIndex);
    const tail = content
      .slice(startIndex + length, lineEnd === -1 ? undefined : lineEnd)
      .replace(/^[\s–—:-]+/, "")
      .trim();

    if (tail) chapters.push({ title: tail, startMs: seconds * 1000 });
  }

  const valid = validateDescriptionChapters(clean(chapters));
  return valid.length > 0 ? { chapters: valid, source: "description" } : null;
}

/** The last resort: regex over plain description text. */
export function chaptersFromDescriptionText(
  text: string,
): ChapterResult | null {
  if (typeof text !== "string" || text.length === 0) return null;

  const chapters: Chapter[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s+(.+)$/.exec(line);
    if (!match) continue;
    const startMs = parseStamp(match[1]);
    if (startMs === null) continue;
    chapters.push({
      title: match[2].replace(/^[\s–—:-]+/, "").trim(),
      startMs,
    });
  }

  const valid = validateDescriptionChapters(clean(chapters));
  return valid.length > 0 ? { chapters: valid, source: "description" } : null;
}

/* ── the whole ladder ───────────────────────────────────────────────────── */

export function chaptersFrom(
  data: unknown,
  description?: string,
): ChapterResult | null {
  return (
    chaptersFromMarkersMap(data) ??
    chaptersFromPanel(data) ??
    chaptersFromAttributedDescription(data) ??
    (description ? chaptersFromDescriptionText(description) : null)
  );
}

/* ── the no-chapters fallback ───────────────────────────────────────────── */

export interface TranscriptLine {
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * Sections derived from the transcript, for videos with no chapters at all.
 *
 * Split at the longest silences, which is where a speaker most often changes
 * subject. The titles are the opening words of each section — honest about being
 * a summary of what is said there rather than an authored chapter name, which is
 * why the view labels this source differently.
 */
/**
 * Words a section title should never begin with.
 *
 * Speech opens with scaffolding — "so", "here are", "and I think" — and the
 * first seven words of a sentence are therefore usually the least informative
 * seven. Stripping these is what turns "Here are brutally honest truths" into
 * "Brutally honest truths".
 */
const LEADING_NOISE = new Set([
  "so",
  "and",
  "but",
  "or",
  "okay",
  "ok",
  "now",
  "well",
  "right",
  "um",
  "uh",
  "er",
  "ah",
  "oh",
  "yeah",
  "yes",
  "no",
  "like",
  "basically",
  "actually",
  "literally",
  "obviously",
  "honestly",
  "look",
  "listen",
  "see",
  "here",
  "there",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "we",
  "our",
  "us",
  "they",
  "their",
  "i",
  "my",
  "me",
  "you",
  "your",
  "he",
  "she",
  "is",
  "are",
  "was",
  "were",
  "am",
  "be",
  "been",
  "being",
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "get",
  "got",
  "going",
  "gonna",
  "wanna",
  "really",
  "just",
  "very",
  "kind",
  "sort",
  "know",
  "mean",
  "let",
  "lets",
  "if",
  "when",
  "what",
  "how",
  "why",
  "who",
  "all",
  "one",
  "two",
  "first",
  "then",
  "also",
  "again",
  "because",
  "as",
  "up",
  "out",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "can",
  "will",
  "would",
  "could",
  "should",
]);

/** Where a title should stop: everything after is a subordinate clause. */
const BOUNDARY = new Set([
  "that",
  "which",
  "who",
  "whom",
  "whose",
  "because",
  "so",
  "but",
  "and",
  "when",
  "if",
  "while",
  "where",
  "than",
  "as",
  "since",
  "though",
  "although",
  "unless",
  "until",
  "or",
]);

/**
 * Words not worth ending a title on.
 *
 * Written out rather than derived from `LEADING_NOISE`, because the two lists
 * disagree on particles: "up", "out" and "over" are noise at the start of a
 * sentence and load-bearing at the end of one — trimming them turns "takes
 * over" into "takes".
 */
const WEAK_TAIL = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "about",
  "from",
  "into",
  "by",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "am",
  "be",
  "been",
  "being",
  "that",
  "this",
  "these",
  "those",
  "it",
  "its",
  "my",
  "your",
  "our",
  "their",
  "his",
  "her",
  "not",
  "no",
  "more",
  "most",
  "some",
  "any",
  "every",
  "each",
  "other",
  "another",
  "very",
  "really",
  "just",
  "so",
  "as",
  "than",
  "then",
  "also",
  "kind",
  "sort",
  "like",
]);

const bare = (word: string): string =>
  word.toLowerCase().replace(/[^a-z0-9']/g, "");

/**
 * Multiword fillers, removed before anything else.
 *
 * Word-by-word stripping cannot catch these: it halts at the first word it does
 * not recognise, so "and I think you know parallel agents" stops on "think" and
 * keeps "you know" in the title. Taking the phrases out first leaves a clean
 * sentence for the remaining passes to work on.
 */
const FILLER_PHRASES =
  /\b(?:you know|i mean|i think|i guess|i would say|to be honest|if that makes sense|at the end of the day|sort of|kind of|like i said|or whatever|and stuff|things like that)\b/gi;

/**
 * A readable title for a stretch of speech.
 *
 * Heuristic, and only ever used where the alternative is a raw sentence
 * fragment: a video with real chapters never reaches this. Three passes — drop
 * the opening scaffolding, stop at the first clause boundary, trim a weak
 * ending — which is enough to turn most spoken openings into a noun phrase.
 */
export function sectionLabel(text: string): string {
  const cleaned = text.replace(FILLER_PHRASES, " ").replace(/\s+/g, " ").trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";

  let start = 0;
  while (start < words.length && LEADING_NOISE.has(bare(words[start])))
    start += 1;

  // Everything was scaffolding: fall back rather than returning nothing.
  if (start >= words.length) start = 0;

  const kept: string[] = [];
  for (let i = start; i < words.length && kept.length < 6; i += 1) {
    const word = words[i];
    // A clause boundary ends the title, but never before it has any content.
    if (kept.length > 0 && BOUNDARY.has(bare(word))) break;
    kept.push(word);
    // Punctuation inside the word ends it too: the sentence moved on.
    if (/[,;:.?!]/.test(word)) break;
  }

  while (kept.length > 1 && WEAK_TAIL.has(bare(kept[kept.length - 1])))
    kept.pop();

  const title = kept
    .join(" ")
    .replace(/[\s,;:.?!]+$/, "")
    .trim();

  // Too little survived to mean anything; the raw opening is more use.
  if (title.split(/\s+/).filter(Boolean).length < 2) {
    const fallback = words
      .slice(0, 5)
      .join(" ")
      .replace(/[\s,;:.?!]+$/, "");
    return capitalise(fallback);
  }

  return capitalise(title);
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

/**
 * Sections derived from the transcript, for videos with no chapters at all.
 *
 * Split at the longest silences, which is where a speaker most often changes
 * subject — but never closer together than `minGap`. Without that rule a breath
 * in the middle of a sentence becomes a chapter, and the outline ends up with
 * entries three seconds apart, which is a pause rather than a section.
 */
export function chaptersFromTranscript(
  lines: TranscriptLine[],
  durationMs: number,
  max = 12,
): Chapter[] {
  if (lines.length === 0) return [];

  const minGap = Math.max(45_000, durationMs > 0 ? durationMs / 25 : 0);

  const candidates = lines
    .slice(1)
    .map((line, index) => ({
      index: index + 1,
      startMs: line.startMs,
      gap: line.startMs - lines[index].endMs,
    }))
    .filter((entry) => entry.gap > 400)
    .sort((a, b) => b.gap - a.gap);

  // Greedy over the longest silences, skipping any that fall too close to a
  // boundary already taken. Longest-first means the strongest breaks win the
  // space rather than whichever happened to come earliest.
  const taken: Array<{ index: number; startMs: number }> = [
    { index: 0, startMs: lines[0].startMs },
  ];

  for (const entry of candidates) {
    if (taken.length >= max) break;
    if (taken.some((t) => Math.abs(entry.startMs - t.startMs) < minGap))
      continue;
    taken.push({ index: entry.index, startMs: entry.startMs });
  }

  const boundaries = taken.map((t) => t.index).sort((a, b) => a - b);
  const chapters: Chapter[] = [];

  for (let i = 0; i < boundaries.length; i += 1) {
    const from = boundaries[i];
    const to = i + 1 < boundaries.length ? boundaries[i + 1] : lines.length;
    const text = lines
      .slice(from, to)
      .map((line) => line.text)
      .join(" ");

    const title = sectionLabel(text);
    if (title) chapters.push({ title, startMs: lines[from].startMs });
  }

  // A single section is not an outline; better to show none and say so.
  if (chapters.length < 2) return [];
  return clean(chapters);
}

/* ── video metadata ─────────────────────────────────────────────────────── */

export interface VideoMeta {
  title: string;
  channel: string;
  durationMs: number;
}

export function videoMetaFrom(playerResponse: unknown): VideoMeta | null {
  const details = at(playerResponse, "videoDetails");
  if (!isObject(details)) return null;

  const title = typeof details.title === "string" ? details.title : "";
  const channel = typeof details.author === "string" ? details.author : "";
  // A string here, unlike the millisecond fields elsewhere in this payload.
  const seconds = Number(details.lengthSeconds);

  if (!title && !channel && !Number.isFinite(seconds)) return null;

  return {
    title,
    channel,
    durationMs: Number.isFinite(seconds) ? seconds * 1000 : 0,
  };
}
