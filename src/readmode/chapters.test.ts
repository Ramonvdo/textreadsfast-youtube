import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  watchDataVideoId,
  parseAiChapters,
  transcriptForChapters,
  sectionLabel,
  chaptersFrom,
  chaptersFromAttributedDescription,
  chaptersFromDescriptionText,
  chaptersFromMarkersMap,
  chaptersFromPanel,
  chaptersFromTranscript,
  hasChapters,
  videoMetaFrom,
} from "./chapters";

/** The tier-1 shape, as it actually appears — including the doubled key. */
function withMarkers(
  entries: Array<{ key: string; chapters: Array<[string, number]> }>,
) {
  return {
    playerOverlays: {
      playerOverlayRenderer: {
        decoratedPlayerBarRenderer: {
          decoratedPlayerBarRenderer: {
            playerBar: {
              multiMarkersPlayerBarRenderer: {
                visibleOnLoad: { key: "yes" },
                markersMap: entries.map((entry) => ({
                  key: entry.key,
                  value: {
                    chapters: entry.chapters.map(([title, startMs]) => ({
                      chapterRenderer: {
                        title: { simpleText: title },
                        timeRangeStartMillis: startMs,
                      },
                    })),
                  },
                })),
              },
            },
          },
        },
      },
    },
  };
}

/**
 * VERIFIED against a real chapterless video: the renderer is present, and only
 * `markersMap` is absent. This is why `hasChapters` cannot be a null check on
 * the renderer.
 */
const noChapters = {
  playerOverlays: {
    playerOverlayRenderer: {
      decoratedPlayerBarRenderer: {
        decoratedPlayerBarRenderer: {
          playerBar: {
            multiMarkersPlayerBarRenderer: {
              visibleOnLoad: { key: "yes" },
              trackingParams: "abc",
            },
          },
        },
      },
    },
  },
};

describe("tier 1 — the player bar markers map", () => {
  it("reads author-written chapters", () => {
    const result = chaptersFromMarkersMap(
      withMarkers([
        {
          key: "DESCRIPTION_CHAPTERS",
          chapters: [
            ["Intro", 0],
            ["Middle", 74_000],
          ],
        },
      ]),
    );
    expect(result).toEqual({
      chapters: [
        { title: "Intro", startMs: 0 },
        { title: "Middle", startMs: 74_000 },
      ],
      source: "description",
    });
  });

  it("prefers author chapters over auto ones when both exist", () => {
    const result = chaptersFromMarkersMap(
      withMarkers([
        {
          key: "AUTO_CHAPTERS",
          chapters: [
            ["Robot", 0],
            ["Robot two", 30_000],
          ],
        },
        {
          key: "DESCRIPTION_CHAPTERS",
          chapters: [
            ["Human", 0],
            ["Human two", 30_000],
          ],
        },
      ]),
    );
    expect(result?.source).toBe("description");
    expect(result?.chapters[0].title).toBe("Human");
  });

  it("falls back to auto chapters", () => {
    const result = chaptersFromMarkersMap(
      withMarkers([
        {
          key: "AUTO_CHAPTERS",
          chapters: [
            ["A", 0],
            ["B", 1000],
          ],
        },
      ]),
    );
    expect(result?.source).toBe("auto");
  });

  // These share the same markersMap and would otherwise be read as chapters.
  it("ignores heatmap and quiz markers", () => {
    const result = chaptersFromMarkersMap(
      withMarkers([
        { key: "ANIMATION_ANNOTATION_MARKERS", chapters: [["heat", 0]] },
        { key: "QUIZ_MARKERS", chapters: [["quiz", 5000]] },
      ]),
    );
    expect(result).toBeNull();
  });

  it("sorts and de-duplicates", () => {
    const result = chaptersFromMarkersMap(
      withMarkers([
        {
          key: "DESCRIPTION_CHAPTERS",
          chapters: [
            ["Later", 60_000],
            ["First", 0],
            ["Duplicate", 0],
          ],
        },
      ]),
    );
    expect(result?.chapters.map((c) => c.title)).toEqual(["First", "Later"]);
  });
});

describe("hasChapters", () => {
  it("is false when the renderer exists but carries no markersMap", () => {
    expect(hasChapters(noChapters)).toBe(false);
  });

  it("is false for an empty chapter array", () => {
    expect(
      hasChapters(withMarkers([{ key: "DESCRIPTION_CHAPTERS", chapters: [] }])),
    ).toBe(false);
  });

  it("is true only for a populated entry", () => {
    expect(
      hasChapters(
        withMarkers([{ key: "AUTO_CHAPTERS", chapters: [["A", 0]] }]),
      ),
    ).toBe(true);
  });

  it("survives nonsense without throwing", () => {
    for (const value of [
      null,
      undefined,
      42,
      "text",
      {},
      [],
      { playerOverlays: 1 },
    ]) {
      expect(hasChapters(value)).toBe(false);
    }
  });
});

