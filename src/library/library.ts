/**
 * The library page.
 *
 * Reads everything over the message protocol; it never opens IndexedDB itself,
 * because the database lives in the service worker — a content script's
 * `indexedDB` would be YouTube's, and an extension page opening its own would
 * simply be a second, empty database.
 *
 * Nothing stored is ever assigned through `innerHTML`. Titles and note text came
 * from a video page and a language model, so every node is built and every
 * string goes through `textContent`.
 */

import {
  formatTimestamp,
  notesToMarkdown,
  type ReadModeModel,
} from "../readmode/model";
import type {
  FullSession,
  LibraryRequest,
  LibraryResponse,
  SessionSummary,
} from "../shared/libraryProtocol";

const grid = document.getElementById("grid") as HTMLUListElement;
const detail = document.getElementById("detail") as HTMLDivElement;
const state = document.getElementById("state") as HTMLDivElement;
const bar = document.getElementById("bar") as HTMLDivElement;
const search = document.getElementById("search") as HTMLInputElement;
const count = document.getElementById("count") as HTMLSpanElement;

let sessions: SessionSummary[] = [];

/* ── messaging ──────────────────────────────────────────────────────────── */

async function send(request: LibraryRequest): Promise<LibraryResponse> {
  try {
    return (await chrome.runtime.sendMessage(request)) as LibraryResponse;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/* ── small builders ─────────────────────────────────────────────────────── */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function watchUrl(videoId: string, atMs?: number): string {
  const base = `https://www.youtube.com/watch?v=${videoId}`;
  return atMs === undefined ? base : `${base}&t=${Math.floor(atMs / 1000)}s`;
}

/** "2 hours ago" reads better than a date for something studied this week. */
function relativeTime(ms: number): string {
  const seconds = Math.round((Date.now() - ms) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.348],
    ["month", 12],
    ["year", Infinity],
  ];

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  let value = seconds;
  for (const [unit, step] of units) {
    if (Math.abs(value) < step)
      return formatter.format(-Math.round(value), unit);
    value /= step;
  }
  return formatter.format(-Math.round(value), "year");
}

/** The same deliberately small Markdown subset the reader uses, as DOM nodes. */
function renderMarkdown(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  let list: HTMLUListElement | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      list = null;
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) {
        list = el("ul");
        list.style.margin = "0 0 8px";
        list.style.paddingLeft = "18px";
        frag.appendChild(list);
      }
      list.appendChild(el("li", undefined, bullet[1].replace(/\*\*/g, "")));
      continue;
    }

    list = null;
    const heading =
      /^#{1,6}\s+(.*)$/.exec(line) ?? /^\*\*(.+)\*\*:?$/.exec(line);
    if (heading) {
      const node = el("p", undefined, heading[1].replace(/\*\*/g, ""));
      node.style.fontWeight = "700";
      node.style.margin = "10px 0 4px";
      frag.appendChild(node);
      continue;
    }

    const paragraph = el("p", undefined, line.replace(/\*\*/g, ""));
    paragraph.style.margin = "0 0 6px";
    frag.appendChild(paragraph);
  }

  return frag;
}

/* ── the grid ───────────────────────────────────────────────────────────── */

function showState(title: string, body: string): void {
  state.replaceChildren();
  const wrap = el("div", "state");
  wrap.appendChild(el("strong", undefined, title));
  wrap.appendChild(el("span", undefined, body));
  state.appendChild(wrap);
}

function paintGrid(filter = ""): void {
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? sessions.filter(
        (s) =>
          s.title.toLowerCase().includes(needle) ||
          s.channel.toLowerCase().includes(needle),
      )
    : sessions;

  grid.replaceChildren();
  state.replaceChildren();

  count.textContent =
    sessions.length === 0
      ? ""
      : `${visible.length} of ${sessions.length} session${sessions.length === 1 ? "" : "s"}`;

  // The search box is noise until there is enough to search through.
  bar.dataset.hidden = String(sessions.length < 4);

  if (sessions.length === 0) {
    showState(
      "Nothing saved yet",
      "Open a YouTube video and press Shift+R, or use the toolbar icon, to start a read-mode session. Notes and chats are saved here automatically.",
    );
    return;
  }

  if (visible.length === 0) {
    showState("No matches", "Nothing here matches that search.");
    return;
  }

  for (const session of visible) {
    const item = el("li");
    const card = el("button", "card");
    card.type = "button";

    const image = el("img");
    image.src = session.thumbnailUrl;
    image.alt = "";
    image.loading = "lazy";

    const body = el("div", "card-body");
    body.appendChild(el("h2", "card-title", session.title || session.videoId));

    const parts = [session.channel, relativeTime(session.updatedAt)].filter(
      Boolean,
    );
    const counts: string[] = [];
    if (session.noteCount)
      counts.push(
        `${session.noteCount} note${session.noteCount === 1 ? "" : "s"}`,
      );
    if (session.messageCount)
      counts.push(
        `${session.messageCount} message${session.messageCount === 1 ? "" : "s"}`,
      );
    if (counts.length) parts.push(counts.join(", "));

    body.appendChild(el("div", "card-meta", parts.join(" · ")));

    card.append(image, body);
    card.addEventListener("click", () => void openDetail(session.videoId));
    item.appendChild(card);
    grid.appendChild(item);
  }
}

