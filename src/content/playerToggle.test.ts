// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlayerToggle } from "./playerToggle";

const mounted: PlayerToggle[] = [];

function mount(withControls = true) {
  const player = document.createElement("div");
  const controls = document.createElement("div");
  controls.className = "ytp-right-controls";
  const native = document.createElement("button");
  controls.append(native);
  if (withControls) player.append(controls);
  document.body.append(player);
  const onToggle = vi.fn();
  const toggle = new PlayerToggle(player, onToggle);
  mounted.push(toggle);
  const button = player.querySelector<HTMLButtonElement>(".trf-player-toggle")!;
  return { player, controls, native, button, toggle, onToggle };
}

/** Resolve after the real observer has had a chance to repair the controls. */
function mutate(player: HTMLElement, change: () => void): Promise<void> {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      observer.disconnect();
      queueMicrotask(resolve);
    });
    observer.observe(player, { childList: true, subtree: true });
    change();
  });
}

afterEach(() => {
  for (const toggle of mounted.splice(0)) toggle.destroy();
  document.body.replaceChildren();
});

describe("player toggle", () => {
  it("mounts in the native control bar without replacing its buttons", () => {
    const { player, controls, native, button } = mount();
    expect(controls.firstElementChild).toBe(button);
    expect(controls.contains(native)).toBe(true);
    expect(player.querySelectorAll(".trf-player-toggle")).toHaveLength(1);
    expect(button.classList.contains("trf-player-toggle--floating")).toBe(
      false,
    );
    expect(button.type).toBe("button");
    expect(button.getAttribute("role")).toBe("switch");
    expect(button.getAttribute("aria-label")).toBe("TextReadsFast captions");
  });

  it("floats until a late control bar appears, then moves into it", async () => {
    const { player, controls, button } = mount(false);
    expect(button.parentElement).toBe(player);
    expect(button.classList.contains("trf-player-toggle--floating")).toBe(true);
    await mutate(player, () => player.append(controls));
    expect(button.parentElement).toBe(controls);
    expect(button.classList.contains("trf-player-toggle--floating")).toBe(
      false,
    );
    expect(player.querySelectorAll(".trf-player-toggle")).toHaveLength(1);
  });

  it("survives a replaced control bar and removal of the switch itself", async () => {
    const { player, controls, button } = mount();
    const replacement = controls.cloneNode(false) as HTMLDivElement;
    await mutate(player, () => controls.replaceWith(replacement));
    expect(button.parentElement).toBe(replacement);
    expect(controls.contains(button)).toBe(false);
    await mutate(player, () => button.remove());
    expect(button.parentElement).toBe(replacement);
    expect(player.querySelectorAll(".trf-player-toggle")).toHaveLength(1);
    await mutate(player, () => replacement.remove());
    expect(button.parentElement).toBe(player);
    expect(button.classList.contains("trf-player-toggle--floating")).toBe(true);
  });

  it("reflects enabled state and keeps clicks and keys out of playback", () => {
    const { player, button, toggle, onToggle } = mount();
    toggle.apply(true);
    expect(button.getAttribute("aria-checked")).toBe("true");
    expect(button.title).toBe("Turn off TextReadsFast captions");
    toggle.apply(false);
    expect(button.getAttribute("aria-checked")).toBe("false");
    expect(button.title).toBe("Turn on TextReadsFast captions");
    const playback = vi.fn();
    for (const type of [
      "click",
      "dblclick",
      "pointerdown",
      "pointerup",
      "keydown",
      "keyup",
      "keypress",
    ]) {
      player.addEventListener(type, playback);
      button.dispatchEvent(new Event(type, { bubbles: true }));
    }
    expect(onToggle).toHaveBeenCalledOnce();
    expect(playback).not.toHaveBeenCalled();
  });

  it("stays removed after destruction even if YouTube changes its controls", async () => {
    const { player, controls, toggle } = mount();
    toggle.destroy();
    await mutate(player, () => controls.replaceWith(controls.cloneNode(false)));
    expect(player.querySelector(".trf-player-toggle")).toBeNull();
  });
});