describe("tier 2 — the engagement panel", () => {
  const panel = (content: unknown) => ({
    engagementPanels: [
      {
        engagementPanelSectionListRenderer: {
          panelIdentifier:
            "engagement-panel-macro-markers-description-chapters",
          content,
        },
      },
    ],
  });

  it("uses startTimeSeconds, not the display string", () => {
    const result = chaptersFromPanel(
      panel({
        macroMarkersListRenderer: {
          contents: [
            {
              macroMarkersListItemRenderer: {
                title: { simpleText: "Opening" },
                timeDescription: { simpleText: "0:00" },
                onTap: { watchEndpoint: { startTimeSeconds: 0 } },
              },
            },
            {
              macroMarkersListItemRenderer: {
                title: { simpleText: "Later" },
                // A localised display string that must NOT be parsed.
                timeDescription: { simpleText: "1:07" },
                onTap: { watchEndpoint: { startTimeSeconds: 67 } },
              },
            },
          ],
        },
      }),
    );
    expect(result?.chapters).toEqual([
      { title: "Opening", startMs: 0 },
      { title: "Later", startMs: 67_000 },
    ]);
  });

  // The crucial distinction: a lazy panel has declined, it has not answered "no".
  it("declines rather than reporting no chapters when the panel is lazy", () => {
    const result = chaptersFromPanel(
      panel({
        continuationItemRenderer: {
          trigger: "CONTINUATION_TRIGGER_ON_ITEM_SHOWN",
        },
      }),
    );
    expect(result).toBeNull();
  });

  it("ignores panels that are not chapter panels", () => {
    expect(
      chaptersFromPanel({
        engagementPanels: [
          {
            engagementPanelSectionListRenderer: {
              panelIdentifier: "engagement-panel-searchable-transcript",
              content: { macroMarkersListRenderer: { contents: [] } },
            },
          },
        ],
      }),
    ).toBeNull();
  });
});

