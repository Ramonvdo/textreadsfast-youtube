/**
 * Inline key setup, embedded in Read Mode's chat panel as an iframe.
 *
 * Why an iframe rather than a form drawn by the content script, which would have
 * been less code:
 *
 * 1. **The page cannot read this.** Read Mode's DOM lives in youtube.com's
 *    document, so an `<input>` drawn there is readable by any script on the
 *    page. This document is extension-origin, so its contents are not.
 * 2. **`chrome.permissions.request()` needs an extension page and a user
 *    gesture.** A content script cannot call it and neither can the service
 *    worker, so without this the key could be stored but its provider origin
 *    could never be granted — the assistant would save happily and then fail.
 *
 * The key is written straight to `chrome.storage.local` and never leaves this
 * document. What goes back to Read Mode is one bare "ready" message.
 */

// `export {}` makes this a module. Without it the file shares the global scope
// with every other entry, and `CHANNEL` collides with the page bridge's.
export {};

const KEY = "secret.apiKey";
const BASE_URL = "ai.baseUrl";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const CHANNEL = "trf-youtube";

const input = document.getElementById("key") as HTMLInputElement;
const save = document.getElementById("save") as HTMLButtonElement;
const settings = document.getElementById("settings") as HTMLButtonElement;
const statusLine = document.getElementById("status") as HTMLParagraphElement;
const step2 = document.getElementById("step2") as HTMLDivElement;
const modelSelect = document.getElementById("model") as HTMLSelectElement;
const start = document.getElementById("start") as HTMLButtonElement;
const refresh = document.getElementById("refresh") as HTMLButtonElement;

interface ModelOption {
  id: string;
  name: string;
  contextLength: number;
}

function say(message: string, tone: "info" | "error" = "info"): void {
  statusLine.textContent = message;
  statusLine.dataset.tone = tone;
}

settings.addEventListener("click", () => {
  void chrome.runtime.sendMessage({ type: "ai.openOptions" });
});

async function submit(): Promise<void> {
  const value = input.value.trim();
  if (!value) {
    say("Paste a key first.", "error");
    /*
     * A key can already be stored and the assistant still be unusable — the
     * provider origin may never have been granted, or the chosen model may have
     * been withdrawn. In both cases the key step is noise, so start at the model.
     */
    void (async () => {
      const stored = await chrome.storage.local.get({ [KEY]: "" });
      if (String(stored[KEY] ?? "").length > 0) {
        document
          .querySelectorAll<HTMLElement>("[data-step1]")
          .forEach((node) => {
            node.hidden = true;
          });
        say("Key already saved. Choose a model and start.");
        await showModels();
        return;
      }
      input.focus();
    })();
    return;
  }

  save.disabled = true;
  say("Saving…");

  try {
    const stored = await chrome.storage.local.get({
      [BASE_URL]: OPENROUTER_BASE,
    });
    const baseUrl =
      String(stored[BASE_URL] ?? OPENROUTER_BASE) || OPENROUTER_BASE;
    const origin = `${new URL(baseUrl).origin}/*`;

    // Must happen inside the click, on an extension page. This is the reason
    // the whole iframe exists.
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) {
      save.disabled = false;
      say(
        "Without access to the provider the assistant cannot run. Nothing was saved.",
        "error",
      );
      return;
    }

    await chrome.storage.local.set({ [KEY]: value });
    input.value = "";
    say("Connected. Pick a model, or just press Start.");

    // Step two rather than starting straight away: which free model answers
    // matters, the list changes weekly, and choosing here beats discovering in
    // settings later that the automatic pick was not what you wanted.
    await showModels();
  } catch (error) {
    save.disabled = false;
    say(error instanceof Error ? error.message : String(error), "error");
  }
}

/**
 * Offer the live free list.
 *
 * Never a hardcoded set. The first release shipped one model id in source, it
 * stopped being free, and every new install failed on its first request.
 */
async function showModels(force = false): Promise<void> {
  step2.hidden = false;
  refresh.disabled = true;
  modelSelect.replaceChildren();

  const reply = (await chrome.runtime
    .sendMessage({ type: "ai.listModels", force })
    .catch(() => null)) as { ok: boolean; models?: ModelOption[] } | null;

  refresh.disabled = false;

  if (!reply?.ok || !reply.models || reply.models.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Choose automatically";
    modelSelect.append(option);
    say("Could not list models. One will be chosen automatically.");
    return;
  }

  // "Automatic" first and selected, so the ranked top choice is followed and
  // stays followed as the free lineup changes underneath.
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = `Choose automatically (${reply.models[0].name})`;
  modelSelect.append(auto);

  for (const option of reply.models) {
    const node = document.createElement("option");
    node.value = option.id;
    node.textContent =
      option.contextLength > 0
        ? `${option.name} · ${Math.round(option.contextLength / 1000)}k context`
        : option.name;
    modelSelect.append(node);
  }

  const stored = await chrome.storage.local.get({ "ai.model": "" });
  modelSelect.value = String(stored["ai.model"] ?? "");
  say(`${reply.models.length} free models available.`);
}

async function begin(): Promise<void> {
  start.disabled = true;
  await chrome.runtime
    .sendMessage({ type: "ai.setModel", model: modelSelect.value })
    .catch(() => undefined);
  // Only a signal. The key itself never crosses this boundary.
  window.parent.postMessage({ channel: CHANNEL, kind: "key-ready" }, "*");
}

start.addEventListener("click", () => void begin());
refresh.addEventListener("click", () => void showModels(true));
save.addEventListener("click", () => void submit());
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void submit();
  }
});

/*
 * A key can already be stored and the assistant still be unusable — the
 * provider origin may never have been granted, or the chosen model may have
 * been withdrawn. In both cases the key step is noise, so start at the model.
 */
void (async () => {
  const stored = await chrome.storage.local.get({ [KEY]: "" });
  if (String(stored[KEY] ?? "").length > 0) {
    document.querySelectorAll<HTMLElement>("[data-step1]").forEach((node) => {
      node.hidden = true;
    });
    say("Key already saved. Choose a model and start.");
    await showModels();
    return;
  }
  input.focus();
})();
