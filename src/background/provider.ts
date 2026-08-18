/**
 * One HTTP path to every model provider.
 *
 * WHY THERE IS NO ADAPTER LAYER: OpenRouter, OpenAI, Groq, Together, and a local
 * Ollama or LM Studio all accept the same POST on `/chat/completions` and all
 * answer with the same SSE frames. "Which provider" is therefore a base URL and
 * nothing else, and a per-provider class would exist only to hide a string.
 *
 * WHY NO SDK: this repository has zero runtime dependencies, which is what keeps
 * the review surface of a thing that reads your YouTube history and holds an API
 * key down to files a person can read in an afternoon. An official client would
 * pull a dependency tree in to save the sixty lines below.
 *
 * Nothing here touches `chrome.*`, so it runs unchanged under vitest against a
 * fake stream. That is deliberate: the parsing below is the part that breaks.
 */

import type { ChatTurn, ErrorCode } from "../shared/aiProtocol";

/** Sent for attribution only when talking to OpenRouter, which asks for them. */
const ATTRIBUTION_URL = "https://github.com/rdooren/textreadsfast";
const ATTRIBUTION_TITLE = "TextReadsFast for YouTube";

export interface ChatRequest {
  /** Up to but not including `/chat/completions`. */
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatTurn[];
}

export interface ChatResult {
  /** `stop`, `length`, `content_filter`… as the provider reported it. */
  stopReason: string | null;
  /** What actually answered. OpenRouter may route a request elsewhere. */
  model: string;
}

/** A failure already mapped onto the protocol's vocabulary, so the port handler
 *  never has to interpret an HTTP status of its own. */
export class ProviderError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
  }
}

export interface ModelOption {
  id: string;
  name: string;
  /**
   * Tokens the model will accept.
   *
   * The transcript of an hour-long video is most of a context window on its own,
   * so this is the number that decides whether a video can be discussed at all.
   */
  contextLength: number;
}

/* ── narrowing ───────────────────────────────────────────────────────────── */

/*
 * Everything below comes off the wire, so it is `unknown` until proven
 * otherwise. `JSON.parse(...) as SomeInterface` would type-check and then throw
 * at runtime on the first provider that answers with a shape nobody expected.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/* ── errors ──────────────────────────────────────────────────────────────── */

function codeForStatus(status: number | null): ErrorCode {
  // 403 is here with 401 because OpenRouter answers a revoked or out-of-credit
  // key with either, and both mean the same thing to the person reading it.
  if (status === 401 || status === 403) return "bad_key";
  if (status === 429) return "rate_limit";
  // A model that has been renamed, withdrawn, or moved off the free tier.
  if (status === 404) return "bad_model";
  return "network";
}

/**
 * Some providers report a withdrawn model with a 400 and an explanation rather
 * than a 404. OpenRouter's is "This model is unavailable for free. The paid
 * version is available now - use this slug instead: …", which is recoverable
 * information dressed as a generic failure.
 */
function looksLikeModelProblem(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("unavailable for free") ||
    text.includes("no endpoints found") ||
    text.includes("not a valid model") ||
    text.includes("model not found") ||
    (text.includes("model") && text.includes("does not exist"))
  );
}

/** `AbortError` arrives as a `DOMException`, which is not reliably an `Error`
 *  across runtimes — so this checks the name rather than the constructor. */
