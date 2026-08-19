/**
 * Read Mode: the wiring.
 *
 * The only impure module in `src/readmode/`. `model.ts` is pure data, `view.ts`
 * is pure DOM, and everything that talks to YouTube, the player, the service
 * worker or storage happens here — which is what lets the interface be rendered
 * and screenshotted from a fixture with no browser extension involved.
 */

import {
  chapterAt,
  chaptersWithEnds,
  emptyModel,
  exportFilename,
  noteId,
  notesToMarkdown,
  type ChatMessage,
  type Note,
  type ReadModeModel,
} from "./model";
import { renderReadMode, type ReadModeView } from "./view";
import {
  adoptPlayer,
  keepAdopted,
  releasePlayer,
  requestSeek,
  type PlayerLoan,
} from "./player";
import * as library from "./library";
import { streamChat } from "./ai";
import { CHAPTER_PROMPT, parseAiChapters } from "./chapters";
import { COVERAGE_BUCKET_MS, thumbnailUrl } from "../shared/libraryProtocol";
import { isAdShowing } from "../content/ads";
import type { ChatContext } from "../shared/aiProtocol";

/** What the content script hands over when Read Mode opens. */
export interface ReadModeContext {
  videoId: string;
  video: HTMLVideoElement;
  /** Plain transcript text for the model. Empty when captions were unavailable. */
  transcript: string;
  title: string;
  channel: string;
  durationMs: number;
  chapters: ReadModeModel["chapters"];
  chapterSource: ReadModeModel["chapterSource"];
  /** Re-run the RSVP reader's draw, since a resize alone will not. */
  redrawReader?: () => void;
  /** Whether the word stream starts drawn over the video. */
  subtitles: boolean;
  /** Record watch time, coverage and rewatch counts for this session. */
  trackStats: boolean;
  /** Append the whole transcript when exporting. */
  exportTranscript: boolean;
  /** The transcript shaped for the chapter prompt, when one is needed. */
  chapterSeed?: string;
  /** Apply and persist a change to that. Owned by the content script, which is
   *  the only place that holds both the reader session and the settings. */
  onSubtitlesChange?: (on: boolean) => void;
}

interface Session {
  model: ReadModeModel;
  view: ReadModeView;
  loan: PlayerLoan | null;
  video: HTMLVideoElement;
  transcript: string;
  dispose: Array<() => void>;
  /** Set while the summary or a reply is streaming, so a second send is refused. */
  streamingId: string | null;
}

let session: Session | null = null;
let savedScrollY = 0;

export const isReadModeOpen = (): boolean => session !== null;

/* ── model plumbing ─────────────────────────────────────────────────────── */

function setModel(next: Partial<ReadModeModel>): void {
  if (!session) return;
  session.model = { ...session.model, ...next };
  session.view.update(session.model);
}

/* ── keyboard ───────────────────────────────────────────────────────────── */

/**
 * Stop YouTube's shortcuts firing while a note is being typed.
 *
 * YouTube binds them at document level, and moving the player does not unbind
 * them — so `k` in the note box would pause the video and `j`/`l` scrub it.
 *
 * ⚠ BUBBLE PHASE, NOT CAPTURE. This listened in the capture phase at first, and
 * `stopPropagation()` there halts the event on the way *down* — so it never
 * reached the input at all and Enter silently did nothing. In the bubble phase
 * the input handles the key first, and the event is stopped on the way back up,
 * before it reaches the document listeners where YouTube's shortcuts live.
 *
 * `stopPropagation` rather than `preventDefault`, because the keystroke still
 * has to do its ordinary job of typing a character.
 */
function shadowKeyboard(root: HTMLElement): () => void {
  const isTyping = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable);

  const stop = (event: KeyboardEvent): void => {
    if (isTyping(event.target)) event.stopPropagation();
  };

  root.addEventListener("keydown", stop);
  root.addEventListener("keyup", stop);
  root.addEventListener("keypress", stop);
  return () => {
    root.removeEventListener("keydown", stop);
    root.removeEventListener("keyup", stop);
    root.removeEventListener("keypress", stop);
  };
}

