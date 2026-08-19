import { describe, expect, it } from "vitest";
import {
  chapterAt,
  chaptersWithEnds,
  emptyModel,
  exportFilename,
  formatTimestamp,
  notesToMarkdown,
  type Chapter,
  type ReadModeModel,
} from "./model";

const chapters: Chapter[] = [
  { title: "Intro", startMs: 0 },
  { title: "Middle", startMs: 60_000 },
  { title: "End", startMs: 120_000 },
];

describe("chaptersWithEnds", () => {
  it("ends each chapter where the next begins, and the last at the duration", () => {
    const withEnds = chaptersWithEnds(chapters, 180_000);
    expect(withEnds.map((c) => c.endMs)).toEqual([60_000, 120_000, 180_000]);
  });

  // The description-parsing tier hands back whatever order the author typed.
  it("sorts before deriving ends", () => {
    const jumbled: Chapter[] = [
      { title: "End", startMs: 120_000 },
      { title: "Intro", startMs: 0 },
      { title: "Middle", startMs: 60_000 },
    ];
    const withEnds = chaptersWithEnds(jumbled, 180_000);
    expect(withEnds.map((c) => c.title)).toEqual(["Intro", "Middle", "End"]);
    expect(withEnds.map((c) => c.endMs)).toEqual([60_000, 120_000, 180_000]);
  });

  it("does not mutate its input", () => {
    const input = [...chapters];
    chaptersWithEnds(input, 180_000);
    expect(input[0].endMs).toBeUndefined();
  });

  it("survives an empty list", () => {
    expect(chaptersWithEnds([], 1000)).toEqual([]);
  });
});

describe("chapterAt", () => {
  const withEnds = chaptersWithEnds(chapters, 180_000);

  it("finds the covering chapter", () => {
    expect(chapterAt(withEnds, 0)).toBe(0);
    expect(chapterAt(withEnds, 59_999)).toBe(0);
    expect(chapterAt(withEnds, 60_000)).toBe(1);
    expect(chapterAt(withEnds, 179_999)).toBe(2);
  });

  it("returns -1 past the end of the last chapter", () => {
    expect(chapterAt(withEnds, 180_000)).toBe(-1);
    expect(chapterAt(withEnds, 999_999)).toBe(-1);
  });

  // A chapter list that starts late leaves the opening seconds genuinely
  // uncovered — better to highlight nothing than to highlight the wrong one.
  it("returns -1 before the first chapter starts", () => {
    const late = chaptersWithEnds(
      [{ title: "Later", startMs: 30_000 }],
      60_000,
    );
    expect(chapterAt(late, 0)).toBe(-1);
    expect(chapterAt(late, 30_000)).toBe(0);
  });

  it("returns -1 for an empty list", () => {
    expect(chapterAt([], 5000)).toBe(-1);
  });
});

describe("formatTimestamp", () => {
  it("uses m:ss under an hour and h:mm:ss over it, as YouTube does", () => {
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(7_000)).toBe("0:07");
    expect(formatTimestamp(621_000)).toBe("10:21");
    expect(formatTimestamp(3_600_000)).toBe("1:00:00");
    expect(formatTimestamp(3_661_000)).toBe("1:01:01");
  });

  it("floors rather than rounding, so a stamp never runs ahead of the video", () => {
    expect(formatTimestamp(7_999)).toBe("0:07");
  });

  it("clamps negatives instead of rendering a minus", () => {
    expect(formatTimestamp(-5000)).toBe("0:00");
  });
});

function model(over: Partial<ReadModeModel> = {}): ReadModeModel {
  return {
    ...emptyModel("abc123"),
    title: "A Video",
    channel: "A Channel",
    ...over,
  };
}

