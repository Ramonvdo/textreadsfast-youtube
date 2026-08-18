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
    input.focus();
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
    say("Connected.");

    // Only a signal. The key itself never crosses this boundary.
    window.parent.postMessage({ channel: CHANNEL, kind: "key-ready" }, "*");
  } catch (error) {
    save.disabled = false;
    say(error instanceof Error ? error.message : String(error), "error");
  }
}

save.addEventListener("click", () => void submit());
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void submit();
  }
});

input.focus();
