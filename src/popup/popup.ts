/**
 * Toolbar popup: switch profile without leaving the video.
 *
 * This is where profile switching actually wants to happen. The reason to change
 * profile is usually what is on screen right now — a bright talking head wants
 * Reading Room, a dark documentary wants Nocturne — and a settings page in
 * another tab is the wrong place to notice that.
 *
 * Applying a profile writes to `chrome.storage.sync`, which the content script
 * is already listening to, so the change lands on the open video with no
 * messaging between the two.
 */

import {
  applyProfile,
  isModified,
  loadProfiles,
  type Profile,
} from "../profiles";
import { loadSettings, saveSettings, type Settings } from "../settings";

const list = document.getElementById("profiles") as HTMLDivElement | null;
const toggle = document.getElementById("enabled") as HTMLInputElement | null;
const settingsButton = document.getElementById("open-settings");

let settings: Settings | null = null;
let activeId = "default";

function paint(profiles: Profile[]): void {
  if (!list) return;
  list.replaceChildren();

  for (const profile of profiles) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "profile";
    const current = profile.id === activeId;
    button.setAttribute("aria-current", String(current));

    const name = document.createElement("span");
    name.textContent = profile.name;

    const blurb = document.createElement("small");
    // Say the settings have drifted, rather than describing a profile that is
    // no longer quite what is on screen.
    blurb.textContent =
      current && settings && isModified(profile, settings)
        ? "Modified"
        : profile.blurb;

    button.append(name, blurb);
    button.addEventListener("click", () => {
      void applyProfile(profile).then(() => {
        activeId = profile.id;
        // Re-read rather than assume: `applyProfile` leaves `enabled` alone, and
        // the toggle must keep showing the truth.
        void loadSettings().then((next) => {
          settings = next;
          paint(profiles);
        });
      });
    });

    list.append(button);
  }
}

async function main(): Promise<void> {
  const [state, current] = await Promise.all([loadProfiles(), loadSettings()]);
  settings = current;
  activeId = state.activeId;

  if (toggle) {
    toggle.checked = current.enabled;
    toggle.addEventListener("change", () => {
      void saveSettings({ enabled: toggle.checked });
      if (settings) settings.enabled = toggle.checked;
    });
  }

  settingsButton?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  paint(state.all);
}

void main();
