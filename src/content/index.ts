/**
 * Content script: wire the caption timeline to the video clock.
 *
 * This reader is much simpler than the desktop app's, and for one reason: the
 * whole transcript arrives with timings attached. There is no queue, no
 * backpressure and no pacing to estimate — the current word is a lookup against
 * `video.currentTime`.
 *
 * That is also why playback rate needs no handling at all. `currentTime` already
 * accounts for it, so watching at 2x simply moves the words twice as fast, which
 * is the point: RSVP is what makes 2x comprehensible.
 */

import {
  parseCaptions,
  pickTrack,
  withoutFillers,
  wordAt,
  type CaptionTrack,
  type TimedWord,
} from "./captions";
import { ReaderOverlay } from "./overlay";
import { DEFAULTS, loadSettings, onSettingsChanged, type Settings } from "../settings";

const CHANNEL = "trf-youtube";

interface Session {
  words: TimedWord[];
  overlay: ReaderOverlay;
  video: HTMLVideoElement;
  stop: () => void;
}

// Not top-level await: a content script is bundled as an IIFE, where that is a
// syntax error. Settings start at their defaults and are replaced during init.
let settings: Settings = DEFAULTS;
let session: Session | null = null;
let tracks: CaptionTrack[] = [];
/** Caption payloads seen for the current video, newest last. */
let pendingBodies: string[] = [];
let currentVideoId: string | null = null;

/* ── page bridge ────────────────────────────────────────────────────────── */

function injectPageScript(): void {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inject.js");
  script.addEventListener("load", () => script.remove());
  (document.head ?? document.documentElement).appendChild(script);
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data as { channel?: string; kind?: string; payload?: unknown };
  if (data?.channel !== CHANNEL) return;

  if (data.kind === "tracks") {
    tracks = data.payload as CaptionTrack[];
    void start();
  } else if (data.kind === "timedtext") {
    const { body } = data.payload as { body: string };
    if (body) {
      pendingBodies.push(body);
      void start();
    }
  }
});

/* ── caption acquisition ────────────────────────────────────────────────── */

/**
 * Three routes, tried in order of how much they give us.
 *
 * Fetching the track ourselves works without the viewer switching captions on,
 * but YouTube increasingly signs these URLs and can refuse. The player's own
 * response always carries whatever signature is currently required, but only
 * exists once captions are enabled. Neither is guaranteed, so both are tried
 * and failure is quiet.
 */
async function collectWords(): Promise<TimedWord[]> {
  const track = pickTrack(tracks, settings.language);
  if (track) {
    for (const format of ["json3", ""]) {
      try {
        const url = new URL(track.baseUrl);
        if (format) url.searchParams.set("fmt", format);
        const response = await fetch(url.toString(), { credentials: "include" });
        // Note the missing `!response.ok` shortcut. Requesting a caption track
        // without the proof-of-origin token the player attaches returns
        // **HTTP 200 with an empty body**, not an error — verified against a
        // live video. Anything that trusted the status code here would decide
        // it had captions and then render nothing, so success is judged by
        // whether words actually came out.
        if (!response.ok) continue;
        const words = parseCaptions(await response.text());
        if (words.length > 0) return words;
      } catch {
        // Network refusal: fall through to what the player fetched for itself.
      }
    }
  }

  // Newest first: a later payload is likelier to be the track now on screen.
  for (const body of [...pendingBodies].reverse()) {
    const words = parseCaptions(body);
    if (words.length > 0) return words;
  }
  return [];
}

/* ── session ────────────────────────────────────────────────────────────── */

const videoIdOf = (): string | null =>
  new URLSearchParams(window.location.search).get("v");

function findPlayer(): { player: HTMLElement; video: HTMLVideoElement } | null {
  const player = document.querySelector<HTMLElement>("#movie_player");
  const video = player?.querySelector<HTMLVideoElement>("video");
  return player && video ? { player, video } : null;
}