describe("notesToMarkdown", () => {
  it("writes timestamps as links that survive outside the browser", () => {
    const md = notesToMarkdown(
      model({
        notes: [
          { id: "1", atMs: 621_000, text: "second", createdAt: 2 },
          { id: "2", atMs: 96_000, text: "first", createdAt: 1 },
        ],
      }),
    );
    expect(md).toContain("# A Video");
    expect(md).toContain("<https://www.youtube.com/watch?v=abc123>");
    // Sorted by position in the video, not by when they were typed.
    expect(md.indexOf("first")).toBeLessThan(md.indexOf("second"));
    expect(md).toContain(
      "- [1:36](https://www.youtube.com/watch?v=abc123&t=96s) first",
    );
  });

  it("says so rather than emitting an empty section", () => {
    expect(notesToMarkdown(model())).toContain("_No notes taken._");
  });

  // Export must never be a dead button: a video studied without typing
  // anything still produced a summary worth keeping.
  it("carries the summary even when there are no notes", () => {
    const md = notesToMarkdown(
      model({
        messages: [
          { id: "m", role: "assistant", text: "The core idea.", createdAt: 1 },
        ],
      }),
    );
    expect(md).toContain("## Summary");
    expect(md).toContain("The core idea.");
    expect(md).toContain("_No notes taken._");
  });
});

describe("the exported sections", () => {
  const withChat = () =>
    model({
      notes: [{ id: "n", atMs: 1000, text: "a note", createdAt: 1 }],
      messages: [
        { id: "a1", role: "assistant", text: "The core idea.", createdAt: 1 },
        { id: "u1", role: "user", text: "What about pacing?", createdAt: 2 },
        { id: "a2", role: "assistant", text: "Pace it slowly.", createdAt: 3 },
      ],
    });

  it("records the conversation as questions and answers", () => {
    const md = notesToMarkdown(withChat());
    expect(md).toContain("## Video related questions");
    expect(md).toContain("What about pacing?");
    expect(md).toContain("Pace it slowly.");
  });

  // The summary already has its own section; repeating it would open the file
  // with the same paragraph twice.
  it("does not repeat the summary inside the questions", () => {
    const md = notesToMarkdown(withChat());
    const qa = md.slice(md.indexOf("## Video related questions"));
    expect(qa).not.toContain("The core idea.");
    expect(md.indexOf("The core idea.")).toBeGreaterThan(-1);
  });

  it("leaves the section out when nothing was asked", () => {
    const md = notesToMarkdown(
      model({
        messages: [
          {
            id: "a1",
            role: "assistant",
            text: "Only a summary.",
            createdAt: 1,
          },
        ],
      }),
    );
    expect(md).not.toContain("## Video related questions");
  });

  // Off by default: the transcript dwarfs everything else in the file.
  it("omits the transcript unless it is asked for", () => {
    const plain = notesToMarkdown(model(), { transcript: "every spoken word" });
    expect(plain).not.toContain("## Transcript");

    const full = notesToMarkdown(model(), {
      transcript: "every spoken word",
      includeTranscript: true,
    });
    expect(full).toContain("## Transcript");
    expect(full).toContain("every spoken word");
  });

  it("keeps the transcript last, after the notes and the questions", () => {
    const md = notesToMarkdown(withChat(), {
      transcript: "every spoken word",
      includeTranscript: true,
    });
    expect(md.indexOf("## Notes")).toBeLessThan(
      md.indexOf("## Video related questions"),
    );
    expect(md.indexOf("## Video related questions")).toBeLessThan(
      md.indexOf("## Transcript"),
    );
  });
});

describe("exportFilename", () => {
  it("strips characters that would break a filesystem", () => {
    expect(exportFilename(model({ title: 'a/b\\c:d*e?f"g<h>i|j' }))).toBe(
      "a b c d e f g h i j.md",
    );
  });

  it("falls back to the video id when there is no title", () => {
    expect(exportFilename(model({ title: "" }))).toBe("abc123.md");
  });

  it("caps the length", () => {
    const name = exportFilename(model({ title: "x".repeat(200) }));
    expect(name.length).toBeLessThanOrEqual(83);
  });
});
