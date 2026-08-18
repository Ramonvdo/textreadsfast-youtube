/**
 * Ad detection.
 *
 * Ads are the one thing that breaks the assumption the rest of the content
 * script rests on — that a video id identifies what is playing. A pre-roll plays
 * through the same `<video>`, inside the same `#movie_player`, at the same URL.
 * The id in the address bar is the *main* video's throughout.
 *
 * That makes reading captions during an ad wrong twice over. The words belong to
 * the ad, and because the id never changes, nothing later invalidates them:
 * `yt-navigate-finish` does not fire when the ad ends, so the ad's transcript
 * plays on over the real video until the page is reloaded.
 *
 * The player announces its own state in its class list, which is the signal used
 * here. It is not a documented API, but it is long-standing and it is the only
 * one visible from the content script's world.
 */

const AD_CLASSES = ["ad-showing", "ad-interrupting"];

export function isAdShowing(player: Element | null | undefined): boolean {
  if (!player) return false;
  return AD_CLASSES.some((name) => player.classList.contains(name));
}

export type AdAction =
  /** No change worth acting on. */
  | "none"
  /** An ad started. Stop rendering, but keep whatever we already parsed. */
  | "suspend"
  /** An ad ended and we still hold the real video's captions. Just resume. */
  | "resume"
  /** An ad ended and there is no session. Ask for the player response again. */
  | "rescan";

export interface AdState {
  wasAd: boolean;
  isAd: boolean;
  /** Whether a session exists that was built while no ad was showing. */
  hasSession: boolean;
}

/**
 * What to do when the player's ad state changes.
 *
 * The distinction that matters is between a mid-roll and a pre-roll. A mid-roll
 * interrupts a session whose captions are already correct, so re-fetching them
 * would be wasted work that can also fail — route 1 can answer HTTP 200 with an
 * empty body. A pre-roll leaves no session at all, and the player response was
 * never published while the ad ran, so it has to be asked for again: no
 * navigation event fires when an ad ends.
 */
export function adAction({ wasAd, isAd, hasSession }: AdState): AdAction {
  if (wasAd === isAd) return "none";
  if (isAd) return "suspend";
  return hasSession ? "resume" : "rescan";
}
