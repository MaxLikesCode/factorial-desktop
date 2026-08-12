#!/usr/bin/env python3
"""Generates the application icons. Run from the repository root:

    python3 build/make-app-icon.py

Requires Pillow (`pip3 install pillow`). The generated files are committed, so
this only has to run when the shape or the colours change.

Two files, both read by electron-builder through `directories.buildResources`:

* `build/icon.icns` — macOS. Written by the system tool `iconutil` from a
  temporary `.iconset` directory, which is the only way to get all ten
  entries (16…512 px, each at @1x and @2x) into one file. **`iconutil` exists
  only on macOS**, so this script cannot regenerate the `.icns` on Windows —
  the committed file is what a Windows build uses, and it needs no regeneration
  there because Windows never reads it.
* `build/icon.ico` — Windows. Written by Pillow with 16/24/32/48/64/128/256 px
  entries; electron-builder rejects an `.ico` without a 256 px image.

The glyph is the same clock as the tray icons (`resources/make-tray-icons.py`),
but white on an emerald rounded square instead of monochrome: an app icon sits
on the user's own wallpaper and in Launchpad, where a dark glyph on transparency
would disappear. The rounded-rectangle geometry follows Apple's icon grid —
824 px of content centred in a 1024 px canvas, corner radius 185 px.
"""

import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

BUILD = Path(__file__).resolve().parent

CANVAS = 1024
SCALE = 4  # Supersample factor; everything below is drawn at CANVAS * SCALE.

# Apple's icon grid for a "rounded rectangle" app icon.
CONTENT = 824
RADIUS = 185

BACKGROUND = (16, 185, 129, 255)  # emerald-500, same tone as the active tray icon
GLYPH = (255, 255, 255, 255)

# The ten entries `iconutil` expects. Name → pixel size.
ICONSET = {
    "icon_16x16.png": 16,
    "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32,
    "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128,
    "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256,
    "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512,
    "icon_512x512@2x.png": 1024,
}

ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)


def draw_icon() -> Image.Image:
    """The 1024 px master, drawn at 4x and downsampled for clean edges."""
    big = CANVAS * SCALE
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    inset = (CANVAS - CONTENT) / 2 * SCALE
    draw.rounded_rectangle(
        (inset, inset, big - inset - 1, big - inset - 1),
        radius=RADIUS * SCALE,
        fill=BACKGROUND,
    )

    # Clock face, centred, sized against the content box rather than the canvas.
    centre = big / 2
    face = CONTENT * SCALE * 0.62
    ring = round(face * 0.085)
    draw.ellipse(
        (centre - face / 2, centre - face / 2, centre + face / 2, centre + face / 2),
        outline=GLYPH,
        width=ring,
    )

    # 10:10-ish hands: both visible, neither hidden behind the other.
    hand = ring
    draw.line((centre, centre, centre, centre - face * 0.30), fill=GLYPH, width=hand)
    draw.line((centre, centre, centre + face * 0.24, centre), fill=GLYPH, width=hand)

    return image.resize((CANVAS, CANVAS), Image.LANCZOS)


def write_icns(master: Image.Image) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for name, size in ICONSET.items():
            master.resize((size, size), Image.LANCZOS).save(iconset / name)
        target = BUILD / "icon.icns"
        subprocess.run(
            ["iconutil", "--convert", "icns", "--output", str(target), str(iconset)],
            check=True,
        )
        print("wrote icon.icns", sorted(set(ICONSET.values())))


def write_ico(master: Image.Image) -> None:
    target = BUILD / "icon.ico"
    master.resize((256, 256), Image.LANCZOS).save(
        target, sizes=[(s, s) for s in ICO_SIZES]
    )
    print("wrote icon.ico", ICO_SIZES)


if __name__ == "__main__":
    master = draw_icon()
    write_icns(master)
    write_ico(master)