function isAbort(error: unknown): boolean {
  const record = asRecord(error);
  return record !== null && record.name === "AbortError";
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (isAbort(error)) return new ProviderError("aborted", "Cancelled.");
  return new ProviderError(
    "network",
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * The most useful sentence available about a failed response.
 *
 * Providers put the real reason in the body — OpenRouter uses
 * `{ error: { message } }`, OpenAI the same, others a bare `{ message }`. A UI
 * that only shows "429" tells the user nothing they can act on.
 */
async function failureMessage(response: Response): Promise<string> {
  const fallback = `${response.status} ${response.statusText}`.trim();

  let body = "";
  try {
    body = await response.text();
  } catch {
    return fallback;
  }
  if (!body.trim()) return fallback;

  try {
    const root = asRecord(JSON.parse(body) as unknown);
    if (root) {
      const nested = asRecord(root.error);
      const message =
        (nested ? asString(nested.message) : null) ??
        asString(root.error) ??
        asString(root.message);
      if (message) return message;
    }
  } catch {
    // Not JSON. An HTML error page is worse than useless in a chat bubble, so
    // only a short prefix of it goes any further.
  }

  return `${fallback}: ${body.slice(0, 200)}`;
}

/* ── SSE ─────────────────────────────────────────────────────────────────── */

/**
 * Split whole events off the front of the buffer, leaving any partial behind.
 *
 * THIS IS THE PART THAT BREAKS NAIVE IMPLEMENTATIONS: a network chunk ends
 * wherever the transport put it — mid-line, mid-JSON, mid-event. Parsing each
 * chunk on its own silently drops tokens. Nothing is interpreted until a blank
 * line proves the event is complete.
 */
function takeEvents(buffer: string): { events: string[]; rest: string } {
  // Normalising the *whole* buffer, not just the new chunk, keeps a `\r` that
  // arrived at the tail of one chunk from being read as a line end before its
  // `\n` shows up in the next one.
  const parts = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = parts.pop() ?? "";
  return { events: parts, rest };
}

/** The `data:` payload of one event, or null when it carries none. */
function payloadOf(event: string): string | null {
  const data: string[] = [];

  for (const line of event.split("\n")) {
    // ":" is a comment. OpenRouter sends `: OPENROUTER PROCESSING` every few
    // seconds while a model is thinking, purely to hold the connection open.
    if (line === "" || line.startsWith(":")) continue;
    if (!line.startsWith("data:")) continue; // `event:`, `id:`, `retry:`
    // The one optional space after the colon is separator, not content.
    data.push(line.slice(5).replace(/^ /, ""));
  }

  // Per the SSE spec, several `data:` lines in one event are one payload joined
  // by newlines. Providers rarely do it; a parser that assumed one would lose
  // the event outright if one ever did.
  return data.length > 0 ? data.join("\n") : null;
}

interface Frame {
  text: string;
  finishReason: string | null;
  model: string | null;
  error: ProviderError | null;
}

/** One decoded frame, or null when the payload was not usable. */
function readFrame(payload: string): Frame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // A frame that will not parse is skipped rather than thrown: killing a
    // half-finished answer over one malformed line serves nobody.
    return null;
  }

  const root = asRecord(parsed);
  if (!root) return null;

  // Providers report mid-stream failures (a moderation block, a rate limit hit
  // between tokens) inside the stream, with HTTP 200 already sent.
  const failure = asRecord(root.error);
  if (failure) {
    const status = asNumber(failure.code);
    return {
      text: "",
      finishReason: null,
      model: null,
      error: new ProviderError(
        codeForStatus(status),
        asString(failure.message) ?? "The provider reported an error.",
      ),
    };
  }

  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = asRecord(choices[0]);
  const delta = first ? asRecord(first.delta) : null;

  return {
    text: (delta ? asString(delta.content) : null) ?? "",
    finishReason: first ? asString(first.finish_reason) : null,
    model: asString(root.model),
    error: null,
  };
}

/* ── the request ─────────────────────────────────────────────────────────── */

const trimSlash = (url: string): string => url.replace(/\/+$/, "");

function isOpenRouter(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.endsWith("openrouter.ai");
  } catch {
    return false;
  }
}

