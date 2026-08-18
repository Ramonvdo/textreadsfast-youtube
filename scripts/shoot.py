"""Render the Read Mode harness and check it against the concept's layout.

Two jobs, deliberately separated:

1. Write a screenshot to dev-shots/, for eyeballing next to
   video-viewer-concept.jpg.
2. Assert the three column boundaries land where the concept puts them. This is
   the automated gate. A per-pixel diff against a hand-composed JPEG would never
   converge, and chasing that number would make the design worse, so the machine
   checks geometry and a person checks taste.

Uses the Playwright already installed for this machine's Python, matching the
precedent set by scripts/fetch-fonts.py.

Run: python scripts/shoot.py
"""

import functools
import http.server
import os
import socketserver
import sys
import threading

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("playwright is not installed for this Python. Try: pip install playwright")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
HARNESS = os.path.join(DIST, "harness.html")
OUT_DIR = os.path.join(ROOT, "dev-shots")
OUT = os.path.join(OUT_DIR, "readmode.png")

WIDTH = 1920
HEIGHT = 950

# Column boundaries read off video-viewer-concept.jpg (native width 1912) and
# scaled to the capture viewport. The tolerance is generous because the concept
# is a hand-composed mock, not a rendering of a grid.
TOLERANCE = 14
TARGETS = [
    ("left nav right edge", "nav", "right", 397),
    ("video column left", "main", "left", 409),
    ("video column right", "main", "right", 1496),
    ("chat column left", "side", "left", 1540),
    ("chat column right", "side", "right", 1896),
]

MEASURE = """() => {
  const box = (sel) => {
    const node = document.querySelector(sel);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
             width: r.width, height: r.height };
  };
  return {
    nav: box('.trf-rm-nav'),
    main: box('.trf-rm-main'),
    side: box('.trf-rm-side'),
    stage: box('.trf-rm-stage'),
    notes: box('.trf-rm-notelist'),
  };
}"""


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    """The request log is noise that would bury the layout table."""

    def log_message(self, *args: object) -> None:  # noqa: D102
        return


def serve(directory: str):
    """Serve dist/ over http.

    Not file://, because the harness fetches its fixture and a file:// page is a
    null origin, so that fetch is refused before it starts. Serving also matches
    how the stylesheet resolves its font urls inside the packed extension.
    """
    handler = functools.partial(QuietHandler, directory=directory)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def main() -> None:
    if not os.path.exists(HARNESS):
        sys.exit(f"No harness at {HARNESS}\nBuild it first: node scripts/build.mjs --dev")

    os.makedirs(OUT_DIR, exist_ok=True)
    httpd, port = serve(DIST)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(
                viewport={"width": WIDTH, "height": HEIGHT}, device_scale_factor=1
            )
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))

            page.goto(f"http://127.0.0.1:{port}/harness.html")

            # Wait on the harness's own signal rather than a timeout: it sets
            # this only after document.fonts.ready, so a slow font can never be
            # captured as a design that renders in the fallback face.
            try:
                page.wait_for_function("() => window.__ready === true", timeout=15000)
            except Exception as error:
                for line in errors:
                    print(f"page error: {line}", file=sys.stderr)
                raise SystemExit(f"harness never became ready: {error}")

            page.screenshot(path=OUT)
            boxes = page.evaluate(MEASURE)
            browser.close()
    finally:
        httpd.shutdown()

    print(f"wrote {OUT}\n")

    stage = boxes.get("stage")
    if stage:
        ratio = stage["width"] / stage["height"] if stage["height"] else 0
        print(f"video stage {stage['width']:.0f}x{stage['height']:.0f}  ratio {ratio:.3f}\n")

    print(f"{'boundary':24s} {'actual':>8s} {'target':>8s} {'delta':>7s}  result")
    print("-" * 62)

    failures = 0
    for label, key, edge, target in TARGETS:
        box = boxes.get(key)
        if not box:
            print(f"{label:24s} {'MISSING':>8s} {target:>8d} {'-':>7s}  FAIL")
            failures += 1
            continue
        actual = box[edge]
        delta = actual - target
        ok = abs(delta) <= TOLERANCE
        if not ok:
            failures += 1
        print(
            f"{label:24s} {actual:8.0f} {target:8d} {delta:+7.0f}  "
            f"{'pass' if ok else 'FAIL'}"
        )

    print()
    if failures:
        sys.exit(f"{failures} boundary check(s) outside the {TOLERANCE}px tolerance")
    print(f"all {len(TARGETS)} boundaries within {TOLERANCE}px of the concept")


if __name__ == "__main__":
    main()
