/**
 * Stopping a model that has come off the rails.
 *
 * THE INCIDENT THIS EXISTS FOR: a free model answered a summary request with
 * `<pad>` repeated thousands of times and kept going. Nothing stopped it —
 * there was no token cap on the request, so the only limit was the model's own
 * context window, and the reader watched a wall of padding tokens fill the
 * panel.
 *
 * Three independent brakes, because each catches a different failure:
 *
 * 1. **Special tokens are stripped.** A model leaking `<pad>` or `<|eot_id|>`
 *    into its output is emitting its own plumbing; none of it should ever be
 *    rendered.
 * 2. **Repetition is detected.** Degeneration nearly always looks like one
 *    short pattern repeating, and that is cheap to spot without waiting for a
 *    length cap that a slow stream might never reach.
 * 3. **Total length is capped.** The backstop for a model that rambles
 *    coherently rather than repeating.
 *
 * Pure and synchronous so every threshold can be tested against real degenerate
 * output — the risk with a guard like this is not that it fails to fire, it is
 * that it fires on legitimate text.
 */

/** Model plumbing that occasionally leaks into a completion. */
const SPECIAL_TOKENS =
  /<\|[^|>]{0,40}\|>|<\/?(?:pad|unk|s|eos|bos|mask|sep|cls)>/gi;

/**
 * Long enough for a thorough summary of a three-hour video, short enough that a
 * runaway is caught in seconds rather than minutes.
 */
export const MAX_REPLY_CHARS = 24_000;

/** How much recent output the repetition check looks at. */
const WINDOW = 600;

/** The longest repeating unit worth hunting for. */
const MAX_PATTERN = 60;

/**
 * Is the tail of this text one short pattern repeated over and over?
 *
 * Deliberately requires the pattern to fill the *whole* window: a numbered list
 * or a run of similar bullet points repeats structure but not text, so it never
 * matches. `<pad><pad><pad>…` matches immediately.
 */
export function looksDegenerate(text: string): boolean {
  if (text.length < WINDOW) return false;
  const tail = text.slice(-WINDOW);

  for (let size = 1; size <= MAX_PATTERN; size += 1) {
    const unit = tail.slice(0, size);
    // A pattern of only whitespace is a formatting quirk, not degeneration.
    if (unit.trim() === "") continue;

    let matches = true;
    for (let at = size; at < tail.length; at += size) {
      if (tail.slice(at, at + size) !== unit.slice(0, tail.length - at)) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }

  return false;
}

export type GuardVerdict =
  { stop: false; text: string } | { stop: true; text: string; reason: string };

/**
 * Filters one stream, and says when to abort it.
 *
 * `push` returns the text that should actually be shown, which is never quite
 * what arrived: special tokens are removed on the way through.
 */
export class RunawayGuard {
  /**
   * The stream as it arrived, kept for detection only.
   *
   * Detection has to run on the RAW text. Stripping `<pad>` first and then
   * looking for repetition finds nothing, because the repetition was entirely
   * in the tokens just removed — the guard would sit silently while the model
   * ran to its context limit. That mistake was in the first version of this
   * file and is exactly what the tests caught.
   */
  private raw = "";
  /** What has actually been shown, which is what "empty" should mean. */
  private shown = "";

  push(delta: string): GuardVerdict {
    const clean = delta.replace(SPECIAL_TOKENS, "");
    this.raw += delta;
    this.shown += clean;

    if (this.raw.length > MAX_REPLY_CHARS) {
      return {
        stop: true,
        text: clean,
        reason:
          "The model kept going past a reasonable length and was stopped.",
      };
    }

    if (looksDegenerate(this.raw)) {
      return {
        stop: true,
        text: clean,
        reason:
          "The model started repeating itself and was stopped. Try again, or pick a different model in settings.",
      };
    }

    return { stop: false, text: clean };
  }

  /**
   * Did anything usable arrive?
   *
   * A stream that was *entirely* special tokens leaves nothing behind, and
   * showing an empty bubble would be worse than saying so.
   */
  get isEmpty(): boolean {
    return this.shown.trim() === "";
  }
}
