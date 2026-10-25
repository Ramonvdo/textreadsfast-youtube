/** The switch stays available even when there is no reader or caption track. */
export class PlayerToggle {
  private button = document.createElement("button");
  private observer: MutationObserver | null = null;

  constructor(
    readonly player: HTMLElement,
    onToggle: () => void,
  ) {
    this.button.type = "button";
    this.button.className = "ytp-button trf-player-toggle";
    this.button.setAttribute("role", "switch");
    this.button.setAttribute("aria-label", "TextReadsFast captions");
    const label = document.createElement("span");
    label.textContent = "TRF";
    const track = document.createElement("span");
    track.className = "trf-switch-track";
    track.setAttribute("aria-hidden", "true");
    this.button.append(label, track);
    this.button.addEventListener("click", (event) => {
      event.stopPropagation();
      onToggle();
    });
    for (const type of [
      "pointerdown",
      "pointerup",
      "mousedown",
      "mouseup",
      "keydown",
      "keyup",
      "keypress",
      "dblclick",
    ]) {
      this.button.addEventListener(type, (event) => event.stopPropagation());
    }
    this.mount();
    // YouTube can replace its controls without navigating to another video.
    this.observer = new MutationObserver(() => this.mount());
    this.observer.observe(player, { childList: true, subtree: true });
  }

  private mount(): void {
    const host = this.player.querySelector(".ytp-right-controls");
    this.button.classList.toggle("trf-player-toggle--floating", !host);
    if (this.button.parentElement !== (host ?? this.player))
      (host ?? this.player).prepend(this.button);
  }

  apply(enabled: boolean): void {
    this.button.setAttribute("aria-checked", String(enabled));
    this.button.title = `${enabled ? "Turn off" : "Turn on"} TextReadsFast captions`;
  }

  destroy(): void {
    this.observer?.disconnect();
    this.button.remove();
  }
}
