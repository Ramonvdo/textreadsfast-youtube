/**
 * Renders Read Mode from a fixture, with no YouTube page and no extension.
 *
 * This is the whole reason `view.ts` is a pure function of a plain object: the
 * design can be screenshotted and compared against `video-viewer-concept.jpg`
 * without a browser profile, a login, or a live video. Dev-only — built behind
 * `--dev` and never listed in the manifest.
 */

import { renderReadMode } from "../readmode/view";
import { chaptersWithEnds, type ReadModeModel } from "../readmode/model";

declare global {
  interface Window {
    __ready?: boolean;
    __model?: ReadModeModel;
  }
}

/** Stands in for the real player, so the screenshot is comparable to the concept. */
function placeholder(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "position:absolute;inset:0;display:grid;place-items:center;background:#1a1c1f;";

  const badge = document.createElement("div");
  badge.style.cssText =
    "width:96px;height:68px;border-radius:16px;background:#f00;display:grid;place-items:center;";

  const triangle = document.createElement("div");
  triangle.style.cssText =
    "width:0;height:0;border-left:26px solid #fff;border-top:16px solid transparent;border-bottom:16px solid transparent;margin-left:6px;";

  badge.appendChild(triangle);
  wrap.appendChild(badge);
  return wrap;
}

async function main(): Promise<void> {
  const response = await fetch("fixtures/session.json");
  const raw = (await response.json()) as ReadModeModel;

  const model: ReadModeModel = {
    ...raw,
    chapters: chaptersWithEnds(raw.chapters, raw.durationMs),
  };
  window.__model = model;

  const view = renderReadMode(model, {
    onSeek: () => undefined,
    onAddNote: () => undefined,
    onDeleteNote: () => undefined,
    onSendChat: () => undefined,
    onExport: () => undefined,
    onClose: () => undefined,
  });

  view.playerSlot.appendChild(placeholder());
  document.body.appendChild(view.root);
  document.title = `${model.title} — Read Mode harness`;

  await document.fonts.ready;
  // The screenshot script waits on this rather than on a timeout, so a slow
  // font load can never be mistaken for a design that renders in the wrong face.
  window.__ready = true;
}

void main();
