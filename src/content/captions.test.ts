// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  captionVideoId,
  parseJson3,
  parseXml,
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
const manual = (text = "one two three") =>
  JSON.stringify({
    events: [{ tStartMs: 0, dDurationMs: 1200, segs: [{ utf8: text }] }],
  });

describe("json3 captions", () => {
  it("does not give a speaker-change marker any of the word's time", () => {
    const words = parseJson3(
      JSON.stringify({
        events: [
          {
            tStartMs: 629440,
            dDurationMs: 4320,
            segs: [
              { utf8: ">> শ্বেতকালি" },
              { utf8: " শ্বেতকালি", tOffsetMs: 800 },
            ],
          },
        ],
      }),
    );
    expect(words.map((w) => w.word.text)).toEqual(["শ্বেতকালি", "শ্বেতকালি"]);
    expect(words.map((w) => w.startMs)).toEqual([629440, 630240]);
  });

  it("uses per-word offsets when the track provides them", () => {
    const words = parseJson3(asr);
    expect(words.map((w) => w.word.text)).toEqual(["Hello", "there", "friend"]);
    // Offsets are relative to the cue start, not absolute.
    expect(words[0].startMs).toBe(1000);
    expect(words[1].startMs).toBe(1400);
    expect(words[2].startMs).toBe(1900);
  });

  it("interpolates a phrase that has no per-word timing", () => {
    const words = parseJson3(manual());
    expect(words.map((w) => w.word.text)).toEqual(["one", "two", "three"]);
    expect(words[0].startMs).toBe(0);
    // Monotonic, inside the cue, and each word gets non-zero time.
    for (let i = 1; i < words.length; i += 1) {
      expect(words[i].startMs).toBeGreaterThan(words[i - 1].startMs);
      expect(words[i].endMs).toBeGreaterThan(words[i].startMs);
    }
    expect(words[words.length - 1].endMs).toBeLessThanOrEqual(1201);
  });

  it.each([undefined, 0])(
    "joins formatting fragments with offset %s before sharing cue time",
    (tOffsetMs) => {
      const fragmented = JSON.stringify({
        events: [
          {
            tStartMs: 1000,
            dDurationMs: 1200,
            segs: [
              { utf8: "one t", tOffsetMs },
              { utf8: "wo three", tOffsetMs },
              { utf8: "\n", tOffsetMs: 100 },
            ],
          },
        ],
      });
      const words = parseJson3(fragmented);
      expect(words.map((w) => w.word.text)).toEqual(["one", "two", "three"]);
      expect(words.map((w) => w.startMs)).toEqual([
        1000,
        1000 + (3 / 11) * 1200,
        1000 + (6 / 11) * 1200,
      ]);
      expect(words[2].endMs).toBeCloseTo(2200);
    },
  );

  it("does not stretch a short cue into the next cue", () => {
    const short = JSON.stringify({
      events: [
        {
          tStartMs: 1000,
          dDurationMs: 40,
          segs: [{ utf8: "one two three four" }],
        },
        { tStartMs: 1040, dDurationMs: 1000, segs: [{ utf8: "next" }] },
      ],
    });
    const words = parseJson3(short);
    expect(words.map((w) => w.word.text)).toEqual([
      "one",
      "two",
      "three",
      "four",
      "next",
    ]);
    expect(words[0].startMs).toBe(1000);
    expect(words[3].endMs).toBeCloseTo(1040);
    expect(words[4].startMs).toBe(1040);
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

  it.each([
    ["我喜欢中文。", ["我", "喜欢", "中文。"]],
    ["我喜歡中文。", ["我", "喜歡", "中文。"]],
    ["“你好，世界。”", ["“你好，", "世界。”"]],
    ["我喜欢 TextReadsFast。", ["我", "喜欢", "TextReadsFast。"]],
    ["  Don't\nre-split\twords!  ", ["Don't", "re-split", "words!"]],
    ["मैं हिन्दी सीखता हूँ।", ["मैं", "हिन्दी", "सीखता", "हूँ।"]],
    ["আমি বাংলা শিখি।", ["আমি", "বাংলা", "শিখি।"]],
  ])("splits caption words: %s", (text, expected) => {
    expect(parseJson3(manual(text)).map((w) => w.word.text)).toEqual(expected);
  });

  it.each([80, 1000])(
    "fits a Chinese phrase before the next segment at %ims",
    (nextOffset) => {
      const timed = JSON.stringify({
        events: [
          {
            tStartMs: 1000,
            dDurationMs: 2000,
            segs: [
              { utf8: "我喜欢中文", tOffsetMs: 0 },
              { utf8: "\n", tOffsetMs: 40 },
              { utf8: " " },
              { utf8: "然后学习", tOffsetMs: nextOffset },
            ],
          },
        ],
      });
      const words = parseJson3(timed);
      expect(words.map((w) => w.word.text)).toEqual([
        "我",
        "喜欢",
        "中文",
        "然后",
        "学习",
      ]);
      expect(words[0].startMs).toBe(1000);
      expect(words[2].endMs).toBeCloseTo(1000 + nextOffset);
      expect(words[3].startMs).toBe(1000 + nextOffset);
      expect(words[4].endMs).toBeCloseTo(3000);
    },
  );
});

describe("XML captions", () => {
  it("segments Chinese after decoding entities and normalising whitespace", () => {
    const words = parseXml(
      '<transcript><text start="1" dur="1.2">  &amp;quot;我\n喜欢\t中文。&amp;quot;  </text></transcript>',
    );
    expect(words.map((w) => w.word.text)).toEqual(['"我', "喜欢", '中文。"']);
    expect(words.map((w) => w.startMs)).toEqual([1000, 1300, 1600]);
    expect(words[2].endMs).toBe(2200);
  });

  it("keeps short phrases inside their stated cue duration", () => {
    const words = parseXml(
      '<transcript><text start="1" dur="0.04">one two three four</text><text start="1.04" dur="1">next</text></transcript>',
    );
    expect(words.map((w) => w.word.text)).toEqual([
      "one",
      "two",
      "three",
      "four",
      "next",
    ]);
    expect(words[0].startMs).toBe(1000);
    expect(words[3].endMs).toBeCloseTo(1040);
    expect(words[4].startMs).toBe(1040);
  });
});

describe("Indic captions", () => {
  it.each(["यह ठीक है । अब चलो ॥", "আমি ভালো আছি । তুমি এসো ॥"])(
    "keeps danda with its word and ends the sentence: %s",
    (text) => {
      const json = parseJson3(manual(text));
      const xml = parseXml(
        `<transcript><text start="0" dur="1.2">${text}</text></transcript>`,
      );
      expect(xml).toEqual(json);
      expect(json).toHaveLength(5);
      expect(json.map((w) => w.word.endsSentence)).toEqual([
        false,
        false,
        true,
        false,
        true,
      ]);
      expect(json[2].word.text.endsWith("।")).toBe(true);
      expect(json[4].word.text.endsWith("॥")).toBe(true);
    },
  );
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

  it.each(["hi-IN", "bn-BD"])(
    "selects the preferred Indic track: %s",
    (code) => {
      const chosen = pickTrack(
        [track("en", false), track(code, true)],
        code.slice(0, 2),
      );
      expect(chosen?.languageCode).toBe(code);
    },
  );
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

describe("captionVideoId", () => {
  // This is what separates an ad's captions from the video's. Nothing else can:
  // they play at the same page URL, so timing says nothing about ownership.
  it("reads the id from a timedtext request", () => {
    expect(
      captionVideoId(
        "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&fmt=json3",
      ),
    ).toBe("dQw4w9WgXcQ");
  });

  it("reads the id from a track baseUrl", () => {
    expect(
      captionVideoId("/api/timedtext?caps=asr&v=abc123XYZ_-&kind=asr&lang=en"),
    ).toBe("abc123XYZ_-");
  });

  it("returns null rather than guessing when there is no id", () => {
    expect(
      captionVideoId("https://www.youtube.com/api/timedtext?lang=en"),
    ).toBeNull();
    expect(captionVideoId("not a url at all")).toBeNull();
    expect(captionVideoId("")).toBeNull();
  });
});
