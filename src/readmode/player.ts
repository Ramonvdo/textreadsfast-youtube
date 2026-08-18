/**
 * Borrowing YouTube's real player.
 *
 * Read Mode moves `#movie_player` into its own layout and gives it back on
 * exit. Moving the real player rather than embedding an iframe is what keeps
 * every video playable, keeps ads working, and — the deciding reason — carries
 * the RSVP overlay along for free, because `.trf-reader` is mounted *inside*
 * `#movie_player` and its `ResizeObserver` watches that same element.
 *
 * Three facts about the player shape everything here, all of them verified
 * against the live page or the player bundle:
 *
 * 1. **It does not observe its container.** `ResizeObserver` appears once in
 *    YouTube's `base.js`, in an ad-measurement path; layout runs off a `window`
 *    resize listener. So a new size has to be pushed with `setSize`, which is an
 *    expando method on the element and therefore only reachable from the page
 *    context — hence the `inject.ts` bridge.
 * 2. **A synchronous move does not stop playback.** `appendChild` is an atomic
 *    remove-then-insert, and the spec's "media element removed from document"
 *    step runs only after awaiting a stable state, by which point the element is
 *    back in the document. Splitting the move across an `await` breaks that.
 * 3. **A hidden or zero-size slot freezes the reader.** The video keeps playing
 *    but presents no frames, so `requestVideoFrameCallback` stops firing and the
 *    RSVP word sticks on the last one. The rAF fallback does not rescue this: it
 *    only exists for browsers without rVFC.
 */

const CHANNEL = "trf-youtube";

/** Everything needed to put the player back exactly where it was. */
export interface PlayerLoan {
  player: HTMLElement;
  parent: ParentNode;
  nextSibling: ChildNode | null;
  /** `setSize` writes inline width/height, so the original must be recoverable. */
  inlineStyle: string | null;
}

function post(kind: string, payload: unknown): void {
  window.postMessage(
    { channel: CHANNEL, kind, payload },
    window.location.origin,
  );
}

/** Push a new size through the page bridge. `setSize` is a player expando. */
export function requestPlayerSize(width: number, height: number): void {
  post("player-size", { width: Math.round(width), height: Math.round(height) });
}

export function requestSeek(seconds: number): void {
  post("player-seek", { seconds: Math.max(0, seconds) });
}

export function findPlayerElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#movie_player");
}

/**
 * Move the player into `slot`.
 *
 * Synchronous from start to finish — see fact 2 above. Returns null rather than
 * throwing when there is no player, because "not on a watch page yet" is an
 * ordinary state, not an error.
 */
export function adoptPlayer(slot: HTMLElement): PlayerLoan | null {
  const player = findPlayerElement();
  if (!player) return null;
  if (player.parentElement === slot) return null; // already ours

  const loan: PlayerLoan = {
    player,
    parent: player.parentNode as ParentNode,
    nextSibling: player.nextSibling,
    inlineStyle: player.getAttribute("style"),
  };

  slot.appendChild(player);
  // Belt and braces alongside `setSize`: if a size push is ever dropped, the
  // element still fills its slot rather than collapsing and freezing the reader.
  player.style.width = "100%";
  player.style.height = "100%";

  return loan;
}

/**
 * Give the player back.
 *
 * If the original parent is gone — YouTube rebuilt the container while we held
 * it — re-query a sensible mount point. If nothing is found we deliberately do
 * NOT drop the player on `document.body`: losing it is worse than failing to
 * exit, so the caller is told and Read Mode stays open.
 */
export function releasePlayer(loan: PlayerLoan): boolean {
  const { player, inlineStyle } = loan;

  let parent: ParentNode | null = loan.parent;
  if (!(parent instanceof Element) || !parent.isConnected) {
    parent =
      document.querySelector("#player-container-inner") ??
      document.querySelector("ytd-player > #container");
  }
  if (!parent) return false;

  // `insertBefore(node, null)` appends, which is exactly right when the player
  // was the last child. Guard the sibling: it may have been moved or removed.
  const before =
    loan.nextSibling && loan.nextSibling.parentNode === parent
      ? loan.nextSibling
      : null;
  parent.insertBefore(player, before);

  if (inlineStyle === null) player.removeAttribute("style");
  else player.setAttribute("style", inlineStyle);

  // Make YouTube re-measure: it listens on window, not on the container.
  window.dispatchEvent(new Event("resize"));
  return true;
}

/**
 * Keep the player in the slot, and keep it the right size.
 *
 * Two independent things can displace it. YouTube's SPA re-render can evict it
 * from a container it does not know we own, and a window resize makes YouTube
 * measure its own now-empty container and push a wrong — sometimes zero — size
 * onto the player. Both are cheap to notice and cheap to undo.
 *
 * Returns a disposer.
 */
export function keepAdopted(loan: PlayerLoan, slot: HTMLElement): () => void {
  const { player } = loan;
  let frame = 0;
  let lastW = 0;
  let lastH = 0;

  const pushSize = (): void => {
    const rect = slot.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return; // never push a collapsing size
    // `setSize` re-lays out the whole player chrome, so coalesce to one call per
    // frame and ignore sub-pixel noise during a drag.
    if (Math.abs(rect.width - lastW) < 1 && Math.abs(rect.height - lastH) < 1)
      return;
    lastW = rect.width;
    lastH = rect.height;
    requestPlayerSize(rect.width, rect.height);
  };

  const schedule = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      pushSize();
    });
  };

  const resize = new ResizeObserver(schedule);
  resize.observe(slot);

  // YouTube writing inline width/height is how a wrong size arrives. Re-assert.
  const styleWatch = new MutationObserver(() => {
    player.style.width = "100%";
    player.style.height = "100%";
    schedule();
  });
  styleWatch.observe(player, { attributes: true, attributeFilter: ["style"] });

  // Re-adopt if the SPA evicts the player from our slot.
  const slotWatch = new MutationObserver(() => {
    if (player.parentElement !== slot && player.isConnected) {
      slot.appendChild(player);
      player.style.width = "100%";
      player.style.height = "100%";
      schedule();
    }
  });
  slotWatch.observe(slot, { childList: true });

  schedule();

  return () => {
    if (frame) cancelAnimationFrame(frame);
    resize.disconnect();
    styleWatch.disconnect();
    slotWatch.disconnect();
  };
}