/* ── the detail view ────────────────────────────────────────────────────── */

function closeDetail(): void {
  detail.dataset.open = "false";
  detail.replaceChildren();
  grid.dataset.hidden = "false";
  paintGrid(search.value);
}

async function openDetail(videoId: string): Promise<void> {
  const reply = await send({ type: "library.getSession", videoId });
  if (!reply.ok || reply.type !== "session") {
    showState(
      "Could not open that session",
      reply.ok ? "It may have been deleted." : reply.error,
    );
    return;
  }

  const full: FullSession = reply.session;
  const session = full.session;
  if (!session) {
    showState("Could not open that session", "It may have been deleted.");
    return;
  }

  grid.dataset.hidden = "true";
  state.replaceChildren();
  detail.replaceChildren();
  detail.dataset.open = "true";

  const back = el("button", "back", "← All sessions");
  back.type = "button";
  back.addEventListener("click", closeDetail);
  detail.appendChild(back);

  detail.appendChild(el("h2", undefined, session.title || session.videoId));
  detail.appendChild(
    el(
      "p",
      "sub",
      [session.channel, `studied ${relativeTime(session.updatedAt)}`]
        .filter(Boolean)
        .join(" · "),
    ),
  );

  const actions = el("div", "actions");

  const open = el("a", undefined, "Open video");
  open.href = watchUrl(session.videoId);
  open.target = "_blank";
  open.rel = "noreferrer";

  const exportBtn = el("button", undefined, "Export notes (.md)");
  exportBtn.type = "button";
  exportBtn.disabled = full.notes.length === 0;
  exportBtn.addEventListener("click", () => {
    // The same function Read Mode exports with, so a note written today and one
    // exported from the library a month later produce identical files.
    const model = {
      videoId: session.videoId,
      title: session.title,
      channel: session.channel,
      notes: full.notes,
    } as ReadModeModel;
    const blob = new Blob([notesToMarkdown(model)], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = el("a");
    anchor.href = url;
    anchor.download = `${(session.title || session.videoId).replace(/[\\/:*?"<>|]+/g, " ").trim()}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });

  const remove = el("button", "danger", "Delete");
  remove.type = "button";
  let armed = false;
  remove.addEventListener("click", () => {
    // Two clicks rather than a confirm dialog: deleting is recoverable only by
    // studying the video again, so it deserves a beat, not a modal.
    if (!armed) {
      armed = true;
      remove.textContent = "Click again to delete";
      window.setTimeout(() => {
        armed = false;
        remove.textContent = "Delete";
      }, 4000);
      return;
    }
    void send({ type: "library.delete", videoId: session.videoId }).then(() => {
      sessions = sessions.filter((s) => s.videoId !== session.videoId);
      closeDetail();
    });
  });

  actions.append(open, exportBtn, remove);
  detail.appendChild(actions);

  if (session.summaryMarkdown) {
    const block = el("section", "block");
    block.appendChild(el("h3", undefined, "Summary"));
    const body = el("div", "summary");
    body.appendChild(renderMarkdown(session.summaryMarkdown));
    block.appendChild(body);
    detail.appendChild(block);
  }

  if (full.notes.length > 0) {
    const block = el("section", "block");
    block.appendChild(el("h3", undefined, `Notes (${full.notes.length})`));
    const list = el("ul", "notes");
    for (const note of [...full.notes].sort((a, b) => a.atMs - b.atMs)) {
      const row = el("li", "note");
      const link = el("a", undefined, formatTimestamp(note.atMs));
      link.href = watchUrl(session.videoId, note.atMs);
      link.target = "_blank";
      link.rel = "noreferrer";
      row.append(link, el("span", undefined, note.text));
      list.appendChild(row);
    }
    block.appendChild(list);
    detail.appendChild(block);
  }

  if (full.messages.length > 0) {
    const block = el("section", "block");
    block.appendChild(
      el("h3", undefined, `Conversation (${full.messages.length})`),
    );
    const thread = el("div", "thread");
    for (const message of full.messages) {
      const turn = el("div", "turn");
      turn.appendChild(
        el("div", "turn-role", message.role === "user" ? "You" : "Assistant"),
      );
      turn.appendChild(renderMarkdown(message.text));
      thread.appendChild(turn);
    }
    block.appendChild(thread);
    detail.appendChild(block);
  }

  window.scrollTo(0, 0);
}

/* ── boot ───────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  showState("Loading…", "");

  const reply = await send({ type: "library.list" });
  if (!reply.ok) {
    showState(
      "The library is unavailable",
      `The extension's background worker did not respond: ${reply.error}. Reloading the extension usually fixes this.`,
    );
    return;
  }
  if (reply.type !== "list") return;

  sessions = reply.sessions;
  paintGrid();

  let debounce = 0;
  search.addEventListener("input", () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => paintGrid(search.value), 120);
  });
}

void main();
