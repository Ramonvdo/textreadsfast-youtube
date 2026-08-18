#!/usr/bin/env node
/**
 * Keep the API key out of the page.
 *
 * The key lives in `chrome.storage.local`, which is readable from *any*
 * extension context. So "only the service worker touches the key" is a
 * convention, not a sandbox — and a convention with nothing enforcing it is a
 * convention that gets broken by the next person in a hurry.
 *
 * This makes the violation loud, the same argument `check-drift.mjs` makes for
 * itself. It cannot stop anyone writing the code; it stops them shipping it
 * without noticing.
 *
 *   node scripts/check-boundaries.mjs
 */

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** Directories that run inside youtube.com, in one world or the other. */
const GUARDED = ["src/content", "src/page", "src/readmode"];

const RULES = [
  {
    pattern: /\bsecret\.apiKey\b|\bapiKey\b/,
    why: "the API key must never be read outside src/background/secrets.ts",
  },
  {
    pattern: /from\s+["'](?:\.\.\/)+background\//,
    why: "the page-side code must not import from src/background/ — talk to it over the message protocol instead",
  },
  {
    pattern: /chrome\.storage\.local\.get\([^)]*secret/,
    why: "secrets are read only in the service worker",
  },
];

/*
 * `src/readmode/ai.ts` is the client for the AI port and legitimately mentions
 * the protocol, but it must still never touch the key. It is guarded by the
 * same rules; no exemption is needed, and adding one would be the first step to
 * hollowing this check out.
 */

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // A guarded directory that does not exist yet is not a failure.
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) yield full;
  }
}

let violations = 0;

for (const guarded of GUARDED) {
  for await (const file of walk(resolve(ROOT, guarded))) {
    const source = readFileSync(file, "utf8");
    const lines = source.split(/\r?\n/);

    lines.forEach((line, index) => {
      // A comment explaining the rule is not a violation of it.
      const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
      if (code.trim().startsWith("*")) return;

      for (const rule of RULES) {
        if (!rule.pattern.test(code)) continue;
        console.error(`${relative(ROOT, file)}:${index + 1}`);
        console.error(`  ${line.trim()}`);
        console.error(`  → ${rule.why}\n`);
        violations += 1;
      }
    });
  }
}

if (violations > 0) {
  console.error(`${violations} boundary violation(s).`);
  console.error(
    "The content script runs on youtube.com. Anything it can read, that page's\n" +
      "context is one bug away from reading too. Route it through the worker.",
  );
  process.exit(1);
}

console.log(`key boundary intact (${GUARDED.join(", ")})`);
