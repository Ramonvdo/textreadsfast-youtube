// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ReaderOverlay } from "./overlay";
import { classify } from "../reader-core/words";
import {
  DEFAULTS,
  MODE_LABELS,
  THEME_LABELS,
  type ReadingMode,
  type Settings,
} from "../settings";

const VIEW = {
  previous: ["the", "brain"].map(classify),
  current: classify("identifies"),
  upcoming: ["a", "whole", "word"].map(classify),
};

/** An overlay with its private root reachable, which is how the options page
 *  already mounts one. */
function mount(patch: Partial<Settings>): {
  root: HTMLElement;
  overlay: ReaderOverlay;
} {
  const overlay = new ReaderOverlay({ ...DEFAULTS, ...patch });
  const root = (overlay as unknown as { root: HTMLElement }).root;
  document.body.replaceChildren(root);
  overlay.render(VIEW);
  return { root, overlay };
}

const words = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(".trf-lw"));

describe("mode labels", () => {
  /*
   * The compiler already enforces this — `MODE_LABELS` is a `Record` keyed by
   * the union, so a mode without a label fails to build. The test is here to
   * say why the record is shaped that way: the option lists used to be
   * hand-written, and a mode added to the type simply never appeared in the
   * settings picker.
   */
  it("names every mode and every theme", () => {
    expect(Object.keys(MODE_LABELS)).toContain("rsvp");
    expect(Object.keys(MODE_LABELS).length).toBeGreaterThanOrEqual(7);
    expect(Object.keys(THEME_LABELS)).toContain("custom");
    for (const label of Object.values({ ...MODE_LABELS, ...THEME_LABELS })) {
      expect(label.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("mode dispatch", () => {
  /*
   * THE FAILURE THIS GUARDS: the dispatch was an if/else whose `else` was RSVP,
   * so a mode added to the union compiled and silently rendered as RSVP. Each
   * mode has to produce visibly different markup, or it is not really a mode.
   */
  const shapes: Array<[ReadingMode, (root: HTMLElement) => void]> = [
    [
      "rsvp",
      (root) => {
        expect(root.querySelector(".trf-pivot")).not.toBeNull();
        expect(words(root)).toHaveLength(0);
      },
    ],
    [
      "rsvp-bionic",
      (root) => {
        // Everything RSVP has: the pivot letter is still picked out and the
        // word is still the absolutely-positioned `.trf-word`.
        expect(root.querySelectorAll(".trf-pivot")).toHaveLength(1);
        expect(words(root)).toHaveLength(0);
        // ...and the context either side is emboldened, which is the whole
        // difference between this and plain RSVP.
        const before = root.querySelector(".trf-context--before");
        const after = root.querySelector(".trf-context--after");
        expect(before?.querySelectorAll("b")).toHaveLength(2);
        expect(after?.querySelectorAll("b")).toHaveLength(3);
        // Real spaces between them, or the run reads as one long word.
        expect(before?.textContent).toBe("the brain");
        expect(after?.textContent).toBe("a whole word");
      },
    ],
    [
      "bionic",
      (root) => {
        expect(root.querySelector(".trf-pivot")).toBeNull();
        expect(words(root)).toHaveLength(6);
        expect(root.querySelectorAll(".trf-lw b")).toHaveLength(6);
      },
    ],
    [
      "plain",
      (root) => {
        // The quietest mode: no pivot letter and no bold anywhere.
        expect(root.querySelector(".trf-pivot")).toBeNull();
        expect(root.querySelector(".trf-lw b")).toBeNull();
        expect(words(root)).toHaveLength(6);
      },
    ],
    [
      "highlight",
      (root) => {
        expect(root.querySelector(".trf-pivot")).toBeNull();
        expect(root.querySelectorAll(".trf-lw--current")).toHaveLength(1);
      },
    ],
    [
      "karaoke",
      (root) => {
        expect(root.querySelectorAll(".trf-lw--past")).toHaveLength(2);
        expect(root.querySelectorAll(".trf-lw--future")).toHaveLength(3);
      },
    ],
    [
      "focusline",
      (root) => {
        // One word, plainly. No pivot span, no line of spans.
        expect(root.querySelector(".trf-pivot")).toBeNull();
        expect(words(root)).toHaveLength(0);
        expect(root.querySelector(".trf-word")?.textContent).toBe("identifies");
      },
    ],
  ];

  for (const [mode, check] of shapes) {
    it(`renders ${mode} as itself`, () => {
      const { root } = mount({ mode });
      expect(root.dataset.mode).toBe(mode);
      check(root);
    });
  }

  /*
   * The pivot must not be emboldened along with its neighbours. The focus word
   * is the one thing that is already at full strength, and bolding it too would
   * leave the mode with nothing to distinguish the word being spoken from the
   * words merely near it.
   */
  it("leaves the focus word alone in rsvp-bionic", () => {
    const { root } = mount({ mode: "rsvp-bionic" });
    expect(root.querySelector(".trf-word")?.querySelector("b")).toBeNull();
    expect(root.querySelector(".trf-word")?.textContent).toBe("identifies");
  });

  /*
   * Both modes split a word at the same point. They used to be a loop each, and
   * a word that changes shape when you switch mode is a bug you only notice by
   * doing exactly that.
   */
  it("splits a word identically in bionic and rsvp-bionic", () => {
    const line = mount({ mode: "bionic" }).root;
    const lineLead = line.querySelector(".trf-lw--future b")?.textContent;

    const hybrid = mount({ mode: "rsvp-bionic" }).root;
    const hybridLead = hybrid.querySelector(
      ".trf-context--after b",
    )?.textContent;

    expect(lineLead).toBeTruthy();
    expect(hybridLead).toBe(lineLead);
  });

  it("marks exactly one current word in every line mode", () => {
    for (const mode of ["bionic", "plain", "highlight", "karaoke"] as const) {
      const { root } = mount({ mode });
      const current = root.querySelectorAll(".trf-lw--current");
      expect(current).toHaveLength(1);
      expect(current[0].textContent).toBe("identifies");
    }
  });

  /*
   * Settings sync between browsers, so a newer version of the extension on
   * another machine can hand this one a mode it has never heard of. That has to
   * degrade to a working reader rather than to an empty card.
   */
  it("falls back to RSVP for a mode from the future", () => {
    const { root } = mount({ mode: "hologram" as ReadingMode });
    expect(root.querySelector(".trf-pivot")).not.toBeNull();
  });
});

describe("the custom palette", () => {
  const PALETTE: Partial<Settings> = {
    customBackground: "#101010",
    customText: "#fafafa",
    customFaded: "#808080",
    customAccent: "#00ff88",
  };

  it("writes its four colours when the custom theme is on", () => {
    const { root } = mount({ theme: "custom", ...PALETTE });
    expect(root.style.getPropertyValue("--trf-custom-bg")).toBe("#101010");
    expect(root.style.getPropertyValue("--trf-custom-text")).toBe("#fafafa");
    expect(root.style.getPropertyValue("--trf-custom-faded")).toBe("#808080");
    expect(root.style.getPropertyValue("--trf-custom-accent")).toBe("#00ff88");
  });

  /*
   * The one that matters: a colour left behind after switching away would leak
   * into a built-in theme, which is defined entirely in the stylesheet and has
   * no business reading an inline property.
   */
  it("clears them again when another theme is chosen", () => {
    const { root, overlay } = mount({ theme: "custom", ...PALETTE });
    overlay.apply({ ...DEFAULTS, ...PALETTE, theme: "sepia" });
    expect(root.style.getPropertyValue("--trf-custom-bg")).toBe("");
    expect(root.style.getPropertyValue("--trf-custom-accent")).toBe("");
  });

  it("never writes a palette for a built-in theme", () => {
    const { root } = mount({ theme: "nocturne", ...PALETTE });
    expect(root.style.getPropertyValue("--trf-custom-text")).toBe("");
  });
});

describe("card opacity", () => {
  it("is published as a percentage, which is what color-mix wants", () => {
    const { root } = mount({ backgroundOpacity: 0.4 });
    expect(root.style.getPropertyValue("--trf-bg-opacity")).toBe("40.0%");
  });

  // Storage can hold anything a previous version wrote, and `color-mix` with a
  // percentage outside 0-100 drops the whole declaration.
  it("clamps a value from outside the range", () => {
    expect(
      mount({ backgroundOpacity: 4 }).root.style.getPropertyValue(
        "--trf-bg-opacity",
      ),
    ).toBe("100.0%");
    expect(
      mount({ backgroundOpacity: -1 }).root.style.getPropertyValue(
        "--trf-bg-opacity",
      ),
    ).toBe("0.0%");
  });
});

describe("the bionic accent", () => {
  // Off is the whole point of the setting: the accent is the one rule that
  // makes Bionic loud, and it lives in CSS keyed on this attribute.
  it("is exposed to the stylesheet either way", () => {
    expect(mount({ mode: "bionic" }).root.dataset.bionicAccent).toBe("true");
    expect(
      mount({ mode: "bionic", bionicAccent: false }).root.dataset.bionicAccent,
    ).toBe("false");
  });
});