async function start(): Promise<void> {
  if (!settings.enabled) return;
  if (session) return; // already reading this video
  const found = findPlayer();
  if (!found) return;

  const words = await collectWords();
  if (words.length === 0) return; // no captions: do nothing, quietly

  const usable = settings.removeFillers ? withoutFillers(words) : words;
  const overlay = new ReaderOverlay(settings);
  overlay.mount(found.player);
  document.documentElement.classList.toggle(
    "trf-hide-native",
    settings.hideNativeCaptions,
  );

  session = {
    words: usable,
    overlay,
    video: found.video,
    stop: track(found.video, usable, overlay),
  };
}

/**
 * Follow the video clock.
 *
 * `requestVideoFrameCallback` is preferred: it fires in step with presented
 * frames, so the word changes when the viewer actually sees that moment. It
 * also stops on its own while paused. rAF is the fallback for browsers without
 * it, where a pause check is needed explicitly.
 */
function track(
  video: HTMLVideoElement,
  words: TimedWord[],
  overlay: ReaderOverlay,
): () => void {
  let stopped = false;
  let handle = 0;

  const update = (): void => {
    const timeMs = video.currentTime * 1000;
    const index = wordAt(words, timeMs);
    if (index < 0) {
      overlay.clear();
      return;
    }
    overlay.render({
      current: words[index].word,
      previous: words
        .slice(Math.max(0, index - settings.contextBefore), index)
        .map((w) => w.word),
      upcoming: words
        .slice(index + 1, index + 1 + settings.contextAfter)
        .map((w) => w.word),
    });
  };

  type WithFrameCallback = HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number;
    cancelVideoFrameCallback?: (id: number) => void;
  };
  const withFrames = video as WithFrameCallback;

  if (typeof withFrames.requestVideoFrameCallback === "function") {
    const step = (): void => {
      if (stopped) return;
      update();
      handle = withFrames.requestVideoFrameCallback!(step);
    };
    handle = withFrames.requestVideoFrameCallback(step);
    // A paused video presents no frames, so the callback stops firing and the
    // last word simply stays — which is the behaviour we want. Seeking while
    // paused still needs an explicit nudge.
    video.addEventListener("seeked", update);
    return () => {
      stopped = true;
      withFrames.cancelVideoFrameCallback?.(handle);
      video.removeEventListener("seeked", update);
    };
  }

  const step = (): void => {
    if (stopped) return;
    if (!video.paused) update();
    handle = requestAnimationFrame(step);
  };
  handle = requestAnimationFrame(step);
  video.addEventListener("seeked", update);
  return () => {
    stopped = true;
    cancelAnimationFrame(handle);
    video.removeEventListener("seeked", update);
  };
}

function teardown(): void {
  session?.stop();
  session?.overlay.destroy();
  session = null;
  document.documentElement.classList.remove("trf-hide-native");
}

/* ── navigation ─────────────────────────────────────────────────────────── */

/**
 * YouTube never reloads. Every video change has to tear the previous session
 * down explicitly, or listeners and overlays accumulate for the whole session.
 */
function onNavigate(): void {
  const id = videoIdOf();
  if (id === currentVideoId) return;
  currentVideoId = id;
  teardown();
  tracks = [];
  pendingBodies = [];
  if (id) {
    // The player response is not ready the instant navigation fires; the page
    // script re-publishes shortly after, which starts us properly.
    void start();
  }
}

async function init(): Promise<void> {
  settings = await loadSettings();

  onSettingsChanged((next) => {
    const wasEnabled = settings.enabled;
    settings = next;
    if (!next.enabled) {
      teardown();
      return;
    }
    if (!wasEnabled) {
      void start();
      return;
    }
    session?.overlay.apply(next);
    document.documentElement.classList.toggle("trf-hide-native", next.hideNativeCaptions);
  });

  document.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("popstate", onNavigate);
  window.addEventListener("pagehide", teardown);

  injectPageScript();
  currentVideoId = videoIdOf();
  void start();
}

void init();
