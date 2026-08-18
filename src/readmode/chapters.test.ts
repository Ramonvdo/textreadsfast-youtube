import { describe, expect, it } from "vitest";
import {
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

  it("splits at the longest silences and titles from the opening words", () => {
    const chapters = chaptersFromTranscript(
      [
        line(0, 1000, "welcome to the show today we discuss"),
        line(1200, 2000, "the first topic"),
        // A long pause: a new section.
        line(9000, 10_000, "moving on to something completely different now"),
        line(10_200, 11_000, "and more"),
      ],
      12_000,
      3,
    );

    expect(chapters).toHaveLength(2);
    expect(chapters[0].startMs).toBe(0);
    expect(chapters[1].startMs).toBe(9000);
    expect(chapters[0].title).toContain("welcome");
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
