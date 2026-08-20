/**
 * How much screen the widget takes, and how much window it needs to take it.
 *
 * Three sizes, chosen in the tray. They are not three skins of one layout — each
 * drops something the smaller one cannot afford:
 *
 * - `standard`  340 × 224. Everything: status, goal line, 42 px timer, bar,
 *                actions, work-location select.
 * - `kompakt`   300 × 126. The same anatomy, tighter, without the location
 *                select — that is a preference and lives in the tray.
 * - `minimal`   156 × 44. Dot, timer, a hairline of progress, and one small
 *                button that grows the card to `kompakt`'s size. No actions of
 *                its own; the tray offers all of them regardless.
 *
 * **Window size is not card size, and that is the whole trick.** Growing a real
 * `BrowserWindow` means `setSize()` from the main process, frame by frame across
 * the IPC boundary, with nothing interpolating in between — it stutters, and a
 * spring is outright impossible there because the overshoot would need window
 * sizes past the target. So the window for an expandable size is fixed at the
 * expanded card's size *plus the overshoot*, sits there transparent, and only
 * the card inside it animates, on the compositor.
 *
 * That headroom is `OVERSHOOT`. The opening spring is damped at 0.55, which
 * peaks about 13 % past the target: a card going 148 → 300 px wide touches
 * 320 px before it settles. Without the room the peak is clipped and the spring
 * is silently gone.
 */

export const WIDGET_SIZES = ['standard', 'kompakt', 'minimal'] as const

export type WidgetSize = (typeof WIDGET_SIZES)[number]

export function isWidgetSize(value: string): value is WidgetSize {
  return (WIDGET_SIZES as readonly string[]).includes(value)
}

/**
 * Which way the Minimal card grows when it is opened.
 *
 * `right` grows away from the expand control, which therefore travels with the
 * card's far corner: the pointer that just clicked it is left behind and has to
 * chase it to close again. `left` grows the other way and pins the control where
 * it already is — click, act, click again without moving the mouse.
 *
 * Both are offered rather than one being fixed, because the better answer
 * depends on where the widget is parked. The window is wider than the collapsed
 * card and is clamped to the display as a whole, so the card cannot be pushed
 * fully into the edge the growth room sits against: growing right keeps the left
 * screen edge reachable, growing left keeps the right one.
 */
export const EXPAND_DIRECTIONS = ['right', 'left'] as const

export type ExpandDirection = (typeof EXPAND_DIRECTIONS)[number]

export function isExpandDirection(value: string): value is ExpandDirection {
  return (EXPAND_DIRECTIONS as readonly string[]).includes(value)
}

export interface Size {
  width: number
  height: number
}

export interface WidgetLayout {
  /** The visible card at rest. */
  card: Size
  /** What the card grows to on click, or `null` when the size needs no growing. */
  expanded: Size | null
}

/**
 * Why 156 and not the 148 the card needs for its own contents: a drag region
 * swallows clicks whole (`-webkit-app-region: drag`), so the card cannot both be
 * draggable and be its own expand button. The 20 px control that resolves that
 * is what the extra width buys.
 */

/**
 * The peak of the opening spring, as a fraction of the distance travelled.
 *
 * Hard-coded rather than derived, because the easing it has to match is a
 * sampled-and-rescaled curve in `styles.css` rather than a closed form — the
 * textbook `exp(-zeta * pi / sqrt(1 - zeta^2))` is only the starting point. The
 * two are pinned against each other in `widget-size.test.ts`, which reads the
 * stylesheet: if the spring is ever retuned to peak higher than this, the window
 * clips the peak and the spring is silently gone, with nothing to see but a
 * slightly abrupt stop.
 */
export const OVERSHOOT = 0.126

export const WIDGET_LAYOUTS: Record<WidgetSize, WidgetLayout> = {
  standard: { card: { width: 340, height: 224 }, expanded: null },
  kompakt: { card: { width: 300, height: 126 }, expanded: null },
  minimal: { card: { width: 156, height: 44 }, expanded: { width: 300, height: 126 } },
}

/**
 * The window a size needs.
 *
 * For a size that never grows this is the card itself — no transparent margin,
 * so nothing invisible is in the way of the desktop behind it. For one that
 * grows it is the expanded card plus the overshoot, rounded up to whole pixels:
 * a fractional window size is rounded by the platform anyway, and rounding *up*
 * here keeps the guarantee that the peak fits.
 */
export function windowSizeFor(size: WidgetSize): Size {
  const { card, expanded } = WIDGET_LAYOUTS[size]
  if (expanded === null) return { ...card }
  return {
    width: Math.ceil(card.width + (expanded.width - card.width) * (1 + OVERSHOOT)),
    height: Math.ceil(card.height + (expanded.height - card.height) * (1 + OVERSHOOT)),
  }
}

/** True when the window carries transparent margin the card does not fill. */
export function hasTransparentMargin(size: WidgetSize): boolean {
  return WIDGET_LAYOUTS[size].expanded !== null
}

export interface Point {
  x: number
  y: number
}

/**
 * Where the collapsed card sits inside its window, from the window's top-left.
 *
 * A size that fills its window sits at the origin and has nowhere else to be.
 * The Minimal card sits against the edge it does *not* grow into: growing right
 * pins it left, growing left pins it right, and the transparent remainder is the
 * room the expansion moves into.
 *
 * Vertically there is never an offset — both directions grow downwards, which
 * keeps the expand control's y fixed in the `left` case and is the only reason
 * that case can leave the pointer where it is.
 */
export function cardOffsetFor(size: WidgetSize, direction: ExpandDirection): Point {
  const { card, expanded } = WIDGET_LAYOUTS[size]
  if (expanded === null || direction === 'right') return { x: 0, y: 0 }
  return { x: windowSizeFor(size).width - card.width, y: 0 }
}

/**
 * Where to put the window so the card does not appear to jump.
 *
 * Changing the size or the direction changes both the window's dimensions and
 * where the card sits inside it. The user's eye is on the card, not on the
 * invisible rectangle around it, so the card's screen position is what has to be
 * preserved — switching direction otherwise slides the visible widget 163 px
 * sideways for no reason the user asked for.
 *
 * Returns the new window origin. Clamping to a display is the caller's job; this
 * is arithmetic and knows nothing about screens.
 */
export function keepCardInPlace(
  origin: Point,
  from: { size: WidgetSize; direction: ExpandDirection },
  to: { size: WidgetSize; direction: ExpandDirection },
): Point {
  const before = cardOffsetFor(from.size, from.direction)
  const after = cardOffsetFor(to.size, to.direction)
  return {
    x: origin.x + before.x - after.x,
    y: origin.y + before.y - after.y,
  }
}
