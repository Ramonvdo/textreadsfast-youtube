// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";

/*
 * THE BUG THIS GUARDS: the reader could only be switched off from the toolbar
 * popup, which Chrome often tucks away in its extensions menu. YouTube's own CC
 * button and `c` key never reach the reader, because it fetches the captions
 * itself, so a viewer pressing CC saw the words carry on regardless.
 */

/** `chrome.storage` with change events, so the content script hears its own writes. */
function fakeChrome() {
  const sync: Record<string, unknown> = {};
  const listeners: ((
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => void)[] = [];
  const area = (data: Record<string, unknown>, name: string) => ({
    get: async (defaults: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(defaults).map(([key, fallback]) => [
          key,
          key in data ? data[key] : fallback,
        ]),
      ),
    set: async (patch: Record<string, unknown>) => {
      const changes = Object.fromEntries(
        Object.entries(patch).map(([key, newValue]) => [
          key,
          { oldValue: data[key], newValue },
        ]),
      );
      Object.assign(data, patch);
      for (const listener of listeners) listener(changes, name);
    },
  });
  return {
    sync,
    chrome: {
      storage: {
        sync: area(sync, "sync"),
        local: area({}, "local"),
        onChanged: {
          addListener: (l: (typeof listeners)[number]) => listeners.push(l),
          removeListener: () => {},
        },
      },
      runtime: {
        getURL: (path: string) => `chrome-extension://test/${path}`,
        onMessage: { addListener: () => {} },
      },
    },
  };
}

/** Let storage reads and the change listener's reload run to completion. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const fake = fakeChrome();
let controls: HTMLElement;

beforeAll(async () => {
  history.replaceState({}, "", "/watch?v=current");
  const player = document.createElement("div");
  player.id = "movie_player";
  controls = document.createElement("div");
  controls.className = "ytp-right-controls";
  player.append(document.createElement("video"), controls);
  document.body.append(player);

  (globalThis as unknown as { chrome: unknown }).chrome = fake.chrome;
  await import("./index");
  await settle();
});

describe("turning the reader off from the player", () => {
  it("puts an on/off switch in YouTube's own player controls", () => {
    const toggle = controls.querySelector(".trf-player-toggle");
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("role")).toBe("switch");
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
  });

  it("switches the reader off, and back on, for every video", async () => {
    const toggle = controls.querySelector<HTMLElement>(".trf-player-toggle")!;

    toggle.click();
    await settle();
    expect(fake.sync.enabled).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    toggle.click();
    await settle();
    expect(fake.sync.enabled).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
});
