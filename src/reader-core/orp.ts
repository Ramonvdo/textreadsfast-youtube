/**
 * Optimal Recognition Point — the letter the eye should land on.
 *
 * Aligning this one letter at a fixed screen position for every word is what
 * removes saccades: the eye never has to re-centre, so reading stops being a
 * sequence of jumps and becomes a sequence of recognitions.
 */

/** Characters stripped from the front of a word before locating the pivot. */
const LEADING_PUNCTUATION = /^[¿¡"'“”‘’(\[{\-–—…]+/;
/** Characters that trail a word and should not shift its pivot. */
const TRAILING_PUNCTUATION = /[.,!?;:"'“”‘’)\]}\-–—…]+$/;

/**
 * Index of the pivot letter within `word`.
 *
 * The thresholds are Spritz's: the pivot sits slightly left of centre, and
 * creeps rightward as words lengthen but never past the fifth letter, because
 * beyond that the word's tail stops being resolvable in peripheral vision.
 *
 * Punctuation is excluded from the measurement but *included* in the returned
 * index, so the caller can slice the original string directly.
 */
export function orpIndex(word: string): number {
  if (!word) return 0;

  const leading = word.match(LEADING_PUNCTUATION)?.[0].length ?? 0;
  const core = word.slice(leading).replace(TRAILING_PUNCTUATION, "");
  const length = [...core].length;

  let pivot: number;
  if (length <= 1) pivot = 0;
  else if (length <= 5) pivot = 1;
  else if (length <= 9) pivot = 2;
  else if (length <= 13) pivot = 3;
  else pivot = 4;

  return Math.min(leading + pivot, Math.max(0, [...word].length - 1));
}

export interface SplitWord {
  /** Everything before the pivot letter. */
  before: string;
  /** The pivot letter itself — exactly one character (or "" for an empty word). */
  pivot: string;
  /** Everything after the pivot letter. */
  after: string;
}

/**
 * Split a word into the three runs the renderer colours independently.
 *
 * Uses `Array.from` rather than string indexing so astral characters (emoji,
 * some CJK) count as one character and never split a surrogate pair.
 */
export function splitAtOrp(word: string): SplitWord {
  const chars = [...word];
  if (chars.length === 0) return { before: "", pivot: "", after: "" };
  const i = orpIndex(word);
  return {
    before: chars.slice(0, i).join(""),
    pivot: chars[i] ?? "",
    after: chars.slice(i + 1).join(""),
  };
}