/**
 * Make YouTube's fullscreen button fullscreen *our* root.
 *
 * Its own handler targets an ancestor that no longer contains the player, so
 * left alone it produces a black screen. Ours contains the player, so the RSVP
 * overlay and the chrome come along.
 */
function interceptFullscreen(root: HTMLElement): () => void {
  const onClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest(".ytp-fullscreen-button")) return;

    event.preventDefault();
    event.stopPropagation();
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.requestFullscreen().catch(() => undefined);
  };

  root.addEventListener("click", onClick, true);
  return () => root.removeEventListener("click", onClick, true);
}

/* ── the video clock ────────────────────────────────────────────────────── */

/**
 * Track the playhead so the active chapter follows the video.
 *
 * Deliberately throttled to ~4Hz rather than run per frame: this only moves a
 * highlight in the left nav, and `update()` re-renders panes. The RSVP reader
 * has its own per-frame loop and is untouched by this.
 */
function trackPlayhead(video: HTMLVideoElement): () => void {
  let timer = 0;
  let lastChapter = -2;

  const tick = (): void => {
    if (!session) return;
    const currentMs = video.currentTime * 1000;
    const index = chapterAt(session.model.chapters, currentMs);
    // Re-render only when the active chapter actually changes; the playhead
    // itself is only read when a note is taken.
    if (index !== lastChapter) {
      lastChapter = index;
      setModel({ currentMs });
    } else {
      session.model.currentMs = currentMs;
    }
  };

  timer = window.setInterval(tick, 250);
  video.addEventListener("seeked", tick);
  return () => {
    window.clearInterval(timer);
    video.removeEventListener("seeked", tick);
  };
}

interface ExportOptions {
  transcript: string | null;
  includeTranscript: boolean;
}

/* ── study stats ────────────────────────────────────────────────────────── */

/** How often the accumulated deltas are pushed to the library. */
const FLUSH_MS = 10_000;

/**
 * Measure the session.
 *
 * Three numbers, because "did I get through it" and "what did it cost me" are
 * different questions:
 *
 * - `watchedMs` is **real** elapsed time with the video playing, not video
 *   time — watching at 2x should not report twice the effort.
 * - `openMs` is wall clock with Read Mode open, which includes the time spent
 *   paused writing a note. That is study too.
 * - `seen` marks 5-second buckets of the timeline, so rewatching the same
 *   thirty seconds cannot inflate the coverage figure.
 *
 * `document.visibilityState` gates both timers: a tab left open in another
 * window is not studying, and counting it would make every number a lie.
 */
function trackStats(
  video: HTMLVideoElement,
  videoId: string,
  durationMs: number,
) {
  const totalBuckets =
    durationMs > 0 ? Math.ceil(durationMs / COVERAGE_BUCKET_MS) : 0;

  let watchedMs = 0;
  let openMs = 0;
  let seen = new Set<number>();
  let opened = true; // the first flush records the visit
  let last = Date.now();

  const flush = (): void => {
    if (watchedMs <= 0 && openMs <= 0 && seen.size === 0 && !opened) return;
    const payload = {
      videoId,
      watchedMs,
      openMs,
      seen: [...seen],
      totalBuckets,
      opened,
    };
    watchedMs = 0;
    openMs = 0;
    seen = new Set();
    opened = false;
    void library.recordActivity(payload);
  };

  const tick = (): void => {
    const now = Date.now();
    const delta = now - last;
    last = now;

    // A long gap means the machine slept or the tab was throttled to death;
    // counting it would invent hours nobody spent.
    if (delta <= 0 || delta > 5_000) return;
    if (document.visibilityState !== "visible") return;

    openMs += delta;

    const player = document.querySelector("#movie_player");
    if (video.paused || video.ended || isAdShowing(player)) return;

    watchedMs += delta;
    if (totalBuckets > 0) {
      const bucket = Math.floor(
        (video.currentTime * 1000) / COVERAGE_BUCKET_MS,
      );
      if (bucket >= 0 && bucket < totalBuckets) seen.add(bucket);
    }
  };

  const timer = window.setInterval(tick, 1_000);
  const flushTimer = window.setInterval(flush, FLUSH_MS);
  // A closed tab is the most common way a session ends, and it gets no teardown.
  window.addEventListener("pagehide", flush);

  return () => {
    window.clearInterval(timer);
    window.clearInterval(flushTimer);
    window.removeEventListener("pagehide", flush);
    flush();
  };
}

