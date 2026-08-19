/**
 * The seam between the reader session and Read Mode.
 *
 * Kept out of `index.ts` because that file is already the busiest in the
 * repository, and because everything here is about *assembling* a Read Mode
 * context rather than about following the video clock. `index.ts` hands over the
 * pieces it owns — the transcript and the video element — and this decides
 * whether there is enough to open with.
 */

import {
  chaptersFrom,
  chaptersFromTranscript,
  transcriptForChapters,
  videoMetaFrom,
} from "../readmode/chapters";
import {
  closeReadMode,
  isReadModeOpen,
  openReadMode,
} from "../readmode/controller";
import type { Chapter, ChapterSource } from "../readmode/model";
import type { TimedWord } from "./captions";

/** The most recent page data seen for this video, from the page-context bridge. */
let watchData: unknown = null;
let playerResponse: unknown = null;

/**
 * Keep only the data that describes the video actually on screen.
 *
 * `ytInitialData` belongs to whichever page was first loaded and is never
 * refreshed on SPA navigation, so without this check clicking through to a video
 * handed the reader the previous page's outline — which is why a properly
 * chaptered video reported having none. The page script now names the video each
 * payload is about; anything else is dropped rather than allowed to overwrite
 * the correct data that arrived from `/youtubei/v1/next`.
 */
export function rememberWatchData(next: {
  watchData?: unknown;
  playerResponse?: unknown;
  videoId?: string | null;
}): void {
  const current = new URLSearchParams(window.location.search).get("v");
  if (next.videoId && current && next.videoId !== current) return;

  if (next.watchData) watchData = next.watchData;
  if (next.playerResponse) playerResponse = next.playerResponse;
}

export function forgetWatchData(): void {
  watchData = null;
  playerResponse = null;
}

/**
 * Transcript words to one block of prose.
 *
 * The model has no use for per-word timings, and sending them would multiply the
 * token count for nothing. Sentence breaks are inferred from gaps, which reads
 * far better than one unbroken wall of words.
 */
export function transcriptText(words: TimedWord[]): string {
  const GAP_MS = 900;
  const parts: string[] = [];
  let previousEnd = 0;

  for (const entry of words) {
    if (parts.length > 0 && entry.startMs - previousEnd > GAP_MS)
      parts.push("\n");
    parts.push(entry.word.text);
    previousEnd = entry.endMs;
  }

  return parts
    .join(" ")
    .replace(/ \n /g, "\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

interface ReaderSession {
  words: TimedWord[];
  video: HTMLVideoElement;
  redraw: () => void;
}

export interface ToggleResult {
  ok: boolean;
  reason?: string;
}

/**
 * Enter Read Mode for the session currently playing, or leave it.
 *
 * Refuses rather than opening half a view: without a transcript there is nothing
 * to summarise and nothing to derive sections from, which would be a worse
 * experience than the ordinary page.
 */
export async function toggleReadMode(
  reader: ReaderSession | null,
  summaryPrompt: string,
  subtitles: { on: boolean; onChange: (on: boolean) => void },
  trackStats: boolean,
  exportTranscript: boolean,
  exportFolder: string,
  exportAskWhere: boolean,
): Promise<ToggleResult> {
  if (isReadModeOpen()) {
    const closed = await closeReadMode();
    return {
      ok: closed,
      reason: closed ? undefined : "The player could not be returned.",
    };
  }

  const videoId = new URLSearchParams(window.location.search).get("v");
  if (!videoId)
    return { ok: false, reason: "Read mode only works on a video page." };
  if (!reader)
    return { ok: false, reason: "No captions found for this video yet." };

  const meta = videoMetaFrom(playerResponse);
  const durationMs =
    meta?.durationMs ||
    (Number.isFinite(reader.video.duration) ? reader.video.duration * 1000 : 0);

  const found = chaptersFrom(watchData);
  let chapters: Chapter[] = found?.chapters ?? [];
  let chapterSource: ChapterSource = found?.source ?? "none";

  // YouTube's own chapters are always preferred. Deriving from transcript gaps
  // is the honest fallback when the video simply has none — labelled as such in
  // the view so nobody mistakes a guess for the author's own outline.
  const lines = reader.words.map((w) => ({
    startMs: w.startMs,
    endMs: w.endMs,
    text: w.word.text,
  }));

  if (chapters.length === 0 && reader.words.length > 0) {
    chapters = chaptersFromTranscript(
      reader.words.map((w) => ({
        startMs: w.startMs,
        endMs: w.endMs,
        text: w.word.text,
      })),
      durationMs,
    );
    chapterSource = chapters.length > 0 ? "derived" : "none";
  }

  await openReadMode(
    {
      videoId,
      video: reader.video,
      transcript: transcriptText(reader.words),
      title: meta?.title ?? document.title.replace(/ - YouTube$/, ""),
      channel: meta?.channel ?? "",
      durationMs,
      chapters,
      chapterSource,
      // Only built when it will be used; a model never sees this otherwise.
      chapterSeed:
        chapterSource === "derived" ? transcriptForChapters(lines) : undefined,
      redrawReader: reader.redraw,
      subtitles: subtitles.on,
      onSubtitlesChange: subtitles.onChange,
      trackStats,
      exportTranscript,
      exportFolder,
      exportAskWhere,
    },
    summaryPrompt,
  );

  return { ok: true };
}

export { isReadModeOpen, closeReadMode };
