// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderReadMode, type Handlers } from "./view";
import { chaptersWithEnds, emptyModel, type ReadModeModel } from "./model";

function handlers(): Handlers {
  return {
    onSeek: vi.fn(),
    onAddNote: vi.fn(),
    onDeleteNote: vi.fn(),
    onSendChat: vi.fn(),
    onExport: vi.fn(),
    onClose: vi.fn(),
  };
}

function model(over: Partial<ReadModeModel> = {}): ReadModeModel {
  return {
    ...emptyModel("vid"),
    title: "A Video",
    channel: "A Channel",
    durationMs: 600_000,
    chapters: chaptersWithEnds(
      [
        { title: "Intro", startMs: 0 },
        { title: "Middle", startMs: 300_000 },
      ],
      600_000,
    ),
    chapterSource: "description",
    ...over,
  };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("the player slot", () => {
  /*
   * The single most important test in this file.
   *
   * YouTube's live player is moved into `playerSlot`. If `update()` ever
   * re-creates, replaces or empties that element, the player is detached from
   * the document and playback stops — silently, and only on a real video, which
   * is exactly the kind of bug a screenshot would never catch.
   */
  it("survives an update with a completely different model", () => {
    const view = renderReadMode(model(), handlers());
    // Mounted, so `isConnected` below actually means "still in the document" —
    // which is the thing that decides whether the real player keeps playing.
    document.body.appendChild(view.root);
    const slot = view.playerSlot;

    const sentinel = document.createElement("video");
    sentinel.id = "pretend-player";
    slot.appendChild(sentinel);

    view.update(
      model({
        title: "Something else entirely",
        chapters: chaptersWithEnds([{ title: "Only one", startMs: 0 }], 100),
        notes: [{ id: "n", atMs: 1000, text: "a note", createdAt: 1 }],
        messages: [{ id: "m", role: "assistant", text: "hello", createdAt: 1 }],
        chat: { kind: "loading" },
      }),
    );

    expect(view.playerSlot).toBe(slot);
    expect(slot.querySelector("#pretend-player")).toBe(sentinel);
    expect(sentinel.isConnected).toBe(true);
  });

  it("is never hidden or collapsed, which would stop frames being presented", () => {
    const view = renderReadMode(model(), handlers());
    document.body.appendChild(view.root);
    expect(view.playerSlot.style.display).not.toBe("none");
    expect(view.playerSlot.hidden).toBe(false);
  });
});

describe("chapters", () => {
  it("renders one button per chapter and seeks on click", () => {
    const h = handlers();
    const view = renderReadMode(model(), h);
    const buttons =
      view.root.querySelectorAll<HTMLButtonElement>(".trf-rm-chapter");

    expect(buttons).toHaveLength(2);
    expect(buttons[0].querySelector(".trf-rm-chaptertitle")?.textContent).toBe(
      "Intro",
    );

    buttons[1].click();
    expect(h.onSeek).toHaveBeenCalledWith(300_000);
  });

  // The nav is for moving around the video, so each row has to say where it
  // goes. Without the timestamp it is a description, not a way to navigate.
  it("shows each chapter's start time", () => {
    const view = renderReadMode(model(), handlers());
    const times = [...view.root.querySelectorAll(".trf-rm-chaptertime")].map(
      (n) => n.textContent,
    );
    expect(times).toEqual(["0:00", "5:00"]);
  });

  it("marks exactly one chapter current, and follows the playhead", () => {
    const view = renderReadMode(model({ currentMs: 0 }), handlers());
    const marked = () =>
      [...view.root.querySelectorAll(".trf-rm-chapter")].map((b) =>
        b.getAttribute("aria-current"),
      );

    expect(marked()).toEqual(["true", "false"]);
    view.update(model({ currentMs: 400_000 }));
    expect(marked()).toEqual(["false", "true"]);
  });

  it("says so when the sections were derived rather than authored", () => {
    const view = renderReadMode(
      model({ chapterSource: "derived" }),
      handlers(),
    );
    const note = view.root.querySelector(".trf-rm-navnote");
    expect(note?.textContent).toContain("no chapters");
    expect((note as HTMLElement).hidden).toBe(false);
  });

  it("stays quiet when the chapters are YouTube's own", () => {
    const view = renderReadMode(model(), handlers());
    expect(
      (view.root.querySelector(".trf-rm-navnote") as HTMLElement).hidden,
    ).toBe(true);
  });
});

describe("notes", () => {
  it("commits on Enter and clears the field", () => {
    const h = handlers();
    const view = renderReadMode(model(), h);
    const input =
      view.root.querySelector<HTMLInputElement>(".trf-rm-noteinput")!;

    input.value = "  a thought  ";
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );

    expect(h.onAddNote).toHaveBeenCalledWith("a thought");
    expect(input.value).toBe("");
  });

  it("ignores an empty note rather than making a blank pill", () => {
    const h = handlers();
    const view = renderReadMode(model(), h);
    const input =
      view.root.querySelector<HTMLInputElement>(".trf-rm-noteinput")!;

    input.value = "   ";
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(h.onAddNote).not.toHaveBeenCalled();
  });

  it("renders a pill per note, with a timestamp that seeks", () => {
    const h = handlers();
    const view = renderReadMode(
      model({
        notes: [
          { id: "n1", atMs: 621_000, text: "layers matter", createdAt: 1 },
        ],
      }),
      h,
    );

    const time =
      view.root.querySelector<HTMLButtonElement>(".trf-rm-notetime")!;
    expect(time.textContent).toBe("10:21");
    expect(view.root.querySelector(".trf-rm-notetext")?.textContent).toBe(
      "layers matter",
    );

    time.click();
    expect(h.onSeek).toHaveBeenCalledWith(621_000);
  });

  it("disables export until there is something to export, then exports", () => {
    const h = handlers();
    const view = renderReadMode(model(), h);
    const button =
      view.root.querySelector<HTMLButtonElement>(".trf-rm-export")!;
    expect(button.disabled).toBe(true);

    view.update(
      model({ notes: [{ id: "n", atMs: 0, text: "x", createdAt: 1 }] }),
    );
    expect(button.disabled).toBe(false);

    button.click();
    expect(h.onExport).toHaveBeenCalled();
  });
});