/* ── AI ─────────────────────────────────────────────────────────────────── */

function chatContext(model: ReadModeModel, transcript: string): ChatContext {
  return {
    videoId: model.videoId,
    title: model.title,
    channel: model.channel,
    transcript,
    notes: model.notes.map((n) => ({ atMs: n.atMs, text: n.text })),
  };
}

/** Stream one assistant turn into the model, persisting it once on completion. */
function runChat(
  system: string,
  turns: Array<{ role: "user" | "assistant"; content: string }>,
): void {
  if (!session || session.streamingId) return;

  const id = `a-${Date.now().toString(36)}`;
  session.streamingId = id;

  const placeholder: ChatMessage = {
    id,
    role: "assistant",
    text: "",
    createdAt: Date.now(),
    streaming: true,
  };
  setModel({
    messages: [...session.model.messages, placeholder],
    chat: { kind: "loading" },
  });

  let text = "";

  streamChat({
    system,
    messages: turns,
    context: chatContext(session.model, session.transcript),
    onDelta: (delta) => {
      if (!session) return;
      text += delta;
      const messages = session.model.messages.map((m) =>
        m.id === id ? { ...m, text, streaming: true } : m,
      );
      setModel({ messages, chat: { kind: "idle" } });
    },
    onDone: () => {
      if (!session) return;
      session.streamingId = null;
      const finished: ChatMessage = { ...placeholder, text, streaming: false };
      const messages = session.model.messages.map((m) =>
        m.id === id ? finished : m,
      );
      setModel({ messages, chat: { kind: "idle" } });

      // Written once here, not per delta — a row per token would be absurd.
      void library.appendMessage(session.model.videoId, finished);
      if (turns.length === 0)
        void library.setSummary(session.model.videoId, text);
    },
    onError: (code, message) => {
      if (!session) return;
      session.streamingId = null;
      // Drop the empty placeholder; an error is not a turn worth keeping.
      const messages = session.model.messages.filter(
        (m) => m.id !== id || m.text !== "",
      );
      setModel({
        messages,
        chat:
          code === "no_key" || code === "no_permission"
            ? {
                kind: "needs-key",
                setupUrl: chrome.runtime.getURL("keysetup.html"),
              }
            : {
                kind: "error",
                message,
                // A bad key is not worth retrying with the same key, but every
                // other failure here is worth one more attempt.
                retryable: code !== "bad_key",
                // Almost every provider failure is a key, a model or a credit
                // balance, and all three are fixed in the same panel.
                setupUrl: chrome.runtime.getURL("keysetup.html"),
              },
      });
    },
  });
}

/**
 * Ask the model to name the sections of a video that has none of its own.
 *
 * Only when the outline is `derived` — YouTube's own chapters are always
 * better, and paying for what the author already wrote would be absurd. The
 * result is saved with the session, so this costs one call per video ever
 * rather than one per visit.
 */
function requestAiChapters(seed: string): void {
  if (!session || !seed) return;
  const videoId = session.model.videoId;
  const durationMs = session.model.durationMs;
  let text = "";

  streamChat({
    system: CHAPTER_PROMPT,
    messages: [{ role: "user", content: seed }],
    context: {
      videoId,
      title: session.model.title,
      channel: session.model.channel,
      // The seed is already in the user turn; sending the transcript twice
      // would double the cost of the one call this feature makes.
      transcript: "",
      notes: [],
    },
    onDelta: (delta) => {
      text += delta;
    },
    onDone: () => {
      if (!session || session.model.videoId !== videoId) return;
      const chapters = parseAiChapters(text, durationMs);
      if (chapters.length === 0) return; // keep the derived outline

      setModel({
        chapters: chaptersWithEnds(chapters, durationMs),
        chapterSource: "ai",
      });
      void saveSession();
    },
    onError: () => {
      // The derived outline is already on screen and is a fine fallback.
    },
  });
}

