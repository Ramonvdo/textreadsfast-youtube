# Security Policy

## Reporting a vulnerability

Please report security issues **privately** through this repository's
**Security** tab → **Report a vulnerability**, rather than opening a public
issue. I aim to acknowledge reports within 7 days.

If the issue concerns a user's API key or anything else that could be actively
exploited, please include enough detail to reproduce it and hold off on public
disclosure until there is a fix.

## Design notes

- **No backend.** There is no server operated by this project, so there is
  nothing to breach. Everything runs in the browser.
- **No telemetry, analytics, or third-party SDKs.** Nothing is bundled that
  phones home.
- **No remote code.** Everything the extension executes ships inside the
  package. Manifest V3 requires this; it is also the reason a supply-chain
  compromise of a CDN cannot reach users here.
- **The API key never enters a content script.** Content scripts run inside
  YouTube's page, which is a hostile environment for a secret. Only the service
  worker reads the key, and `scripts/check-boundaries.mjs` fails the build if
  anything under `src/content/` or `src/page/` references it.
- **The key is in `chrome.storage.local`, never `sync`.** `sync` replicates to
  Google's servers and to every signed-in device; `local` does not. This is
  stated plainly in the options page too, along with the honest limit: any
  extension-level compromise, or anyone with access to your browser profile on
  disk, can read `storage.local`. It is not a vault.
- **Provider access is an optional permission**, requested when a key is first
  saved rather than granted at install, so a user who never uses the assistant
  never grants network access to anything but YouTube.
- **The page-context bridge passes data, not capability.** The script injected
  into YouTube's page posts caption and metadata payloads over
  `window.postMessage`, checked for origin, and holds no credentials.
- **Model output is rendered as DOM nodes, never as HTML.** Summaries and chat
  replies are built element by element, so a model cannot inject markup or
  script into the page.
- **Model output is bounded.** A runaway or degenerate reply is detected and the
  stream aborted rather than allowed to run to the context limit — see
  `src/background/guard.ts`.

## Known limits

- `chrome.storage.local` is not encrypted at rest. An attacker with access to
  your browser profile directory, or another extension with sufficient
  permissions, can read the API key. Use a key scoped and rate-limited to what
  you are willing to lose, and revoke it if your machine is compromised.
- Caption data comes from YouTube's own responses, which are not a stable public
  API and are outside this project's control.

## Supported versions

Security fixes target the latest released version.