describe("focus mode", () => {
  const focus = (view: { root: HTMLElement }) =>
    view.root.querySelector<HTMLButtonElement>(".trf-rm-focus")!;

  it("starts off", () => {
    const view = renderReadMode(model(), handlers());
    expect(view.root.dataset.focus).toBe("false");
    expect(focus(view).getAttribute("aria-pressed")).toBe("false");
  });

  it("toggles both ways", () => {
    const view = renderReadMode(model(), handlers());
    focus(view).click();
    expect(view.root.dataset.focus).toBe("true");
    expect(focus(view).getAttribute("aria-pressed")).toBe("true");

    focus(view).click();
    expect(view.root.dataset.focus).toBe("false");
  });

  // It is presentation, not data — so a model change must not quietly drop the
  // reader back out of it mid-video.
  it("survives an update", () => {
    const view = renderReadMode(model(), handlers());
    focus(view).click();

    view.update(
      model({
        notes: [{ id: "n", atMs: 0, text: "still focused", createdAt: 1 }],
        chat: { kind: "loading" },
      }),
    );
    expect(view.root.dataset.focus).toBe("true");
  });

  it("says what it does, in both states", () => {
    const view = renderReadMode(model(), handlers());
    expect(focus(view).getAttribute("aria-label")).toContain("Hide");
    focus(view).click();
    expect(focus(view).getAttribute("aria-label")).toContain("Show");
  });
});

describe("chat", () => {
  it("sends on Enter but not on Shift+Enter", () => {
    const h = handlers();
    const view = renderReadMode(model(), h);
    const box =
      view.root.querySelector<HTMLTextAreaElement>(".trf-rm-composebox")!;

    box.value = "what did they mean?";
    box.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(h.onSendChat).not.toHaveBeenCalled();

    box.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(h.onSendChat).toHaveBeenCalledWith("what did they mean?");
    expect(box.value).toBe("");
  });

  // Markdown is built as DOM nodes rather than parsed, so there is nothing to
  // sanitise. This proves it: a script tag in model text stays text.
  it("never turns model output into markup", () => {
    const view = renderReadMode(
      model({
        messages: [
          {
            id: "m",
            role: "assistant",
            text: "<script>alert(1)</script> and <img src=x onerror=y>",
            createdAt: 1,
          },
        ],
      }),
      handlers(),
    );

    expect(view.root.querySelector("script")).toBeNull();
    expect(view.root.querySelector("img")).toBeNull();
    expect(view.root.querySelector(".trf-rm-chat")?.textContent).toContain(
      "alert(1)",
    );
  });

  it("renders headings, bullets, bold and inline code", () => {
    const view = renderReadMode(
      model({
        messages: [
          {
            id: "m",
            role: "assistant",
            text: "**What It Is**\n- a `thing` that **works**\n- another",
            createdAt: 1,
          },
        ],
      }),
      handlers(),
    );

    expect(view.root.querySelector(".trf-rm-mdh")?.textContent).toBe(
      "What It Is",
    );
    expect(view.root.querySelectorAll(".trf-rm-mdli")).toHaveLength(2);
    expect(view.root.querySelector(".trf-rm-mdcode")?.textContent).toBe(
      "thing",
    );
    expect(view.root.querySelector("strong")?.textContent).toBe("works");
  });

  // Setting up the key happens in the chat panel, not on a settings page. The
  // form is an extension-origin iframe, so the host page cannot read what is
  // typed into it, and so it can request the provider permission — neither of
  // which a form drawn by the content script could manage.
  it("embeds the key form inline when one is offered", () => {
    const view = renderReadMode(
      model({ chat: { kind: "needs-key", setupUrl: "keysetup.html" } }),
      handlers(),
    );
    const frame =
      view.root.querySelector<HTMLIFrameElement>(".trf-rm-keyframe");
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("src")).toBe("keysetup.html");
  });

  it("falls back to words when no setup page is available", () => {
    const view = renderReadMode(
      model({ chat: { kind: "needs-key" } }),
      handlers(),
    );
    expect(view.root.querySelector(".trf-rm-keyframe")).toBeNull();
    expect(view.root.querySelector(".trf-rm-chat")?.textContent).toContain(
      "settings",
    );
  });

  it("shows an error rather than an empty panel", () => {
    const view = renderReadMode(
      model({
        chat: { kind: "error", message: "Rate limited.", retryable: true },
      }),
      handlers(),
    );
    expect(view.root.querySelector(".trf-rm-status--error")?.textContent).toBe(
      "Rate limited.",
    );
  });
});

describe("lifecycle", () => {
  it("mounts detached and removes itself on destroy", () => {
    const view = renderReadMode(model(), handlers());
    expect(view.root.isConnected).toBe(false);

    document.body.appendChild(view.root);
    expect(view.root.isConnected).toBe(true);

    view.destroy();
    expect(view.root.isConnected).toBe(false);
  });
});
