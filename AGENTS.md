# AGENTS.md

Guidance for AI coding assistants working in this repository.

## What this is

A browser extension that replaces YouTube's captions with an RSVP reader — one
word at a time, with the Optimal Recognition Point pinned to a fixed screen
position. Companion to the desktop app
[TextReadsFast](https://github.com/rdooren/textreadsfast).

The crucial difference from the desktop app: **YouTube supplies the whole
transcript with timings up front.** There is no transcription, no queue, no
backpressure, no pacing to estimate. The current word is a lookup against
`video.currentTime`. If you find yourself porting the desktop app's `cadence.ts`
here, stop — the problem it solves does not exist in this repository.

## Commands

```bash
pnpm install
pnpm run build          # -> dist/, load unpacked in chrome://extensions
pnpm run watch          # rebuild on change
pnpm run typecheck
pnpm test               # caption parsing and word lookup
pnpm run check-drift    # reader-core vs the desktop app
pnpm run check          # all of the above
pnpm run format         # prettier; `src/reader-core` is ignored on purpose
```

## Things that will bite you

- **`src/reader-core/` is copied from the desktop app. Do not edit it here.**
  Changing it means changing both repos, or the same word reads differently in
  the app than in the browser. `pnpm run check-drift` reports divergence; it
  cannot prevent it. Behaviour that should differ belongs in `src/content/`.
  This includes _formatting_: the comparison is byte-for-byte, so the directory
  is in `.prettierignore`. Running prettier over it broke the check once already.

- **A caption request can "succeed" and return nothing.** Fetching a track
  without the player's proof-of-origin token gives HTTP 200 with an empty body,
  not an error. Never treat `response.ok` as "we have captions" — judge on
  whether words came out.

- **The manifest lives in `src/`, not the repository root.** Chrome will happily
  try to load any folder containing a `manifest.json` and then fail on the
  unbuilt paths inside it. Keeping the root manifest-free means the only
  loadable folder is `dist/`, which is the one that works.

- **Content scripts are bundled as IIFE, so no top-level `await`.** Init runs
  inside an async function called at the end of `src/content/index.ts`.

- **The page context is a different world.** `ytInitialPlayerResponse` and the
  player's network calls are unreachable from the content script. That is what
  `src/page/inject.ts` is for; it talks back over `window.postMessage`.

- **YouTube never reloads.** Every video change is `yt-navigate-finish`, and each
  one must tear the previous session down explicitly or overlays and listeners
  accumulate for as long as the tab lives.

- **Mount inside `#movie_player`, never `document.body`.** That is what makes
  fullscreen and theatre mode work without any code handling either.

- **Auto-captions repeat themselves.** Rolling `aAppend` events duplicate the
  previous line; taking both reads every word twice.

- **A profile is not the whole of `Settings`.** `enabled` and `language` are
  excluded deliberately — they belong to the user, not to a reading style, and a
  profile switch that turned the reader off would read as a bug. `PROFILE_FIELDS`
  in `src/profiles.ts` is keyed by `keyof ProfileSettings` so that adding a
  setting and forgetting the profiles is a compile error, not a half-applied
  switch at runtime.

- **`chrome.storage.sync` rejects more than 120 writes a minute**, silently. One
  unhurried drag of one slider exceeds that, which is why the options page
  debounces writes and flushes them on `pagehide` and before applying a profile.

- **The overlay skips redrawing a word it is already showing**, and a paused
  video presents no frames. Anything that changes what the stage should look like
  has to clear `lastText` — `apply()` does it unconditionally for that reason.

## Design rules

The reader is a precision instrument. A fixed focal point is the entire
mechanism, so nothing may compete with the word stream: no animation beyond a
sub-80ms opacity swap, all on `transform`/`opacity`. Never pure black or pure
white — that contrast is what causes eye strain over a long session.

This code runs inside someone else's page. Every class is prefixed `trf-`, every
rule is scoped under `.trf-reader`, and the overlay is `pointer-events: none`.
Reading must never cost the viewer a click.

## Code style

Strict TypeScript, no `any`. Plain DOM rather than a framework — the whole
surface is one word plus context, and a renderer would cost more than it saves.
Document _why_, not _what_.

**Commits:** conventional prefixes (`feat:`, `fix:`, `docs:`, `refactor:`,
`chore:`), and say why rather than what.
