/**
 * The service worker: the only context that may hold the API key or touch the
 * library database.
 *
 * Two reasons it exists, both of them structural rather than stylistic:
 *
 * 1. Content-script `fetch` has been subject to the *host page's* CORS since
 *    Chrome 85, so a model-provider call from youtube.com is cross-origin and
 *    gets refused. A worker's fetch runs on the extension origin, where the
 *    extension's host permissions apply.
 * 2. `indexedDB` inside a content script is `https://www.youtube.com`'s
 *    database, not the extension's — only `chrome.*` is extension-scoped there.
 *    So the library could never have lived in the content script.
 *
 * This file is a router and nothing else. The work lives in the modules it
 * dispatches to, which keeps the two concerns independently testable.
 */

import { AI_PORT } from "../shared/aiProtocol";
import type {
  LibraryRequest,
  LibraryResponse,
} from "../shared/libraryProtocol";
import { handleAiPort } from "./ai";
import { handleLibraryRequest } from "./db";
import { availableModels } from "./models";
import { setModel } from "./secrets";

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== AI_PORT) return;
  handleAiPort(port);
});

/**
 * The settings page asks for the model list.
 *
 * It cannot fetch it itself: the list needs the API key, and the key is only
 * ever read here.
 */
/**
 * Save an export.
 *
 * Routed through the worker rather than an `<a download>` in the page for two
 * reasons: `chrome.downloads` is the only API that can put the file in a chosen
 * folder or open the save dialog, and a blob anchor click from a content script
 * on youtube.com is at the mercy of that page's policies.
 *
 * A `data:` URL rather than `URL.createObjectURL`, which service workers do not
 * have.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if ((message as { type?: string })?.type !== "export.save") return false;

  const { markdown, filename, saveAs } = message as {
    markdown: string;
    filename: string;
    saveAs: boolean;
  };

  void chrome.downloads
    .download({
      url: `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown)}`,
      filename,
      saveAs,
      conflictAction: "uniquify",
    })
    .then(() => sendResponse({ ok: true }))
    .catch((error: unknown) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );

  return true;
});

chrome.runtime.onMessage.addListener((message) => {
  // The inline setup frame is sandboxed inside a content-script overlay and
  // cannot open a tab itself.
  if ((message as { type?: string })?.type !== "ai.openOptions") return false;
  chrome.runtime.openOptionsPage();
  return false;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if ((message as { type?: string })?.type !== "ai.listModels") return false;

  void (async () => {
    try {
      const force = Boolean((message as { force?: boolean }).force);
      // Ranked, not raw: the first entry is the one that gets used when nobody
      // chooses, so the list and the automatic choice agree.
      sendResponse({ ok: true, models: await availableModels(force) });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if ((message as { type?: string })?.type !== "ai.setModel") return false;
  void setModel(String((message as { model?: string }).model ?? "")).then(() =>
    sendResponse({ ok: true }),
  );
  return true;
});

chrome.runtime.onMessage.addListener(
  (
    message: LibraryRequest,
    _sender,
    sendResponse: (r: LibraryResponse) => void,
  ) => {
    if (
      typeof message?.type !== "string" ||
      !message.type.startsWith("library.")
    ) {
      return false;
    }

    handleLibraryRequest(message)
      .then(sendResponse)
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );

    // Keeps the message channel open for the async reply above. Returning
    // anything falsy here closes it and `sendResponse` becomes a no-op.
    return true;
  },
);
