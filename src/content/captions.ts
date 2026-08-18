/**
 * Turning YouTube's caption payloads into a word timeline.
 *
 * This is the part most likely to need maintenance: YouTube's caption plumbing
 * is not a stable API, and the shape below is what it emits today rather than
 * anything documented. Every parser here fails soft, because a video whose
 * captions cannot be read should quietly do nothing rather than break the page.
 */

import { classify, isFiller, type Word } from "../reader-core/words";

export interface TimedWord {
  word: Word;
  /** Milliseconds into the video. */
  startMs: number;
  endMs: number;
}

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  isAsr: boolean;
  label: string;
}

/**
 * The video id a caption URL names, or null if it does not name one.
 *
 * Both the timedtext requests and the track `baseUrl`s carry `?v=`, which is the
 * only reliable way to tell an ad's captions from the video's. Timing cannot: an
 * ad and the video behind it play at the same page URL, and the player fetches
 * the *main* video's track during a pre-roll as well as the ad's.
 */
export function captionVideoId(url: string): string | null {
  try {
    return new URL(url, "https://www.youtube.com").searchParams.get("v");
  } catch {
    return null;
  }
}

/** Cues shorter than this are dropped: they are usually markup artefacts. */
const MIN_WORD_MS = 40;

/* ── json3 ──────────────────────────────────────────────────────────────── */

interface Json3Seg {
  utf8?: string;
  tOffsetMs?: number;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Seg[];
  /** Present on the rolling duplicates auto-captions emit. */
  aAppend?: number;
}

/**
 * Parse the `fmt=json3` payload.
 *
 * Auto-generated tracks carry a `tOffsetMs` per segment, and those segments are
 * per-word — which is exactly what RSVP wants, and better timing than the
 * desktop app can infer from a live decoder. Manually uploaded tracks usually
 * carry one segment per phrase, so those get interpolated across the cue by
 * character count. Both shapes are handled because both are common.
 */
export function parseJson3(body: string): TimedWord[] {
  let parsed: { events?: Json3Event[] };
  try {
    parsed = JSON.parse(body) as { events?: Json3Event[] };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.events)) return [];

  const words: TimedWord[] = [];

  for (const event of parsed.events) {
    // Auto-captions repeat the previous line as a rolling duplicate; taking
    // both would read every word twice.
    if (event.aAppend === 1) continue;
    if (!Array.isArray(event.segs)) continue;

    const eventStart = event.tStartMs ?? 0;
    const eventEnd = eventStart + (event.dDurationMs ?? 0);

    for (const seg of event.segs) {
      const text = (seg.utf8 ?? "").replace(/\s+/g, " ").trim();
      if (!text) continue;

      const segStart = eventStart + (seg.tOffsetMs ?? 0);
      const pieces = text.split(" ").filter(Boolean);

      if (pieces.length === 1) {
        words.push({
          word: classify(pieces[0]),
          startMs: segStart,
          endMs: eventEnd,
        });
        continue;
      }

      // A phrase in one segment: no per-word timing exists, so share the cue
      // out by character count. Longer words get proportionally longer, which
      // is closer to speech than splitting the time evenly.
      const total = pieces.reduce((sum, p) => sum + p.length, 0);
      const span = Math.max(eventEnd - segStart, pieces.length * MIN_WORD_MS);
      let cursor = segStart;
      for (const piece of pieces) {
        const share = (piece.length / total) * span;
        words.push({
          word: classify(piece),
          startMs: cursor,
          endMs: cursor + share,
        });
        cursor += share;
      }
    }
  }

  return tidy(words);
}

/* ── legacy XML (srv1/srv3) ─────────────────────────────────────────────── */

/**
 * Parse the XML caption format, used when `fmt=json3` is unavailable.
 *
 * Phrase-level only — there is no per-word timing here — so every cue is
 * interpolated.
 */
