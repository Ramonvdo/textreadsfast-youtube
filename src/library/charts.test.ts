import { describe, expect, it } from "vitest";
import { formatDuration, layoutBars, runsOf } from "./charts";

describe("layoutBars", () => {
  const options = { width: 100, height: 50, bottomGutter: 10, gap: 0 };

  it("scales bars against the tallest, from a shared baseline", () => {
    const bars = layoutBars([10, 5, 0], options);
    const plot = 40; // height - bottomGutter

    expect(bars[0].height).toBe(plot);
    expect(bars[1].height).toBe(plot / 2);
    expect(bars[0].y).toBe(0);
    expect(bars[1].y).toBe(plot / 2);
    // Every bar ends on the same line, whatever its height.
    for (const bar of bars) expect(bar.y + bar.height).toBe(plot);
  });

  it("shares the width evenly", () => {
    const bars = layoutBars([1, 1, 1, 1], options);
    expect(bars.map((b) => b.x)).toEqual([0, 25, 50, 75]);
    expect(bars.every((b) => b.width === 25)).toBe(true);
  });

  // An all-zero week must not render as a full-height week. This is the bug a
  // naive `value / max` produces the moment `max` is zero.
  it("draws nothing when nothing was studied", () => {
    const bars = layoutBars([0, 0, 0], options);
    expect(bars.every((b) => b.height === 0)).toBe(true);
  });

  // The opposite failure: a genuinely quiet day rounding away to invisible.
  it("gives a small value a visible sliver", () => {
    const bars = layoutBars([10_000, 1], options);
    expect(bars[1].height).toBeGreaterThanOrEqual(2);
  });

  it("returns nothing for an empty series or a zero-size box", () => {
    expect(layoutBars([], options)).toEqual([]);
    expect(layoutBars([1, 2], { ...options, width: 0 })).toEqual([]);
  });
});

describe("formatDuration", () => {
  it("reads the way a person would say it", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(48_000)).toBe("48s");
    expect(formatDuration(12 * 60_000)).toBe("12m");
    expect(formatDuration(60 * 60_000)).toBe("1h 0m");
    expect(formatDuration(4 * 60 * 60_000 + 12 * 60_000)).toBe("4h 12m");
  });

  it("never renders a negative", () => {
    expect(formatDuration(-5000)).toBe("0s");
  });
});

describe("runsOf", () => {
  // A two-hour video is 1,440 buckets. Merging runs is what keeps the coverage
  // bar from being 1,440 DOM nodes.
  it("merges adjacent watched buckets", () => {
    expect(runsOf([1, 1, 1, 0, 0, 1, 1])).toEqual([
      { start: 0, length: 3 },
      { start: 5, length: 2 },
    ]);
  });

  it("closes a run that reaches the end", () => {
    expect(runsOf([0, 1, 1])).toEqual([{ start: 1, length: 2 }]);
  });

  it("handles the extremes", () => {
    expect(runsOf([])).toEqual([]);
    expect(runsOf([0, 0])).toEqual([]);
    expect(runsOf([1, 1])).toEqual([{ start: 0, length: 2 }]);
  });

  it("works on the Uint8Array the database actually stores", () => {
    expect(runsOf(new Uint8Array([0, 1, 0]))).toEqual([
      { start: 1, length: 1 },
    ]);
  });
});
