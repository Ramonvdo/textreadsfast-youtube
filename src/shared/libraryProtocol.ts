/**
 * The content script ↔ service worker contract for the session library.
 *
 * WHY THIS CROSSES A BOUNDARY AT ALL: `indexedDB` inside a content script is the
 * *host page's* database — `https://www.youtube.com`'s, not the extension's.
 * Only `chrome.*` APIs are extension-scoped there. So the library cannot live in
 * the content script under any arrangement, and since a service worker already
 * exists for the AI calls, the database lives there and is reached by messaging.
 */

import type {
  Chapter,
  ChapterSource,
  ChatMessage,
  Note,
} from "../readmode/model";

/** Bumped only alongside an `onupgradeneeded` step in `background/db.ts`. */
export const SCHEMA_VERSION = 2;

/** Coverage resolution. 5s buckets: a three-hour video is 2,160 bytes. */
export const COVERAGE_BUCKET_MS = 5_000;

/** The library-list row. Deliberately small: no transcript, no messages. */
export interface SessionSummary {
  videoId: string;
  title: string;
  channel: string;
  durationMs: number;
  thumbnailUrl: string;
  createdAt: number;
  updatedAt: number;
  noteCount: number;
  messageCount: number;

  /* ── study stats (schema 2) ──────────────────────────────────────────── */

  /** Real elapsed time with the video actually playing. Effort. */
  watchedMs: number;
  /** Wall clock with Read Mode open and the tab visible. Time invested. */
  openMs: number;
  /** How many times Read Mode has been opened for this video. */
  openCount: number;
  lastOpenedAt: number;
  /** Share of the timeline actually seen, 0–1. Retention. */
  coveragePct: number;
}

export interface SessionRecord extends SessionSummary {
  schemaVersion: number;
  chapters: Chapter[];
  chapterSource: ChapterSource;
  summaryMarkdown: string | null;
  /**
   * One byte per `COVERAGE_BUCKET_MS` of the timeline, OR-ed across visits.
   *
   * A typed array rather than an encoded string: IndexedDB stores it through
   * structured clone with no serialisation of ours, and rewatching the same
   * thirty seconds cannot inflate it the way a running total would.
   */
  coverage: Uint8Array;
}

/** What one session contributed on one calendar day. */
export interface ActivityRecord {
  /** `${videoId}:${YYYY-MM-DD}` in local time — a study day is a local day. */
  id: string;
  videoId: string;
  day: string;
  watchedMs: number;
  openMs: number;
}

export type Granularity = "day" | "week" | "month";

export interface StatsBucket {
  /** Start of the bucket, as `YYYY-MM-DD`. */
  key: string;
  watchedMs: number;
  openMs: number;
}

export interface LibraryStats {
  totalWatchedMs: number;
  totalOpenMs: number;
  videoCount: number;
  noteCount: number;
  buckets: StatsBucket[];
}

export interface TranscriptRecord {
  videoId: string;
  language: string;
  /** What goes to the model. The timed words stay with the reader session. */
  plainText: string;
  updatedAt: number;
}

/**
 * What a caller may upsert.
 *
 * The stats are excluded deliberately: they are accumulated by
 * `library.recordActivity`, and an upsert carrying them would reset a video's
 * history every time Read Mode reopened it.
 */
export type SessionUpsertInput = Omit<
  SessionRecord,
  | "schemaVersion"
  | "coverage"
  | "watchedMs"
  | "openMs"
  | "openCount"
  | "lastOpenedAt"
  | "coveragePct"
>;

export type LibraryRequest =
  | { type: "library.upsertSession"; session: SessionUpsertInput }
  | { type: "library.putTranscript"; transcript: TranscriptRecord }
  | { type: "library.getSession"; videoId: string }
  | { type: "library.list"; limit?: number }
  | { type: "library.delete"; videoId: string }
  | { type: "library.putNote"; videoId: string; note: Note }
  | { type: "library.deleteNote"; videoId: string; noteId: string }
  | { type: "library.appendMessage"; videoId: string; message: ChatMessage }
  | { type: "library.setSummary"; videoId: string; summaryMarkdown: string }
  | {
      type: "library.recordActivity";
      videoId: string;
      /** Deltas since the last flush, never running totals. */
      watchedMs: number;
      openMs: number;
      /** Buckets newly seen this flush. Merged, never replaced. */
      seen: number[];
      totalBuckets: number;
      opened: boolean;
    }
  | { type: "library.stats"; granularity: Granularity; videoId?: string };

export interface FullSession {
  session: SessionRecord | null;
  notes: Note[];
  messages: ChatMessage[];
  transcript: TranscriptRecord | null;
}

/** Local `YYYY-MM-DD`. Deliberately not ISO/UTC: a session at 23:30 belongs to
 *  the day the person was awake for, not to tomorrow in Greenwich. */
export function dayKey(at: number | Date): string {
  const date = at instanceof Date ? at : new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export type LibraryResponse =
  | { ok: true; type: "session"; session: FullSession }
  | { ok: true; type: "stats"; stats: LibraryStats }
  | { ok: true; type: "list"; sessions: SessionSummary[] }
  | { ok: true; type: "void" }
  | { ok: false; error: string };

/** YouTube's own thumbnail for a video. No API call, no key, always present. */
export function thumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}
