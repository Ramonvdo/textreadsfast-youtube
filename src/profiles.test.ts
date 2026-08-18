import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULTS, loadSettings, type Settings } from "./settings";
import {
  BUILT_IN_PROFILES,
  DEFAULT_PROFILE_ID,
  PROFILE_KEYS,
  applyProfile,
  deleteProfile,
  isModified,
  loadProfiles,
  saveAsProfile,
  updateProfile,
  type Profile,
} from "./profiles";

/**
 * A stand-in for `chrome.storage.sync`.
 *
 * Only `get`/`set`/`remove` are modelled, and `get` follows the real contract
 * that matters here: given an object of defaults it returns the stored value for
 * each key, or the default when nothing was stored. Most of the settings code
 * depends on exactly that behaviour.
 */
function fakeStorage() {
  let data: Record<string, unknown> = {};
  return {
    reset: () => {
      data = {};
    },
    raw: () => data,
    area: {
      get: async (defaults: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(defaults).map(([key, fallback]) => [
            key,
            key in data ? data[key] : fallback,
          ]),
        ),
      set: async (patch: Record<string, unknown>) => {
        data = { ...data, ...patch };
      },
      remove: async (key: string) => {
        delete data[key];
      },
    },
  };
}

const storage = fakeStorage();

beforeEach(() => {
  storage.reset();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      sync: storage.area,
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  };
});

const byId = (id: string): Profile => {
  const found = BUILT_IN_PROFILES.find((p) => p.id === id);
  if (!found) throw new Error(`no built-in profile ${id}`);
  return found;
};

describe("built-in profiles", () => {
  // The guard against the failure this design is most exposed to: a field added
  // to Settings, wired into the options page, and forgotten in the profiles —
  // which would look like a profile switch that only half works.
  it("every built-in defines every profile key", () => {
    for (const profile of BUILT_IN_PROFILES) {
      for (const key of PROFILE_KEYS) {
        expect(
          profile.settings[key],
          `${profile.id} is missing ${String(key)}`,
        ).toBeDefined();
      }
    }
  });

  it("declares no keys beyond the profile keys", () => {
    const allowed = new Set<string>(PROFILE_KEYS as string[]);
    for (const profile of BUILT_IN_PROFILES) {
      for (const key of Object.keys(profile.settings)) {
        expect(
          allowed.has(key),
          `${profile.id} declares stray key ${key}`,
        ).toBe(true);
      }
    }
  });

  it("Default matches the shipped defaults exactly", () => {
    const preset = byId(DEFAULT_PROFILE_ID);
    for (const key of PROFILE_KEYS) {
      expect(preset.settings[key], String(key)).toEqual(DEFAULTS[key]);
    }
  });

  it("has unique ids and names", () => {
    const ids = BUILT_IN_PROFILES.map((p) => p.id);
    const names = BUILT_IN_PROFILES.map((p) => p.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("applying a profile", () => {
  it("writes every profile key", async () => {
    await applyProfile(byId("serif-flow"));
    const settings = await loadSettings();
    for (const key of PROFILE_KEYS) {
      expect(settings[key], String(key)).toEqual(
        byId("serif-flow").settings[key],
      );
    }
  });

  // `enabled` and `language` belong to the user, not to the reading style. A
  // profile that turned the reader back on, or switched caption language, would
  // read as a bug rather than as a theme change.
  it("leaves enabled and language alone", async () => {
    await chrome.storage.sync.set({ enabled: false, language: "nl" });
    await applyProfile(byId("clarity"));
    const settings = await loadSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.language).toBe("nl");
  });

  it("records the profile as active", async () => {
    await applyProfile(byId("sprint"));
    expect((await loadProfiles()).activeId).toBe("sprint");
  });
});

describe("modification tracking", () => {
  it("is false straight after applying, true after one change", async () => {
    const preset = byId("reading-room");
    await applyProfile(preset);

    const applied = await loadSettings();
    expect(isModified(preset, applied)).toBe(false);

    const nudged: Settings = { ...applied, fontSize: applied.fontSize + 1 };
    expect(isModified(preset, nudged)).toBe(true);
  });

  it("ignores the keys a profile does not own", async () => {
    const preset = byId("night-study");
    await applyProfile(preset);
    const applied = await loadSettings();
    expect(
      isModified(preset, { ...applied, enabled: false, language: "de" }),
    ).toBe(false);
  });
});

describe("custom profiles", () => {
  it("round-trips save, load and update", async () => {
    await applyProfile(byId("default"));
    const settings = await loadSettings();

    const saved = await saveAsProfile("  Late night  ", {
      ...settings,
      fontSize: 41,
    });
    expect(saved.name).toBe("Late night");

    let state = await loadProfiles();
    expect(state.activeId).toBe(saved.id);
    expect(state.all.find((p) => p.id === saved.id)?.settings.fontSize).toBe(
      41,
    );

    await updateProfile(saved.id, { ...settings, fontSize: 19 });
    state = await loadProfiles();
    expect(state.all.find((p) => p.id === saved.id)?.settings.fontSize).toBe(
      19,
    );
  });

  it("stores only the profile keys, never enabled or language", async () => {
    const settings = await loadSettings();
    const saved = await saveAsProfile("Trimmed", {
      ...settings,
      enabled: false,
    });
    const stored = (await loadProfiles()).all.find((p) => p.id === saved.id);
    expect(Object.keys(stored!.settings).sort()).toEqual(
      [...PROFILE_KEYS].sort(),
    );
  });

  it("falls back to Default when the active profile is deleted", async () => {
    const settings = await loadSettings();
    const saved = await saveAsProfile("Temporary", settings);
    expect((await loadProfiles()).activeId).toBe(saved.id);

    await deleteProfile(saved.id);
    const state = await loadProfiles();
    // A dangling id would leave the picker with nothing selected.
    expect(state.activeId).toBe(DEFAULT_PROFILE_ID);
    expect(state.all.some((p) => p.id === saved.id)).toBe(false);
  });

  it("refuses to overwrite a built-in", async () => {
    const settings = await loadSettings();
    await updateProfile("default", { ...settings, fontSize: 99 });
    const state = await loadProfiles();
    expect(state.all.find((p) => p.id === "default")?.settings.fontSize).toBe(
      DEFAULTS.fontSize,
    );
  });
});
