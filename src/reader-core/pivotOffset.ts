/**
 * Horizontal offset that places a word's pivot letter on the focal column.
 *
 * Monospace is the default reading face precisely because this is exact there:
 * every glyph is 1ch wide, so the offset is pure arithmetic and no measurement
 * or layout read is needed. Proportional faces (Atkinson Hyperlegible for
 * legibility, Geist for looks) need real glyph widths, which means canvas
 * measurement — cached, because this runs on every word.
 */

import { orpIndex } from "./orp";

let ctx: CanvasRenderingContext2D | null = null;
const cache = new Map<string, number>();

/** Guard against the cache growing without bound over a long session. */
const CACHE_LIMIT = 4000;

function context(): CanvasRenderingContext2D | null {
  if (ctx) return ctx;
  if (typeof document === "undefined") return null;
  ctx = document.createElement("canvas").getContext("2d");
  return ctx;
}

/**
 * Offset in CSS pixels to apply as `translateX`, such that the centre of the
 * pivot letter sits on the element's left edge (the focal column).
 *
 * Returns a negative number: the word is pulled left so the pivot lands on the
 * line rather than the word starting there.
 */
export function pivotOffsetPx(
  word: string,
  font: string,
  letterSpacingPx: number,
): number {
  if (!word) return 0;

  const key = `${font}|${letterSpacingPx}|${word}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const c = context();
  if (!c) return 0;
  c.font = font;

  const i = orpIndex(word);
  const chars = [...word];
  const before = chars.slice(0, i).join("");
  const pivot = chars[i] ?? "";

  // Canvas measureText does not apply letter-spacing, so add it back per gap.
  const beforeWidth = c.measureText(before).width + letterSpacingPx * before.length;
  const pivotWidth = c.measureText(pivot).width;
  const offset = -(beforeWidth + pivotWidth / 2);

  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, offset);
  return offset;
}

/** Drop cached measurements — call when the font or size changes. */
export function clearPivotCache(): void {
  cache.clear();
}

/**
 * Offset expressed in `ch` units, valid only for monospace faces where every
 * glyph advances exactly 1ch. Avoids a canvas round-trip per word.
 */
export function pivotOffsetCh(word: string): number {
  if (!word) return 0;
  return -(orpIndex(word) + 0.5);
}

/**
 * How far a word reaches either side of the focal column.
 *
 * `left` is negative, `right` positive, both measured from the column. Context
 * words need this: the focus word is centred on its *pivot letter*, not on
 * itself, so how far it extends depends on where that letter falls. Placing
 * neighbours a fixed distance from the column instead makes long words collide
 * with them — "brain uses to" renders as "brainusesto" with the pivot word
 * painted over both sides.
 */
export interface WordExtent {
  left: number;
  right: number;
}

/** Extent in `ch`, for monospace faces. */
export function wordExtentCh(word: string): WordExtent {
  if (!word) return { left: 0, right: 0 };
  const left = pivotOffsetCh(word);
  return { left, right: left + [...word].length };
}

/** Extent in CSS pixels, for proportional faces. */
export function wordExtentPx(
  word: string,
  font: string,
  letterSpacingPx: number,
): WordExtent {
  if (!word) return { left: 0, right: 0 };
  const left = pivotOffsetPx(word, font, letterSpacingPx);

  const key = `w|${font}|${letterSpacingPx}|${word}`;
  let width = cache.get(key);
  if (width === undefined) {
    const c = context();
    if (!c) return { left, right: left };
    c.font = font;
    width = c.measureText(word).width + letterSpacingPx * Math.max(0, [...word].length - 1);
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, width);
  }
  return { left, right: left + width };
}
