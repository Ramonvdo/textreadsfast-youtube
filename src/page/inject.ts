/**
 * Runs in the *page* context, not the content script's isolated world.
 *
 * Two things are only reachable from here: `ytInitialPlayerResponse`, which
 * lists the caption tracks, and the player's own network calls, which carry a
 * caption payload already signed with whatever parameters YouTube currently
 * requires. Content scripts see neither.
 *
 * Everything found is posted back over `window.postMessage`. This script never
 * touches the DOM and never renders anything.
 */

const CHANNEL = "trf-youtube";

type OutboundKind = "tracks" | "timedtext";

function post(kind: OutboundKind, payload: unknown): void {
  window.postMessage(
    { channel: CHANNEL, kind, payload },
    window.location.origin,
  );
}

/* ── caption track list ─────────────────────────────────────────────────── */

interface CaptionTrack {
  baseUrl: string;
  languageCode?: string;
  kind?: string; // "asr" for auto-generated
  name?: { simpleText?: string };
}

/**
 * During an ad, `getPlayerResponse()` describes the *ad*, not the video behind
 * it. Publishing that would hand the content script the ad's caption track as if
 * it were the video's — and the URL's video id is identical either side of an
 * ad, so nothing downstream could tell the difference.
 */
function adShowing(): boolean {
  const player = document.querySelector("#movie_player");
  return (
    player?.classList.contains("ad-showing") ||
    player?.classList.contains("ad-interrupting") ||
    false
  );
}

function readTracks(): CaptionTrack[] {
  // The player response moves around between YouTube revisions, so try the
  // documented spot and then the player object, rather than assuming either.
  const candidates: unknown[] = [
    (window as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse,
  ];

  const player = document.querySelector<
    HTMLElement & { getPlayerResponse?: () => unknown }
  >("#movie_player");
  if (typeof player?.getPlayerResponse === "function") {
    try {
      candidates.push(player.getPlayerResponse());
    } catch {
      // The player exists but is not ready; the network hook still covers us.
    }
  }

  for (const candidate of candidates) {
    const tracks = (
      candidate as {
        captions?: {
          playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] };
        };
      }
    )?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (Array.isArray(tracks) && tracks.length > 0) return tracks;
  }
  return [];
}

function publishTracks(): void {
  if (adShowing()) return;
  const tracks = readTracks();
  if (tracks.length > 0) {
    post(
      "tracks",
      tracks.map((t) => ({
        baseUrl: t.baseUrl,
        languageCode: t.languageCode ?? "",
        isAsr: t.kind === "asr",
        label: t.name?.simpleText ?? t.languageCode ?? "",
      })),
    );
  }
}

/* ── network hook ───────────────────────────────────────────────────────── */

const isTimedText = (url: string): boolean => url.includes("/api/timedtext");

/**
 * Capture caption payloads the player fetches for itself.
 *
 * More reliable than requesting them: the player's URL already carries any
 * signature YouTube requires today, so this keeps working through changes that
 * break a hand-built request. It only fires when captions are switched on,
 * which is why it is a supplement rather than the only route.
 */
function hookNetwork(): void {
  const originalFetch = window.fetch;
  window.fetch = async function (...args: Parameters<typeof fetch>) {
    const response = await originalFetch.apply(this, args);
    try {
      const url =
        typeof args[0] === "string" ? args[0] : (args[0] as Request).url;
      if (isTimedText(url)) {
        // Clone so the player still gets to consume its own response body.
        void response
          .clone()
          .text()
          .then((body) => post("timedtext", { url, body }))
          .catch(() => undefined);
      }
    } catch {
      // Never let instrumentation break the page's own request.
    }
    return response;
  };

  // `open` is overloaded (2-arg and 5-arg forms). Both are forwarded explicitly
  // rather than spread, because calling the 5-arg form with `async: undefined`
  // is not the same as calling the 2-arg form — it would force a synchronous
  // request and hang whichever caller relied on the default.
  const originalOpen = XMLHttpRequest.prototype.open;

  function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    isAsync?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    const href = typeof url === "string" ? url : url.toString();
    if (isTimedText(href)) {
      this.addEventListener("load", () => {
        try {
          post("timedtext", { url: href, body: this.responseText });
        } catch {
          // Ignore: a failed capture just falls back to another tier.
        }
      });
    }
    if (isAsync === undefined) {
      // `.call` resolves to the widest overload, so the two-argument form has
      // to be named explicitly to reach it.
      const openDefaults = originalOpen as (
        this: XMLHttpRequest,
        method: string,
        url: string | URL,
      ) => void;
      openDefaults.call(this, method, url);
      return;
    }
    originalOpen.call(this, method, url, isAsync, username, password);
  }

  XMLHttpRequest.prototype.open =
    patchedOpen as typeof XMLHttpRequest.prototype.open;
}

hookNetwork();
publishTracks();

// YouTube is a single-page app: the next video's tracks arrive without a
// reload, and the player response is not ready the instant navigation fires.
document.addEventListener("yt-navigate-finish", () => {
  publishTracks();
  setTimeout(publishTracks, 600);
});

// The content script asks for this when an ad ends. No navigation event fires
// then — the URL was the main video's throughout — so without being asked, the
// player response we published during the ad would be the last word on it.
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window || event.origin !== window.location.origin)
    return;
  const data = event.data as { channel?: string; kind?: string };
  if (data?.channel !== CHANNEL || data.kind !== "rescan") return;
  publishTracks();
  // The response can lag the ad ending by a moment.
  setTimeout(publishTracks, 400);
  setTimeout(publishTracks, 1200);
});
