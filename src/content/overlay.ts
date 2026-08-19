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
  /**
   * What "already on screen" means, when the current word is not enough.
   *
   * Static mode holds a whole line still and swaps at a boundary, so the thing
   * that must not be redrawn every frame is the *line*, not the word. Keying on
   * the word's text would also break outright whenever two consecutive lines
   * happened to start with the same word — the second would be judged already
   * drawn, and the caption would stop advancing.
   */
  key?: string;
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
  private lastKey: string | null = null;
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
    this.lastKey = null;
  }

  apply(settings: Settings): void {
    const fontChanged =
      settings.font !== this.settings.font ||
      settings.fontSize !== this.settings.fontSize ||
      settings.letterSpacing !== this.settings.letterSpacing ||
      // Both change glyph widths, so a cached pixel offset measured before
      // them puts the pivot in the wrong place.
      settings.textWeight !== this.settings.textWeight ||
      settings.fontStyle !== this.settings.fontStyle;
    this.settings = settings;

    const stack = FONT_STACKS[settings.font];
    this.root.dataset.theme = settings.theme;
    this.root.dataset.mode = settings.mode;
    // Read by one CSS rule rather than by TypeScript, so Bionic's accent is
    // still a stylesheet decision and not a colour computed in two places.
    this.root.dataset.bionicAccent = String(settings.bionicAccent);
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
    // A percentage, because `color-mix` wants one. Clamped here rather than
    // trusting storage, which can hold anything a previous version wrote.
    const opacity = Math.min(1, Math.max(0, settings.backgroundOpacity));
    this.root.style.setProperty(
      "--trf-bg-opacity",
      `${(opacity * 100).toFixed(1)}%`,
    );
    this.root.style.setProperty("--trf-style", settings.fontStyle);
    this.root.style.setProperty("--trf-weight", String(settings.textWeight));
    this.root.style.setProperty(
      "--trf-case",
      settings.textCase === "upper" ? "uppercase" : "none",
    );
    this.root.style.setProperty("--trf-outline", outlineShadow(settings));
    this.applyCustomPalette(settings);

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
    this.lastKey = null;

    // Sets `--trf-size` from the size setting and the player's current height.
    const player = this.root.parentElement;
    this.rescale(player instanceof HTMLElement ? player : null);
  }

  /**
   * Hide the reader entirely, for as long as something other than the video is
   * playing. Separate from `clear()`, which fades between cues and is meant to
   * hold the reader's place on screen — during an ad there is no place to hold,
   * and a card sitting over someone else's video is just clutter.
   */
  setHidden(hidden: boolean): void {
    this.root.classList.toggle("trf-hidden", hidden);
  }

  /** Nothing is playing, or no word covers this moment. */
  clear(): void {
    // Keyed on what is actually on screen, not on `lastKey`. `apply` clears
    // `lastKey` to force a redraw, so guarding on it here meant that after any
    // settings change this became a no-op and the last word stayed put.
    if (this.root.classList.contains("trf-idle")) return;
    this.lastKey = null;
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
    // Re-rendering the same content every frame would restart its transition
    // and make the focal point shimmer.
    const key = view.key ?? view.current.text;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.root.classList.remove("trf-idle");
    this.root.classList.remove("trf-hidden");

    switch (this.settings.mode) {
      case "rsvp":
        this.renderRsvp(view, false);
        return;
      case "rsvp-bionic":
        this.renderRsvp(view, true);
        return;
      case "focusline":
        this.renderSingle(view);
        return;
      case "bionic":
      case "plain":
      case "highlight":
        this.renderLine(view, this.settings.mode === "bionic");
        return;
      default: {
        /*
         * A mode in the union with no branch here is a build error, not a
         * surprise on screen. The previous shape of this was an if/else whose
         * `else` was RSVP, so a new mode compiled and silently rendered as
         * something else entirely.
         *
         * At runtime it still falls back rather than throwing: settings sync
         * between browsers, so a newer version of the extension on another
         * machine can legitimately hand this one a mode it has never heard of.
         */
        const unhandled: never = this.settings.mode;
        void unhandled;
        this.renderRsvp(view, false);
      }
    }
  }

  /**
   * The Custom theme's five properties.
   *
   * Written as `--trf-custom-*` and mapped across by a `[data-theme="custom"]`
   * block, rather than writing `--bg` and friends directly: every other theme
   * is defined entirely in the stylesheet, and a palette assembled half in CSS
   * and half in TypeScript is the kind of split that drifts. Cleared for every
   * other theme so a stale colour cannot leak into one.
   */
  private applyCustomPalette(settings: Settings): void {
    const palette: Record<string, string> = {
      "--trf-custom-bg": settings.customBackground,
      "--trf-custom-text": settings.customText,
      "--trf-custom-faded": settings.customFaded,
      "--trf-custom-accent": settings.customAccent,
    };
    for (const [name, value] of Object.entries(palette)) {
      if (settings.theme === "custom" && value) {
        this.root.style.setProperty(name, value);
      } else {
        this.root.style.removeProperty(name);
      }
    }
  }

  /**
   * One word at the focal point, optionally with bolded context.
   *
   * `bionicContext` is what makes RSVP + Bionic a distinct mode rather than a
   * theme. Plain RSVP gives up *parafoveal preview* — the information a normal
   * reader pulls from the next word before fixating it — and that loss is one
   * of the three real costs of the technique. Emboldening the lead letters of
   * the words either side puts some of it back: the pivot still owns fixation,
   * but the shape of what is coming is legible without looking straight at it.
   */
  private renderRsvp(view: ReaderView, bionicContext: boolean): void {
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
    /*
     * Style and weight belong in the string, not just size and family.
     *
     * `pivotOffsetPx` measures with a canvas, and a canvas measures whatever
     * font it is given. Leaving these out meant a bold or italic proportional
     * face was measured at regular upright, and the pivot landed off the column
     * by exactly the difference.
     */
    const cssFont = `${this.settings.fontStyle} ${this.settings.textWeight} ${(
      this.settings.fontSize * this.scale
    ).toFixed(2)}px ${FONT_STACKS[this.settings.font]}`;
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

    if (bionicContext) {
      this.beforeEl.replaceChildren(...bionicRun(view.previous));
      this.afterEl.replaceChildren(...bionicRun(view.upcoming));
    } else {
      this.beforeEl.textContent = view.previous.map((w) => w.text).join(" ");
      this.afterEl.textContent = view.upcoming.map((w) => w.text).join(" ");
    }
  }

  /**
   * One line of words, with the current one marked.
   *
   * Shared by every mode that reads as a sentence — Bionic, Plain, Highlighter
   * differ only in how the current word is distinguished, and that
   * is a stylesheet question. Each word gets its position as a class and the
   * mode decides what to do with it, which is why adding a fifth line mode is a
   * CSS block rather than a fifth copy of this loop.
   */
  private renderLine(view: ReaderView, bionic: boolean): void {
    const words = [...view.previous, view.current!, ...view.upcoming];
    const currentIndex = view.previous.length;

    this.beforeEl.textContent = "";
    this.afterEl.textContent = "";

    this.wordEl.replaceChildren(
      ...words.map((word, index) => {
        const span = document.createElement("span");
        const position =
          index === currentIndex
            ? "current"
            : index < currentIndex
              ? "past"
              : "future";
        span.className = `trf-lw trf-lw--${position}`;

        if (bionic) fillBionic(span, word.text);
        else span.textContent = word.text;
        return span;
      }),
    );
  }

  /**
   * One word, centred.
   *
   * RSVP without the pivot: the same word-at-a-time rhythm for people who find
   * a coloured letter mid-word distracting rather than helpful. No offset is
   * set, so the word is centred by the stage's own flexbox.
   */
  private renderSingle(view: ReaderView): void {
    this.beforeEl.textContent = "";
    this.afterEl.textContent = "";
    this.wordEl.replaceChildren(document.createTextNode(view.current!.text));
  }
}

