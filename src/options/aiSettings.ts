/**
 * The AI section of the settings page.
 *
 * This lives on an extension page for a reason that is not stylistic:
 * `chrome.permissions.request()` needs a user gesture AND an extension page. A
 * content script cannot call it, and neither can the service worker. So the
 * moment a key is saved is the only moment the provider's origin can be asked
 * for, and this is the only place that moment can happen.
 *
 * The key field is write-only. A stored key renders as dots and a "Replace"
 * action; the real value is never put back into the DOM, so it cannot be read
 * off the screen, copied out by an extension with page access, or leak into a
 * screenshot.
 */

const KEY = "secret.apiKey";
const BASE_URL = "ai.baseUrl";
const MODEL = "ai.model";
const PROMPT = "readmode.summaryPrompt";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

interface ModelOption {
  id: string;
  name: string;
  contextLength: number;
}

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

function row(label: string, help: string, control: HTMLElement): HTMLElement {
  const wrapper = el("div", "row");
  const text = el("div");
  text.append(el("label", undefined, label));
  if (help) text.append(el("p", undefined, help));
  const holder = el("div", "control");
  holder.append(control);
  wrapper.append(text, holder);
  return wrapper;
}

/** The origin pattern a base URL needs, or null if it is not a usable URL. */
function originOf(baseUrl: string): string | null {
  try {
    return `${new URL(baseUrl).origin}/*`;
  } catch {
    return null;
  }
}

