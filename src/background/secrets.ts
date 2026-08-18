/**
 * The API key, and the AI configuration around it.
 *
 * THE ONLY MODULE IN THIS CODEBASE THAT READS THE KEY. That is convention rather
 * than a sandbox — `chrome.storage.local` is readable from any extension
 * context — so `scripts/check-boundaries.mjs` fails the build if anything under
 * `src/content/**` or `src/page/**` goes near it. `inject.js` runs in the page
 * world with no `chrome.*` at all, so the key is structurally unreachable there;
 * do not "helpfully" route AI through the page bridge.
 *
 * Storage is `local`, never `sync`. `sync` replicates to Google's servers and to
 * every signed-in device, and carries the 120-writes-per-minute silent throttle
 * this repository has already been bitten by once.
 *
 * Honest limit, which the options page states out loud: `storage.local` is not
 * encrypted at rest and is readable through the extension's devtools.
 */

const KEY = "secret.apiKey";
const BASE_URL = "ai.baseUrl";
const MODEL = "ai.model";
const PROMPT = "readmode.summaryPrompt";

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

/**
 * Empty means "resolve one from the live list".
 *
 * There is deliberately no hardcoded model here. The first version shipped
 * `meta-llama/llama-3.3-70b-instruct:free`, which then stopped being free, and
 * every install failed on its first request. A model id in source is a fact
 * about the day it was written; `models.ts` asks the provider instead.
 */
export const DEFAULT_MODEL = "";

/** Shipped default, editable in settings. Kept here so there is exactly one. */
export const DEFAULT_SUMMARY_PROMPT = `Explain this video transcript in as few words as possible, make sure to list bulletpoints to provide a complete but simple summary. Try and explain the what (what it is / does), why (the benefit it provides), and provide clear actionable guidelines on how to implement it. Explain concepts as if to a child. Identify knowledge gaps. Refine the explanation to eliminate jargon. Ensure deep comprehension over memorization. Deliver only the 20% of information that yields 80% of the results. Eliminate all secondary data. Ensure reasoning is airtight without using complex phrasing or redundant analogies, make sure things are easy, not everything needs an analogy if it is easy to grasp. Again the main goal is: Explain this in as few words as possible.

#### GENERAL RULES
**1. Explain in as few words as possible**
- Every word should have the right to be written, seek to never use any filler word, use brackets like () to put side notes in.

**2. Unvarnished Facts (No Boasting)**
- State impressive achievements, data, or credentials as simple, historical facts. Never wrap achievements in prideful or dramatic language.

**3. The 14-Year-Old Simplicity**
- Never use corporate jargon, buzzwords, or artificial fluff. Speak plainly. If a smart 14-year-old wouldn't say the phrase in a casual conversation, delete it.

**4. The "Peer-to-Peer" Frame**
- Speak to the reader as an equal. Do not write from a position of desperation or artificial superiority.

**5. Utility Over Hype**
- Value truth and utility over making a pitch. Be willing to call out flaws, state what won't work, or say when something is a waste of time.

**6. Immediate Momentum**
- Never use introductory throat-clearing sentences. Start immediately with the core point.

#### BANNED VOCABULARY
- Pleasantries: "Hey there!", "I hope this finds you well", "In today's fast-paced world".
- Hype: "revolutionize", "transform", "cutting-edge", "unlock your potential", "elevate", "delve", "testament", "tapestry", "seamlessly", "game-changer".
- Forced emotion: "thrilled", "excited", "passionate", "honored", "proudly".
- Transitions: "Ultimately,", "Indeed,", "Crucially,", "In reality,".
- Never use EM-dashes, use commas instead.
- Never use "not just a, but a", "It's not about X, it's about Y", or "More than a X, it's a Y".
- Use the definitive present tense. Avoid "can", "could", "might", "aims to".`;

export interface AiConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  summaryPrompt: string;
}

export async function getConfig(): Promise<AiConfig> {
  const stored = await chrome.storage.local.get({
    [KEY]: "",
    [BASE_URL]: OPENROUTER_BASE,
    [MODEL]: DEFAULT_MODEL,
    [PROMPT]: "",
  });

  return {
    apiKey: String(stored[KEY] ?? ""),
    baseUrl: String(stored[BASE_URL] ?? OPENROUTER_BASE) || OPENROUTER_BASE,
    model: String(stored[MODEL] ?? DEFAULT_MODEL),
    // An empty stored prompt means "use the shipped default", so the default
    // lives in exactly one place rather than being copied into storage on install.
    summaryPrompt: String(stored[PROMPT] ?? "") || DEFAULT_SUMMARY_PROMPT,
  };
}

/** Record the model in use, so a resolved choice shows up in settings. */
export async function setModel(model: string): Promise<void> {
  await chrome.storage.local.set({ [MODEL]: model });
}

export async function hasApiKey(): Promise<boolean> {
  const stored = await chrome.storage.local.get({ [KEY]: "" });
  return String(stored[KEY] ?? "").length > 0;
}

/**
 * Has the user granted the origin this base URL needs?
 *
 * The provider host is an *optional* permission: making it required would put an
 * install-time warning in front of everyone, including the people who never turn
 * the AI on. Only an extension page can request it, and only with a user
 * gesture, which is why the options page asks and this only checks.
 */
export async function hasOriginPermission(baseUrl: string): Promise<boolean> {
  try {
    const origin = `${new URL(baseUrl).origin}/*`;
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}
