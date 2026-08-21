#!/usr/bin/env python3
"""Generates the application icons from the Factorial mark.

    python build/make-app-icon.py [path/to/logo.png]

Requires Pillow. The generated files are committed, so this only has to run when
the artwork changes.

Two files, both read by electron-builder through `directories.buildResources`:

* `build/icon.icns` — macOS, written by Pillow.
* `build/icon.ico` — Windows, 16/24/32/48/64/128/256 px. electron-builder
  rejects an `.ico` without a 256 px entry.

**This runs on any platform.** The previous version shelled out to `iconutil`
for the `.icns`, which exists only on macOS and meant the two files could not be
regenerated from the same machine. Pillow writes ICNS directly, so a change to
the artwork no longer needs two computers.

The mark sits on a white rounded square rather than on transparency. An app icon
lands on the user's own wallpaper, in Launchpad and in the Windows task bar, and
a red-on-nothing glyph disappears against anything red or dark. White is also
what Factorial's own favicon uses, so the two read as the same product.

Geometry follows Apple's icon grid: 824 px of content centred in a 1024 px
canvas, corner radius 185 px. Windows has no such grid and looks acceptable with
the same shape, which is why one master serves both.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

BUILD = Path(__file__).resolve().parent
DEFAULT_SOURCE = BUILD / 'factorial-logo.png'

CANVAS = 1024
SCALE = 4  # Supersample factor; the square is drawn at CANVAS * SCALE.

# Apple's icon grid for a "rounded rectangle" app icon.
CONTENT = 824
RADIUS = 185

# How much of the content square the mark itself fills. Less than the full 824:
# the logo is a circle, and a circle drawn edge to edge inside a rounded square
# reads as larger than a square glyph of the same size would. 78 % leaves it
# looking the same weight as the system's own icons next to it.
MARK_RATIO = 0.78

BACKGROUND = (255, 255, 255, 255)


def rounded_square() -> Image.Image:
    """The white plate, supersampled and scaled down so the corners are smooth."""
    big = Image.new('RGBA', (CANVAS * SCALE, CANVAS * SCALE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(big)
    inset = ((CANVAS - CONTENT) // 2) * SCALE
    draw.rounded_rectangle(
        [inset, inset, CANVAS * SCALE - inset, CANVAS * SCALE - inset],
        radius=RADIUS * SCALE,
        fill=BACKGROUND,
    )
    return big.resize((CANVAS, CANVAS), Image.LANCZOS)


def load_mark(source: Path) -> Image.Image:
    """The logo, trimmed to its own ink and scaled to fit the plate.

    Trimming matters: the source has whatever margin the exporter left, and
    without cropping to the actual bounding box the mark would sit at an
    arbitrary size inside the square — visibly smaller than a system icon, and
    off-centre if the margin is uneven.
    """
    mark = Image.open(source).convert('RGBA')
    box = mark.getbbox()
    if box is None:
        raise SystemExit('the source image is empty')
    mark = mark.crop(box)

    target = int(CONTENT * MARK_RATIO)
    width, height = mark.size
    factor = target / max(width, height)
    return mark.resize((max(1, round(width * factor)), max(1, round(height * factor))), Image.LANCZOS)


def compose(source: Path) -> Image.Image:
    icon = rounded_square()
    mark = load_mark(source)
    icon.alpha_composite(mark, ((CANVAS - mark.width) // 2, (CANVAS - mark.height) // 2))
    return icon


def main() -> None:
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SOURCE
    if not source.exists():
        raise SystemExit(f'no source image at {source}')

    icon = compose(source)

    # Every size electron-builder and Windows ask for. 256 is the one it refuses
    # to build without.
    sizes = [(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]
    icon.save(BUILD / 'icon.ico', format='ICO', sizes=sizes)

    # ICNS wants a square power-of-two master; Pillow derives the rest.
    icon.save(BUILD / 'icon.icns', format='ICNS')

    print(f'wrote {BUILD / "icon.ico"} and {BUILD / "icon.icns"} from {source}')


if __name__ == '__main__':
    main()
