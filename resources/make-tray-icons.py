#!/usr/bin/env python3
"""Generates the tray icons. Run from the repository root:

    python3 resources/make-tray-icons.py

Requires Pillow (`pip3 install pillow`). The generated files are committed, so
this only has to run when the shape or the colours change.

Two platforms, two very different requirements (docs/WINDOWS.md §3):

* **macOS** wants a *template* image: monochrome black on transparent, named
  `…Template.png`, with an `@2x` variant. macOS ignores the colour and re-tints
  the alpha channel itself for light mode, dark mode, and the highlighted
  menubar. That is why there is exactly one macOS icon and no coloured variants —
  the state is carried by `tray.setTitle()` next to it.
* **Windows** has no menubar title, so the state has to be visible in the icon:
  four coloured `.ico` files, each holding 16/32/48 px for DPI scaling. The
  colours match the widget's status dot (StatusWidget.tsx): grey when clocked
  out, emerald while clocked in, amber during a break, red when the session is
  gone. A 32 px `.png` per tone is written alongside as a fallback — macOS
  Electron cannot decode `.ico` at all (measured: `nativeImage.createFromPath`
  returns an empty image for every `.ico`), so whether these files decode on
  Windows could not be verified here, and `tray.ts` falls back to the PNG rather
  than risk an invisible tray icon.

The `.ico` entries are written as BMP, not as embedded PNG: both are legal since
Vista, and BMP is what every ICO consumer has always understood.

The glyph is a clock: a ring plus two hands, drawn at 8x and downsampled, which
is what gives it clean edges at 16 px.
"""

from pathlib import Path

from PIL import Image, ImageDraw

RESOURCES = Path(__file__).resolve().parent
SCALE = 8

# Same values as the widget's status dot, so the two surfaces agree on colour.
TONES = {
    "idle": (113, 113, 122, 255),  # zinc-500
    "active": (16, 185, 129, 255),  # emerald-500
    "paused": (245, 158, 11, 255),  # amber-500
    "alert": (239, 68, 68, 255),  # red-500
}

ICO_SIZES = (16, 32, 48)


def draw_clock(size: int, colour: tuple[int, int, int, int]) -> Image.Image:
    """A clock face at `size` px, antialiased through an 8x supersample."""
    big = size * SCALE
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    # One pixel of padding at the target size keeps the ring off the edge, where
    # the menubar and the taskbar both clip.
    pad = SCALE
    ring = max(SCALE, round(big * 0.09))
    draw.ellipse((pad, pad, big - pad - 1, big - pad - 1), outline=colour, width=ring)

    centre = big / 2
    hand = max(SCALE, round(big * 0.085))
    # 10:10-ish hands: both visible, neither hidden behind the other.
    draw.line((centre, centre, centre, centre - big * 0.27), fill=colour, width=hand)
    draw.line((centre, centre, centre + big * 0.22, centre), fill=colour, width=hand)

    return image.resize((size, size), Image.LANCZOS)


def write_template(size: int, name: str) -> None:
    """Black on transparent: macOS reads the alpha channel and ignores the rest."""
    draw_clock(size, (0, 0, 0, 255)).save(RESOURCES / name)
    print("wrote", name, f"{size}x{size}")


def write_ico(tone: str) -> None:
    colour = TONES[tone]
    largest = draw_clock(max(ICO_SIZES), colour)
    name = f"tray-{tone}.ico"
    largest.save(
        RESOURCES / name,
        sizes=[(s, s) for s in ICO_SIZES],
        bitmap_format="bmp",
    )
    print("wrote", name, "sizes", ICO_SIZES)

    # The fallback described in the module docstring.
    png = f"tray-{tone}.png"
    draw_clock(32, colour).save(RESOURCES / png)
    print("wrote", png, "32x32")


if __name__ == "__main__":
    write_template(16, "trayTemplate.png")
    write_template(32, "trayTemplate@2x.png")
    for tone in TONES:
        write_ico(tone)
