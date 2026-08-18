import { describe, expect, it } from "vitest";
import {
  parseJson3,
  parseCaptions,
  pickTrack,
  wordAt,
  withoutFillers,
} from "./captions";
import type { CaptionTrack } from "./captions";

/** Auto-generated tracks: one segment per word, each with its own offset. */
const asr = JSON.stringify({
  events: [
    {
      tStartMs: 1000,
      dDurationMs: 2000,
      segs: [
        { utf8: "Hello", tOffsetMs: 0 },
        { utf8: " there", tOffsetMs: 400 },
        { utf8: " friend", tOffsetMs: 900 },
      ],
    },
  ],
});

/** Manually uploaded tracks: a whole phrase in one segment, no word timing. */
const manual = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 1200, segs: [{ utf8: "one two three" }] },
  ],
});

describe("json3 captions", () => {
  it("uses per-word offsets when the track provides them", () => {
    const words = parseJson3(asr);
    expect(words.map((w) => w.word.text)).toEqual(["Hello", "there", "friend"]);
    // Offsets are relative to the cue start, not absolute.
    expect(words[0].startMs).toBe(1000);
    expect(words[1].startMs).toBe(1400);
    expect(words[2].startMs).toBe(1900);
  });

  it("interpolates a phrase that has no per-word timing", () => {
    const words = parseJson3(manual);
    expect(words.map((w) => w.word.text)).toEqual(["one", "two", "three"]);
    expect(words[0].startMs).toBe(0);
    // Monotonic, inside the cue, and each word gets non-zero time.
    for (let i = 1; i < words.length; i += 1) {
      expect(words[i].startMs).toBeGreaterThan(words[i - 1].startMs);
      expect(words[i].endMs).toBeGreaterThan(words[i].startMs);
    }
    expect(words[words.length - 1].endMs).toBeLessThanOrEqual(1201);
  });

  it("drops the rolling duplicates auto-captions emit", () => {
    // `aAppend` events repeat the previous line as it scrolls; taking both
    // would read every word twice.
    const rolling = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 500, segs: [{ utf8: "first" }] },
        {
          tStartMs: 500,
          dDurationMs: 500,
          aAppend: 1,
          segs: [{ utf8: "first" }],
        },
        { tStartMs: 500, dDurationMs: 500, segs: [{ utf8: "second" }] },
      ],
    });
    expect(parseJson3(rolling).map((w) => w.word.text)).toEqual([
      "first",
      "second",
    ]);
  });

  it("never lets two words be current at the same moment", () => {
    // A cue that outlasts the next cue's start would otherwise overlap.
    const overlapping = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: "long" }] },
        { tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: "next" }] },
      ],
    });
    const words = parseJson3(overlapping);
    expect(words[0].endMs).toBeLessThanOrEqual(words[1].startMs);
  });

  it("treats an empty body as no captions", () => {
    // Verified against a live video: requesting a caption track without the
    // proof-of-origin token the player attaches returns HTTP 200 with an empty
    // body rather than an error, so the status code cannot be trusted.
    expect(parseCaptions("")).toEqual([]);
    expect(parseJson3("")).toEqual([]);
  });

  it("returns nothing rather than throwing on junk", () => {
    expect(parseJson3("not json")).toEqual([]);
    expect(parseJson3("{}")).toEqual([]);
    expect(parseJson3(JSON.stringify({ events: [{}] }))).toEqual([]);
  });

  it("ignores empty and whitespace-only segments", () => {
    const noisy = JSON.stringify({
      events: [
        {
          tStartMs: 0,
          dDurationMs: 900,
          segs: [{ utf8: "\n" }, { utf8: "real" }, { utf8: " " }],
        },
      ],
    });
    expect(parseJson3(noisy).map((w) => w.word.text)).toEqual(["real"]);
  });
});

describe("format detection", () => {
  it("picks the parser from the payload, not the requested format", () => {
    // YouTube does not always return the format that was asked for.
    expect(parseCaptions(asr).length).toBe(3);
    expect(parseCaptions("   \n<transcript></transcript>")).toEqual([]);
    expect(parseCaptions("")).toEqual([]);
  });
});

describe("choosing a track", () => {
  const track = (languageCode: string, isAsr: boolean): CaptionTrack => ({
    baseUrl: `https://x/${languageCode}${isAsr ? "-asr" : ""}`,
    languageCode,
    isAsr,
    label: languageCode,
  });

  it("prefers the requested language", () => {
    const chosen = pickTrack([track("de", false), track("nl", false)], "nl");
    expect(chosen?.languageCode).toBe("nl");
  });

  it("prefers a manual track over auto-generated at the same language", () => {
    // Auto tracks give better timing, but manual ones are punctuated and
    // spelled correctly, which matters more.
    const chosen = pickTrack([track("en", true), track("en", false)], "en");
    expect(chosen?.isAsr).toBe(false);
  });

  it("falls back to English, then to anything", () => {
    expect(
      pickTrack([track("ja", false), track("en", false)], "nl")?.languageCode,
    ).toBe("en");
    expect(pickTrack([track("ja", false)], "nl")?.languageCode).toBe("ja");
    expect(pickTrack([], "en")).toBeNull();
  });

  it("matches on the base language, ignoring the region", () => {
    expect(
      pickTrack([track("pt-BR", false), track("de", false)], "pt")
        ?.languageCode,
    ).toBe("pt-BR");
  });
});

describe("finding the current word", () => {
  const words = parseJson3(asr);

  it("returns the word covering the moment", () => {
    expect(words[wordAt(words, 1100)].word.text).toBe("Hello");
    expect(words[wordAt(words, 1500)].word.text).toBe("there");
    expect(words[wordAt(words, 2000)].word.text).toBe("friend");
  });

  it("reports a gap rather than the nearest word", () => {
    // Before the first cue, and after the last one ends.
    expect(wordAt(words, 0)).toBe(-1);
    expect(wordAt(words, 99_000)).toBe(-1);
    expect(wordAt([], 500)).toBe(-1);
  });

  it("lands correctly when seeking backwards", () => {
    // Scrubbing is why this is a binary search and not a forward cursor.
    expect(words[wordAt(words, 1900)].word.text).toBe("friend");
    expect(words[wordAt(words, 1000)].word.text).toBe("Hello");
  });
});

describe("filler removal", () => {
  it("drops disfluencies but keeps real words that contain them", () => {
    const source = JSON.stringify({
      events: [
        {
          tStartMs: 0,
          dDurationMs: 1000,
          segs: [
            { utf8: "so", tOffsetMs: 0 },
            { utf8: " um", tOffsetMs: 100 },
            { utf8: " hums", tOffsetMs: 200 },
            { utf8: " yes", tOffsetMs: 300 },
          ],
        },
      ],
    });
    expect(withoutFillers(parseJson3(source)).map((w) => w.word.text)).toEqual([
      "so",
      "hums",
      "yes",
    ]);
  });

  it("leaves the surviving words' timing untouched", () => {
    const words = parseJson3(asr);
    const filtered = withoutFillers(words);
    expect(filtered[0].startMs).toBe(words[0].startMs);
  });
});
