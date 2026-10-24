// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./inject";

const response = (videoId: string) => ({
  videoDetails: { videoId },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        {
          baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`,
          languageCode: "en",
        },
      ],
    },
  },
});

const publishedTracks = () =>
  vi
    .mocked(window.postMessage)
    .mock.calls.map(
      ([data]) =>
        data as {
          kind: string;
          payload: { baseUrl: string }[];
        },
    )
    .filter(({ kind }) => kind === "tracks")
    .flatMap(({ payload }) =>
      payload.map((track) => new URL(track.baseUrl).searchParams.get("v")),
    );

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
  history.replaceState({}, "", "/watch?v=current");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("caption tracks after navigation", () => {
  it.each([
    ["old", "current", false, ["current"]],
    ["current", "old", false, ["current"]],
    ["old", "old", false, []],
    ["current", "throws", false, ["current"]],
    [undefined, "current", false, ["current"]],
    ["current", "current", true, []],
  ])(
    "selects tracks with initial=%s, live=%s, ad=%s",
    (initial, live, ad, expected) => {
      Object.assign(window, {
        ytInitialPlayerResponse: initial ? response(initial) : undefined,
      });
      const player = document.createElement("div");
      player.id = "movie_player";
      player.classList.toggle("ad-showing", ad);
      Object.assign(player, {
        getPlayerResponse: () => {
          if (live === "throws") throw new Error("Player not ready");
          return response(live);
        },
      });
      document.body.replaceChildren(player);

      document.dispatchEvent(new Event("yt-navigate-finish"));

      expect(publishedTracks()).toEqual(expected);
    },
  );
});
