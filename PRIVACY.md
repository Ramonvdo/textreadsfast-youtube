# Privacy Policy

**TextReadsFast for YouTube**
Last updated: 19 August 2026

The short version: the extension reads YouTube's own caption tracks and shows
them back to you differently. That happens entirely inside your browser. The one
feature that sends anything anywhere is the Read Mode assistant, it is off until
you supply your own API key, and it sends to a provider you choose.

There is no server operated by this project. There is no account, no analytics,
no telemetry, no advertising, and nothing is sold or shared with anyone.

---

## What the extension stores, and where

| Data                                                  | Where it lives                | Leaves your device?                                   |
| ----------------------------------------------------- | ----------------------------- | ----------------------------------------------------- |
| Reading settings and profiles                         | `chrome.storage.sync`         | Only via Chrome's own account sync, if you have it on |
| Your AI API key                                       | `chrome.storage.local`        | **No** — `local` is never synced by Chrome            |
| Chosen model, provider URL, summary prompt            | `chrome.storage.local`        | No                                                    |
| Device preferences (stats tracking, export folder, …) | `chrome.storage.local`        | No                                                    |
| Read Mode sessions: notes, summaries, chat history    | The extension's own IndexedDB | No                                                    |
| Study stats: watch time, coverage, rewatch counts     | The extension's own IndexedDB | No                                                    |

Everything above stays on this computer. Uninstalling the extension removes it.

Note on `chrome.storage.sync`: this is Chrome's built-in setting-sync mechanism.
If you are signed into Chrome with sync enabled, Google replicates those values
to your other devices under your own Google account. That is Chrome's feature,
not this project's, and it covers **only** reading settings and profiles —
never your API key.

## What is sent over the network

### By the reader: nothing

The reader obtains captions from YouTube, on pages you have already opened, by
two routes:

1. Requesting the caption track named in the page's own player response.
2. Observing the caption data the YouTube player fetches for itself.

Both are requests to YouTube, for a video you are already watching. No copy of
any transcript is transmitted anywhere else, and no record of what you watch is
sent off the device.

### By the Read Mode assistant: only after you opt in

The assistant is inert until you enter an API key in the extension's settings.
Once you have entered one:

- **Opening Read Mode on a video sends that video's transcript and title** to
  the AI provider configured in settings — by default
  [OpenRouter](https://openrouter.ai) — so it can produce the summary.
- **Questions you type in the assistant are sent** to the same provider, along
  with the transcript for context.
- **Asking for generated chapter names sends the transcript** to the same
  provider.

That is the complete list. Your notes are not sent. Your library, stats and
settings are not sent. Nothing is sent for videos you do not open Read Mode on.

Requests are made by the extension's service worker directly to your provider.
They do not pass through any server belonging to this project, because there
isn't one.

**Your provider's privacy policy governs what happens to that data once it
arrives.** If you use OpenRouter, read
[their privacy policy](https://openrouter.ai/privacy) — and note that OpenRouter
in turn routes to whichever model vendor you select. You can point the extension
at any OpenAI-compatible endpoint, including one you run yourself, by changing
the base URL in settings.

**Deleting your API key stops all of this.** The assistant returns to doing
nothing, and the rest of the extension is unaffected.

## Permissions, and why each is needed

| Permission                               | Why                                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `storage`, `unlimitedStorage`            | Save settings, profiles, notes, sessions and stats locally. Transcripts of long videos are sizeable.  |
| `downloads`                              | Write the Markdown file when you press Export. Used only at that moment.                              |
| `*://*.youtube.com/*` (host)             | Read captions and place the reader over the player. The extension runs on YouTube and nowhere else.   |
| `https://openrouter.ai/*` (**optional**) | Talk to the AI provider. Requested when you first save a key, not at install.                         |
| `https://*/*` (**optional**)             | Only if you point the assistant at a different OpenAI-compatible provider. Never requested otherwise. |

The optional permissions are genuinely optional: Chrome does not grant them at
install time, and the extension is fully usable as a reader without ever
granting them.

## What the extension deliberately does not do

- It does not read pages other than YouTube.
- It does not read, or have permission to read, your browsing history.
- It does not access your microphone, camera, clipboard, or files (the export is
  a download you initiate, not filesystem access).
- It does not contain analytics, crash reporting, or any third-party SDK.
- It does not load remote code. Everything it runs ships in the package, which
  is a requirement of Manifest V3 and is also just the right thing to do.
- The API key is never given to a content script — scripts running inside
  YouTube's page cannot reach it. This is enforced by a build check
  (`pnpm run check-boundaries`) that fails if the boundary is ever crossed.

## Children

Not directed at children, and it collects nothing from anyone.

## Your control

- **Settings and profiles** — change or reset in the options page.
- **API key** — clear it in settings; the assistant stops immediately.
- **Sessions and notes** — delete individually or clear the whole library.
- **Study stats** — a single toggle turns recording off. Turning it off stops
  the recording, rather than merely hiding what was recorded.
- **Everything** — uninstalling removes all local data.

## Changes

Material changes will be reflected here with a new date, and noted in the
release notes.

## Contact

Open an issue at
<https://github.com/Ramonvdo/textreadsfast-youtube/issues>, or use the
repository's Security tab for anything sensitive.
