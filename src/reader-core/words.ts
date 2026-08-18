/**
 * Word classification, shared with the desktop app.
 *
 * Only the parts that both readers need. The desktop app's `StreamTokenizer`
 * does not travel: it exists to hold back sub-word fragments that a live
 * decoder commits mid-word, and captions arrive as whole phrases with no such
 * boundary to protect.
 */

/** Disfluencies removed when the user asks for it. Matched case-insensitively
 *  against the word with punctuation stripped. */
const FILLERS = new Set([
  "uh",
  "um",
  "uhm",
  "umm",
  "uhh",
  "erm",
  "ehm",
  "hmm",
  "mmm",
  "mhm",
  "ah",
  "er",
]);

const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
const CLAUSE_END = /[,;:—–]["'”’)\]]*$/;
const STRIP = /[^\p{L}\p{N}]/gu;

export interface Word {
  /** The text as displayed, punctuation included. */
  text: string;
  /** Ends a sentence — earns the longest pause. */
  endsSentence: boolean;
  /** Ends a clause — earns a shorter pause. */
  endsClause: boolean;
  /** Contains a digit; numbers take longer to read than their length suggests. */
  isNumeric: boolean;
}

export function classify(text: string): Word {
  return {
    text,
    endsSentence: SENTENCE_END.test(text),
    endsClause: CLAUSE_END.test(text),
    isNumeric: /\p{N}/u.test(text),
  };
}

export function isFiller(text: string): boolean {
  return FILLERS.has(text.replace(STRIP, "").toLowerCase());
}
