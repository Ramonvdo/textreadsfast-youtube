/**
 * Read Mode's data model, and the pure derivations over it.
 *
 * Zero DOM, zero `chrome.*`, zero network. Everything the view draws is a
 * function of one plain object, which is what lets the whole interface render in
 * headless Chromium from a fixture with no YouTube page involved — the same
 * split that keeps `captions.ts` testable while `content/index.ts` does wiring.
 */

/** A section of the video, from YouTube's own chapters or derived. */
export interface Chapter {
  title: string;
  startMs: number;
  /** Filled in by `chaptersWithEnds`; the raw sources never carry an end. */
  endMs?: number;
}

/**
 * Where the left navigation's sections came from.
 *
 * Surfaced in the UI because "YouTube's chapters" and "we guessed" deserve
 * different amounts of trust from the reader.
 */
export type ChapterSource =
  | "description" // author-written, the best case
  | "auto" // YouTube's own auto-chapters
  | "ai" // generated here, when the video has none
  | "derived" // split from transcript gaps, no model involved
  | "none";

export interface Note {
  id: string;
  /** Position in the video when the note was taken. */
  atMs: number;
  text: string;
  createdAt: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  /** True while tokens are still streaming into this message. */
  streaming?: boolean;
}

/** What the chat column is doing, so the view never has to infer it. */
export type ChatState =
  | { kind: "idle" }
  | { kind: "loading" }
  /** `setupUrl` is an extension page rendered inline so the key can be entered
   *  without leaving the video. Optional so the harness can render this state
   *  without an extension around it. */
  | { kind: "needs-key"; setupUrl?: string }
  | { kind: "error"; message: string; retryable: boolean };

export interface ReadModeModel {
  videoId: string;
  title: string;
  channel: string;
  durationMs: number;
  /** Playhead, so the active chapter and new notes can be placed. */
  currentMs: number;
  chapters: Chapter[];
  chapterSource: ChapterSource;
  notes: Note[];
  messages: ChatMessage[];
  chat: ChatState;
}

export function emptyModel(videoId: string): ReadModeModel {
  return {
    videoId,
    title: "",
    channel: "",
    durationMs: 0,
    currentMs: 0,
    chapters: [],
    chapterSource: "none",
    notes: [],
    messages: [],
    chat: { kind: "idle" },
  };
}

/**
 * Give every chapter an end.
 *
 * None of YouTube's chapter sources carry one: each chapter ends where the next
 * begins, and the last runs to the end of the video. Sorted first, because the
 * description-parsing tier can hand back timestamps in whatever order the author
 * typed them.
 */
export function chaptersWithEnds(
  chapters: Chapter[],
  durationMs: number,
): Chapter[] {
  const sorted = [...chapters].sort((a, b) => a.startMs - b.startMs);
  return sorted.map((chapter, index) => ({
    ...chapter,
    endMs: index + 1 < sorted.length ? sorted[index + 1].startMs : durationMs,
  }));
}

/**
 * Index of the chapter covering `ms`, or -1.
 *
 * Binary search: this runs on every presented frame to keep the left nav's
 * active marker in step with the video, exactly as `wordAt` does for the reader.
 */
export function chapterAt(chapters: Chapter[], ms: number): number {
  let low = 0;
  let high = chapters.length - 1;
  let found = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (chapters[mid].startMs <= ms) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  // A chapter list that starts after 0 leaves the opening seconds uncovered.
  if (found === -1) return -1;
  const end = chapters[found].endMs;
  return end !== undefined && ms >= end ? -1 : found;
}

/**
 * `m:ss`, or `h:mm:ss` past an hour — the form YouTube itself uses, so a
 * timestamp read here matches the one on the scrubber.
 */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/** A stable id for a note. Time-ordered, so it sorts naturally. */
export function noteId(videoId: string, createdAt: number): string {
  return `${videoId}:${createdAt}`;
}

/**
 * Notes as Markdown, for export.
 *
 * Timestamps are written as links back into the video so they stay clickable
 * once the file is out of the browser and in a notes app.
 */
export function notesToMarkdown(model: ReadModeModel): string {
  const url = `https://www.youtube.com/watch?v=${model.videoId}`;
  const lines: string[] = [`# ${model.title || model.videoId}`, ""];

  if (model.channel) lines.push(`${model.channel}`, "");
  lines.push(`<${url}>`, "");

  if (model.notes.length === 0) {
    lines.push("_No notes._", "");
    return lines.join("\n");
  }

  lines.push("## Notes", "");
  for (const note of [...model.notes].sort((a, b) => a.atMs - b.atMs)) {
    const stamp = formatTimestamp(note.atMs);
    const seconds = Math.floor(note.atMs / 1000);
    lines.push(`- [${stamp}](${url}&t=${seconds}s) ${note.text}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** A filename that will not upset Windows, macOS or Linux. */
export function exportFilename(model: ReadModeModel): string {
  const base = (model.title || model.videoId)
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || model.videoId}.md`;
}
