/**
 * Read Mode's interface, as a pure function of the model.
 *
 * Imports nothing from `chrome.*`, the network, or `src/content/` — only
 * `./model`. That is deliberate and load-bearing: it means the entire interface
 * renders in headless Chromium from a fixture with no YouTube page and no
 * extension involved, which is how the design gets checked against the concept.
 *
 * ⚠ THE INVARIANT: `playerSlot` keeps a stable element identity for the life of
 * the view. `update()` may re-render every other pane, but re-creating the slot
 * would detach YouTube's live player and stop playback dead. Enforced by a test
 * in `view.test.ts`.
 *
 * Nothing derived from the model is ever assigned through `innerHTML`. This runs
 * inside someone else's page against text the model wrote, so every node is
 * built and every string goes through `textContent`.
 */

import {
  chapterAt,
  formatTimestamp,
  type ChatMessage,
  type ReadModeModel,
} from "./model";

export interface Handlers {
  onSeek(ms: number): void;
  onAddNote(text: string): void;
  onDeleteNote(id: string): void;
  onSendChat(text: string): void;
  onExport(): void;
  onClose(): void;
}

export interface ReadModeView {
  root: HTMLElement;
  playerSlot: HTMLElement;
  update(next: ReadModeModel): void;
  destroy(): void;
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

function svg(path: string, viewBox = "0 0 24 24"): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const root = document.createElementNS(ns, "svg");
  root.setAttribute("viewBox", viewBox);
  root.setAttribute("fill", "none");
  root.setAttribute("stroke", "currentColor");
  root.setAttribute("stroke-width", "2");
  root.setAttribute("stroke-linecap", "round");
  root.setAttribute("stroke-linejoin", "round");
  root.setAttribute("aria-hidden", "true");
  const d = document.createElementNS(ns, "path");
  d.setAttribute("d", path);
  root.appendChild(d);
  return root;
}

const TRASH = "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6";
const ARROW_UP = "M12 19V5M5 12l7-7 7 7";

/* ── a deliberately small markdown renderer ─────────────────────────────── */

/**
 * Enough Markdown for a model's summary, built as DOM nodes.
 *
 * A parser that produced HTML would need sanitising; building elements means
 * there is nothing to sanitise. Headings, bullets, paragraphs, bold and inline
 * code cover everything the summary prompt asks for, and anything else degrades
 * to plain text rather than showing markup.
 */
function renderInline(target: HTMLElement, text: string): void {
  // Split on **bold** and `code`, keeping the delimiters' contents.
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      target.appendChild(
        document.createTextNode(text.slice(last, match.index)),
      );
    }
    const token = match[0];
    if (token.startsWith("**")) {
      target.appendChild(el("strong", undefined, token.slice(2, -2)));
    } else {
      target.appendChild(el("code", "trf-rm-mdcode", token.slice(1, -1)));
    }
    last = match.index + token.length;
  }

  if (last < text.length) {
    target.appendChild(document.createTextNode(text.slice(last)));
  }
}

function renderMarkdown(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  let list: HTMLUListElement | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();

    if (line.trim() === "") {
      list = null;
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) {
        list = el("ul", "trf-rm-mdul");
        frag.appendChild(list);
      }
      const item = el("li", "trf-rm-mdli");
      renderInline(item, bullet[1]);
      list.appendChild(item);
      continue;
    }

    list = null;

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const node = el("div", "trf-rm-mdh");
      renderInline(node, heading[2]);
      frag.appendChild(node);
      continue;
    }

    // A line that is entirely bold reads as a heading in practice, and the
    // summary prompt produces exactly that for its section titles.
    const wholeBold = /^\*\*(.+)\*\*:?$/.exec(line);
    if (wholeBold) {
      frag.appendChild(el("div", "trf-rm-mdh", wholeBold[1]));
      continue;
    }

    // A numbered step: kept as a paragraph, but the number carries weight.
    const paragraph = el("p", "trf-rm-mdp");
    renderInline(paragraph, line);
    frag.appendChild(paragraph);
  }

  return frag;
}

/* ── the view ───────────────────────────────────────────────────────────── */

