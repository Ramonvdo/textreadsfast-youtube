/**
 * The library's charts.
 *
 * Hand-written SVG rather than a charting library. What is needed here is a bar
 * series and a coverage strip; pulling in React, Recharts and Tailwind to draw
 * them would add a second toolchain to a repository that builds plain DOM with
 * esbuild and has no runtime dependencies at all. Written this way they also
 * inherit the library page's palette directly, so the charts look like the rest
 * of the product instead of like a component kit.
 *
 * Every geometry function is pure and unit-tested; only `render*` touches the
 * DOM. A chart that is wrong by a pixel is a rounding bug, but a chart that is
 * wrong by a bar is a lie about how much someone studied.
 */

const NS = "http://www.w3.org/2000/svg";

export interface Bar {
  /** Bucket key, `YYYY-MM-DD`. */
  key: string;
  value: number;
  /** What a person should read, e.g. "Mon 18". */
  label: string;
}

export interface BarGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BarLayoutOptions {
  width: number;
  height: number;
  /** Room for the baseline labels. */
  bottomGutter?: number;
  gap?: number;
  /** Widest a single bar may be. See `MAX_BAR_WIDTH`. */
  maxBarWidth?: number;
}

/**
 * A bar is a bar, not a wall.
 *
 * With one or two buckets the even split gives each bar hundreds of pixels, and
 * a single month of activity rendered as a grey slab the width of the panel
 * with its label swallowed underneath. Capping the width and centring the
 * series keeps one bucket looking like one bucket.
 */
const MAX_BAR_WIDTH = 46;

/**
 * Where each bar sits.
 *
 * Split out from rendering so the arithmetic can be tested without a DOM: bars
 * proportional to their value, sharing the width evenly, growing upward from a
 * common baseline.
 */
export function layoutBars(
  values: number[],
  options: BarLayoutOptions,
): BarGeometry[] {
  const { width, height } = options;
  const bottomGutter = options.bottomGutter ?? 18;
  const gap = options.gap ?? 3;

  if (values.length === 0 || width <= 0 || height <= 0) return [];

  const plot = Math.max(0, height - bottomGutter);
  const maxBarWidth = options.maxBarWidth ?? MAX_BAR_WIDTH;

  const slot = width / values.length;
  const barWidth = Math.max(1, Math.min(slot - gap, maxBarWidth));
  // Centre the series when the cap leaves the row narrower than the panel, so a
  // sparse chart reads as sparse rather than as left-aligned and broken.
  const used = values.length * (barWidth + gap);
  const offset = Math.max(0, (width - used) / 2);
  // An all-zero series must not divide by zero, and must not draw full-height
  // bars either — nothing studied should look like nothing studied.
  const peak = Math.max(...values, 0);

  return values.map((value, index) => {
    const ratio = peak > 0 ? Math.max(0, value) / peak : 0;
    // A non-zero value always gets at least a sliver, or a quiet day reads as
    // an absent one.
    const barHeight = value > 0 ? Math.max(2, ratio * plot) : 0;
    return {
      x: offset + index * (barWidth + gap) + gap / 2,
      y: plot - barHeight,
      width: barWidth,
      height: barHeight,
    };
  });
}

/** `4h 12m`, `12m`, `48s` — never `0.7 hours`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** A short weekday-and-date label for a `YYYY-MM-DD` key. */
export function shortDayLabel(key: string): string {
  const date = new Date(`${key}T00:00:00`);
  if (Number.isNaN(date.getTime())) return key;
  return date.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2);
}

function svg(width: number, height: number): SVGSVGElement {
  const node = document.createElementNS(NS, "svg");
  node.setAttribute("viewBox", `0 0 ${width} ${height}`);
  node.setAttribute("width", "100%");
  node.setAttribute("height", String(height));
  node.setAttribute("preserveAspectRatio", "none");
  node.setAttribute("role", "img");
  return node;
}

function rect(geometry: BarGeometry, className: string): SVGRectElement {
  const node = document.createElementNS(NS, "rect");
  node.setAttribute("x", String(geometry.x));
  node.setAttribute("y", String(geometry.y));
  node.setAttribute("width", String(geometry.width));
  node.setAttribute("height", String(geometry.height));
  node.setAttribute("rx", "2");
  node.setAttribute("class", className);
  return node;
}

