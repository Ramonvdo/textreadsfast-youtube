/**
 * Toolbar popup: switch profile without leaving the video.
 *
 * This is where profile switching actually wants to happen. The reason to change
 * profile is usually what is on screen right now — a bright talking head wants
 * Clarity Cold, a dark documentary wants Obsidian — and a settings page in
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
import {
  loadDevicePrefs,
  loadSettings,
  saveDevicePrefs,
  saveSettings,
  type Settings,
} from "../settings";

const list = document.getElementById("profiles") as HTMLDivElement | null;
const toggle = document.getElementById("enabled") as HTMLInputElement | null;
const settingsButton = document.getElementById("open-settings");
const readModeButton = document.getElementById("read-mode");
const libraryButton = document.getElementById("open-library");
const note = document.getElementById("popup-note");
const autoReadMode = document.getElementById(
  "auto-read-mode",
) as HTMLInputElement | null;

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

  if (autoReadMode) {
    const prefs = await loadDevicePrefs();
    autoReadMode.checked = prefs.autoReadMode;
    autoReadMode.addEventListener("change", () => {
      void saveDevicePrefs({ autoReadMode: autoReadMode.checked });
    });
  }

  settingsButton?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  libraryButton?.addEventListener("click", () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL("library.html") });
    window.close();
  });

  // The popup cannot reach the player, so the content script does the work and
  // reports back. It refuses on a page with no captions rather than opening an
  // empty study view, and that refusal is worth showing.
  readModeButton?.addEventListener("click", () => {
    void (async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id === undefined) return;
      try {
        const reply = (await chrome.tabs.sendMessage(tab.id, {
          type: "readmode.toggle",
        })) as { ok: boolean; reason?: string } | undefined;
        if (reply?.ok) window.close();
        else if (note)
          note.textContent =
            reply?.reason ?? "Read mode is not available here.";
      } catch {
        if (note) note.textContent = "Open a YouTube video first.";
      }
    })();
  });

  paint(state.all);
}

void main();