export function mountAiSettings(host: HTMLElement): void {
  const status = el("p", "ai-status");
  let baseUrl = OPENROUTER_BASE;

  /* ── provider ─────────────────────────────────────────────────────────── */

  const provider = el("select");
  for (const [value, label] of [
    ["openrouter", "OpenRouter (free models)"],
    ["custom", "Custom (OpenAI-compatible)"],
  ]) {
    const option = el("option");
    option.value = value;
    option.textContent = label;
    provider.append(option);
  }

  const baseInput = el("input");
  baseInput.type = "url";
  baseInput.placeholder = "https://api.example.com/v1";
  baseInput.setAttribute("aria-label", "API base URL");

  const baseRow = row(
    "Base URL",
    "Anything that speaks the OpenAI chat-completions API: OpenAI, Groq, Together, or a local Ollama or LM Studio.",
    baseInput,
  );

  const syncProviderRows = (): void => {
    baseRow.hidden = provider.value !== "custom";
  };

  /* ── the key ──────────────────────────────────────────────────────────── */

  const keyInput = el("input");
  keyInput.type = "password";
  keyInput.placeholder = "sk-or-v1-…";
  keyInput.autocomplete = "off";
  keyInput.spellcheck = false;
  keyInput.setAttribute("aria-label", "API key");

  const saveKey = el(
    "button",
    "profile-action profile-action--primary",
    "Save key",
  );
  saveKey.type = "button";

  const replaceKey = el("button", "profile-action", "Replace key");
  replaceKey.type = "button";

  const keyHolder = el("div", "control");
  keyHolder.append(keyInput, saveKey, replaceKey);

  const keyRow = el("div", "row");
  const keyText = el("div");
  keyText.append(el("label", undefined, "API key"));
  keyText.append(
    el(
      "p",
      undefined,
      "Stored on this device only, never synced. It is not encrypted at rest and can be read through the extension's devtools, so use a key you can revoke.",
    ),
  );
  keyRow.append(keyText, keyHolder);

  const showStoredKey = (stored: boolean): void => {
    keyInput.hidden = stored;
    saveKey.hidden = stored;
    replaceKey.hidden = !stored;
    if (stored) keyInput.value = "";
  };

  replaceKey.addEventListener("click", () => {
    showStoredKey(false);
    keyInput.focus();
  });

  /* ── model ────────────────────────────────────────────────────────────── */

  const model = el("select");
  const refresh = el("button", "profile-action", "Refresh");
  refresh.type = "button";

  const modelHolder = el("div", "control");
  modelHolder.append(model, refresh);

  const setModels = (options: ModelOption[], selected: string): void => {
    model.replaceChildren();
    const seen = new Set<string>();

    for (const option of options) {
      const node = el("option");
      node.value = option.id;
      node.textContent =
        option.contextLength > 0
          ? `${option.name} (${Math.round(option.contextLength / 1000)}k)`
          : option.name;
      model.append(node);
      seen.add(option.id);
    }

    // Keep whatever is configured selectable even when the list could not be
    // fetched, or the model has since left the free tier.
    if (selected && !seen.has(selected)) {
      const node = el("option");
      node.value = selected;
      node.textContent = `${selected} (configured)`;
      model.prepend(node);
    }
    model.value = selected;
  };

  const loadModels = async (): Promise<void> => {
    status.textContent = "Loading models…";
    const reply = (await chrome.runtime
      .sendMessage({ type: "ai.listModels" })
      .catch(() => null)) as { ok: boolean; models?: ModelOption[] } | null;

    if (!reply?.ok || !reply.models || reply.models.length === 0) {
      status.textContent =
        "Could not load the model list. The configured model still works; you can type another in settings.";
      return;
    }
    setModels(reply.models, model.value);
    status.textContent = `${reply.models.length} free models available.`;
  };

  refresh.addEventListener("click", () => void loadModels());

  /* ── prompt ───────────────────────────────────────────────────────────── */

  const prompt = el("textarea");
  prompt.rows = 8;
  prompt.setAttribute("aria-label", "Summary prompt");
  prompt.placeholder = "Using the shipped default prompt.";

  const resetPrompt = el("button", "profile-action", "Reset to default");
  resetPrompt.type = "button";
  resetPrompt.addEventListener("click", () => {
    // Empty means "use the shipped default", so the default lives in exactly
    // one place instead of being copied into storage on install.
    prompt.value = "";
    void chrome.storage.local.set({ [PROMPT]: "" });
    status.textContent = "Prompt reset to the shipped default.";
  });

  /* ── saving ───────────────────────────────────────────────────────────── */

  saveKey.addEventListener("click", () => {
    void (async () => {
      const value = keyInput.value.trim();
      if (!value) {
        status.textContent = "Enter a key first.";
        return;
      }

      const origin = originOf(baseUrl);
      if (!origin) {
        status.textContent = "That base URL is not a valid address.";
        return;
      }

      // Must happen inside the click, on an extension page. The optional
      // permission keeps the install-time warning off everyone who never turns
      // the AI on.
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        status.textContent =
          "Without access to that address the assistant cannot run. The key was not saved.";
        return;
      }

      await chrome.storage.local.set({ [KEY]: value });
      keyInput.value = "";
      showStoredKey(true);
      status.textContent = "Key saved. The assistant is ready.";
      void loadModels();
    })();
  });

  provider.addEventListener("change", () => {
    baseUrl =
      provider.value === "custom" ? baseInput.value.trim() : OPENROUTER_BASE;
    syncProviderRows();
    void chrome.storage.local.set({ [BASE_URL]: baseUrl });
  });

  baseInput.addEventListener("change", () => {
    baseUrl = baseInput.value.trim() || OPENROUTER_BASE;
    void chrome.storage.local.set({ [BASE_URL]: baseUrl });
    status.textContent =
      "Base URL saved. Save your key again to grant access to it.";
  });

  model.addEventListener("change", () => {
    void chrome.storage.local.set({ [MODEL]: model.value });
  });

  let promptTimer = 0;
  prompt.addEventListener("input", () => {
    window.clearTimeout(promptTimer);
    promptTimer = window.setTimeout(() => {
      void chrome.storage.local.set({ [PROMPT]: prompt.value });
    }, 400);
  });

  /* ── assemble ─────────────────────────────────────────────────────────── */

  host.append(
    row(
      "Provider",
      "OpenRouter has free models, which is why it is the default.",
      provider,
    ),
    baseRow,
    keyRow,
    row(
      "Model",
      "Fetched live, so the free list never goes stale.",
      modelHolder,
    ),
    row(
      "Summary prompt",
      "What the assistant is told when read mode opens. Leave empty for the shipped default.",
      resetPrompt,
    ),
  );

  const promptRow = el("div", "row");
  promptRow.style.display = "block";
  promptRow.append(prompt);
  host.append(promptRow, status);

  void (async () => {
    const stored = await chrome.storage.local.get({
      [KEY]: "",
      [BASE_URL]: OPENROUTER_BASE,
      [MODEL]: "",
      [PROMPT]: "",
    });

    baseUrl = String(stored[BASE_URL] ?? OPENROUTER_BASE) || OPENROUTER_BASE;
    provider.value = baseUrl === OPENROUTER_BASE ? "openrouter" : "custom";
    baseInput.value = baseUrl;
    prompt.value = String(stored[PROMPT] ?? "");
    syncProviderRows();

    const hasKey = String(stored[KEY] ?? "").length > 0;
    showStoredKey(hasKey);
    setModels([], String(stored[MODEL] ?? ""));

    if (hasKey) void loadModels();
    else
      status.textContent =
        "Add a key to get video summaries and ask questions.";
  })();
}
