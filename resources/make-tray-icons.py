#!/usr/bin/env python3
"""Generates the tray icons from the Factorial mark. Run from the repo root:

    python resources/make-tray-icons.py

Requires Pillow. The generated files are committed, so this only has to run when
the artwork or the colours change.

The mark is the same one the app icon uses (`build/factorial-logo.png`), recoloured
rather than redrawn: it is a single-colour glyph, so replacing every pixel's
colour while keeping its alpha preserves both the shape and its antialiasing.

Two platforms, two different requirements:

* **macOS** wants a *template* image: monochrome black on transparent, named
  `…Template.png`, with an `@2x` variant. macOS ignores the colour and re-tints
  the alpha itself for light mode, dark mode and the highlighted menu bar. That
  is why there is one macOS icon and no coloured variants — the state is carried
  by `tray.setTitle()` next to it.
* **Windows** has no menu-bar title, so the state has to be visible in the icon:
  four coloured `.ico` files, each holding 16/32/48 px for DPI scaling. The
  colours match the widget's status dot, so the two surfaces agree: grey clocked
  out, emerald clocked in, amber on a break, red when the session is gone.

**Why the mark is tinted rather than left in Factorial's red.** On Windows the
icon's colour *is* the state — there is nothing else next to it. Leaving the mark
its own red for every state would mean the tray says nothing about whether you
are clocked in, which is the one thing it exists to say. A coloured dot in the
corner was the alternative and loses at 16 px, where the whole icon is sixteen
pixels and a badge is four.

A 32 px `.png` per tone is written alongside as a fallback: `tray.ts` uses it if
an `.ico` decodes empty, which is what macOS Electron does with every `.ico`.

The `.ico` entries are written as BMP rather than embedded PNG: both are legal
since Vista, and BMP is what every ICO consumer has always understood.
"""

from pathlib import Path

from PIL import Image

RESOURCES = Path(__file__).resolve().parent
SOURCE = RESOURCES.parent / 'build' / 'factorial-logo.png'

# Same values as the widget's status dot, so the two surfaces agree on colour.
TONES = {
    'idle': (113, 113, 122, 255),  # zinc-500
    'active': (16, 185, 129, 255),  # emerald-500
    'paused': (245, 158, 11, 255),  # amber-500
    'alert': (239, 68, 68, 255),  # red-500
}

ICO_SIZES = (16, 32, 48)

# How much of the canvas the mark fills. The rest is breathing room: both the
# macOS menu bar and the Windows tray clip a glyph that runs to the edge, and the
# mark is a circle, which already reads larger than its bounding box suggests.
FILL = 0.86


def load_mark() -> Image.Image:
    """The logo, cropped to its own ink so the padding below is the real padding."""
    if not SOURCE.exists():
        raise SystemExit(f'no source image at {SOURCE}')
    mark = Image.open(SOURCE).convert('RGBA')
    box = mark.getbbox()
    if box is None:
        raise SystemExit('the source image is empty')
    return mark.crop(box)


MARK = load_mark()


def render(size: int, colour: tuple[int, int, int, int]) -> Image.Image:
    """The mark at `size` px in one flat colour, centred on a square canvas.

    Resized from the full-resolution original every time rather than from a
    cached small copy: scaling 493 px straight to 16 keeps far more of the shape
    than going through an intermediate would.
    """
    target = max(1, round(size * FILL))
    scaled = MARK.resize((target, target), Image.LANCZOS)

    # Replace the colour, keep the alpha. The mark is one flat colour, so this is
    # exact rather than an approximation — and the antialiased edge survives,
    # which is what makes 16 px legible at all.
    solid = Image.new('RGBA', scaled.size, colour)
    solid.putalpha(scaled.getchannel('A'))

    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    offset = (size - target) // 2
    canvas.alpha_composite(solid, (offset, offset))
    return canvas


def write_template(size: int, name: str) -> None:
    """Black on transparent: macOS reads the alpha and ignores the rest."""
    render(size, (0, 0, 0, 255)).save(RESOURCES / name)
    print('wrote', name, f'{size}x{size}')


def write_ico(tone: str) -> None:
    colour = TONES[tone]
    name = f'tray-{tone}.ico'
    # Pillow derives the smaller entries from this one; rendering the largest
    # from the original keeps that derivation as short as possible.
    render(max(ICO_SIZES), colour).save(
        RESOURCES / name,
        sizes=[(s, s) for s in ICO_SIZES],
        bitmap_format='bmp',
    )
    print('wrote', name, 'sizes', ICO_SIZES)

    png = f'tray-{tone}.png'
    render(32, colour).save(RESOURCES / png)
    print('wrote', png, '32x32')


if __name__ == '__main__':
    write_template(16, 'trayTemplate.png')
    write_template(32, 'trayTemplate@2x.png')
    for tone in TONES:
        write_ico(tone)
