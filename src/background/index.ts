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
import { listFreeModels } from "./provider";
import { getConfig } from "./secrets";

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
      const config = await getConfig();
      const models = await listFreeModels(config.baseUrl, config.apiKey);
      sendResponse({ ok: true, models });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

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
