/**
 * How much screen the widget takes, and how much window it needs to take it.
 *
 * One card, two states:
 *
 * - **collapsed** 156 × 44. A dot, the timer, the day's bar. This is what is on
 *   screen all day.
 * - **expanded** 300 × 150. Everything: status, remaining time, the action
 *   buttons, the work-location select and the day's break total.
 *
 * The split is not about how much fits — it is about what the expanded card IS.
 * You open it to do something, press Pause or clock out, and it closes again. It
 * is a moment of acting, not a view you sit in, so it shows everything you might
 * reach for while you are there rather than making you open it twice. That is
 * also why the collapsed state is the one that persists: there is no size to
 * choose and nothing to remember.
 *
 * **Window size is not card size, and that is the whole trick.** Growing a real
 * `BrowserWindow` means `setSize()` from the main process, frame by frame across
 * the IPC boundary, with nothing interpolating in between — it stutters, and a
 * spring is outright impossible there because the overshoot would need window
 * sizes past the target. So the window is fixed at the expanded card's size
 * *plus the overshoot*, sits there transparent, and only the card inside it
 * animates, on the compositor.
 *
 * That headroom is `OVERSHOOT`. The opening spring is damped so it peaks about
 * 13 % past the target: a card going 156 → 300 px wide touches 318 px before it
 * settles. Without the room the peak is clipped and the spring is silently gone.
 */

export interface Size {
  width: number
  height: number
}

export const CARD: { collapsed: Size; expanded: Size } = {
  collapsed: { width: 156, height: 44 },
  // 162, not the 150 the rows themselves need. The work-location select is 24 px
  // tall, not the 16 of a line of text, so the footer ends 24 px below where it
  // starts — and the day's bar sits flush to the very bottom edge. At 150 that
  // left 3 px between them, which read as the footer resting on the bar.
  expanded: { width: 300, height: 162 },
}

/**
 * Where each row sits inside the expanded card, measured from its top edge.
 *
 * These live here rather than as numbers inside the component because they are
 * geometry, and geometry that nothing can check drifts. The footer looked right
 * at every height until someone noticed it resting on the day's bar: the
 * work-location select is 24 px tall, not the 16 of a line of text, so the row
 * ends 8 px lower than it reads in the source. `widget-size.test.ts` now does
 * the arithmetic that nobody was doing.
 *
 * `height` is what the row actually occupies on screen — the tallest thing in
 * it — not the font size it is written with.
 */
export const EXPANDED_ROWS = {
  /** Status label and the goal line. */
  head: { top: 11, height: 16 },
  /** The timer, at 30 px on a 1.04 line. */
  timer: { top: 32, height: 32 },
  /** The advisory line, in the gap the composition leaves anyway. */
  hint: { top: 65, height: 14 },
  /** Pause / Ausstempeln, at the button height. */
  actions: { top: 80, height: 28 },
  /** Work location and the day's break total; the select sets the height. */
  footer: { top: 120, height: 24 },
} as const

/** The day's bar, flush to the card's bottom edge in both states. */
export const DAY_BAR_HEIGHT = 3

/**
 * The smallest gap allowed between the last row and the day's bar.
 *
 * Not a round number for its own sake: at 3 px the footer read as resting on the
 * bar, which is what prompted this constant existing at all.
 */
export const BOTTOM_CLEARANCE = 12

/**
 * Which way the card grows when it is opened.
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

/**
 * The peak of the opening spring, as a fraction of the distance travelled.
 *
 * Hard-coded rather than derived, because the easing it has to match is a
 * sampled-and-rescaled curve in `styles.css` rather than a closed form. The two
 * are pinned against each other in `widget-size.test.ts`, which reads the
 * stylesheet: if the spring is ever retuned to peak higher than this, the window
 * clips the peak and the spring is silently gone, with nothing to see but a
 * slightly abrupt stop.
 */
export const OVERSHOOT = 0.126

/**
 * A little more room than the spring's peak strictly needs.
 *
 * Reserving exactly the peak leaves the card's last row of pixels flush against
 * the window's edge at the top of the bounce — 0.13 px of margin, in one case —
 * and sub-pixel rounding is enough to take it. What gets taken is the day's bar,
 * because that lives at the very bottom edge of the card: it vanished at the
 * fullest point of the rubber band and came back as the card settled.
 *
 * Two pixels is not a fudge factor. It is the difference between "fits" and
 * "fits with nothing to spare", on a window whose whole job is to be bigger than
 * what it contains.
 */
const SPRING_HEADROOM_PX = 2

/**
 * The window the card lives in: the expanded card, plus the room its opening
 * spring overshoots into, plus a margin. Rounded up — rounding down would give
 * back exactly what the margin is there to provide.
 */
export function windowSize(): Size {
  const { collapsed, expanded } = CARD
  const peak = (from: number, to: number): number => from + (to - from) * (1 + OVERSHOOT)
  return {
    width: Math.ceil(peak(collapsed.width, expanded.width)) + SPRING_HEADROOM_PX,
    height: Math.ceil(peak(collapsed.height, expanded.height)) + SPRING_HEADROOM_PX,
  }
}

export interface Point {
  x: number
  y: number
}

/**
 * Where the collapsed card sits inside its window, from the window's top-left.
 *
 * Against the edge it does *not* grow into: growing right pins it left, growing
 * left pins it right, and the transparent remainder is the room the expansion
 * moves into.
 *
 * Vertically there is never an offset — both directions grow downwards, which
 * keeps the expand control's y fixed in the `left` case and is the only reason
 * that case can leave the pointer where it is.
 */
export function cardOffsetFor(direction: ExpandDirection): Point {
  if (direction === 'right') return { x: 0, y: 0 }
  return { x: windowSize().width - CARD.collapsed.width, y: 0 }
}

/**
 * Where to put the window so the card does not appear to jump when the expand
 * direction changes.
 *
 * The user's eye is on the card, not on the invisible rectangle around it, and
 * flipping the direction moves the card to the other end of that rectangle.
 * Without this the visible widget would slide the full width of its growth room
 * — 163 px — for a setting meant to change nothing but which way it opens.
 *
 * Returns the new window origin. Clamping to a display is the caller's job; this
 * is arithmetic and knows nothing about screens.
 */
export function keepCardInPlace(
  origin: Point,
  from: ExpandDirection,
  to: ExpandDirection,
): Point {
  const before = cardOffsetFor(from)
  const after = cardOffsetFor(to)
  return { x: origin.x + before.x - after.x, y: origin.y + before.y - after.y }
}