export function renderReadMode(
  model: ReadModeModel,
  handlers: Handlers,
): ReadModeView {
  let current = model;

  const root = el("div", "trf-rm");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Read mode");

  const grid = el("div", "trf-rm-grid");
  root.appendChild(grid);

  const close = el("button", "trf-rm-close", "Exit read mode");
  close.type = "button";
  close.addEventListener("click", () => handlers.onClose());
  root.appendChild(close);

  /* left ───────────────────────────────────────────────────────────────── */

  const nav = el("nav", "trf-rm-nav");
  nav.setAttribute("aria-label", "Chapters");
  const title = el("h1", "trf-rm-title");
  const navLabel = el("span", "trf-rm-navlabel", "Chapters");
  const navNote = el("p", "trf-rm-navnote");
  const chapterList = el("ul", "trf-rm-chapters");
  nav.append(title, navLabel, navNote, chapterList);
  grid.appendChild(nav);

  /* centre ─────────────────────────────────────────────────────────────── */

  const main = el("div", "trf-rm-main");

  // Created ONCE. Never re-created by update() — see the module doc.
  const stage = el("div", "trf-rm-stage");
  const playerSlot = el("div", "trf-rm-player");
  stage.appendChild(playerSlot);

  const notesHead = el("div", "trf-rm-noteshead");
  const notesTitle = el("h2", undefined, "Notetaking:");
  const exportBtn = el("button", "trf-rm-export", "export");
  exportBtn.type = "button";
  exportBtn.addEventListener("click", () => handlers.onExport());
  notesHead.append(notesTitle, exportBtn);

  const noteInput = el("input", "trf-rm-noteinput");
  noteInput.type = "text";
  noteInput.placeholder =
    "you can type right here to take notes and it will be added as a pill below when you press enter";
  noteInput.setAttribute("aria-label", "New note");
  noteInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const text = noteInput.value.trim();
    if (!text) return;
    noteInput.value = "";
    handlers.onAddNote(text);
  });

  const noteList = el("ul", "trf-rm-notelist");
  const notesEmpty = el(
    "p",
    "trf-rm-empty",
    "No notes yet. Type above and press Enter to pin a thought to this moment in the video.",
  );

  main.append(stage, notesHead, noteInput, noteList, notesEmpty);
  grid.appendChild(main);

  /* right ──────────────────────────────────────────────────────────────── */

  const side = el("div", "trf-rm-side");
  const chat = el("div", "trf-rm-chat");
  chat.setAttribute("role", "log");
  chat.setAttribute("aria-live", "polite");
  chat.setAttribute("aria-label", "Assistant");

  const compose = el("div", "trf-rm-compose");
  const composeBox = el("textarea", "trf-rm-composebox");
  composeBox.rows = 3;
  composeBox.placeholder =
    "here you can send followup messages to chat with the AI that uses the video transcript and your notes";
  composeBox.setAttribute("aria-label", "Message the assistant");

  const send = el("button", "trf-rm-send");
  send.type = "button";
  send.setAttribute("aria-label", "Send message");
  send.appendChild(svg(ARROW_UP));

  const submit = (): void => {
    const text = composeBox.value.trim();
    if (!text) return;
    composeBox.value = "";
    handlers.onSendChat(text);
  };
  send.addEventListener("click", submit);
  // Enter sends, Shift+Enter makes a new line — the convention every chat uses,
  // so nobody has to learn it here.
  composeBox.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });

  compose.append(composeBox, send);
  side.append(chat, compose);
  grid.appendChild(side);

  /* ── painting ─────────────────────────────────────────────────────────── */

  let lastChapterIndex = -2;
  const chapterButtons: HTMLButtonElement[] = [];

  function paintChapters(next: ReadModeModel, structural: boolean): void {
    if (structural) {
      chapterList.replaceChildren();
      chapterButtons.length = 0;

      for (const chapter of next.chapters) {
        const item = el("li");
        const button = el("button", "trf-rm-chapter");
        button.type = "button";

        // The start time is what makes this a way of moving around the video
        // rather than a description of it.
        const stamp = formatTimestamp(chapter.startMs);
        button.append(
          el("span", "trf-rm-chaptertime", stamp),
          el("span", "trf-rm-chaptertitle", chapter.title),
        );
        button.setAttribute("aria-label", `${chapter.title}, at ${stamp}`);

        button.addEventListener("click", () =>
          handlers.onSeek(chapter.startMs),
        );
        item.appendChild(button);
        chapterList.appendChild(item);
        chapterButtons.push(button);
      }
      lastChapterIndex = -2;
    }

    const active = chapterAt(next.chapters, next.currentMs);
    if (active === lastChapterIndex) return;
    lastChapterIndex = active;
    chapterButtons.forEach((button, index) => {
      button.setAttribute("aria-current", String(index === active));
    });
  }

  function paintNotes(next: ReadModeModel): void {
    noteList.replaceChildren();

    for (const note of next.notes) {
      const row = el("li", "trf-rm-note");

      const time = el("button", "trf-rm-notetime", formatTimestamp(note.atMs));
      time.type = "button";
      time.setAttribute("aria-label", `Jump to ${formatTimestamp(note.atMs)}`);
      time.addEventListener("click", () => handlers.onSeek(note.atMs));

      const body = el("div", "trf-rm-notebody");
      body.appendChild(el("span", "trf-rm-notetext", note.text));

      const del = el("button", "trf-rm-delete");
      del.type = "button";
      del.setAttribute("aria-label", "Delete note");
      del.appendChild(svg(TRASH));
      del.addEventListener("click", () => handlers.onDeleteNote(note.id));
      body.appendChild(del);

      row.append(time, body);
      noteList.appendChild(row);
    }

    notesEmpty.hidden = next.notes.length > 0;
    exportBtn.disabled = next.notes.length === 0;
  }

  function paintMessage(message: ChatMessage): HTMLElement {
    const wrap = el("div", `trf-rm-msg trf-rm-msg--${message.role}`);
    wrap.appendChild(renderMarkdown(message.text));
    if (message.streaming) wrap.appendChild(el("span", "trf-rm-caret"));
    return wrap;
  }

  function paintChat(next: ReadModeModel): void {
    const atBottom =
      chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
    chat.replaceChildren();

    for (const message of next.messages) {
      if (message.text.trim() === "" && !message.streaming) continue;
      chat.appendChild(paintMessage(message));
    }

    const state = next.chat;
    if (state.kind === "loading" && next.messages.every((m) => m.text === "")) {
      chat.appendChild(el("p", "trf-rm-status", "Reading the transcript…"));
    } else if (state.kind === "needs-key") {
      // Set up right here rather than sending anyone to a settings page. The
      // form is an extension-origin iframe, which is what keeps the key out of
      // this page's DOM and lets it ask for the provider permission — neither of
      // which a form drawn by the content script could do.
      if (state.setupUrl) {
        const frame = el("iframe", "trf-rm-keyframe");
        frame.src = state.setupUrl;
        frame.title = "Connect the assistant";
        chat.appendChild(frame);
      } else {
        chat.appendChild(
          el(
            "p",
            "trf-rm-status",
            "Add an API key in settings to get a summary and ask questions about this video.",
          ),
        );
      }
    } else if (state.kind === "error") {
      chat.appendChild(
        el("p", "trf-rm-status trf-rm-status--error", state.message),
      );
    }

    send.disabled = state.kind === "loading";
    // Only follow the stream when the reader was already at the bottom;
    // yanking the scroll away from something they were reading is worse than a
    // missed line.
    if (atBottom) chat.scrollTop = chat.scrollHeight;
  }

  function paint(next: ReadModeModel, previous: ReadModeModel | null): void {
    const structural =
      previous === null ||
      previous.chapters !== next.chapters ||
      previous.chapters.length !== next.chapters.length;

    title.textContent = next.title;
    navNote.textContent =
      next.chapters.length === 0
        ? "This video has no chapters."
        : next.chapterSource === "derived"
          ? "Derived from the transcript — this video has no chapters of its own."
          : next.chapterSource === "ai"
            ? "Generated from the transcript."
            : "";
    navNote.hidden = navNote.textContent === "";

    paintChapters(next, structural);
    if (previous === null || previous.notes !== next.notes) paintNotes(next);
    if (
      previous === null ||
      previous.messages !== next.messages ||
      previous.chat !== next.chat
    ) {
      paintChat(next);
    }
  }

  paint(model, null);

  return {
    root,
    playerSlot,
    update(next: ReadModeModel) {
      const previous = current;
      current = next;
      paint(next, previous);
    },
    destroy() {
      root.remove();
    },
  };
}
