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
  captionVideoId,
  parseCaptions,
  pickTrack,
  withoutFillers,
  wordAt,
  type CaptionTrack,
  type TimedWord,
} from "./captions";
import { ReaderOverlay } from "./overlay";
import { buildLines, lineAt, readsWholeLine, type Line } from "./lines";
import { adAction, isAdShowing } from "./ads";
import {
  forgetWatchData,
  isReadModeOpen,
  closeReadMode,
  rememberWatchData,
  toggleReadMode,
} from "./readmodeBridge";
import {
  DEFAULTS,
  DEVICE_DEFAULTS,
  loadDevicePrefs,
  loadSettings,
  onDevicePrefsChanged,
  onSettingsChanged,
  saveSettings,
  type DevicePrefs,
  type Settings,
} from "../settings";

const CHANNEL = "trf-youtube";

interface Session {
  words: TimedWord[];
  overlay: ReaderOverlay;
  video: HTMLVideoElement;
  stop: () => void;
  /** Force one redraw. A paused video presents no frames, so a settings change
   *  would otherwise not reach the screen until playback resumed. */
  redraw: () => void;
}

// Not top-level await: a content script is bundled as an IIFE, where that is a
// syntax error. Settings start at their defaults and are replaced during init.
let settings: Settings = DEFAULTS;
let session: Session | null = null;
let tracks: CaptionTrack[] = [];
/** Caption payloads seen for the current video, newest last. */
let pendingBodies: string[] = [];
let currentVideoId: string | null = null;
/** Whether an ad is on screen right now. See `ads.ts`. */
let adShowing = false;
let adWatcher: { player: HTMLElement; observer: MutationObserver } | null =
  null;
/**
 * Read Mode is showing and the viewer asked for no word stream there.
 *
 * A second, independent reason to hide the reader alongside "an ad is playing".
 * They have to compose: `update` runs every frame and would otherwise unhide on
 * the next one, which is exactly what a naive `setHidden(true)` here did.
 */
let readerSuppressed = false;
/** Device-local preferences: stats tracking and auto-entry. See `settings.ts`. */
let prefs: DevicePrefs = DEVICE_DEFAULTS;

/* ── page bridge ────────────────────────────────────────────────────────── */

function injectPageScript(): void {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inject.js");
  script.addEventListener("load", () => script.remove());
  (document.head ?? document.documentElement).appendChild(script);
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window || event.origin !== window.location.origin)
    return;
  const data = event.data as {
    channel?: string;
    kind?: string;
    payload?: unknown;
  };
  if (data?.channel !== CHANNEL) return;

  if (data.kind === "tracks") {
    const mine = (data.payload as CaptionTrack[]).filter((t) =>
      belongsToCurrentVideo(t.baseUrl),
    );
    // An empty result means every track belonged to something else — an ad.
    // Keeping what we had beats replacing it with nothing.
    if (mine.length > 0) {
      tracks = mine;
      void start();
    }
  } else if (data.kind === "watchdata") {
    // Chapters and video metadata for Read Mode. Not filtered by video id the
    // way captions are: this payload identifies its own video internally, and
    // the extractors ignore anything whose shape they do not recognise.
    rememberWatchData(
      data.payload as {
        watchData?: unknown;
        playerResponse?: unknown;
        videoId?: string | null;
      },
    );
  } else if (data.kind === "timedtext") {
    const { url, body } = data.payload as { url?: string; body: string };
    if (body && belongsToCurrentVideo(url)) {
      pendingBodies.push(body);
      void start();
    }
  }
});

/**
 * Does this payload belong to the video in the address bar?
 *
 * A caption URL names its own video id, which settles a question the ad state
 * alone cannot. The player fetches the *main* video's track during a pre-roll as
 * well as the ad's, so "arrived while an ad was showing" and "belongs to the ad"
 * are different things — and discarding on timing alone would throw away the
 * very captions being waited for.
 */
function belongsToCurrentVideo(url: string | undefined): boolean {
  const current = videoIdOf();
  const id = url ? captionVideoId(url) : null;
  // Either side unknown: fall back to the ad state, which is the weaker signal.
  if (id === null || current === null) return !adShowing;
  return id === current;
}

