import { describe, expect, it } from "vitest";
import { adAction, isAdShowing } from "./ads";

/** A stand-in for the player element, since these tests do not run in a DOM. */
const player = (...classes: string[]) =>
  ({
    classList: { contains: (name: string) => classes.includes(name) },
  }) as Element;

describe("isAdShowing", () => {
  it("recognises both classes the player uses", () => {
    expect(isAdShowing(player("ad-showing"))).toBe(true);
    expect(isAdShowing(player("ad-interrupting"))).toBe(true);
    expect(isAdShowing(player("playing-mode", "ad-showing"))).toBe(true);
  });

  it("is false for an ordinary player, and for no player at all", () => {
    expect(isAdShowing(player("playing-mode", "ytp-fullscreen"))).toBe(false);
    expect(isAdShowing(null)).toBe(false);
    expect(isAdShowing(undefined)).toBe(false);
  });
});

describe("adAction", () => {
  it("does nothing when the ad state has not changed", () => {
    expect(adAction({ wasAd: false, isAd: false, hasSession: true })).toBe(
      "none",
    );
    expect(adAction({ wasAd: true, isAd: true, hasSession: false })).toBe(
      "none",
    );
  });

  it("suspends when an ad starts", () => {
    expect(adAction({ wasAd: false, isAd: true, hasSession: true })).toBe(
      "suspend",
    );
    expect(adAction({ wasAd: false, isAd: true, hasSession: false })).toBe(
      "suspend",
    );
  });

  // A mid-roll interrupts captions that are already correct. Re-fetching them
  // would be wasted work that can also fail outright — route 1 answers HTTP 200
  // with an empty body when it is refused.
  it("resumes after a mid-roll, keeping the captions it already has", () => {
    expect(adAction({ wasAd: true, isAd: false, hasSession: true })).toBe(
      "resume",
    );
  });

  // The reported bug: a pre-roll leaves no session, and everything captured
  // while it ran describes the ad. Reusing that put the ad's transcript over the
  // real video, and nothing could later invalidate it, because the URL's video
  // id was the main video's the whole time.
  it("rescans after a pre-roll, discarding what the ad left behind", () => {
    expect(adAction({ wasAd: true, isAd: false, hasSession: false })).toBe(
      "rescan",
    );
  });
});
