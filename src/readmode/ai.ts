/**
 * Content-side client for the assistant.
 *
 * Speaks the protocol and nothing else. It never reads the API key, never
 * touches `chrome.storage.local`, and never imports from `src/background/` —
 * `scripts/check-boundaries.mjs` fails the build if that changes. The key stays
 * in the service worker because a content-script fetch is bound by the *host
 * page's* CORS and a provider would refuse it anyway.
 */

import {
  AI_PORT,
  newRequestId,
  type AiRequest,
  type AiResponse,
  type ChatContext,
  type ChatTurn,
  type ErrorCode,
} from "../shared/aiProtocol";

export interface StreamOptions {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  context: ChatContext;
  onDelta(text: string): void;
  onDone(): void;
  onError(code: ErrorCode, message: string): void;
}

let port: chrome.runtime.Port | null = null;
/** Handlers by requestId, so one port can carry the summary and a reply at once. */
const inFlight = new Map<string, StreamOptions>();

function connect(): chrome.runtime.Port | null {
  if (port) return port;

  try {
    port = chrome.runtime.connect({ name: AI_PORT });
  } catch {
    return null;
  }

  port.onMessage.addListener((message: AiResponse) => {
    const handlers = inFlight.get(message.requestId);
    if (!handlers) return;

    switch (message.type) {
      case "chat.open":
        // Only a liveness signal — the worker is alive and the request is real.
        break;
      case "chat.delta":
        handlers.onDelta(message.text);
        break;
      case "chat.done":
        inFlight.delete(message.requestId);
        handlers.onDone();
        break;
      case "chat.error":
        inFlight.delete(message.requestId);
        handlers.onError(message.code, message.message);
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    port = null;
    // A disconnect with requests outstanding is the worker being torn down or
    // the extension reloading. Say so rather than leaving a caret blinking
    // forever against a stream that will never resume.
    for (const [id, handlers] of inFlight) {
      inFlight.delete(id);
      handlers.onError(
        "network",
        "The assistant stopped responding. Try again.",
      );
    }
  });

  return port;
}

/** Start a turn. Returns the request id, which `cancel` takes. */
export function streamChat(options: StreamOptions): string | null {
  const channel = connect();
  const requestId = newRequestId();

  if (!channel) {
    options.onError(
      "network",
      "Could not reach the extension's background worker.",
    );
    return null;
  }

  inFlight.set(requestId, options);

  const request: AiRequest = {
    type: "chat.start",
    requestId,
    system: options.system,
    messages: options.messages as ChatTurn[],
    context: options.context,
  };

  try {
    channel.postMessage(request);
  } catch {
    inFlight.delete(requestId);
    options.onError(
      "network",
      "Could not reach the extension's background worker.",
    );
    return null;
  }

  return requestId;
}

export function cancel(requestId: string): void {
  inFlight.delete(requestId);
  try {
    port?.postMessage({ type: "chat.cancel", requestId } satisfies AiRequest);
  } catch {
    // Already gone; the worker's `onDisconnect` aborts everything anyway.
  }
}

/** Drop the port. Called when Read Mode closes, which aborts any live stream. */
export function closeAiPort(): void {
  inFlight.clear();
  try {
    port?.disconnect();
  } catch {
    // Nothing to do; it was already disconnected.
  }
  port = null;
}
