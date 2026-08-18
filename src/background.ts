/**
 * Service worker.
 *
 * Exists for one reason: without a handler, clicking the toolbar icon does
 * nothing at all, which reads as a broken extension. The settings live on the
 * options page, so that is where the click goes.
 */

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});
