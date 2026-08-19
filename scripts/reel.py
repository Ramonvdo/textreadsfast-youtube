"""Record the reader into the GIFs the README uses.

RSVP is difficult to explain and trivial to show: one animation of a word
swapping at a fixed point does what three paragraphs cannot. This drives
`dist/reel.html` a frame at a time and assembles the results.

Stepped rather than timed. Screen-recording a self-animating page captures
whatever happens to be on screen when the grab lands, which drops and duplicates
frames at random; stepping explicitly means frame *n* of the file is word *n* of
the sentence, every time, and the loop is seamless because it has to be.

Run: python scripts/reel.py   (after `node scripts/build.mjs --dev`)
"""

import functools
import http.server
import io
import os
import socketserver
import sys
import threading

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("playwright is not installed for this Python. Try: pip install playwright")

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is not installed for this Python. Try: pip install Pillow")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
OUT_DIR = os.path.join(ROOT, ".github", "assets")

# Milliseconds per word. Slower than anyone reads, because a README GIF is
# glanced at rather than read along with, and a loop that outruns the eye reads
# as a flicker rather than as a demonstration.
FRAME_MS = 260

# The full 256. Fewer starves the accent on the pivot letter, which occupies a
# few dozen pixels and is the one thing the animation exists to show.
PALETTE = 256

# Pillow moved these onto enums in 9.1 and kept the old module-level constants
# as aliases; this repo's interpreter predates the enums, so resolve either.
DITHER_NONE = getattr(getattr(Image, "Dither", Image), "NONE")
MEDIANCUT = getattr(getattr(Image, "Quantize", Image), "MEDIANCUT")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args: object) -> None:
        return


def serve(directory: str):
    handler = functools.partial(QuietHandler, directory=directory)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def record(page, url: str, width: int, height: int, every: int = 1):
    """Step the page and return one frame per step."""
    page.set_viewport_size({"width": width, "height": height})
    page.goto(url)
    page.wait_for_function("() => window.__ready === true", timeout=20000)
    steps = page.evaluate("() => window.__steps")

    frames = []
    for i in range(0, steps, every):
        page.evaluate("(i) => window.__step(i)", i)
        frames.append(Image.open(io.BytesIO(page.screenshot())).convert("RGB"))
    return frames


def save_gif(frames, path: str, frame_ms: int = FRAME_MS) -> None:
    """Write an optimised, infinitely looping GIF."""
    if not frames:
        sys.exit(f"no frames captured for {path}")

    # One shared palette for every frame. Quantising each frame on its own makes
    # the background shift colour slightly between them, which both looks like
    # a flicker and defeats the delta compression that keeps the file small.
    # Dithering is wrong for this material twice over: it speckles flat panels,
    # and the speckle differs between frames, so the delta encoder can no longer
    # tell which pixels actually changed and stores nearly a full frame each
    # time. Off, the backdrop is byte-identical frame to frame and only the
    # words are stored.
    base = frames[0].quantize(
        colors=PALETTE, method=MEDIANCUT, dither=DITHER_NONE
    )
    quantised = [base] + [
        f.quantize(palette=base, dither=DITHER_NONE) for f in frames[1:]
    ]

    quantised[0].save(
        path,
        save_all=True,
        append_images=quantised[1:],
        duration=frame_ms,
        loop=0,
        optimize=True,
        # 1, not 2. "Restore to background" forces every frame to be written in
        # full; "leave in place" lets Pillow store only the rectangle that
        # actually changed, which here is the line of text and nothing else.
        disposal=1,
    )
    size = os.path.getsize(path) / 1024
    print(f"  {os.path.basename(path):24s} {len(frames):3d} frames  {size:6.0f} KB")


def main() -> None:
    if not os.path.exists(os.path.join(DIST, "reel.html")):
        sys.exit("No dist/reel.html. Build it first: node scripts/build.mjs --dev")

    os.makedirs(OUT_DIR, exist_ok=True)
    httpd, port = serve(DIST)
    base = f"http://127.0.0.1:{port}/reel.html"

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(device_scale_factor=1)
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))

            print("recording:")

            # The hero. One word at a time, large, so the fixed pivot is the
            # first thing anyone notices.
            save_gif(record(page, base, 760, 190), os.path.join(OUT_DIR, "rsvp.gif"))

            # Every mode at once, reading the same sentence in step. This is the
            # picture that answers "which one do I want" without a paragraph.
            save_gif(
                # Tall enough for all six strips. Static wraps to two lines and
                # grows its card, which is what pushes the last strip off a
                # viewport sized for the others.
                record(page, f"{base}?grid=1", 760, 806),
                os.path.join(OUT_DIR, "modes.gif"),
            )

            # Two finished looks, for the profiles section.
            for profile in ("lyric", "caption-box"):
                save_gif(
                    record(page, f"{base}?profile={profile}", 760, 190),
                    os.path.join(OUT_DIR, f"profile-{profile}.gif"),
                )

            browser.close()

            for line in errors:
                print(f"page error: {line}", file=sys.stderr)
            if errors:
                sys.exit("the reel page raised an error; the frames are unreliable")
    finally:
        httpd.shutdown()

    print(f"\nwrote {OUT_DIR}")


if __name__ == "__main__":
    main()
