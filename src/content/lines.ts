/**
 * Grouping the word timeline into lines that hold still.
 *
 * Every other mode slides: the window advances one word per word, so something
 * on screen moves roughly three hundred times a minute. Static mode does the
 * opposite — it shows a whole line, holds it completely still, and swaps once
 * at a boundary. That is what an ordinary subtitle does, and it is the calmest
 * the reader can be.
 *
 * The lines have to be built here because YouTube's own cue boundaries do not
 * survive parsing: `parseCaptions` flattens everything into one flat timeline
 * of words, which is exactly what the sliding modes want and exactly what this
 * one does not. What survives is `endsSentence` / `endsClause` on each word, so
 * the breaks are rebuilt from the punctuation instead.
 *
 * Pure and separate from the render loop so the break rules can be tested
 * directly. A bad break is the only way this mode can look wrong, and it is not
 * something a screenshot of one moment would show.
 */

import type { Word } from "../reader-core/words";

export interface Line {
  words: Word[];
  /** Index of this line's first word in the source timeline. */
  startIndex: number;
  /** One past its last word, so `slice(startIndex, endIndex)` is the line. */
  endIndex: number;
}

/**
 * Longest a line may get before it is broken regardless of punctuation.
 *
 * Transcripts of speech are not reliably punctuated — auto-generated ones often
 * run for dozens of words without a full stop — so a rule that only broke on
 * sentences would produce a paragraph and clip it. This is the backstop.
 */
export const MAX_LINE_WORDS = 12;

/**
 * Shortest a line may get by choosing to break at a clause.
 *
 * Without a floor, a transcript full of commas turns into a stutter of
 * three-word lines, which moves more than the sliding window it replaced.
 */
const MIN_CLAUSE_WORDS = 6;

/**
 * Break the timeline into lines.
 *
 * Sentences end a line outright. A clause ends one only once the line is long
 * enough to be worth ending, which keeps commas from shredding it. Anything
 * still running at `maxWords` is broken there.
 */
export function buildLines(
  words: Word[],
  maxWords: number = MAX_LINE_WORDS,
): Line[] {
  const cap = Math.max(1, Math.floor(maxWords));
  const lines: Line[] = [];
  let start = 0;

  for (let i = 0; i < words.length; i += 1) {
    const length = i - start + 1;
    const word = words[i];
    const shouldBreak =
      word.endsSentence ||
      (word.endsClause && length >= MIN_CLAUSE_WORDS) ||
      length >= cap;

    if (shouldBreak) {
      lines.push({
        words: words.slice(start, i + 1),
        startIndex: start,
        endIndex: i + 1,
      });
      start = i + 1;
    }
  }

  // Whatever is left over is still a line; dropping it would silently lose the
  // end of every transcript that does not finish on a full stop.
  if (start < words.length) {
    lines.push({
      words: words.slice(start),
      startIndex: start,
      endIndex: words.length,
    });
  }

  return lines;
}

/**
 * The line containing a word, by binary search.
 *
 * Called once per video frame, against a transcript that can be tens of
 * thousands of words. A linear scan here is a scan of the whole lecture, sixty
 * times a second.
 */
export function lineAt(lines: Line[], wordIndex: number): Line | null {
  let low = 0;
  let high = lines.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const line = lines[mid];
    if (wordIndex < line.startIndex) high = mid - 1;
    else if (wordIndex >= line.endIndex) low = mid + 1;
    else return line;
  }

  return null;
}
