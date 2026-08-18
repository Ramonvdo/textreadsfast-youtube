# TextReadsFast for YouTube

**Read YouTube subtitles one word at a time — so 2x actually works.**

A browser extension that replaces YouTube's captions with a single word held at
a fixed focal point. Your eyes stop moving, so the words can move faster than
you could read them line by line.

The speed comes from YouTube's own playback rate. Set it to 2x or 3x and the
reader tracks it exactly, because it reads from the video clock rather than a
timer of its own.

> **Status: early.** Built and unit-tested, but not yet run against a broad
> range of real videos. See [Known risks](#known-risks).

---

## Why one word at a time

Reading is slow mostly because the eye moves. Roughly 80% of reading time goes
to _saccades_ — the jumps between fixation points — not to recognising words.

Rapid Serial Visual Presentation removes the jumps by holding the text still and
moving the words instead. The refinement that makes it work is the **Optimal
Recognition Point**: the single letter, slightly left of centre, that the brain
uses to identify a word. Align that letter at the same screen position for every
word and the eye never re-centres. That letter is the red one.

```
        ·
    But un̲til a few
        ·
```

## How it differs from the desktop app

[TextReadsFast](https://github.com/rdooren/textreadsfast) transcribes your
computer's audio live, which means guessing when each word was spoken and pacing
against a backlog that can never quite be trusted.

Here, YouTube hands over the entire transcript with timings attached before
playback starts. So there is no transcription, no backlog, no pacing to
estimate — the current word is a lookup against `video.currentTime`. Seeking,
pausing and playback rate all work without a line of code, because the video
clock already accounts for them.

The two share their reading engine — the pivot maths and alignment — so a word
lands identically in both. See [`src/reader-core/`](src/reader-core/README.md).

## Install

Not yet on the Chrome Web Store. To run it now:

```bash
pnpm install
pnpm run build
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load
unpacked**, and select **`dist/`** — not the repository root. The root has no
manifest precisely so it cannot be loaded by mistake; `dist/` is the extension.

Chrome and Edge; Firefox is a later port, since its MV3 differs enough to be its
own task.

`pnpm run watch` rebuilds on change — reload the extension to pick changes up.

## Profiles

Click the toolbar icon to switch profile mid-video, which is usually when you
want to: the right settings depend on what is on screen.

| Profile          | What it is for                                                  |
| ---------------- | --------------------------------------------------------------- |
| **Default**      | One word at a fixed point, dark, a little context either side.  |
| **Serif Flow**   | A whole line at once, serif on neutral grey. Reads like a page. |
| **Reading Room** | Light and warm, for daytime and bright video.                   |
| **Night Study**  | Bionic on deep blue-grey, for a lecture in the dark.            |
| **Sprint**       | Large, narrow, almost no context. For 2x and above.             |
| **Clarity**      | Big, high contrast, letter shapes drawn for low vision.         |

Editing any control leaves the change live and marks the profile _modified_ —
built-ins are never overwritten, so **Default** stays exactly as shipped
whatever you do to it. **Save as…** keeps your version under its own name.

## Settings

Click the toolbar icon → **All settings…**, or find Options on
`chrome://extensions`. There is a live preview running the real overlay, so
every control can be judged by looking at it.

Defaults match the desktop app so the two feel like one product.

## Known risks

**YouTube's caption plumbing is not a public API.** It changes, and this
extension reads it three ways so that one change does not break everything:

1. **Fetch the caption track directly**, from the URL in the page's player
   response. Works without the viewer turning captions on — when it works.
2. **Capture what the player fetches for itself.** A page-context script hooks
   `fetch` and `XMLHttpRequest` for `/api/timedtext`. Always correctly signed,
   but only fires once captions are switched on.
3. Failing both, the extension does nothing at all.

Route 1 is already unreliable. Requesting a caption track without the
proof-of-origin token the player attaches returns **HTTP 200 with an empty
body** — verified against a live video — rather than an error. Anything trusting
the status code would conclude it had captions and then render nothing, which is
why success here is judged on whether words actually came out.

**Word-level timing depends on the track.** Auto-generated captions carry a
per-word offset, which is exactly what this needs. Manually uploaded ones
usually give a whole phrase per cue, so those are interpolated across the cue by
character count — good enough to read along with, but not as tight.

**Videos with no captions do nothing.** That is deliberate: there is no
transcription here, so there is nothing to fall back to.

## Development

```bash
pnpm run typecheck
pnpm test              # caption parsing and word lookup
pnpm run check-drift   # reader-core vs the desktop app
pnpm run check         # all three
```

```
src/
  reader-core/   copied from the desktop app — do not edit here
  content/       caption parsing, the overlay, the video-clock loop
  page/          runs in the page context to reach YouTube's own objects
  options/       settings page
  popup/         toolbar profile switcher
  profiles.ts    the built-in profiles and the saved-profile store
```

Profiles live in their own storage keys rather than inside `Settings`, so the
content script never parses a list it has no use for. A profile deliberately
excludes `enabled` and `language`: those belong to you, not to a reading style,
and switching profile must not silently turn the reader off.

The reading engine lives in both repositories because they ship separately.
`check-drift` compares them and fails on any difference — it cannot prevent
divergence, only make it visible. Run it before releasing: if the two disagree
about where a pivot goes, the same word reads differently in the app than in the
browser.

## Privacy

No data leaves your browser. The extension reads caption tracks from YouTube,
which your browser is fetching anyway, and stores your settings in
`chrome.storage.sync`. There is no analytics, no network calls to anywhere else,
and no account.

## License

MIT — see [LICENSE](LICENSE). Bundled fonts are SIL Open Font License 1.1; see
[public/fonts/LICENSES.md](public/fonts/LICENSES.md).
