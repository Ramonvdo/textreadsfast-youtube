/**
 * The reader, rendered over the YouTube player.
 *
 * Plain DOM rather than a framework: this runs inside someone else's page on
 * every video, and the whole surface is one word plus a little context. A
 * renderer would cost more than it saves.
 *
 * Mounted *inside* `#movie_player`, not the page body, so it follows the video
 * into fullscreen and theatre mode without any code to handle either.
 */

import { splitAtOrp } from "../reader-core/orp";
import {
  pivotOffsetCh,
  pivotOffsetPx,
  wordExtentCh,
  wordExtentPx,
  clearPivotCache,
} from "../reader-core/pivotOffset";
import { FONT_STACKS, isMonospace } from "../reader-core/fonts";
import type { Word } from "../reader-core/words";
import type { Settings } from "../settings";

/** Fraction of a word rendered bold in Bionic mode. */
const BIONIC_LEAD = 0.42;

/**
 * Player height the configured text size is calibrated against.
 *
 * Roughly a 720p player in a normal window. Autoscale multiplies the chosen size
 * by how far the real player differs from this, so a size picked while windowed
 * keeps the same *relative* weight in fullscreen instead of shrinking into the
 * picture.
 */
const REFERENCE_PLAYER_HEIGHT = 540;

/** Scale bounds. Unbounded scaling makes a tiny miniplayer illegible and a 4K
 *  fullscreen absurd. */
const MIN_SCALE = 0.6;
const MAX_SCALE = 2.6;

export interface ReaderView {
  current: Word | null;
  previous: Word[];
  upcoming: Word[];
}

export class ReaderOverlay {
  private root: HTMLDivElement;
  private stage: HTMLDivElement;
  private wordEl: HTMLSpanElement;
  private beforeEl: HTMLSpanElement;
  private afterEl: HTMLSpanElement;
  private guideTop: HTMLSpanElement;
  private guideBottom: HTMLSpanElement;
  private settings: Settings;
  private lastText: string | null = null;
  private resize: ResizeObserver | null = null;
  private scale = 1;

  constructor(settings: Settings) {
    this.settings = settings;

    this.root = document.createElement("div");
    this.root.className = "trf-reader";
    // The player owns the pointer. Reading must never cost a click.
    this.root.style.pointerEvents = "none";

    this.stage = document.createElement("div");
    this.stage.className = "trf-stage";

    this.guideTop = document.createElement("span");
    this.guideTop.className = "trf-guide trf-guide--top";
    this.guideBottom = document.createElement("span");
    this.guideBottom.className = "trf-guide trf-guide--bottom";

    this.beforeEl = document.createElement("span");
    this.beforeEl.className = "trf-context trf-context--before";
    this.afterEl = document.createElement("span");
    this.afterEl.className = "trf-context trf-context--after";

    this.wordEl = document.createElement("span");
    this.wordEl.className = "trf-word";

    this.stage.append(
      this.guideTop,
      this.guideBottom,
      this.beforeEl,
      this.wordEl,
      this.afterEl,
    );
    this.root.append(this.stage);
    this.apply(settings);
  }

  /** Attach to the player. Idempotent, so repeated navigation cannot stack
   *  overlays — a real hazard in a single-page app. */
  mount(player: HTMLElement): void {
    if (this.root.parentElement === player) return;
    player.appendChild(this.root);

    // Watching the player covers fullscreen, theatre mode and plain window
    // resizing with one mechanism, rather than listening for a fullscreen event
    // and missing the other two.
    this.resize?.disconnect();
    this.resize = new ResizeObserver(() => this.rescale(player));
    this.resize.observe(player);
    this.rescale(player);
  }

  destroy(): void {
    this.resize?.disconnect();
    this.resize = null;
    this.root.remove();
  }

  /** Re-derive the text size from the player's current height. Tolerates being
   *  called before mount, where the reference height stands in. */
  private rescale(player: HTMLElement | null): void {
    const height = player?.clientHeight || REFERENCE_PLAYER_HEIGHT;
    this.scale = this.settings.autoScale
      ? Math.min(
          MAX_SCALE,
          Math.max(MIN_SCALE, height / REFERENCE_PLAYER_HEIGHT),
        )
      : 1;
    this.root.style.setProperty(
      "--trf-size",
      `${(this.settings.fontSize * this.scale).toFixed(2)}px`,
    );
    // A pixel offset measured at the old size would put the pivot in the wrong
    // place; `ch` offsets scale with the font and are unaffected.
    clearPivotCache();
    this.lastText = null;
  }

