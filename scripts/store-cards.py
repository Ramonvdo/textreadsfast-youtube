"""Render the Chrome Web Store listing cards.

Screenshots `dist/cards.html` at exactly 1280x800 -- the size the store wants --
and writes each into store-assets/. The caption samples are drawn by the real
reader, so a listing image cannot drift from the product it is advertising.

Served from the repository root rather than dist/, because the cards embed
finished screenshots out of store-assets/ alongside the built stylesheet.

Run: python scripts/store-cards.py   (after `node scripts/build.mjs --dev`)
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
OUT_DIR = os.path.join(ROOT, "store-assets")

# name -> (card, width, height). The tiles are their own sizes, fixed by the
# store: 440x280 for the search-result thumbnail, 1400x560 for the marquee.
CARDS = [
    ("modes", "01-reading-modes", 1280, 800),
    ("styles", "02-caption-styles", 1280, 800),
    ("readmode", "03-read-mode", 1280, 800),
    ("library", "04-library", 1280, 800),
    ("tile", "promo-tile-440x280", 440, 280),
    ("marquee", "promo-marquee-1400x560", 1400, 560),
]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args: object) -> None:
        return


def main() -> None:
    if not os.path.exists(os.path.join(ROOT, "dist", "cards.html")):
        sys.exit("No dist/cards.html. Build it first: node scripts/build.mjs --dev")

    os.makedirs(OUT_DIR, exist_ok=True)
    handler = functools.partial(QuietHandler, directory=ROOT)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(device_scale_factor=1)
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))

            for card, name, width, height in CARDS:
                page.set_viewport_size({"width": width, "height": height})
                page.goto(f"http://127.0.0.1:{port}/dist/cards.html?card={card}")
                try:
                    page.wait_for_function("() => window.__ready === true", timeout=20000)
                except Exception as error:
                    for line in errors:
                        print(f"page error: {line}", file=sys.stderr)
                    raise SystemExit(f"card {card!r} never became ready: {error}")

                out = os.path.join(OUT_DIR, f"{name}.png")
                page.screenshot(path=out)
                print(
                    f"  {name + '.png':30s} {width}x{height}"
                    f"  {os.path.getsize(out) / 1024:6.0f} KB"
                )

            browser.close()
            for line in errors:
                print(f"page error: {line}", file=sys.stderr)
            if errors:
                sys.exit("a card raised an error; the images are unreliable")
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
