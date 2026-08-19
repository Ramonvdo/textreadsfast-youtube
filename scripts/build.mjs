#!/usr/bin/env node
/**
 * Build the extension into `dist/`.
 *
 * esbuild rather than a bundler with a plugin ecosystem: an extension is a few
 * independent entry points that must each be a self-contained IIFE, which is
 * exactly what esbuild does with no configuration. A content script cannot be
 * an ES module in the general case, so `format: "iife"` is not a preference.
 *
 *   node scripts/build.mjs [--watch]
 */

import { build, context } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = resolve(root, "dist");
const watch = process.argv.includes("--watch");
// The screenshot harness renders the Read Mode view from a fixture, with no
// YouTube page involved. Never listed in the manifest — `--dev` keeps it out of
// a shipping build entirely.
const dev = watch || process.argv.includes("--dev");

const entries = {
  content: "src/content/index.ts",
  inject: "src/page/inject.ts",
  options: "src/options/options.ts",
  popup: "src/popup/popup.ts",
  background: "src/background/index.ts",
  library: "src/library/library.ts",
  keysetup: "src/keysetup/keysetup.ts",
  ...(dev ? { harness: "src/dev/harness.ts", modes: "src/dev/modes.ts" } : {}),
};

/** The font stylesheet ships as-is, but its `url()`s must resolve against the
 *  extension root rather than a web origin. */
async function buildCss() {
  const reader = await readFile(
    resolve(root, "src/content/reader.css"),
    "utf8",
  );
  const fonts = await readFile(
    resolve(root, "src/reader-core/fonts.css"),
    "utf8",
  );
  // `/fonts/x.woff2` is correct for the desktop app's web root; inside an
  // extension the same path must be relative so Chrome resolves it against the
  // package. Rewritten here so the shared file stays byte-identical upstream.
  const scoped = fonts.replace(/url\("\/fonts\//g, 'url("fonts/');
  await writeFile(
    resolve(outdir, "reader.css"),
    `${scoped}\n\n${reader}`,
    "utf8",
  );

  // Read Mode ships as its own content-script stylesheet, and carries the same
  // font faces. `url("fonts/...")` only resolves from a document at the dist
  // root, which is also why the harness is emitted there rather than a subdir.
  const readmode = await readFile(
    resolve(root, "src/readmode/readmode.css"),
    "utf8",
  );
  await writeFile(
    resolve(outdir, "readmode.css"),
    `${scoped}\n\n${readmode}`,
    "utf8",
  );
}

async function copyStatic() {
  await cp(
    resolve(root, "src/manifest.json"),
    resolve(outdir, "manifest.json"),
  );
  await cp(resolve(root, "public/fonts"), resolve(outdir, "fonts"), {
    recursive: true,
  });
  await cp(resolve(root, "icons"), resolve(outdir, "icons"), {
    recursive: true,
  });
  await cp(
    resolve(root, "src/options/options.html"),
    resolve(outdir, "options.html"),
  );
  await cp(
    resolve(root, "src/popup/popup.html"),
    resolve(outdir, "popup.html"),
  );
  await cp(
    resolve(root, "src/library/library.html"),
    resolve(outdir, "library.html"),
  );
  await cp(
    resolve(root, "src/keysetup/keysetup.html"),
    resolve(outdir, "keysetup.html"),
  );
  if (dev) {
    // Emitted at the dist root on purpose: `buildCss` rewrites font urls to be
    // relative, so a harness one directory deeper would render in a fallback
    // face and every screenshot diff would be chasing that instead of the design.
    await cp(
      resolve(root, "src/dev/harness.html"),
      resolve(outdir, "harness.html"),
    );
    // The reader's own harness: every reading mode over a stand-in player.
    await cp(
      resolve(root, "src/dev/modes.html"),
      resolve(outdir, "modes.html"),
    );
    await cp(resolve(root, "src/dev/fixtures"), resolve(outdir, "fixtures"), {
      recursive: true,
    });
  }
  await buildCss();
}

const options = {
  entryPoints: Object.fromEntries(
    Object.entries(entries).map(([name, file]) => [name, resolve(root, file)]),
  ),
  outdir,
  bundle: true,
  // A content script shares the page's global scope. IIFE keeps every
  // declaration private, so nothing here can collide with YouTube's own code.
  format: "iife",
  target: ["chrome114"],
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
};

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await copyStatic();

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("watching — load dist/ as an unpacked extension");
} else {
  await build(options);
  console.log("built dist/");
}
