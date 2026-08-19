// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  formatDuration,
  layoutBars,
  renderBarChart,
  renderCoverageBar,
  runsOf,
  type Bar,
} from "./charts";

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
    const bars = layoutBars([1, 1, 1, 1], { ...options, maxBarWidth: 999 });
    expect(bars.map((b) => b.x)).toEqual([0, 25, 50, 75]);
    expect(bars.every((b) => b.width === 25)).toBe(true);
  });

  /*
   * A single month rendered as a grey slab the full width of the panel, with
   * its label swallowed underneath. One bucket must look like one bucket.
   */
  it("caps a lone bar and centres it", () => {
    const bars = layoutBars([1], { width: 320, height: 96 });
    expect(bars[0].width).toBeLessThanOrEqual(46);
    // Centred: as much space to the left as to the right.
    const right = 320 - (bars[0].x + bars[0].width);
    expect(Math.abs(bars[0].x - right)).toBeLessThanOrEqual(4);
  });

  it("still fills the row once there are enough bars", () => {
    const bars = layoutBars(Array(30).fill(1), { width: 320, height: 96 });
    expect(bars[0].width).toBeLessThan(46);
    expect(bars[0].x).toBeLessThan(6);
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

/*
 * THE BUG THESE ASSERTIONS EXIST FOR: every chart was drawn into a fixed
 * 320-unit viewBox at `width: 100%` with `preserveAspectRatio="none"`. In a
 * panel three times that wide, glyphs were scaled 3.4x horizontally and 1x
 * vertically — "Wed" arrived as an unreadable smear. Nothing in this file
 * asserted a single SVG attribute, which is why it shipped.
 */
describe("chart geometry on the page", () => {
  const bars: Bar[] = [
    { key: "2026-08-17", value: 600_000, label: "We" },
    { key: "2026-08-18", value: 900_000, label: "Th" },
    { key: "2026-08-19", value: 300_000, label: "Fr" },
  ];

  it("draws the bar chart at the width it is given", () => {
    const node = renderBarChart(bars, 96, 1080);
    expect(node.getAttribute("viewBox")).toBe("0 0 1080 96");
    // Absent, so the browser's default `meet` applies and the scale stays 1:1.
    expect(node.getAttribute("preserveAspectRatio")).toBeNull();
  });

  it("keeps the default width for a caller that does not measure", () => {
    expect(renderBarChart(bars).getAttribute("viewBox")).toBe("0 0 320 96");
  });

  it("places labels inside the box at every width", () => {
    for (const width of [320, 640, 1080]) {
      const node = renderBarChart(bars, 96, width);
      const labels = Array.from(node.querySelectorAll("text"));
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) {
        const x = Number(label.getAttribute("x"));
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(width);
      }
    }
  });

  // The one chart that genuinely wants to stretch: rectangles only, no text.
  it("still stretches the coverage strip", () => {
    const node = renderCoverageBar([1, 1, 0, 1]);
    expect(node.getAttribute("preserveAspectRatio")).toBe("none");
  });
});