/** Ask the page script to re-read the player response. */
function requestRescan(): void {
  window.postMessage(
    { channel: CHANNEL, kind: "rescan" },
    window.location.origin,
  );
}

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
        const response = await fetch(url.toString(), {
          credentials: "include",
        });
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

/**
 * Which attempt at building a session currently owns the reader.
 *
 * THE BUG THIS EXISTS FOR: switching profile mid-video left two readers stacked
 * on the player, one drawing the old profile's card underneath the new one, and
 * nothing could take the old one down again.
 *
 * `start()` guards on `session` and then awaits the transcript, which takes
 * hundreds of milliseconds. `session` is still null for all of that time, so a
 * second `start()` walked straight past the guard and both calls mounted an
 * overlay. Only the last was stored, so `teardown()` had no reference left to
 * destroy the first -- it stayed in the DOM with its own frame loop running.
 *
 * A profile switch is exactly what triggers it, because a profile that differs
 * in `removeFillers` tears down and restarts, and `teardown()` is a no-op while
 * the previous start is still in flight.
 *
 * Every start claims a number, and every start and teardown invalidates the
 * ones before it. A start that was overtaken while awaiting stands down instead
 * of mounting.
 */
let generation = 0;

async function start(): Promise<void> {
  if (!settings.enabled) return;
  if (session) return; // already reading this video
  const found = findPlayer();
  if (!found) return;

  // Attached even when the start is about to be refused: the ad ending is the
  // only signal that will bring us back, since the URL never changed.
  watchAds(found.player);
  if (adShowing) return;

  const mine = ++generation;
  const words = await collectWords();
  // Overtaken while fetching the transcript, by another start or by a teardown.
  // Mounting now would leave a second reader on the player forever.
  if (mine !== generation) return;
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
    ...track(found.video, usable, overlay),
  };

  // Only now: before this, there was no transcript to open Read Mode with.
  maybeAutoEnter();
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
): { stop: () => void; redraw: () => void } {
  let stopped = false;
  let handle = 0;

  /*
   * Built once, and only if a static mode actually asks for one.
   *
   * A transcript is tens of thousands of words, and chunking it is wasted work
   * for the five modes that slide. Cached rather than recomputed per frame for
   * the same reason.
   */
  let cachedLines: Line[] | null = null;
  // Indices line up with `words` because the map is one-to-one, which is what
  // lets `lineAt` be queried with the index `wordAt` just returned.
  let cachedFor = -1;
  const lines = (): Line[] => {
    // Rebuilt when the setting changes, not only when the video does: line
    // length is a live control and the preview has to follow it.
    if (!cachedLines || cachedFor !== settings.lineWords) {
      cachedFor = settings.lineWords;
      cachedLines = buildLines(
        words.map((w) => w.word),
        settings.lineWords,
      );
    }
    return cachedLines;
  };

  const update = (): void => {
    // An ad runs through this same element on its own clock, so the transcript
    // read at that offset would be real words at meaningless moments. Hide the
    // reader outright rather than fading it: there is nothing to follow.
    //
    // The player is read directly here rather than through the cached flag. A
    // session can be built in the instant before the ad class lands, and the
    // flag would then let a frame of the real transcript render over the ad.
    if (adOnScreen() || readerSuppressed) {
      overlay.setHidden(true);
      overlay.clear();
      return;
    }
    overlay.setHidden(false);
    const timeMs = video.currentTime * 1000;
    const index = wordAt(words, timeMs);
    if (index < 0) {
      overlay.clear();
      return;
    }

    /*
     * Static is a line at a time, not a window around the playhead.
     *
     * Keyed on the line's own start index so the render guard holds the whole
     * line still: this runs once a frame, and without a key that changes only
     * at a boundary the caption would be rebuilt sixty times a second for no
     * visible reason. `current` is the line's first word purely so the guard
     * upstream still has a word to work with; nothing marks it on screen.
     */
    if (readsWholeLine(settings)) {
      const line = lineAt(lines(), index);
      if (!line) {
        overlay.clear();
        return;
      }
      overlay.render({
        key: `line:${line.startIndex}`,
        current: line.words[0],
        previous: [],
        upcoming: line.words.slice(1),
      });
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
    return {
      redraw: update,
      stop: () => {
        stopped = true;
        withFrames.cancelVideoFrameCallback?.(handle);
        video.removeEventListener("seeked", update);
      },
    };
  }

  const step = (): void => {
    if (stopped) return;
    if (!video.paused) update();
    handle = requestAnimationFrame(step);
  };
  handle = requestAnimationFrame(step);
  video.addEventListener("seeked", update);
  return {
    redraw: update,
    stop: () => {
      stopped = true;
      cancelAnimationFrame(handle);
      video.removeEventListener("seeked", update);
    },
  };
}

function teardown(): void {
  // Invalidates any start still waiting on its transcript, which is the case
  // this has to handle: with no session yet, there is nothing else to stop.
  generation += 1;
  session?.stop();
  session?.overlay.destroy();
  session = null;
  document.documentElement.classList.remove("trf-hide-native");
}

/* ── ads ────────────────────────────────────────────────────────────────── */

/**
 * Watch the player's ad state.
 *
 * Attached lazily, because `#movie_player` does not exist when the content
 * script first runs. Re-attaching to the same element is a no-op, so this can be
 * called from anywhere that has just found the player.
 */
/**
 * Is an ad on screen right now?
 *
 * Reads the player rather than the cached flag, which only updates when the
 * observer fires. Cheap enough to call per frame, and being right per frame is
 * what keeps the reader off the screen during an ad.
 */
function adOnScreen(): boolean {
  return isAdShowing(
    adWatcher?.player ?? document.querySelector("#movie_player"),
  );
}

function watchAds(player: HTMLElement): void {
  if (adWatcher?.player !== player) {
    adWatcher?.observer.disconnect();
    const observer = new MutationObserver(() => onAdStateChange(player));
    observer.observe(player, { attributes: true, attributeFilter: ["class"] });
    adWatcher = { player, observer };
  }

  // Reconcile on every call, not only on the first. A MutationObserver reports
  // changes, never the state it started from, so the page may already be mid-ad
  // when we attach — and this is also what corrects a transition that was missed
  // while no observer was attached at all.
  onAdStateChange(player);
}

function onAdStateChange(player: HTMLElement): void {
  const isAd = isAdShowing(player);
  const action = adAction({ wasAd: adShowing, isAd, hasSession: !!session });
  adShowing = isAd;

  switch (action) {
    case "suspend":
      // Done here as well as in `update`, because a paused ad presents no frames
      // and `update` would not run to notice.
      session?.overlay.setHidden(true);
      session?.overlay.clear();
      break;
    case "resume":
      // A mid-roll interrupted captions that are still correct. Re-fetching them
      // would be wasted work that can also fail.
      session?.overlay.setHidden(false);
      session?.redraw();
      break;
    case "rescan":
      // A pre-roll left no session. Nothing is discarded here: payloads are
      // filtered by the video id in their own URL, so anything held is already
      // the main video's — including tracks the player prefetched behind the ad.
      // What is missing is the player response, which `inject.ts` declines to
      // publish while an ad is showing and no navigation event will prompt again.
      requestRescan();
      void start();
      break;
    case "none":
      break;
  }
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
  autoEnteredFor = null;
  teardown();
  tracks = [];
  pendingBodies = [];
  forgetWatchData();

  // Read Mode needs its own handling here. Leaving /watch has to close it, and
  // a new video has to rebuild it — neither of which the reader session's own
  // teardown covers, since Read Mode owns the player and the page cover.
  if (isReadModeOpen()) void closeReadMode();
  if (id) {
    // The player response is not ready the instant navigation fires; the page
    // script re-publishes shortly after, which starts us properly.
    awaitPlayer();
  }
}

/**
 * Look for the player until it appears, then start.
 *
 * `#movie_player` does not exist when the content script first runs, and there
 * is one case where nothing else will ever prompt us: a pre-roll ad with
 * captions switched off. No caption request is made, and the page script
 * declines to publish a player response while an ad is showing — so without
 * this, the ad would end with no watcher attached and the video would play
 * unread until the page was reloaded.
 */
function awaitPlayer(): void {
  let tries = 0;
  const tick = (): void => {
    const found = findPlayer();
    if (found) {
      watchAds(found.player);
      void start();
      return;
    }
    if (++tries < 40) window.setTimeout(tick, 250);
  };
  tick();
}

/* ── read mode ──────────────────────────────────────────────────────────── */

/**
 * The prompt is user-editable and is not a secret, so the content script may
 * read it. An empty string means "use the shipped default", which the service
 * worker substitutes — that keeps the default in one place rather than two.
 */
async function summaryPrompt(): Promise<string> {
  try {
    const stored = await chrome.storage.local.get({
      "readmode.summaryPrompt": "",
    });
    return String(stored["readmode.summaryPrompt"] ?? "");
  } catch {
    return "";
  }
}

async function enterOrLeaveReadMode(): Promise<{
  ok: boolean;
  reason?: string;
}> {
  const reader = session
    ? { words: session.words, video: session.video, redraw: session.redraw }
    : null;
  const result = await toggleReadMode(
    reader,
    await summaryPrompt(),
    {
      on: settings.readerInReadMode,
      onChange: (on) => {
        // One source of truth: the button writes the same setting the options
        // page does, so the two can never disagree about whether the reader runs.
        readerSuppressed = on ? false : isReadModeOpen();
        session?.redraw();
        void saveSettings({ readerInReadMode: on });
      },
    },
    prefs.statsTracking,
    prefs.exportTranscript,
    prefs.exportFolder,
    prefs.exportAskWhere,
  );

  // The reader travels with the player into read mode for free, because
  // `.trf-reader` is mounted inside `#movie_player`. Honouring the setting is
  // therefore about hiding it, not about moving it.
  if (result.ok && session) {
    readerSuppressed = isReadModeOpen() && !settings.readerInReadMode;
    session.redraw();
  }
  return result;
}

/**
 * Enter Read Mode by itself, if that is what the viewer asked for.
 *
 * Only once per video and only when a session with captions exists, since Read
 * Mode without a transcript has nothing to show. Never fights a manual exit:
 * `autoEnteredFor` remembers the video, so closing it stays closed.
 */
let autoEnteredFor: string | null = null;

function maybeAutoEnter(): void {
  if (!prefs.autoReadMode) return;
  if (isReadModeOpen() || !session) return;
  const id = videoIdOf();
  if (!id || autoEnteredFor === id) return;
  autoEnteredFor = id;
  void enterOrLeaveReadMode();
}

async function init(): Promise<void> {
  settings = await loadSettings();
  prefs = await loadDevicePrefs();

  onDevicePrefsChanged((next) => {
    prefs = next;
    maybeAutoEnter();
  });

  // The popup is an extension page and cannot reach the player, so it asks.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if ((message as { type?: string })?.type !== "readmode.toggle")
      return false;
    void enterOrLeaveReadMode().then(sendResponse);
    return true; // async reply; returning falsy closes the channel
  });

  // Shift+R rather than a bare letter: YouTube already owns most single keys,
  // and a modifier keeps this from firing while someone types in a comment.
  document.addEventListener("keydown", (event) => {
    if (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey)
      return;
    if (event.key !== "R" && event.key !== "r") return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable)
    ) {
      return;
    }
    event.preventDefault();
    void enterOrLeaveReadMode();
  });

  onSettingsChanged((next) => {
    const previous = settings;
    settings = next;

    if (!next.enabled) {
      teardown();
      return;
    }
    if (!previous.enabled) {
      void start();
      return;
    }

    // Toggling it while read mode is open should take effect immediately.
    readerSuppressed = isReadModeOpen() && !next.readerInReadMode;

    // Filler removal is applied when the word list is built, not when it is
    // read, so this one setting cannot be handled by redrawing. Rebuild instead.
    if (previous.removeFillers !== next.removeFillers) {
      teardown();
      void start();
      return;
    }

    session?.overlay.apply(next);
    // A profile switch changes several things at once, the reading mode among
    // them. Without this the change waits for the next presented frame, and a
    // paused video never presents one.
    session?.redraw();
    document.documentElement.classList.toggle(
      "trf-hide-native",
      next.hideNativeCaptions,
    );
  });

  document.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("popstate", onNavigate);
  window.addEventListener("pagehide", teardown);

  injectPageScript();
  currentVideoId = videoIdOf();
  awaitPlayer();
}

void init();