describe("tier 3 — description timestamps", () => {
  it("accepts a well-formed chapter list", () => {
    const result = chaptersFromDescriptionText(
      ["Some blurb", "0:00 Intro", "1:30 Middle bit", "12:05 The end"].join(
        "\n",
      ),
    );
    expect(result?.source).toBe("description");
    expect(result?.chapters).toEqual([
      { title: "Intro", startMs: 0 },
      { title: "Middle bit", startMs: 90_000 },
      { title: "The end", startMs: 725_000 },
    ]);
  });

  it("handles hours", () => {
    const result = chaptersFromDescriptionText(
      ["0:00 Start", "10:00 Middle", "1:02:03 Late"].join("\n"),
    );
    expect(result?.chapters[2].startMs).toBe(3_723_000);
  });

  // YouTube's own rules, applied here for the same reason it applies them: a
  // description that merely mentions a time is not a chaptered video.
  it("rejects a single stray timestamp", () => {
    expect(
      chaptersFromDescriptionText("Watch from 3:45 for the good bit"),
    ).toBeNull();
  });

  it("rejects a list that does not begin at zero", () => {
    expect(
      chaptersFromDescriptionText(
        ["0:30 One", "2:00 Two", "4:00 Three"].join("\n"),
      ),
    ).toBeNull();
  });

  it("rejects chapters shorter than ten seconds", () => {
    expect(
      chaptersFromDescriptionText(
        ["0:00 One", "0:05 Two", "0:09 Three"].join("\n"),
      ),
    ).toBeNull();
  });

  it("reads the structured attributed description when present", () => {
    const content = "0:00 Opening\n1:00 Second\n2:00 Third";
    const result = chaptersFromAttributedDescription({
      contents: {
        twoColumnWatchNextResults: {
          results: {
            results: {
              contents: [
                {
                  videoSecondaryInfoRenderer: {
                    attributedDescription: {
                      content,
                      commandRuns: [
                        {
                          startIndex: 0,
                          length: 4,
                          onTap: {
                            innertubeCommand: {
                              watchEndpoint: { startTimeSeconds: 0 },
                            },
                          },
                        },
                        {
                          startIndex: 13,
                          length: 4,
                          onTap: {
                            innertubeCommand: {
                              watchEndpoint: { startTimeSeconds: 60 },
                            },
                          },
                        },
                        {
                          startIndex: 25,
                          length: 4,
                          onTap: {
                            innertubeCommand: {
                              watchEndpoint: { startTimeSeconds: 120 },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      },
    });

    expect(result?.chapters.map((c) => c.title)).toEqual([
      "Opening",
      "Second",
      "Third",
    ]);
  });
});

describe("the whole ladder", () => {
  it("returns null for a video with nothing anywhere", () => {
    expect(chaptersFrom(noChapters)).toBeNull();
  });

  it("uses tier 1 when it can", () => {
    expect(
      chaptersFrom(
        withMarkers([{ key: "DESCRIPTION_CHAPTERS", chapters: [["A", 0]] }]),
      )?.source,
    ).toBe("description");
  });

  it("reaches the description when the structured tiers are absent", () => {
    const result = chaptersFrom(noChapters, "0:00 One\n1:00 Two\n2:00 Three");
    expect(result?.chapters).toHaveLength(3);
  });
});

describe("chaptersFromTranscript", () => {
  const line = (startMs: number, endMs: number, text: string) => ({
    startMs,
    endMs,
    text,
  });

  it("splits at the longest silences and titles each section", () => {
    const chapters = chaptersFromTranscript(
      [
        line(0, 1000, "welcome to the show today we discuss leverage"),
        line(1200, 2000, "the first topic"),
        // A long pause, and far enough along to clear the minimum spacing.
        line(90_000, 91_000, "moving on to something completely different now"),
        line(91_200, 92_000, "and more"),
      ],
      180_000,
      3,
    );

    expect(chapters).toHaveLength(2);
    expect(chapters[0].startMs).toBe(0);
    expect(chapters[1].startMs).toBe(90_000);
    // Titled by the phrase parser, not by the raw opening words.
    expect(chapters[0].title).toBe("Welcome to the show today we");
  });

  it("returns nothing for an empty transcript", () => {
    expect(chaptersFromTranscript([], 1000)).toEqual([]);
  });

  // One section is not an outline; showing it would imply structure that is not
  // there, which is worse than showing none.
  it("returns nothing when it cannot find a second section", () => {
    expect(
      chaptersFromTranscript([line(0, 1000, "one continuous stream")], 1000),
    ).toEqual([]);
  });
});

describe("videoMetaFrom", () => {
  it("parses lengthSeconds, which is a string here", () => {
    expect(
      videoMetaFrom({
        videoDetails: { title: "T", author: "A", lengthSeconds: "1425" },
      }),
    ).toEqual({ title: "T", channel: "A", durationMs: 1_425_000 });
  });

  it("returns null when there is no videoDetails at all", () => {
    expect(videoMetaFrom({})).toBeNull();
    expect(videoMetaFrom(null)).toBeNull();
  });

  it("tolerates a missing duration", () => {
    expect(
      videoMetaFrom({ videoDetails: { title: "T", author: "A" } }),
    ).toEqual({
      title: "T",
      channel: "A",
      durationMs: 0,
    });
  });
});

describe("sectionLabel", () => {
  // The reported case, verbatim. The first seven words of spoken English are
  // usually the least informative seven.
  it("finds the phrase inside the scaffolding", () => {
    expect(
      sectionLabel("Here are brutally honest truths that nobody tells you"),
    ).toBe("Brutally honest truths");
  });

  it("drops the openings people actually say", () => {
    expect(sectionLabel("So basically the compound effect takes over")).toBe(
      "Compound effect takes over",
    );
    expect(sectionLabel("and I think you know parallel agents work well")).toBe(
      "Parallel agents work well",
    );
    expect(sectionLabel("Um, okay, so leverage is the whole game here")).toBe(
      "Leverage is the whole game here",
    );
  });

  it("stops at a clause boundary rather than running on", () => {
    expect(
      sectionLabel("Revenue multipliers decay because the market adjusts"),
    ).toBe("Revenue multipliers decay");
  });

  it("stops at punctuation", () => {
    expect(sectionLabel("Three rules, and here is the first one")).toBe(
      "Three rules",
    );
  });

  it("never ends on a weak word", () => {
    expect(sectionLabel("Career capital is about the")).toBe("Career capital");
  });

  it("caps the length", () => {
    const label = sectionLabel(
      "compound interest rewards patience discipline consistency focus attention effort",
    );
    expect(label.split(/\s+/)).toHaveLength(6);
  });

  it("falls back rather than returning nothing when it is all filler", () => {
    expect(sectionLabel("so you know I mean like")).not.toBe("");
    expect(sectionLabel("")).toBe("");
  });
});

describe("chaptersFromTranscript spacing", () => {
  /*
   * The reported failure: sections at 2:24 and 2:27. A breath is not a chapter,
   * and an outline whose entries are three seconds apart is not an outline.
   */
  it("refuses sections that are seconds apart", () => {
    const line = (startMs: number, endMs: number, text: string) => ({
      startMs,
      endMs,
      text,
    });

    const chapters = chaptersFromTranscript(
      [
        line(0, 5_000, "opening remarks about the whole idea"),
        // A long pause, then two breaks three seconds apart.
        line(144_000, 146_000, "second section begins here properly"),
        line(147_000, 149_000, "third would start here far too soon"),
        line(400_000, 405_000, "much later a genuine new subject appears"),
      ],
      600_000,
    );

    const starts = chapters.map((c) => c.startMs);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(45_000);
    }
    expect(starts).not.toContain(147_000);
  });

  it("scales the minimum gap with the video length", () => {
    const lines = Array.from({ length: 40 }, (_, i) => ({
      startMs: i * 60_000,
      endMs: i * 60_000 + 1_000,
      text: `distinct subject number ${i} being discussed`,
    }));
    // A two-hour video: the floor becomes duration/25 = 4.8 minutes.
    const chapters = chaptersFromTranscript(lines, 7_200_000);
    const starts = chapters.map((c) => c.startMs);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(288_000);
    }
  });
});

describe("parseAiChapters", () => {
  it("reads the shape the prompt asks for", () => {
    const chapters = parseAiChapters(
      [
        "0:00 | 1. Why leverage beats effort",
        "2:30 | 2. Choosing a market",
      ].join("\n"),
      600_000,
    );
    expect(chapters).toEqual([
      { title: "1. Why leverage beats effort", startMs: 0 },
      { title: "2. Choosing a market", startMs: 150_000 },
    ]);
  });

  // Models add bullets, swap the pipe for a dash, and wrap things in asterisks.
  // None of that is worth throwing away an otherwise good outline over.
  it("tolerates the ways a model drifts from the format", () => {
    const chapters = parseAiChapters(
      [
        "Here are the chapters:",
        "- 0:00 — **1. Opening claim**",
        "* 1:05 - 2. The mechanism",
        "2:10: 3. What to do",
      ].join("\n"),
      600_000,
    );
    expect(chapters.map((c) => c.title)).toEqual([
      "1. Opening claim",
      "2. The mechanism",
      "3. What to do",
    ]);
  });

  // A model that invents a timestamp past the end has lost the plot, and the
  // row it produced would be unreachable in the navigation.
  it("drops a timestamp past the end of the video", () => {
    const chapters = parseAiChapters(
      ["0:00 | 1. Real", "1:00 | 2. Also real", "99:00 | 3. Invented"].join(
        "\n",
      ),
      120_000,
    );
    expect(chapters.map((c) => c.title)).toEqual(["1. Real", "2. Also real"]);
  });

  it("returns nothing rather than a one-row outline", () => {
    expect(parseAiChapters("0:00 | 1. Only one", 600_000)).toEqual([]);
    expect(parseAiChapters("no timestamps at all", 600_000)).toEqual([]);
    expect(parseAiChapters("", 600_000)).toEqual([]);
  });

  it("handles hours", () => {
    const chapters = parseAiChapters(
      ["0:00 | 1. Start", "1:02:03 | 2. Late"].join("\n"),
      7_200_000,
    );
    expect(chapters[1].startMs).toBe(3_723_000);
  });
});

describe("transcriptForChapters", () => {
  it("stamps blocks so the model can place its sections", () => {
    const seed = transcriptForChapters(
      [
        { startMs: 0, endMs: 1_000, text: "opening words" },
        { startMs: 2_000, endMs: 3_000, text: "still opening" },
        { startMs: 20_000, endMs: 21_000, text: "a new subject" },
      ],
      15_000,
    );
    expect(seed.split("\n")).toEqual([
      "0:00 opening words still opening",
      "0:20 a new subject",
    ]);
  });

  it("survives an empty transcript", () => {
    expect(transcriptForChapters([])).toBe("");
  });
});

describe("a real YouTube payload", () => {
  /*
   * Captured from https://www.youtube.com/watch?v=aKBfAnxChjU, a video that
   * reported "no chapters of its own" in the navigation while plainly having
   * thirteen. This fixture proved the extractor was never the problem: the
   * content script was being handed the *previous* page's `ytInitialData`,
   * which YouTube never refreshes on SPA navigation.
   */
  const data = JSON.parse(
    readFileSync("src/dev/fixtures/watchdata-chapters.json", "utf8"),
  ) as unknown;

  it("finds every authored chapter", () => {
    const result = chaptersFrom(data);
    expect(result?.source).toBe("description");
    expect(result?.chapters).toHaveLength(13);
    expect(result?.chapters[0]).toEqual({ title: "intro", startMs: 0 });
    expect(result?.chapters[1].startMs).toBe(47_000);
  });

  it("names the video it describes, which is what makes staleness detectable", () => {
    expect(watchDataVideoId(data)).toBe("aKBfAnxChjU");
  });

  it("has no id to offer for something that is not watch data", () => {
    expect(watchDataVideoId({})).toBeNull();
    expect(watchDataVideoId(null)).toBeNull();
    expect(watchDataVideoId("nonsense")).toBeNull();
  });

  it("falls back to the player response's own id", () => {
    expect(watchDataVideoId({ videoDetails: { videoId: "abc123" } })).toBe(
      "abc123",
    );
  });
});
