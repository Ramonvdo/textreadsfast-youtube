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
export const SCHEMA_VERSION = 1;

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
}

export interface SessionRecord extends SessionSummary {
  schemaVersion: number;
  chapters: Chapter[];
  chapterSource: ChapterSource;
  summaryMarkdown: string | null;
}

export interface TranscriptRecord {
  videoId: string;
  language: string;
  /** What goes to the model. The timed words stay with the reader session. */
  plainText: string;
  updatedAt: number;
}

export type LibraryRequest =
  | {
      type: "library.upsertSession";
      session: Omit<SessionRecord, "schemaVersion">;
    }
  | { type: "library.putTranscript"; transcript: TranscriptRecord }
  | { type: "library.getSession"; videoId: string }
  | { type: "library.list"; limit?: number }
  | { type: "library.delete"; videoId: string }
  | { type: "library.putNote"; videoId: string; note: Note }
  | { type: "library.deleteNote"; videoId: string; noteId: string }
  | { type: "library.appendMessage"; videoId: string; message: ChatMessage }
  | { type: "library.setSummary"; videoId: string; summaryMarkdown: string };

export interface FullSession {
  session: SessionRecord | null;
  notes: Note[];
  messages: ChatMessage[];
  transcript: TranscriptRecord | null;
}

export type LibraryResponse =
  | { ok: true; type: "session"; session: FullSession }
  | { ok: true; type: "list"; sessions: SessionSummary[] }
  | { ok: true; type: "void" }
  | { ok: false; error: string };

/** YouTube's own thumbnail for a video. No API call, no key, always present. */
export function thumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}