  apply(settings: Settings): void {
    const fontChanged =
      settings.font !== this.settings.font ||
      settings.fontSize !== this.settings.fontSize ||
      settings.letterSpacing !== this.settings.letterSpacing;
    this.settings = settings;

    const stack = FONT_STACKS[settings.font];
    this.root.dataset.theme = settings.theme;
    this.root.dataset.mode = settings.mode;
    this.root.style.setProperty("--trf-font", stack);
    this.root.style.setProperty(
      "--trf-tracking",
      `${settings.letterSpacing}px`,
    );
    // Named `--trf-*` to match the stylesheet. An earlier `--context-opacity`
    // here matched nothing, so the dimness control silently did nothing.
    this.root.style.setProperty(
      "--trf-context-opacity",
      String(settings.contextOpacity),
    );
    this.root.style.setProperty(
      "--trf-bottom",
      `${settings.verticalPosition}%`,
    );
    this.root.style.setProperty("--trf-width", `${settings.boxWidth}%`);

    this.guideTop.style.display = settings.showPivotGuides ? "" : "none";
    this.guideBottom.style.display = settings.showPivotGuides ? "" : "none";

    if (fontChanged) {
      // Cached pixel offsets were measured in the old face and would put the
      // pivot in the wrong place. Gated because measuring is the expensive part.
      clearPivotCache();
    }

    // `render` skips redrawing a word it is already showing, which is what stops
    // the focal point shimmering every frame. Any settings change has to clear
    // that guard, or it will not reach the screen until the next word — never,
    // on a paused video. This used to be gated on the font alone, which missed
    // both the reading mode and the context counts. Settings changes are rare;
    // one redraw costs nothing, and enumerating the triggers cost correctness.
    this.lastText = null;

    // Sets `--trf-size` from the size setting and the player's current height.
    const player = this.root.parentElement;
    this.rescale(player instanceof HTMLElement ? player : null);
  }

  /** Nothing is playing, or no word covers this moment. */
  clear(): void {
    if (this.lastText === null) return;
    this.lastText = null;
    this.root.classList.add("trf-idle");
    this.wordEl.textContent = "";
    this.beforeEl.textContent = "";
    this.afterEl.textContent = "";
  }

  render(view: ReaderView): void {
    if (!view.current) {
      this.clear();
      return;
    }
    // Re-rendering the same word every frame would restart its transition and
    // make the focal point shimmer.
    if (view.current.text === this.lastText) return;
    this.lastText = view.current.text;
    this.root.classList.remove("trf-idle");

    if (this.settings.mode === "bionic") {
      this.renderBionic(view);
      return;
    }
    this.renderRsvp(view);
  }

  private renderRsvp(view: ReaderView): void {
    const text = view.current!.text;
    const { before, pivot, after } = splitAtOrp(text);

    this.wordEl.replaceChildren(
      document.createTextNode(before),
      pivotSpan(pivot),
      document.createTextNode(after),
    );

    // Monospace lands the pivot exactly using `ch` units; a proportional face
    // needs the glyph measured.
    const mono = isMonospace(this.settings.font);
    const cssFont = `${(this.settings.fontSize * this.scale).toFixed(2)}px ${
      FONT_STACKS[this.settings.font]
    }`;
    const spacing = this.settings.letterSpacing;

    const offset = mono
      ? pivotOffsetCh(text)
      : pivotOffsetPx(text, cssFont, spacing);
    // Context words are placed against the focus word's real edges. Anchoring
    // them a fixed distance from the focal column instead lets a long word run
    // straight over them, which is what turned "brain uses to" into a pile-up.
    const extent = mono
      ? wordExtentCh(text)
      : wordExtentPx(text, cssFont, spacing);
    const unit = mono ? "ch" : "px";

    this.stage.style.setProperty("--trf-pivot-offset", `${offset}${unit}`);
    this.stage.style.setProperty("--trf-word-left", `${extent.left}${unit}`);
    this.stage.style.setProperty("--trf-word-right", `${extent.right}${unit}`);

    this.beforeEl.textContent = view.previous.map((w) => w.text).join(" ");
    this.afterEl.textContent = view.upcoming.map((w) => w.text).join(" ");
  }

  private renderBionic(view: ReaderView): void {
    const words = [...view.previous, view.current!, ...view.upcoming];
    const currentIndex = view.previous.length;

    this.beforeEl.textContent = "";
    this.afterEl.textContent = "";

    this.wordEl.replaceChildren(
      ...words.map((word, index) => {
        const chars = [...word.text];
        const lead = Math.max(1, Math.round(chars.length * BIONIC_LEAD));
        const span = document.createElement("span");
        span.className =
          index === currentIndex
            ? "trf-bionic trf-bionic--current"
            : "trf-bionic";
        const bold = document.createElement("b");
        bold.textContent = chars.slice(0, lead).join("");
        span.append(bold, document.createTextNode(chars.slice(lead).join("")));
        return span;
      }),
    );
  }
}

function pivotSpan(char: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "trf-pivot";
  span.textContent = char;
  return span;
}
