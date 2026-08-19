/**
 * The content script ↔ service worker contract for AI chat.
 *
 * Imported by both sides so the message shapes cannot drift apart. Only types
 * and constants live here — nothing that touches `chrome.*`, so either context
 * can import it without dragging the other's dependencies along.
 *
 * WHY A SERVICE WORKER AT ALL: content-script `fetch` has been subject to the
 * *host page's* CORS since Chrome 85. A request to a model provider from a
 * content script on youtube.com is cross-origin from `https://www.youtube.com`,
 * and no provider sends an `Access-Control-Allow-Origin` for it. A service
 * worker's fetch runs on the extension origin, where host permissions apply.
 *
 * WHY A PORT AND NOT `sendMessage`: an MV3 worker is torn down after ~30s idle.
 * Port traffic resets that timer, so token deltas keep the worker alive for the
 * length of the stream. `onDisconnect` also gives cancellation for free when
 * Read Mode closes or the tab navigates, which one-shot messaging does not.
 */

export const AI_PORT = "trf-ai";

/** A turn as the provider wants it. Deliberately the OpenAI shape. */
export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Everything the model is told about the video, assembled by the content script
 * because only it can see the transcript and the notes.
 */
export interface ChatContext {
  videoId: string;
  title: string;
  channel: string;
  /** Plain transcript text. Not the timed words — the model has no use for those. */
  transcript: string;
  /** The user's own notes, so "what did I mean at 10:21" works. */
  notes: Array<{ atMs: number; text: string }>;
}

export type ErrorCode =
  /** No API key configured. The UI should offer to open settings. */
  | "no_key"
  /** The provider origin was never granted. Only an extension page can ask. */
  | "no_permission"
  | "rate_limit"
  | "bad_key"
  /** The chosen model is gone, renamed, or no longer free. Recoverable by
   *  choosing another, which is why it is not lumped in with `network`. */
  | "bad_model"
  | "network"
  | "aborted";

/** content → background */
export type AiRequest =
  | {
      type: "chat.start";
      requestId: string;
      /** Prepended as the system turn. The summary prompt, or the chat persona. */
      system: string;
      messages: ChatTurn[];
      context: ChatContext;
    }
  | { type: "chat.cancel"; requestId: string };

/** background → content */
export type AiResponse =
  /** Sent immediately, before the first token, so the UI can stop guessing. */
  | { type: "chat.open"; requestId: string; model: string }
  | { type: "chat.delta"; requestId: string; text: string }
  | { type: "chat.done"; requestId: string; stopReason: string | null }
  | { type: "chat.error"; requestId: string; code: ErrorCode; message: string };

export function newRequestId(): string {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * How the model is told about the video.
 *
 * A USER turn, not a system one. The first version put the whole transcript in
 * the system message, and a free model answered a long video with `<pad>`
 * repeated to its context limit — while the chapter call, which sends its text
 * as a user turn, handled the same video on the same model perfectly. A system
 * message is meant for instructions; tens of thousands of tokens of transcript
 * in one is not what providers tune for.
 */
export function buildContextTurn(context: ChatContext): string {
  const parts = [`# Video: ${context.title}`];
  if (context.channel) parts.push(`Channel: ${context.channel}`);
  parts.push("", "# Transcript", "", context.transcript);

  if (context.notes.length > 0) {
    parts.push("", "# The viewer's own notes", "");
    for (const note of context.notes) {
      const total = Math.floor(note.atMs / 1000);
      const stamp = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
      parts.push(`- [${stamp}] ${note.text}`);
    }
  }

  return parts.join("\n");
}