/**
 * Append a word to `target` with its leading letters in a `<b>`.
 *
 * Shared by Bionic and by RSVP + Bionic's context, which is the whole reason it
 * is a function: these were one loop each, and the fraction that counts as
 * "leading" has to be identical in both or the same word reads differently
 * depending on which mode you happen to be in.
 */
function fillBionic(target: HTMLElement, text: string): void {
  const chars = [...text];
  const lead = Math.max(1, Math.round(chars.length * BIONIC_LEAD));
  const bold = document.createElement("b");
  bold.textContent = chars.slice(0, lead).join("");
  target.append(bold, document.createTextNode(chars.slice(lead).join("")));
}

/**
 * A run of context words, each emboldened, separated by real spaces.
 *
 * Spaces as text nodes rather than a flex `gap`: these land inside
 * `.trf-context`, which is absolutely positioned against the focus word's own
 * edges and aligned to whichever side it sits on. Making it a flex container
 * would take that alignment away, and the context would stop tracking the word
 * it belongs to.
 */
function bionicRun(words: Word[]): Node[] {
  const out: Node[] = [];
  words.forEach((word, index) => {
    if (index > 0) out.push(document.createTextNode(" "));
    const span = document.createElement("span");
    fillBionic(span, word.text);
    out.push(span);
  });
  return out;
}

/**
 * An outline around every glyph, as a `text-shadow`.
 *
 * `-webkit-text-stroke` would be the obvious tool and is the wrong one: it
 * draws the stroke *inside* the glyph, eating into the letterform until heavy
 * values turn text into a smear. Four offset shadows sit outside it instead,
 * which is how burned-in captions have always been done.
 *
 * This is the single most useful thing for legibility over an arbitrary moving
 * picture, and it is why a caption with no card behind it can work at all.
 */
function outlineShadow(settings: Settings): string {
  const width = Math.max(0, settings.textOutline);
  if (width === 0) return "none";
  const ink = "rgba(0, 0, 0, 0.92)";
  const steps: string[] = [];
  // Eight directions rather than four: at 3px and above, corners left visible
  // gaps that read as a ragged edge rather than an outline.
  for (const [x, y] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ]) {
    steps.push(`${x * width}px ${y * width}px 0 ${ink}`);
  }
  // A soft drop under the whole thing, which is what stops the outline reading
  // as a sticker pasted onto the video.
  steps.push(`0 ${width}px ${width * 1.6}px rgba(0, 0, 0, 0.45)`);
  return steps.join(", ");
}

function pivotSpan(char: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "trf-pivot";
  span.textContent = char;
  return span;
}