/* ── open / close ───────────────────────────────────────────────────────── */

export async function openReadMode(
  ctx: ReadModeContext,
  summaryPrompt: string,
): Promise<void> {
  if (session) return;

  const model: ReadModeModel = {
    ...emptyModel(ctx.videoId),
    title: ctx.title,
    channel: ctx.channel,
    durationMs: ctx.durationMs,
    currentMs: ctx.video.currentTime * 1000,
    chapters: chaptersWithEnds(ctx.chapters, ctx.durationMs),
    chapterSource: ctx.chapterSource,
    subtitles: ctx.subtitles,
  };

  const view = renderReadMode(model, {
    onSeek: (ms) => {
      requestSeek(ms / 1000);
      // Seek locally too: the bridge is best-effort, the element always works.
      ctx.video.currentTime = ms / 1000;
    },
    onAddNote: (text) => {
      if (!session) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      const createdAt = Date.now();
      const note: Note = {
        id: noteId(session.model.videoId, createdAt),
        atMs: Math.floor(session.model.currentMs),
        text: trimmed,
        createdAt,
      };
      setModel({ notes: [note, ...session.model.notes] });
      void library.putNote(session.model.videoId, note);
      void saveSession();
    },
    onDeleteNote: (id) => {
      if (!session) return;
      setModel({ notes: session.model.notes.filter((n) => n.id !== id) });
      void library.deleteNote(session.model.videoId, id);
      void saveSession();
    },
    onSendChat: (text) => {
      if (!session) return;
      const trimmed = text.trim();
      if (!trimmed || session.streamingId) return;

      const message: ChatMessage = {
        id: `u-${Date.now().toString(36)}`,
        role: "user",
        text: trimmed,
        createdAt: Date.now(),
      };
      setModel({ messages: [...session.model.messages, message] });
      void library.appendMessage(session.model.videoId, message);

      const turns = [...session.model.messages, message]
        .filter((m) => m.text.trim().length > 0)
        .map((m) => ({ role: m.role, content: m.text }));
      runChat(summaryPrompt, turns);
    },
    onExport: () => {
      if (!session) return;
      exportNotes(session.model, {
        transcript: session.transcript,
        includeTranscript: ctx.exportTranscript,
      });
    },
    onToggleSubtitles: (on) => {
      setModel({ subtitles: on });
      ctx.onSubtitlesChange?.(on);
    },
    onClose: () => void closeReadMode(),
    onRegenerate: () => {
      if (!session || session.streamingId) return;
      // Drop the previous answer first, so the new one replaces it rather than
      // appending a second summary below the first.
      setModel({
        messages: session.model.messages.filter((m) => m.role !== "assistant"),
        chat: { kind: "loading" },
      });
      runChat(summaryPrompt, []);
    },
  });

  // Mounted on documentElement, a sibling of <body>: `ytd-app` creates no
  // stacking context, so a fixed layer here outranks the masthead and dialogs.
  document.documentElement.appendChild(view.root);
  document.documentElement.classList.add("trf-rm-open");
  savedScrollY = window.scrollY;

  // Synchronous, and after mounting so the slot already has a real size — a
  // zero-size or hidden slot presents no frames and freezes the RSVP reader.
  const loan = adoptPlayer(view.playerSlot);

  session = {
    model,
    view,
    loan,
    video: ctx.video,
    transcript: ctx.transcript,
    dispose: [],
    streamingId: null,
  };

  // The inline setup frame reports back when a key is saved. It sends only a
  // signal — the key itself never crosses out of that extension-origin document.
  const onKeyReady = (event: MessageEvent): void => {
    const data = event.data as { channel?: string; kind?: string };
    if (data?.channel !== "trf-youtube" || data.kind !== "key-ready") return;
    if (!session || session.streamingId) return;
    setModel({ chat: { kind: "loading" } });
    runChat(summaryPrompt, []);
  };
  window.addEventListener("message", onKeyReady);
  session.dispose.push(() => window.removeEventListener("message", onKeyReady));

  if (loan) session.dispose.push(keepAdopted(loan, view.playerSlot));
  session.dispose.push(shadowKeyboard(view.root));
  session.dispose.push(interceptFullscreen(view.root));
  session.dispose.push(trackPlayhead(ctx.video));
  // Opt-out rather than always-on: someone who does not want their viewing
  // measured should not have it measured, not merely have it hidden.
  if (ctx.trackStats) {
    session.dispose.push(trackStats(ctx.video, ctx.videoId, ctx.durationMs));
  }

  // The reader's own loop is frame-driven; a paused video presents none, so the
  // move alone would leave the last word at the old size.
  ctx.redrawReader?.();

  const alreadySummarised = await restoreSaved();
  void saveSession();

  /*
   * Do not pay for the same summary twice.
   *
   * The summary was always being saved — `library.setSummary` writes it and the
   * assistant turn goes into `messages` — it was simply never consulted, so
   * every re-open regenerated it from scratch. Regenerating is still one click
   * away, but it is now a decision rather than a default.
   */
  // A derived outline is a guess made of the speaker's own words; a model can
  // name what a section is *about*. Asked for once, then saved.
  if (ctx.chapterSource === "derived" && ctx.chapterSeed) {
    requestAiChapters(ctx.chapterSeed);
  }

  if (alreadySummarised) {
    setModel({ chat: { kind: "idle" } });
  } else if (ctx.transcript.trim().length > 0) {
    runChat(summaryPrompt, []);
  } else {
    setModel({
      chat: {
        kind: "error",
        message:
          "No transcript available for this video, so there is nothing to summarise.",
        retryable: false,
      },
    });
  }
}