/**
 * A bar series with baseline labels.
 *
 * `aria-label` carries the whole story in words, because a chart nobody can
 * read is decoration. Hover shows a value through a native `<title>`, which
 * needs no positioning code and works on touch.
 */
export function renderBarChart(bars: Bar[], height = 96): SVGSVGElement {
  const width = 320;
  const node = svg(width, height);

  const total = bars.reduce((sum, bar) => sum + bar.value, 0);
  node.setAttribute(
    "aria-label",
    bars.length === 0
      ? "No activity yet"
      : `${formatDuration(total)} across ${bars.length} periods, ending ${bars[bars.length - 1].label}`,
  );

  const geometry = layoutBars(
    bars.map((bar) => bar.value),
    { width, height },
  );

  geometry.forEach((box, index) => {
    const bar = bars[index];
    const group = document.createElementNS(NS, "g");

    const shape = rect(
      box,
      bar.value > 0 ? "chart-bar" : "chart-bar chart-bar--empty",
    );
    const tip = document.createElementNS(NS, "title");
    tip.textContent = `${bar.label}: ${formatDuration(bar.value)}`;
    shape.appendChild(tip);
    group.appendChild(shape);

    // Only label a few, or a month of days becomes a smear.
    const step = Math.ceil(bars.length / 7);
    if (index % step === 0 || index === bars.length - 1) {
      const text = document.createElementNS(NS, "text");
      text.setAttribute("x", String(box.x + box.width / 2));
      text.setAttribute("y", String(height - 5));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("class", "chart-label");
      text.textContent = bar.label;
      group.appendChild(text);
    }

    node.appendChild(group);
  });

  return node;
}

/**
 * The timeline, with the parts actually watched filled in.
 *
 * The one figure that answers "did I finish it", and the reason coverage is
 * stored per bucket rather than as a running total.
 */
export function renderCoverageBar(
  coverage: Uint8Array | number[],
  height = 14,
): SVGSVGElement {
  const buckets = Array.from(coverage);
  const width = 320;
  const node = svg(width, height);

  const seen = buckets.filter(Boolean).length;
  const pct =
    buckets.length > 0 ? Math.round((seen / buckets.length) * 100) : 0;
  node.setAttribute("aria-label", `${pct}% of this video watched`);

  const track = document.createElementNS(NS, "rect");
  track.setAttribute("x", "0");
  track.setAttribute("y", "0");
  track.setAttribute("width", String(width));
  track.setAttribute("height", String(height));
  track.setAttribute("rx", "3");
  track.setAttribute("class", "chart-track");
  node.appendChild(track);

  // Adjacent seen buckets are merged into one rectangle: a two-hour video is
  // 1,440 buckets, and 1,440 nodes to draw a striped bar is absurd.
  for (const run of runsOf(buckets)) {
    const box = {
      x: (run.start / buckets.length) * width,
      y: 0,
      width: Math.max(1, (run.length / buckets.length) * width),
      height,
    };
    node.appendChild(rect(box, "chart-seen"));
  }

  return node;
}

/** Contiguous runs of watched buckets. Exported for the geometry tests. */
export function runsOf(
  buckets: ArrayLike<number>,
): Array<{ start: number; length: number }> {
  const runs: Array<{ start: number; length: number }> = [];
  let start = -1;

  for (let i = 0; i < buckets.length; i += 1) {
    const filled = Boolean(buckets[i]);
    if (filled && start === -1) start = i;
    if (!filled && start !== -1) {
      runs.push({ start, length: i - start });
      start = -1;
    }
  }
  if (start !== -1) runs.push({ start, length: buckets.length - start });
  return runs;
}

/** One figure with its label. */
export function renderStatTile(
  label: string,
  value: string,
  hint?: string,
): HTMLElement {
  const tile = document.createElement("div");
  tile.className = "tile";

  const figure = document.createElement("strong");
  figure.textContent = value;

  const name = document.createElement("span");
  name.textContent = label;

  tile.append(figure, name);

  if (hint) {
    const note = document.createElement("small");
    note.textContent = hint;
    tile.appendChild(note);
  }

  return tile;
}
