#!/usr/bin/env node
/**
 * Compare `src/reader-core/` against a desktop checkout.
 *
 * The reading engine lives in two repositories because they ship separately.
 * That is a deliberate trade, but it means the copies can silently diverge —
 * and divergence here is not cosmetic: if the two disagree about where a word's
 * pivot letter goes, the same word reads differently in the app than in the
 * browser, and the whole technique depends on that position being identical.
 *
 * This cannot prevent drift. It makes drift loud.
 *
 *   node scripts/check-drift.mjs --desktop ../textreadsfast
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** Each copied file, and where it came from upstream. */
const FILES = [
  { local: "orp.ts", upstream: "src/reader/orp.ts", exact: true },
  {
    local: "pivotOffset.ts",
    upstream: "src/reader/pivotOffset.ts",
    exact: true,
  },
  { local: "fonts.css", upstream: "src/styles/fonts.css", exact: true },
  // Adapted on purpose: the desktop derives its font union from generated Tauri
  // bindings that do not exist here. Compared loosely so the shared parts still
  // get checked without the known difference failing every run.
  { local: "fonts.ts", upstream: "src/reader/fonts.ts", exact: false },
  // Extracted subset of the desktop's tokenizer.
  { local: "words.ts", upstream: "src/reader/tokenize.ts", exact: false },
];

const args = process.argv.slice(2);
const flag = args.indexOf("--desktop");
const desktop = resolve(flag === -1 ? "../textreadsfast" : args[flag + 1]);

if (!existsSync(desktop)) {
  console.error(`No desktop checkout at ${desktop}`);
  console.error(
    "Pass one with --desktop <path>, or skip this check knowingly.",
  );
  process.exit(2);
}

const norm = (s) => s.replace(/\r\n/g, "\n").trimEnd();

/** Shared declarations, so an adapted file can still be compared on substance. */
function declarations(source) {
  return new Set(
    [
      ...source.matchAll(
        /^(?:export\s+)?(?:const|function|interface|type)\s+(\w+)/gm,
      ),
    ].map((m) => m[1]),
  );
}

let drifted = 0;
let checked = 0;

for (const file of FILES) {
  const localPath = join("src/reader-core", file.local);
  const upstreamPath = join(desktop, file.upstream);

  if (!existsSync(upstreamPath)) {
    console.error(`MISSING UPSTREAM  ${file.upstream}`);
    console.error("  It was renamed or deleted; this copy is now orphaned.");
    drifted += 1;
    continue;
  }

  const local = norm(readFileSync(localPath, "utf8"));
  const upstream = norm(readFileSync(upstreamPath, "utf8"));
  checked += 1;

  if (file.exact) {
    if (local !== upstream) {
      console.error(`DRIFT  ${file.local}  differs from ${file.upstream}`);
      drifted += 1;
    }
    continue;
  }

  // For adapted files, every name the copy exports must still exist upstream.
  // A rename or deletion upstream is what actually breaks these.
  const here = declarations(local);
  const there = declarations(upstream);
  const gone = [...here].filter((name) => !there.has(name));
  if (gone.length > 0) {
    console.error(
      `DRIFT  ${file.local}  declares names absent from ${file.upstream}:`,
    );
    for (const name of gone) console.error(`         ${name}`);
    drifted += 1;
  }
}

if (drifted > 0) {
  console.error(
    `\n${drifted} of ${checked} file(s) have drifted from the desktop app.`,
  );
  console.error(
    "Reconcile them before releasing — the pivot must land identically in both.",
  );
  process.exit(1);
}

console.log(`reader-core matches ${desktop} (${checked} files checked)`);
