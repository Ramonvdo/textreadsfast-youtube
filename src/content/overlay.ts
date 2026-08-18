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
import { pivotOffsetCh, pivotOffsetPx, clearPivotCache } from "../reader-core/pivotOffset";
import { FONT_STACKS, isMonospace } from "../reader-core/fonts";
import type { Word } from "../reader-core/words";
import type { Settings } from "../settings";

/** Fraction of a word rendered bold in Bionic mode. */
const BIONIC_LEAD = 0.42;

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
  }

  destroy(): void {
    this.root.remove();
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
    this.root.style.setProperty("--trf-size", `${settings.fontSize}px`);
    this.root.style.setProperty("--trf-tracking", `${settings.letterSpacing}px`);
    this.root.style.setProperty("--trf-context-opacity", String(settings.contextOpacity));

    this.guideTop.style.display = settings.showPivotGuides ? "" : "none";
    this.guideBottom.style.display = settings.showPivotGuides ? "" : "none";

    if (fontChanged) {
      // Cached pixel offsets were measured in the old face and would put the
      // pivot in the wrong place.
      clearPivotCache();
      this.lastText = null;
    }
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
    const offset = isMonospace(this.settings.font)
      ? `${pivotOffsetCh(text)}ch`
      : `${pivotOffsetPx(
          text,
          `${this.settings.fontSize}px ${FONT_STACKS[this.settings.font]}`,
          this.settings.letterSpacing,
        )}px`;
    this.wordEl.style.setProperty("--trf-pivot-offset", offset);

    this.beforeEl.textContent = view.previous.map((w) => w.text).join(" ");
    this.afterEl.textContent = view.upcoming.map((w) => w.text).join(" ");
  }

  private renderBionic(view: ReaderView): void {
    const words = [...view.previous, view.current!, ...view.upcoming];
    const currentIndex = view.previous.length;

    this.beforeEl.textContent = "";
    this.afterEl.textContent = "";
    this.wordEl.style.removeProperty("--trf-pivot-offset");

    this.wordEl.replaceChildren(
      ...words.map((word, index) => {
        const chars = [...word.text];
        const lead = Math.max(1, Math.round(chars.length * BIONIC_LEAD));
        const span = document.createElement("span");
        span.className =
          index === currentIndex ? "trf-bionic trf-bionic--current" : "trf-bionic";
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
