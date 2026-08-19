# AGENTS.md

Guidance for AI coding assistants working in this repository.

## What this is

A browser extension that replaces YouTube's captions with an RSVP reader — one
word at a time, with the Optimal Recognition Point pinned to a fixed screen
position. Companion to the desktop app
[TextReadsFast](https://github.com/Ramonvdo/textreadsfast).

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
pnpm run shoot          # screenshot both harnesses, assert their geometry
pnpm run reel           # re-record the README's GIFs
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

- **An ad is not a navigation.** A pre-roll plays through the same `<video>`, in
  the same `#movie_player`, at the same URL — the address bar holds the _main_
  video's id throughout. So `yt-navigate-finish` never fires when the ad ends,
  and a session built from the ad's captions has nothing to invalidate it: the
  ad's transcript plays on over the real video until the page is reloaded. That
  was a real bug. The only signal is the player's own `ad-showing` class.

- **Timing does not tell you whose captions those are.** The player fetches the
  main video's track during a pre-roll as well as the ad's, so "arrived while an
  ad was showing" is not "belongs to the ad". Filter on the `v=` parameter in the
  caption URL (`captionVideoId`), which names the video outright.

- **Read Mode borrows the real player, and the loan is fragile.** It moves
  `#movie_player` into its own layout and gives it back on exit. Four rules, each
  of which has a silent failure mode:
  - The move must be **synchronous**. `appendChild` is an atomic remove-then-insert
    and playback survives it; an `await` in the middle lets the "media element
    removed from document" step run and the video pauses.
  - The player slot must **never** be `display: none` or zero-size. The video keeps
    playing but presents no frames, so `requestVideoFrameCallback` stops firing and
    the RSVP word freezes. The rAF fallback in `track()` does not rescue this — it
    only exists for browsers without rVFC.
  - **No `transform`, `filter`, `opacity`, `backdrop-filter`, `will-change` or
    `contain`** on the slot or its ancestors. Each creates a stacking context and
    breaks `.trf-reader`, which lives _inside_ the moved player.
  - `ReadModeView.playerSlot` keeps a **stable element identity**. `update()` may
    re-render every other pane; re-creating the slot detaches the live player.

- **The player does not observe its container.** `ResizeObserver` appears once in
  YouTube's `base.js`, in an ad-measurement path — layout runs off a `window`
  resize listener. A resized player must be told with `setSize`, which is an
  expando on the element and so only reachable from `inject.ts`.

- **Content-script `fetch` obeys the _host page's_ CORS**, not the extension's.
  That is the whole reason `src/background/` exists: a model-provider call from a
  content script on youtube.com is cross-origin and gets refused, while the same
  fetch from the service worker runs on the extension origin.

- **Content-script `indexedDB` is YouTube's database, not the extension's.** Only
  `chrome.*` is extension-scoped there, so the library could never have lived in
  the content script whatever the arrangement.

- **The API key lives in `chrome.storage.local`, never `sync`.** `sync`
  replicates to Google's servers and every signed-in device. Only
  `src/background/secrets.ts` reads it, and `scripts/check-boundaries.mjs` fails
  the build if anything under `src/content/**` or `src/page/**` goes near it.

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

- **A new reading mode is three places, and the compiler names all three.** The
  `ReadingMode` union, a `MODE_LABELS` entry (a `Record` keyed by the union, so
  the settings picker cannot go stale), and a `case` in `render()`'s switch. That
  switch ends in a `never` check on purpose: it used to be an if/else whose
  `else` was RSVP, so a mode added to the type compiled and silently rendered as
  something else. `THEME_LABELS` and the field chain in `options.ts` are guarded
  the same way.

- **Bionic, Plain and Highlighter share one renderer.** `renderLine`
  emits `.trf-lw` per word with `--past` / `--current` / `--future`, and the
  mode's CSS block decides what that means. A fifth line mode is a stylesheet
  block, not a fifth copy of the loop.

- **A mode-scoped rule outranks `.trf-lw--current`.**
  `.trf-reader[data-mode="plain"] .trf-lw` is two selectors to that rule's one,
  so a mode that colours its words has to scope its current-word rule too. Plain
  shipped a faded current word for exactly this reason, caught in `pnpm run
shoot` rather than by any test.

- **Highlighter's padding is on every word, not on the marked one.** Padding one
  word alone slides every word after it sideways once per word. `scripts/shoot.py`
  measures this and fails on a width change over 0.6px, because a still
  screenshot cannot show it.

- **Only some weights and no italics are bundled.** Geist stops at 600; a higher
  weight is synthesised by the browser and reads thinner than a real bold, which
  is why a heavy style wants Atkinson (a real 700). There are no italic faces
  at all, so `fontStyle: italic` is a synthetic slant. `fonts.css` is one of the
  five drift-checked files, so adding faces means changing the desktop too.

- **The measured pivot font string must carry weight and style.**
  `pivotOffsetPx` measures with a canvas, and a canvas measures exactly the font
  it is handed. Omitting them measured a bold or italic proportional face as
  regular upright, and the pivot landed off the column by the difference.

- **Custom theme colours are written as `--trf-custom-*`**, never as `--bg` and
  friends. A `[data-theme="custom"]` block maps them across, so all eight
  palettes are still defined in one stylesheet rather than half in CSS and half
  in TypeScript. `apply()` clears them for every other theme.

- **The README's GIFs are generated, not recorded by hand.** `pnpm run reel`
  drives `src/dev/reel.ts` a frame at a time and assembles them, so frame _n_ is
  word _n_ and the loop closes exactly. Two things keep the files small enough
  for a README: `disposal=1` (2 forces every frame to be written in full) and
  dithering off (its speckle differs per frame, so the delta encoder can no
  longer tell what actually changed). Both together took `modes.gif` from 2.7MB
  to 0.6MB. The reel backdrop is a two-stop gradient for the same reason — a
  richer one spends the 256-colour budget on scenery and leaves the pivot accent
  washed pink.

- **Charts with text in them must be drawn at their real pixel width.**
  `preserveAspectRatio="none"` on a fixed 320-unit viewBox at `width: 100%`
  scaled a 1080px panel 3.4x horizontally and 1x vertically — rectangles survive
  that, glyphs do not, and "Wed" arrived as a smeared "We". `mountBarChart` in
  `library.ts` measures with a `ResizeObserver`; only `renderCoverageBar`, which
  is nothing but rectangles, still stretches.

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
