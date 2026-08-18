/**
 * Content-side client for the session library.
 *
 * Thin on purpose: it speaks the message protocol and nothing else. It never
 * opens IndexedDB, because a content script's `indexedDB` is YouTube's own
 * database rather than the extension's — only `chrome.*` is extension-scoped
 * here. The real store lives in the service worker.
 */

import type {
  FullSession,
  Granularity,
  LibraryRequest,
  LibraryResponse,
  LibraryStats,
  SessionSummary,
  SessionUpsertInput,
  TranscriptRecord,
} from "../shared/libraryProtocol";
import type { ChatMessage, Note } from "./model";

async function send(request: LibraryRequest): Promise<LibraryResponse> {
  try {
    return (await chrome.runtime.sendMessage(request)) as LibraryResponse;
  } catch (error) {
    // The worker can be asleep or the extension reloaded mid-session. Saving a
    // note is not worth throwing into the reading loop over.
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function upsertSession(
  session: SessionUpsertInput,
): Promise<void> {
  await send({ type: "library.upsertSession", session });
}

/**
 * Report what happened since the last flush.
 *
 * Deltas, never totals: two tabs on the same video would otherwise overwrite
 * each other's numbers instead of adding to them.
 */
export async function recordActivity(input: {
  videoId: string;
  watchedMs: number;
  openMs: number;
  seen: number[];
  totalBuckets: number;
  opened: boolean;
}): Promise<void> {
  await send({ type: "library.recordActivity", ...input });
}

export async function stats(
  granularity: Granularity,
  videoId?: string,
): Promise<LibraryStats | null> {
  const reply = await send({ type: "library.stats", granularity, videoId });
  return reply.ok && reply.type === "stats" ? reply.stats : null;
}

export async function putTranscript(
  transcript: TranscriptRecord,
): Promise<void> {
  await send({ type: "library.putTranscript", transcript });
}

export async function getSession(videoId: string): Promise<FullSession | null> {
  const reply = await send({ type: "library.getSession", videoId });
  return reply.ok && reply.type === "session" ? reply.session : null;
}

export async function listSessions(limit?: number): Promise<SessionSummary[]> {
  const reply = await send({ type: "library.list", limit });
  return reply.ok && reply.type === "list" ? reply.sessions : [];
}

export async function putNote(videoId: string, note: Note): Promise<void> {
  await send({ type: "library.putNote", videoId, note });
}

export async function deleteNote(
  videoId: string,
  noteId: string,
): Promise<void> {
  await send({ type: "library.deleteNote", videoId, noteId });
}

export async function appendMessage(
  videoId: string,
  message: ChatMessage,
): Promise<void> {
  await send({ type: "library.appendMessage", videoId, message });
}

export async function setSummary(
  videoId: string,
  summaryMarkdown: string,
): Promise<void> {
  await send({ type: "library.setSummary", videoId, summaryMarkdown });
}
