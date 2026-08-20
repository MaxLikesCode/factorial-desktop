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
