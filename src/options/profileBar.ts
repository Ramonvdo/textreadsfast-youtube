/**
 * The profile picker, at the top of the settings page.
 *
 * It is first because it is the decision that makes the rest unnecessary most of
 * the time: pick the profile that suits what you are watching and every slider
 * below is already where it should be.
 *
 * Built-ins are never written to. Editing one leaves the change live and marks
 * the profile modified, with Revert and "Save as…" beside it — so Default stays
 * exactly as shipped no matter what anyone does to it.
 */

import {
  applyProfile,
  deleteProfile,
  isModified,
  loadProfiles,
  saveAsProfile,
  updateProfile,
  type Profile,
} from "../profiles";
import type { Settings } from "../settings";

export interface ProfileBarHost {
  /** Current live settings. Read on every refresh, never cached here. */
  settings: () => Settings;
  /** Write any edit still waiting on a debounce, before it can race a profile. */
  flushPending: () => Promise<void>;
  /** A profile was applied; the page must reload its controls and preview. */
  onApplied: (settings: Settings) => void;
}

function button(label: string, className = ""): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `profile-action ${className}`.trim();
  el.textContent = label;
  return el;
}

export class ProfileBar {
  private host: ProfileBarHost;
  private root: HTMLElement;
  private select = document.createElement("select");
  private note = document.createElement("p");
  private actions = document.createElement("div");
  private revertBtn = button("Revert");
  private saveAsBtn = button("Save as…");
  private updateBtn = button("Update");
  private deleteBtn = button("Delete", "profile-action--danger");
  private nameRow = document.createElement("div");
  private nameInput = document.createElement("input");
  private profiles: Profile[] = [];
  private activeId = "default";

  constructor(root: HTMLElement, host: ProfileBarHost) {
    this.root = root;
    this.host = host;
    this.build();
  }

  private build(): void {
    this.select.id = "profile-select";
    this.select.addEventListener(
      "change",
      () => void this.choose(this.select.value),
    );

    this.note.className = "profile-note";

    this.actions.className = "profile-actions";
    this.actions.append(
      this.revertBtn,
      this.updateBtn,
      this.saveAsBtn,
      this.deleteBtn,
    );

    this.revertBtn.addEventListener(
      "click",
      () => void this.choose(this.activeId),
    );
    this.saveAsBtn.addEventListener("click", () => this.toggleNameRow(true));
    this.updateBtn.addEventListener("click", () => void this.update());
    this.deleteBtn.addEventListener("click", () => void this.remove());

    this.nameRow.className = "profile-name-row";
    this.nameInput.type = "text";
    this.nameInput.placeholder = "Name this profile";
    this.nameInput.maxLength = 40;
    const confirm = button("Save", "profile-action--primary");
    const cancel = button("Cancel");
    confirm.addEventListener("click", () => void this.saveAs());
    cancel.addEventListener("click", () => this.toggleNameRow(false));
    // Enter is what anyone will reach for after typing a name.
    this.nameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void this.saveAs();
      if (event.key === "Escape") this.toggleNameRow(false);
    });
    this.nameRow.append(this.nameInput, confirm, cancel);
    this.nameRow.hidden = true;

    const row = document.createElement("div");
    row.className = "profile-row";
    const label = document.createElement("label");
    label.htmlFor = this.select.id;
    label.textContent = "Profile";
    row.append(label, this.select);

    this.root.append(row, this.note, this.actions, this.nameRow);
  }

  private toggleNameRow(open: boolean): void {
    this.nameRow.hidden = !open;
    if (open) {
      this.nameInput.value = this.suggestName();
      this.nameInput.focus();
      this.nameInput.select();
    }
  }

  private suggestName(): string {
    const active = this.active();
    const base = active ? `${active.name} (yours)` : "My profile";
    const taken = new Set(this.profiles.map((p) => p.name));
    if (!taken.has(base)) return base;
    for (let n = 2; n < 100; n += 1) {
      if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
    }
    return base;
  }

  private active(): Profile | undefined {
    return this.profiles.find((p) => p.id === this.activeId);
  }

  /** Re-read the profile list from storage, then repaint. For when the list
   *  itself may have changed — a save, an update, a delete. */
  async refresh(): Promise<void> {
    const state = await loadProfiles();
    this.profiles = state.all;
    this.activeId = state.activeId;
    this.paint();
  }

  /** Repaint from what is already loaded. This is the one the settings page
   *  calls on every edit, so it must not touch storage: a slider drag would
   *  otherwise issue a read per frame to answer a question — has this drifted
   *  from its profile? — that the cached list already answers. */
  repaint(): void {
    this.paint();
  }

  private paint(): void {
    const builtIn = this.profiles.filter((p) => p.builtIn);
    const mine = this.profiles.filter((p) => !p.builtIn);

    this.select.replaceChildren();
    this.select.append(this.group("Built in", builtIn));
    if (mine.length > 0) this.select.append(this.group("Yours", mine));
    this.select.value = this.activeId;

    const active = this.active();
    const modified = active ? isModified(active, this.host.settings()) : false;

    this.note.textContent = modified
      ? "Modified — your changes are live but not saved to this profile."
      : (active?.blurb ?? "");
    this.note.classList.toggle("profile-note--modified", modified);

    this.revertBtn.hidden = !modified;
    // Overwriting a built-in would leave no way back to the shipped values.
    this.updateBtn.hidden = !active || active.builtIn || !modified;
    this.deleteBtn.hidden = !active || active.builtIn;
  }

  private group(label: string, items: Profile[]): HTMLOptGroupElement {
    const group = document.createElement("optgroup");
    group.label = label;
    for (const profile of items) {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.name;
      group.append(option);
    }
    return group;
  }

  private async choose(id: string): Promise<void> {
    const profile = this.profiles.find((p) => p.id === id);
    if (!profile) return;
    await this.host.flushPending();
    await applyProfile(profile);
    this.activeId = id;
    this.toggleNameRow(false);
    // The whole page reads from settings, so it reloads rather than being
    // patched field by field — fewer places for a control to disagree with what
    // is actually stored.
    this.host.onApplied({ ...this.host.settings(), ...profile.settings });
    this.paint();
  }

  private async saveAs(): Promise<void> {
    const name = this.nameInput.value.trim();
    if (!name) return;
    try {
      const saved = await saveAsProfile(name, this.host.settings());
      this.activeId = saved.id;
      this.toggleNameRow(false);
      await this.refresh();
    } catch (error) {
      // Sync storage caps each key at 8KB, so a long enough list of profiles
      // will eventually refuse a write. Say so rather than appearing to save.
      this.note.textContent =
        error instanceof Error
          ? `Could not save: ${error.message}`
          : "Could not save.";
      this.note.classList.add("profile-note--modified");
    }
  }

  private async update(): Promise<void> {
    await updateProfile(this.activeId, this.host.settings());
    await this.refresh();
  }

  private async remove(): Promise<void> {
    const active = this.active();
    if (!active || active.builtIn) return;
    await deleteProfile(active.id);
    await this.refresh();
    // `loadProfiles` already fell back to Default for the dangling id; applying
    // it is what actually puts those settings back on screen.
    await this.choose(this.activeId);
  }
}