function headersFor(request: ChatRequest): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${request.apiKey}`,
  };

  // Only OpenRouter asks for these, and only OpenRouter gets them: sending the
  // extension's identity to whatever host a user typed in would leak what they
  // are running to a third party that never asked.
  if (isOpenRouter(request.baseUrl)) {
    headers["HTTP-Referer"] = ATTRIBUTION_URL;
    headers["X-Title"] = ATTRIBUTION_TITLE;
  }

  return headers;
}

/**
 * Stream one completion, calling `onDelta` with each token as it lands.
 *
 * Resolves when the provider says it is finished. Rejects with a `ProviderError`
 * whose `code` is already one of the protocol's, including `aborted` when
 * `signal` fires.
 */
export async function streamChat(
  request: ChatRequest,
  onDelta: (text: string) => void,
  signal: AbortSignal,
): Promise<ChatResult> {
  let response: Response;
  try {
    response = await fetch(`${trimSlash(request.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: headersFor(request),
      signal,
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: true,
      }),
    });
  } catch (error) {
    throw toProviderError(error);
  }

  if (!response.ok) {
    const message = await failureMessage(response);
    const code = codeForStatus(response.status);
    throw new ProviderError(
      code === "network" && looksLikeModelProblem(message) ? "bad_model" : code,
      message,
    );
  }

  const body = response.body;
  if (!body) {
    throw new ProviderError("network", "The provider sent no response body.");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let model = request.model;
  let stopReason: string | null = null;

  /** Returns true once the provider has said the stream is over. */
  const consume = (event: string): boolean => {
    const payload = payloadOf(event);
    if (payload === null) return false;
    if (payload === "[DONE]") return true;

    const frame = readFrame(payload);
    if (!frame) return false;
    if (frame.error) throw frame.error;

    if (frame.model) model = frame.model;
    if (frame.finishReason) stopReason = frame.finishReason;
    // An empty delta is normal: the first frame of an OpenAI stream carries only
    // the assistant role, and keepalive frames carry nothing at all.
    if (frame.text) onDelta(frame.text);
    return false;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();

      if (done) {
        buffer += decoder.decode();
        // A stream cut off without its final blank line still holds one whole
        // event, and for a short answer it can be the only one.
        const { events, rest } = takeEvents(`${buffer}\n\n`);
        void rest;
        for (const event of events) if (consume(event)) break;
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = takeEvents(buffer);
      buffer = rest;

      let finished = false;
      for (const event of events) {
        if (consume(event)) {
          finished = true;
          break;
        }
      }
      if (finished) break;
    }
  } catch (error) {
    throw toProviderError(error);
  } finally {
    // Releases the connection when we stopped early — on `[DONE]`, on a
    // mid-stream error, or on cancellation.
    void reader.cancel().catch(() => undefined);
  }

  return { stopReason, model };
}

/* ── the free-model list ─────────────────────────────────────────────────── */

/** Zero, when the price is stated at all. Prices arrive as strings. */
function priceOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toFreeModel(entry: unknown): ModelOption | null {
  const record = asRecord(entry);
  if (!record) return null;

  const id = asString(record.id);
  if (!id) return null;

  const pricing = asRecord(record.pricing);
  const prompt = pricing ? priceOf(pricing.prompt) : null;
  const completion = pricing ? priceOf(pricing.completion) : null;
  // Absent pricing means unknown, not free. Only an explicit zero on both sides
  // counts, so a model whose cost we cannot read is never presented as free.
  const free = id.endsWith(":free") || (prompt === 0 && completion === 0);
  if (!free) return null;

  return {
    id,
    name: asString(record.name) ?? id,
    contextLength:
      asNumber(record.context_length) ??
      asNumber(asRecord(record.top_provider)?.context_length) ??
      0,
  };
}

/**
 * The provider's free models, live.
 *
 * WHY NOT A HARDCODED LIST: OpenRouter's free lineup turns over constantly —
 * models arrive, get renamed, and are retired within weeks. A default baked in
 * here would be a support burden by the second month, and its failure mode is a
 * 400 the user cannot diagnose.
 *
 * Returns an empty list when the endpoint is missing, which is the normal answer
 * from an OpenAI-compatible server that never implemented `/models`.
 */
export async function listFreeModels(
  baseUrl: string,
  apiKey: string,
): Promise<ModelOption[]> {
  let response: Response;
  try {
    response = await fetch(`${trimSlash(baseUrl)}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
  } catch (error) {
    throw toProviderError(error);
  }

  if (response.status === 404) return [];
  if (!response.ok) {
    const message = await failureMessage(response);
    const code = codeForStatus(response.status);
    throw new ProviderError(
      code === "network" && looksLikeModelProblem(message) ? "bad_model" : code,
      message,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    throw new ProviderError("network", "The model list was not JSON.");
  }

  const root = asRecord(parsed);
  const data = root && Array.isArray(root.data) ? root.data : [];
  const models: ModelOption[] = [];
  for (const entry of data) {
    const model = toFreeModel(entry);
    if (model) models.push(model);
  }

  // Largest context first: with a full transcript in the system turn, the
  // difference between 8k and 128k is the difference between a model that can
  // discuss the video and one that cannot. Ties fall back to the id so the list
  // does not reshuffle between refreshes.
  models.sort(
    (a, b) => b.contextLength - a.contextLength || a.id.localeCompare(b.id),
  );
  return models;
}
