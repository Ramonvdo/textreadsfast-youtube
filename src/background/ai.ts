/**
 * The AI port handler.
 *
 * One long-lived port per Read Mode session, carrying every request on it.
 * `sendMessage` would have been simpler and wrong for three reasons:
 *
 * - An MV3 worker is torn down after ~30s idle. Port traffic resets that timer,
 *   so token deltas keep the worker alive for the length of the stream.
 * - `onDisconnect` gives cancellation for free when Read Mode closes or the tab
 *   navigates. One-shot messaging gives nothing when the tab simply dies.
 * - Ordering is guaranteed on one channel; interleaving several `sendMessage`
 *   replies would be our problem to solve.
 */

import {
  buildSystemTurn,
  type AiRequest,
  type AiResponse,
  type ChatTurn,
} from "../shared/aiProtocol";
import { ProviderError, streamChat } from "./provider";
import { pickAlternative, resolveModel } from "./models";
import { getConfig, hasOriginPermission } from "./secrets";

/**
 * How often to nudge the port while waiting for the first token.
 *
 * Comfortably under the ~30s idle teardown. A model that thinks for a while
 * before emitting anything would otherwise have its worker killed mid-request,
 * which reads to the user as a silent stall.
 */
const KEEPALIVE_MS = 20_000;

export function handleAiPort(port: chrome.runtime.Port): void {
  const running = new Map<string, AbortController>();

  const post = (message: AiResponse): void => {
    try {
      port.postMessage(message);
    } catch {
      // The other end went away mid-stream. `onDisconnect` will abort us.
    }
  };

  port.onDisconnect.addListener(() => {
    for (const controller of running.values()) controller.abort();
    running.clear();
  });

  port.onMessage.addListener((raw: AiRequest) => {
    if (raw?.type === "chat.cancel") {
      running.get(raw.requestId)?.abort();
      running.delete(raw.requestId);
      return;
    }
    if (raw?.type !== "chat.start") return;
    void run(raw);
  });

  async function run(
    request: Extract<AiRequest, { type: "chat.start" }>,
  ): Promise<void> {
    const { requestId } = request;
    const controller = new AbortController();
    running.set(requestId, controller);

    try {
      const config = await getConfig();

      if (!config.apiKey) {
        post({
          type: "chat.error",
          requestId,
          code: "no_key",
          message: "Add an API key in settings to use the assistant.",
        });
        return;
      }

      if (!(await hasOriginPermission(config.baseUrl))) {
        post({
          type: "chat.error",
          requestId,
          code: "no_permission",
          message:
            "This browser has not granted access to the AI provider. Open settings and save your key again to allow it.",
        });
        return;
      }

      // An empty `system` from the content script means "use the configured
      // prompt", which keeps the default in one place instead of two.
      const system = request.system.trim() || config.summaryPrompt;
      const messages: ChatTurn[] = [
        { role: "system", content: buildSystemTurn(system, request.context) },
        ...request.messages,
      ];

      // Never a hardcoded id: resolved from the live free list when the user
      // has not chosen one. See the note at the top of `models.ts`.
      let model = await resolveModel();

      // Sent before the first token so the UI can stop guessing whether
      // anything is happening at all.
      post({ type: "chat.open", requestId, model });

      let sawDelta = false;
      const keepalive = setInterval(() => {
        if (!sawDelta) post({ type: "chat.open", requestId, model });
      }, KEEPALIVE_MS);

      try {
        /*
         * One retry, and only for a model the provider refused.
         *
         * Free models are withdrawn and re-priced constantly, so "this model is
         * unavailable for free" is an ordinary Tuesday rather than a real
         * failure, and it is recoverable without involving the reader at all.
         * Only retried before any token has arrived: once text is on screen,
         * starting again would replace what they are already reading.
         */
        for (let attempt = 0; ; attempt += 1) {
          try {
            const result = await streamChat(
              {
                baseUrl: config.baseUrl,
                apiKey: config.apiKey,
                model,
                messages,
              },
              (text) => {
                sawDelta = true;
                post({ type: "chat.delta", requestId, text });
              },
              controller.signal,
            );
            post({
              type: "chat.done",
              requestId,
              stopReason: result.stopReason,
            });
            return;
          } catch (error) {
            const recoverable =
              error instanceof ProviderError &&
              error.code === "bad_model" &&
              !sawDelta &&
              attempt === 0;
            if (!recoverable) throw error;

            const alternative = await pickAlternative(model);
            if (!alternative) throw error;
            model = alternative;
            post({ type: "chat.open", requestId, model });
          }
        }
      } finally {
        clearInterval(keepalive);
      }
    } catch (error) {
      if (error instanceof ProviderError) {
        post({
          type: "chat.error",
          requestId,
          code: error.code,
          message: error.message,
        });
      } else {
        post({
          type: "chat.error",
          requestId,
          code: "network",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      running.delete(requestId);
    }
  }
}
