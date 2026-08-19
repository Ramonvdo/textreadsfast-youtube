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
  /** Ask for the summary again. Optional so the harness need not supply it. */
  onRegenerate?(): void;
  /** Turn the word stream over the video on or off. */
  onToggleSubtitles(on: boolean): void;
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
const EYE =
  "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z";
const CAPTIONS = "M3 5h18v14H3z M7 11h4 M13 11h4 M7 15h10";
const CAPTIONS_OFF = "M3 5h18v14H3z M7 11h4 M13 11h4 M7 15h10 M3 3l18 18";
const EYE_OFF =
  "M10.7 5.1A11 11 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-2.8 3.7 M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a10.6 10.6 0 0 0 4.5-1 M3 3l18 18 M9.9 9.9a3 3 0 0 0 4.2 4.2";

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

  /*
   * Focus mode: hide the chapters and the assistant, leaving the video and your
   * own notes.
   *
   * Kept as view-local state rather than put on the model, because it changes
   * nothing about the video, the notes or the conversation — it is only about
   * what is on screen right now. `paint` never touches this attribute, so an
   * update cannot silently drop out of it.
   */
  let focused = false;
  const focusBtn = el("button", "trf-rm-focus");
  focusBtn.type = "button";

  const paintFocus = (): void => {
    root.dataset.focus = String(focused);
    focusBtn.setAttribute("aria-pressed", String(focused));
    focusBtn.title = focused
      ? "Show chapters and assistant"
      : "Hide everything but the video";
    focusBtn.setAttribute("aria-label", focusBtn.title);
    focusBtn.replaceChildren(svg(focused ? EYE_OFF : EYE));
    // The player's own observer follows the slot, so the video resizes itself;
    // this only re-measures what the chat column is aligned against.
    sync();
  };

  focusBtn.addEventListener("click", () => {
    focused = !focused;
    paintFocus();
  });

  /*
   * The word stream over the video.
   *
   * Backed by the `readerInReadMode` setting rather than by state of its own,
   * so this button and the settings page can never disagree about whether the
   * reader is running.
   */
  const subsBtn = el("button", "trf-rm-subs");
  subsBtn.type = "button";
  subsBtn.addEventListener("click", () =>
    handlers.onToggleSubtitles(!current.subtitles),
  );

  const paintSubs = (on: boolean): void => {
    subsBtn.setAttribute("aria-pressed", String(on));
    subsBtn.title = on
      ? "Hide the subtitles over the video"
      : "Show the subtitles over the video";
    subsBtn.setAttribute("aria-label", subsBtn.title);
    subsBtn.replaceChildren(svg(on ? CAPTIONS : CAPTIONS_OFF));
  };

  const exportBtn = el("button", "trf-rm-export", "export");
  exportBtn.type = "button";
  exportBtn.addEventListener("click", () => handlers.onExport());

  const notesActions = el("div", "trf-rm-noteactions");
  notesActions.append(subsBtn, focusBtn, exportBtn);
  notesHead.append(notesTitle, notesActions);

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
    // Never disabled. Even with no notes there is a title, a link and often a
    // summary worth keeping, and a button that silently does nothing reads as
    // broken rather than as empty.
    exportBtn.title =
      next.notes.length === 0
        ? "Export the summary and video details"
        : `Export ${next.notes.length} notes`;
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

      /*
       * An error must offer a way out of itself.
       *
       * "Provider returned error" with nothing beside it is a dead end: almost
       * every failure here is a key, a model or a credit balance, and all three
       * are fixed in the same panel. So the fix opens inline rather than
       * sending anyone off to a settings page to guess which switch it was.
       */
      const actions = el("div", "trf-rm-erroractions");

      if (state.setupUrl) {
        const fix = el("button", "trf-rm-statusbtn", "Fix in settings");
        fix.type = "button";
        fix.addEventListener("click", () => {
          fix.remove();
          const frame = el("iframe", "trf-rm-keyframe");
          frame.src = state.setupUrl as string;
          frame.title = "Assistant settings";
          chat.appendChild(frame);
          chat.scrollTop = chat.scrollHeight;
        });
        actions.appendChild(fix);
      }

      if (state.retryable && handlers.onRegenerate) {
        const again = el("button", "trf-rm-again", "Try again");
        again.type = "button";
        again.addEventListener("click", () => handlers.onRegenerate?.());
        actions.appendChild(again);
      }

      if (actions.childElementCount > 0) chat.appendChild(actions);
    }

    /*
     * A cached summary must never be a dead end.
     *
     * The summary is reused across visits rather than regenerated, which saves
     * the tokens — but a stale or disappointing one then has no way out unless
     * asking again is one click away.
     */
    if (
      handlers.onRegenerate &&
      state.kind !== "loading" &&
      next.messages.some((m) => m.role === "assistant" && m.text.trim() !== "")
    ) {
      const again = el("button", "trf-rm-again", "Regenerate summary");
      again.type = "button";
      again.addEventListener("click", () => handlers.onRegenerate?.());
      chat.appendChild(again);
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

    paintSubs(next.subtitles);
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

  /*
   * Tie the right column's geometry to the left one's.
   *
   * The chat panel ends where the video ends, and the message box ends where
   * the note box ends, so the two writing surfaces sit side by side on one line.
   * Neither can be expressed in CSS alone: the video's height comes from an
   * aspect ratio applied to an `fr` column, and `fr` is not reachable from
   * `calc()`. So the two numbers are measured and published as custom
   * properties, and the stylesheet does the rest.
   */
  const sync = (): void => {
    const stageBox = stage.getBoundingClientRect();
    if (stageBox.height < 1) return; // not laid out yet

    // Measured from the column's own top, not the grid's. The grid carries 57px
    // of top padding, so measuring from its border box counted that padding
    // twice and pushed the message box below the note box by exactly that much.
    const columnTop = main.getBoundingClientRect().top;
    const inputBottom = noteInput.getBoundingClientRect().bottom - columnTop;

    root.style.setProperty("--trf-rm-stage-h", `${stageBox.height}px`);
    root.style.setProperty(
      "--trf-rm-inputs-h",
      `${Math.max(0, inputBottom)}px`,
    );
  };

  // Guarded because `ResizeObserver` does not exist in every environment this
  // renders in — jsdom, where the view is unit-tested, has no implementation.
  // The layout still works without it; it just stops re-measuring on resize.
  const geometry =
    typeof ResizeObserver === "function" ? new ResizeObserver(sync) : null;
  geometry?.observe(stage);
  geometry?.observe(noteInput);
  geometry?.observe(notesHead);

  // Called here, not at construction: it uses `sync`, which is defined above it.
  paintFocus();

  return {
    root,
    playerSlot,
    update(next: ReadModeModel) {
      const previous = current;
      current = next;
      paint(next, previous);
      sync();
    },
    destroy() {
      geometry?.disconnect();
      root.remove();
    },
  };
}
