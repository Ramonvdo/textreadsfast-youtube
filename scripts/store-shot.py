"""Turn a screenshot into a Chrome Web Store listing image.

The store is strict and unhelpful about it: screenshots must be exactly
1280x800 or 640x400, and PNGs must be 24-bit with no alpha channel. A capture
from Win+Shift+S is neither, and the upload is rejected without saying which
rule it broke.

Give this any image and it produces one that fits: scaled to fit inside the
frame, centred, and padded with a colour sampled from the image's own edges so
the padding does not read as a border. Alpha is flattened away.

    python scripts/store-shot.py shot.png 03-on-a-real-video
    python scripts/store-shot.py shot.png promo --size 440x280
"""

import argparse
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is not installed for this Python. Try: pip install Pillow")

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "store-assets")


def edge_colour(image: Image.Image) -> tuple:
    """The average of the four edges, so padding blends into the capture."""
    w, h = image.size
    px = list(image.crop((0, 0, w, 1)).getdata())
    px += list(image.crop((0, h - 1, w, h)).getdata())
    px += list(image.crop((0, 0, 1, h)).getdata())
    px += list(image.crop((w - 1, 0, w, h)).getdata())
    n = len(px)
    return tuple(sum(c[i] for c in px) // n for i in range(3))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("name", help="output basename, written into store-assets/")
    ap.add_argument("--size", default="1280x800", help="1280x800, 640x400, 440x280, 1400x560")
    ap.add_argument(
        "--crop",
        action="store_true",
        help="fill the frame by trimming the long edge, instead of padding it",
    )
    ap.add_argument(
        "--trim",
        action="store_true",
        help="strip a uniform border first, so padding is not spent on padding",
    )
    args = ap.parse_args()

    width, height = (int(v) for v in args.size.lower().split("x"))

    # Flattened onto its own edge colour: a transparent capture would otherwise
    # composite against black and gain a frame nobody asked for.
    src = Image.open(args.source)
    if src.mode in ("RGBA", "LA", "P"):
        src = src.convert("RGBA")
        flat = Image.new("RGB", src.size, edge_colour(src.convert("RGB")))
        flat.paste(src, mask=src.split()[-1])
        src = flat
    else:
        src = src.convert("RGB")

    if args.trim:
        # A screen recording on a coloured backdrop is mostly backdrop. Cropping
        # to what is actually different from the corner pixel lets the window
        # itself fill the frame, which matters when the frame is 1280 wide and
        # the recording is 2880.
        bg = src.getpixel((0, 0))
        mask = Image.new("L", src.size)
        mask.putdata([0 if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) < 40 else 255
                      for r, g, b in src.getdata()])
        box = mask.getbbox()
        if box and (box[2] - box[0]) > src.width * 0.3 and (box[3] - box[1]) > src.height * 0.3:
            src = src.crop(box)

    if args.crop:
        # Trim the long edge to the target ratio, then scale. Padding a 2:1
        # screen recording into a 1.6:1 slot spends a fifth of the image on
        # bars; cropping spends it on the recording instead.
        want = width / height
        have = src.width / src.height
        if have > want:
            keep = round(src.height * want)
            left = (src.width - keep) // 2
            src = src.crop((left, 0, left + keep, src.height))
        elif have < want:
            keep = round(src.width / want)
            top = (src.height - keep) // 2
            src = src.crop((0, top, src.width, top + keep))
        canvas = src.resize((width, height), Image.LANCZOS)
    else:
        scale = min(width / src.width, height / src.height)
        # Never upscale past 1:1; a blown-up capture looks worse than a padded one.
        scale = min(scale, 1.0)
        fitted = src.resize(
            (max(1, round(src.width * scale)), max(1, round(src.height * scale))),
            Image.LANCZOS,
        )
        canvas = Image.new("RGB", (width, height), edge_colour(src))
        canvas.paste(fitted, ((width - fitted.width) // 2, (height - fitted.height) // 2))

    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, f"{args.name}.png")
    canvas.save(out, optimize=True)

    check = Image.open(out)
    print(f"{out}")
    print(f"  {check.size[0]}x{check.size[1]}  mode {check.mode}  {os.path.getsize(out)/1024:.0f} KB")
    print("  ready to upload" if check.mode == "RGB" and check.size == (width, height) else "  PROBLEM")


if __name__ == "__main__":
    main()