/**
 * Re-attach notes, chat and summary from a previous visit.
 *
 * Returns whether this video has already been summarised, which is what decides
 * against paying for it a second time.
 */
async function restoreSaved(): Promise<boolean> {
  if (!session) return false;
  const saved = await library.getSession(session.model.videoId);
  if (!saved || !session) return false;

  const notes = [...saved.notes].sort((a, b) => b.createdAt - a.createdAt);
  if (notes.length > 0 || saved.messages.length > 0) {
    setModel({ notes, messages: saved.messages });
  }

  const hasAssistantTurn = saved.messages.some((m) => m.role === "assistant");
  const hasStoredSummary = Boolean(saved.session?.summaryMarkdown?.trim());
  return hasAssistantTurn || hasStoredSummary;
}

async function saveSession(): Promise<void> {
  if (!session) return;
  const { model } = session;
  await library.upsertSession({
    videoId: model.videoId,
    title: model.title,
    channel: model.channel,
    durationMs: model.durationMs,
    thumbnailUrl: thumbnailUrl(model.videoId),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    noteCount: model.notes.length,
    messageCount: model.messages.length,
    chapters: model.chapters,
    chapterSource: model.chapterSource,
    summaryMarkdown: null,
  });
}

function exportNotes(model: ReadModeModel, options: ExportOptions): void {
  const blob = new Blob([notesToMarkdown(model, options)], {
    type: "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = exportFilename(model);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next task so the download has definitely started.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function closeReadMode(): Promise<boolean> {
  if (!session) return true;
  const current = session;

  // Reparenting a fullscreen element exits fullscreen anyway; doing it first
  // keeps the transition from happening mid-teardown.
  if (document.fullscreenElement) {
    try {
      await document.exitFullscreen();
    } catch {
      // Already exiting, or never really in it. Not worth blocking the close.
    }
  }

  for (const dispose of current.dispose) dispose();
  current.dispose = [];

  if (current.loan && !releasePlayer(current.loan)) {
    // Losing the player is worse than failing to exit, so stay open and say so.
    setModel({
      chat: {
        kind: "error",
        message:
          "Could not return the video player to the page. Reload to exit read mode.",
        retryable: false,
      },
    });
    return false;
  }

  current.view.destroy();
  document.documentElement.classList.remove("trf-rm-open");
  window.scrollTo(0, savedScrollY);
  session = null;
  return true;
}
