/**
 * Choosing a model, and choosing a different one when that fails.
 *
 * THE LESSON THIS FILE EXISTS FOR: the first version shipped
 * `meta-llama/llama-3.3-70b-instruct:free` as a hardcoded default. It stopped
 * being free, and every new install hit "This model is unavailable for free"
 * on its very first request. A model id written into source is a fact about one
 * afternoon, not about the provider — OpenRouter's free lineup changes weekly.
 *
 * So nothing here hardcodes a model as the answer. The list is fetched live, a
 * choice is made from it, and if that choice later stops working the failure is
 * recoverable rather than terminal.
 */

import { listFreeModels, type ModelOption } from "./provider";
import { getConfig, setModel } from "./secrets";

/**
 * A transcript is the whole point, and an hour of speech is roughly 10k words.
 * With the prompt and the reply, anything under this cannot hold the
 * conversation at all, so a small-context model is worse than no default.
 */
const MIN_CONTEXT = 16_000;

/**
 * Families that reliably follow a long instruction, used only to break ties.
 *
 * Not a whitelist: an unrecognised model still ranks, just below a known one of
 * similar context. Ordered best-first.
 */
const PREFERRED = [
  "deepseek",
  "llama",
  "qwen",
  "mistral",
  "gemma",
  "glm",
  "phi",
];

function familyRank(id: string): number {
  const lower = id.toLowerCase();
  const index = PREFERRED.findIndex((name) => lower.includes(name));
  return index === -1 ? PREFERRED.length : index;
}

/**
 * Best free model first.
 *
 * Context length leads, because it decides whether a long video can be
 * discussed at all; family is only a tie-breaker among models that can already
 * hold the transcript.
 */
export function rankModels(models: ModelOption[]): ModelOption[] {
  const usable = models.filter((m) => m.contextLength >= MIN_CONTEXT);
  // If nothing meets the bar, rank everything rather than returning none — a
  // short-context model still summarises a short video.
  const pool = usable.length > 0 ? usable : models;

  return [...pool].sort((a, b) => {
    const family = familyRank(a.id) - familyRank(b.id);
    if (family !== 0) return family;
    return b.contextLength - a.contextLength;
  });
}

let cached: { models: ModelOption[]; at: number } | null = null;
const CACHE_MS = 30 * 60 * 1000;

async function freeModels(force = false): Promise<ModelOption[]> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS)
    return cached.models;

  const config = await getConfig();
  const models = await listFreeModels(config.baseUrl, config.apiKey);
  cached = { models, at: Date.now() };
  return models;
}

export function forgetModelCache(): void {
  cached = null;
}

/**
 * The model to use right now.
 *
 * A configured id wins — that is the user's choice and it is not second-guessed.
 * Otherwise one is picked from the live list and remembered, so the choice is
 * visible in settings afterwards rather than being invisible magic.
 */
export async function resolveModel(): Promise<string> {
  const config = await getConfig();
  if (config.model) return config.model;

  const ranked = rankModels(await freeModels());
  if (ranked.length === 0) {
    // No list, no configured model: let the provider answer for itself rather
    // than inventing an id that is certainly wrong.
    throw new Error(
      "No free models could be listed. Choose one in settings, or check the base URL.",
    );
  }

  await setModel(ranked[0].id);
  return ranked[0].id;
}

/**
 * A replacement for a model that just failed.
 *
 * Forces a refetch, because the cached list is what suggested the broken one.
 * Returns null when there is nothing else to try, so the caller reports the
 * original failure instead of looping.
 */
export async function pickAlternative(broken: string): Promise<string | null> {
  const ranked = rankModels(await freeModels(true));
  const next = ranked.find((m) => m.id !== broken);
  if (!next) return null;

  await setModel(next.id);
  return next.id;
}

export async function availableModels(force = false): Promise<ModelOption[]> {
  return rankModels(await freeModels(force));
}
