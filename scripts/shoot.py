"""Render the harnesses and check the parts of them a person cannot eyeball.

Three jobs, deliberately separated:

1. Write screenshots to dev-shots/, for eyeballing Read Mode next to
   video-viewer-concept.jpg, and the six reading modes next to each other.
2. Assert the column boundaries land where the concept puts them. This is the
   automated gate. A per-pixel diff against a hand-composed JPEG would never
   converge, and chasing that number would make the design worse, so the machine
   checks geometry and a person checks taste.
3. Assert Highlighter does not change a word's width when it becomes the current
   one. That would shift the whole line once per word, and it is the one failure
   here that no still screenshot can show.

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
MODES_OUT = os.path.join(OUT_DIR, "reading-modes.png")

# The modes harness is a 2x4 grid of stand-in players: tall rather than wide.
MODES_WIDTH = 1400
MODES_HEIGHT = 1580

# Sub-pixel differences are rounding in the layout engine, not a jump. Anything
# a person could see is far larger: one side of Highlighter's padding is ~4px.
JUMP_TOLERANCE = 0.6

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

            # The key-setup state is worth looking at too: it is what a new user
            # sees first, and it is the only pane that is an iframe.
            page.goto(f"http://127.0.0.1:{port}/harness.html?state=needs-key")
            page.wait_for_function("() => window.__ready === true", timeout=15000)
            page.screenshot(path=os.path.join(OUT_DIR, "readmode-needs-key.png"))

            page.goto(f"http://127.0.0.1:{port}/harness.html?state=focus")
            page.wait_for_function("() => window.__ready === true", timeout=15000)
            page.screenshot(path=os.path.join(OUT_DIR, "readmode-focus.png"))

            page.goto(f"http://127.0.0.1:{port}/harness.html?state=error")
            page.wait_for_function("() => window.__ready === true", timeout=15000)
            page.screenshot(path=os.path.join(OUT_DIR, "readmode-error.png"))

            # The reader itself, every mode at once. Its own page rather than
            # another state of the Read Mode harness: this one is about the
            # overlay over a player, and shares none of that layout.
            modes_page = browser.new_page(
                viewport={"width": MODES_WIDTH, "height": MODES_HEIGHT},
                device_scale_factor=1,
            )
            modes_page.on("pageerror", lambda e: errors.append(str(e)))
            modes_page.goto(f"http://127.0.0.1:{port}/modes.html")
            try:
                modes_page.wait_for_function(
                    "() => window.__ready === true", timeout=15000
                )
            except Exception as error:
                for line in errors:
                    print(f"page error: {line}", file=sys.stderr)
                raise SystemExit(f"modes harness never became ready: {error}")
            modes_page.screenshot(path=MODES_OUT, full_page=True)
            jump = modes_page.evaluate("() => window.__jump")

            browser.close()
    finally:
        httpd.shutdown()

    print(f"wrote {OUT}\n")
    print(f"wrote {MODES_OUT}")

    # ---- the highlighter must not move the line ----------------------------
    if not jump:
        sys.exit("the modes harness measured no words; its probe is broken")

    worst = max(abs(w["asCurrent"] - w["asOther"]) for w in jump)
    moved = [w for w in jump if abs(w["asCurrent"] - w["asOther"]) > JUMP_TOLERANCE]
    print(
        f"highlighter: {len(jump)} words measured, worst width change "
        f"{worst:.2f}px  {'FAIL' if moved else 'pass'}"
    )
    print()
    if moved:
        for word in moved:
            print(
                f"  {word['text']!r}: {word['asCurrent']:.2f} -> {word['asOther']:.2f}",
                file=sys.stderr,
            )
        sys.exit(
            "Highlighter changes a word's width when it becomes current, so the "
            "line shifts sideways once per word. Every word needs the same box."
        )

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
