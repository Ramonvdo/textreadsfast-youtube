import { describe, expect, it } from "vitest";
import { buildLines, lineAt, MAX_LINE_WORDS } from "./lines";
import { classify } from "../reader-core/words";

const words = (text: string) => text.split(/\s+/).filter(Boolean).map(classify);
const texts = (line: { words: { text: string }[] }) =>
  line.words.map((w) => w.text).join(" ");

describe("buildLines", () => {
  it("ends a line at a sentence", () => {
    const lines = buildLines(words("One two three. Four five six."));
    expect(lines.map(texts)).toEqual(["One two three.", "Four five six."]);
  });

  /*
   * A transcript full of commas must not shred into a stutter of three-word
   * lines. That would move *more* than the sliding window this mode replaces,
   * which would defeat the entire point of it.
   */
  it("ignores a clause break while the line is still short", () => {
    // Four words, three of them ending a clause, and none taken: the line is
    // nowhere near long enough to be worth ending.
    const lines = buildLines(words("One, two, three, four."));
    expect(lines.map(texts)).toEqual(["One, two, three, four."]);
  });

  it("takes a clause break once the line is long enough", () => {
    const lines = buildLines(
      words("one two three four five six, seven eight nine ten."),
    );
    expect(lines.map(texts)).toEqual([
      "one two three four five six,",
      "seven eight nine ten.",
    ]);
  });

  /*
   * Auto-generated captions are frequently unpunctuated for dozens of words. A
   * rule that only broke on sentences would build one enormous line and clip
   * it, losing the end of every one.
   */
  it("breaks an unpunctuated run at the cap", () => {
    const lines = buildLines(words(Array(30).fill("word").join(" ")));
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.words.length).toBeLessThanOrEqual(MAX_LINE_WORDS);
    }
  });

  it("respects a caller's cap", () => {
    const lines = buildLines(words(Array(9).fill("word").join(" ")), 3);
    expect(lines.map((l) => l.words.length)).toEqual([3, 3, 3]);
  });

  // Dropping the tail would silently lose the end of every transcript that does
  // not happen to finish on a full stop.
  it("keeps a trailing run that never breaks", () => {
    const lines = buildLines(words("One two. three four five"));
    expect(lines.map(texts)).toEqual(["One two.", "three four five"]);
  });

  it("indexes back into the source timeline", () => {
    const source = words("One two three. Four five. Six.");
    const lines = buildLines(source);
    for (const line of lines) {
      expect(source.slice(line.startIndex, line.endIndex)).toEqual(line.words);
    }
    // Contiguous and complete: every word belongs to exactly one line.
    expect(lines[0].startIndex).toBe(0);
    expect(lines[lines.length - 1].endIndex).toBe(source.length);
    for (let i = 1; i < lines.length; i += 1) {
      expect(lines[i].startIndex).toBe(lines[i - 1].endIndex);
    }
  });

  it("returns nothing for an empty timeline", () => {
    expect(buildLines([])).toEqual([]);
  });
});

describe("lineAt", () => {
  const source = words(Array(100).fill("word").join(" "));
  const lines = buildLines(source);

  it("finds the line holding a word", () => {
    for (let i = 0; i < source.length; i += 1) {
      const line = lineAt(lines, i);
      expect(line).not.toBeNull();
      expect(i).toBeGreaterThanOrEqual(line!.startIndex);
      expect(i).toBeLessThan(line!.endIndex);
    }
  });

  it("says nothing for an index off either end", () => {
    expect(lineAt(lines, -1)).toBeNull();
    expect(lineAt(lines, source.length)).toBeNull();
    expect(lineAt([], 0)).toBeNull();
  });

  /*
   * Called once per video frame against a transcript that can be tens of
   * thousands of words. A linear scan here is a scan of the whole lecture,
   * sixty times a second.
   */
  it("does not scan linearly", () => {
    const huge = buildLines(words(Array(50_000).fill("word").join(" ")));
    const started = Date.now();
    for (let i = 0; i < 20_000; i += 1) lineAt(huge, i * 2);
    expect(Date.now() - started).toBeLessThan(300);
  });
});
