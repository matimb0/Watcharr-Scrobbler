#!/usr/bin/env python3
"""Generates the extension icons as PNG with Pillow.

Usage:
    python3 tools/generate_icons.py                # writes icons/icon-48/96/128.png
    python3 tools/generate_icons.py --preview     # 128px preview to /tmp
"""
import os
import sys

from PIL import Image, ImageDraw

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPT_DIR)  # project folder
OUT = os.path.join(ROOT, "icons")
SIZES = [48, 96, 128]

# --- Brand colors -----------------------------------------------------------
RED = (229, 9, 20, 255)  # Netflix red #E50914
YELLOW = (241, 218, 131, 255)  # Watcharr yellow #F1DA83
DARK_TOP = (27, 27, 31, 255)  # Netflix-dark gradient top
DARK_BOT = (6, 6, 8, 255)  # … bottom
RING = (255, 255, 255, 26)  # subtle edge against dark taskbars

SUPERSAMPLE = 4  # render 4x, then downscale for smooth edges/gradient

def draw_gradient_bg(img, d, size, radius):
    """Dark Netflix gradient as a rounded square + subtle edge."""
    grad = Image.new("RGBA", (size, size), DARK_TOP)
    gp = grad.load()
    for y in range(size):
        t = y / max(1, size - 1)
        c = tuple(int(DARK_TOP[i] + (DARK_BOT[i] - DARK_TOP[i]) * t) for i in range(3))
        for x in range(size):
            gp[x, y] = (c[0], c[1], c[2], 255)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=radius, fill=255
    )
    img.paste(grad, (0, 0), mask)
    d.rounded_rectangle(
        [0, 0, size - 1, size - 1],
        radius=radius,
        outline=RING,
        width=max(1, size // 128),
    )


def generate_icon(size):
    """The FINAL logo: our own bauchiges (plump, rounded) yellow W with a
    black outline and a soft drop shadow, plus the red Netflix play badge
    bottom right."""
    s = float(size)
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    draw_gradient_bg(img, d, size, int(s * 0.24))

    # centreline of the plump W (fractions of a nominal 128px canvas)
    pts = [
        (int(s * 22 / 128), int(s * 36 / 128)),
        (int(s * 45 / 128), int(s * 100 / 128)),
        (int(s * 64 / 128), int(s * 46 / 128)),
        (int(s * 83 / 128), int(s * 100 / 128)),
        (int(s * 106 / 128), int(s * 36 / 128)),
    ]
    wpx = max(1, int(round(s * 23 / 128)))  # yellow stroke width
    ol = max(1, int(round(s * 2.2 / 128)))  # black outline (per side)
    ox = max(1, int(round(s * 3 / 128)))  # drop-shadow offset
    bw = wpx + 2 * ol  # outline-total stroke width

    # soft drop shadow bottom/right, then black outline, then yellow belly
    d.line(
        [(x + ox, y + ox) for x, y in pts],
        fill=(0, 0, 0, 120),
        width=bw,
        joint="curve",
    )
    d.line(pts, fill=(12, 12, 12, 255), width=bw, joint="curve")
    d.line(pts, fill=YELLOW, width=wpx, joint="curve")

    # red Netflix play badge bottom right
    cx, cy = int(s * 90 / 128), int(s * 95 / 128)
    r = max(2, int(s * 24 / 128))
    rr = max(1, int(s * 3 / 128))
    d.ellipse(
        [cx - r - rr, cy - r - rr, cx + r + rr, cy + r + rr],
        fill=None,
        outline=(0, 0, 0, 150),
        width=max(1, int(s * 2 / 128)),
    )
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=RED)
    d.polygon(
        [
            (cx - int(s * 5.5 / 128), cy - int(s * 8 / 128)),
            (cx - int(s * 5.5 / 128), cy + int(s * 8 / 128)),
            (cx + int(s * 10 / 128), cy),
        ],
        fill=(245, 245, 245, 255),
    )
    return img


def render(builder, size):
    """Supersampled rendering: draw 4x larger, then downscale smoothly."""
    big = builder(size * SUPERSAMPLE)
    return big.resize((size, size), Image.LANCZOS)


def main():
    preview = "--preview" in sys.argv
    if preview:
        os.makedirs("/tmp/watcharr-scrobbler_icons", exist_ok=True)
        p = os.path.join("/tmp/watcharr-scrobbler_icons", "preview.png")
        render(generate_icon, 128).save(p)
        print(f"preview: {p}")
        return

    os.makedirs(OUT, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT, f"icon-{size}.png")
        render(generate_icon, size).save(path)
        print(f"written: {path}")


if __name__ == "__main__":
    main()