export function parseXml(body: string): TimedWord[] {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(body, "text/xml");
  } catch {
    return [];
  }
  if (doc.querySelector("parsererror")) return [];

  const words: TimedWord[] = [];
  for (const node of Array.from(doc.querySelectorAll("text"))) {
    const start = Number(node.getAttribute("start") ?? "0") * 1000;
    const duration = Number(node.getAttribute("dur") ?? "0") * 1000;
    // Caption text is HTML-escaped inside the XML node.
    const decoded = new DOMParser().parseFromString(
      node.textContent ?? "",
      "text/html",
    ).documentElement.textContent;
    const pieces = (decoded ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean);
    if (pieces.length === 0) continue;

    const total = pieces.reduce((sum, p) => sum + p.length, 0);
    const span = Math.max(duration, pieces.length * MIN_WORD_MS);
    let cursor = start;
    for (const piece of pieces) {
      const share = (piece.length / total) * span;
      words.push({
        word: classify(piece),
        startMs: cursor,
        endMs: cursor + share,
      });
      cursor += share;
    }
  }
  return tidy(words);
}

/** Pick the parser from the payload's own shape rather than the requested
 *  format — YouTube does not always return what was asked for. */
export function parseCaptions(body: string): TimedWord[] {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) return parseJson3(body);
  if (trimmed.startsWith("<")) return parseXml(body);
  return [];
}

/* ── shared cleanup ─────────────────────────────────────────────────────── */

/**
 * Sort, de-duplicate and close gaps.
 *
 * Auto-captions revise themselves as they go, so the same word can appear more
 * than once at slightly different times. Keeping both would stutter the reader.
 */
function tidy(words: TimedWord[]): TimedWord[] {
  const sorted = words
    .filter((w) => Number.isFinite(w.startMs) && w.word.text.length > 0)
    .sort((a, b) => a.startMs - b.startMs);

  const out: TimedWord[] = [];
  for (const candidate of sorted) {
    const previous = out[out.length - 1];
    // Same word at effectively the same moment: a revision, not a repetition.
    if (
      previous &&
      previous.word.text === candidate.word.text &&
      Math.abs(previous.startMs - candidate.startMs) < MIN_WORD_MS
    ) {
      continue;
    }
    // A word may not outlast the next one's start, or two would be current.
    if (previous && previous.endMs > candidate.startMs) {
      previous.endMs = candidate.startMs;
    }
    out.push(candidate);
  }

  return out.filter((w) => w.endMs - w.startMs >= 1);
}

/** Drop disfluencies. Applied after timing so the remaining words keep theirs. */
export function withoutFillers(words: TimedWord[]): TimedWord[] {
  return words.filter((w) => !isFiller(w.word.text));
}

/**
 * Choose which caption track to read.
 *
 * Preference order: the page's language, then English, then whatever exists.
 * Manual tracks beat auto-generated ones at the same language — they are
 * punctuated and spelled correctly, and the per-word timing auto tracks provide
 * is worth less than being right.
 */
export function pickTrack(
  tracks: CaptionTrack[],
  preferred: string,
): CaptionTrack | null {
  if (tracks.length === 0) return null;
  const base = (code: string) => code.split("-")[0]?.toLowerCase() ?? "";
  const want = base(preferred);

  const score = (track: CaptionTrack): number => {
    let value = 0;
    if (base(track.languageCode) === want) value += 4;
    else if (base(track.languageCode) === "en") value += 2;
    if (!track.isAsr) value += 1;
    return value;
  };

  return [...tracks].sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** Index of the word covering `timeMs`, or -1. Binary search, because this runs
 *  every animation frame and a scrub can jump anywhere in a long transcript. */
export function wordAt(words: TimedWord[], timeMs: number): number {
  let low = 0;
  let high = words.length - 1;
  let best = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (words[mid].startMs <= timeMs) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  // `best` is the last word that has started. It is current only if it has not
  // already ended — otherwise this is a gap between cues.
  if (best >= 0 && words[best].endMs < timeMs) return -1;
  return best;
}
