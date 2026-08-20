import { describe, expect, it } from 'vitest'
import {
  OVERSHOOT,
  WIDGET_LAYOUTS,
  WIDGET_SIZES,
  hasTransparentMargin,
  isWidgetSize,
  windowSizeFor,
} from '@shared/widget-size'

describe('isWidgetSize', () => {
  it('accepts exactly the three sizes', () => {
    for (const size of WIDGET_SIZES) expect(isWidgetSize(size)).toBe(true)
  })

  it('rejects anything else, including near misses', () => {
    for (const value of ['Standard', 'compact', 'tiny', '', 'minimal ']) {
      expect(isWidgetSize(value)).toBe(false)
    }
  })
})

describe('windowSizeFor', () => {
  /**
   * A size that never grows must not carry invisible margin: the window would
   * sit in front of the desktop behind it for no reason, and in `minimal` that
   * margin is the whole thing the mouse has to be let through.
   */
  it('gives a non-growing size a window exactly the size of its card', () => {
    for (const size of ['standard', 'kompakt'] as const) {
      expect(windowSizeFor(size)).toEqual(WIDGET_LAYOUTS[size].card)
      expect(hasTransparentMargin(size)).toBe(false)
    }
  })

  /**
   * The regression this whole module exists for. The opening spring overshoots,
   * and a window sized to the *settled* card clips the peak — the spring is then
   * silently gone, with nothing to see but a slightly abrupt stop.
   */
  it('leaves room for the opening spring to overshoot', () => {
    const { card, expanded } = WIDGET_LAYOUTS.minimal
    if (expanded === null) throw new Error('minimal must expand')
    const win = windowSizeFor('minimal')

    const peakWidth = card.width + (expanded.width - card.width) * (1 + OVERSHOOT)
    const peakHeight = card.height + (expanded.height - card.height) * (1 + OVERSHOOT)

    expect(win.width).toBeGreaterThanOrEqual(peakWidth)
    expect(win.height).toBeGreaterThanOrEqual(peakHeight)
    // And genuinely larger than the settled card, or the test above would pass
    // for the wrong reason.
    expect(win.width).toBeGreaterThan(expanded.width)
    expect(win.height).toBeGreaterThan(expanded.height)
    expect(hasTransparentMargin('minimal')).toBe(true)
  })

  it('rounds up, never down — a rounded-down window clips the peak', () => {
    const win = windowSizeFor('minimal')
    expect(Number.isInteger(win.width)).toBe(true)
    expect(Number.isInteger(win.height)).toBe(true)
  })

  it('hands out a copy, so a caller cannot resize the table', () => {
    const win = windowSizeFor('standard')
    win.width = 9999
    expect(WIDGET_LAYOUTS.standard.card.width).toBe(340)
  })
})

describe('the sizes themselves', () => {
  /** The point of the feature: each step down must actually save screen. */
  it('gets strictly smaller in area from standard to minimal', () => {
    const areas = WIDGET_SIZES.map((s) => {
      const { width, height } = WIDGET_LAYOUTS[s].card
      return width * height
    })
    expect(areas).toEqual([...areas].sort((a, b) => b - a))

    // Minimal is the one that has to be dramatic to be worth a mode at all.
    const [standard, , minimal] = areas
    if (standard === undefined || minimal === undefined) throw new Error('three sizes expected')
    expect(minimal).toBeLessThan(standard * 0.15)
  })

  /**
   * `minimal` has no action buttons, so the card it grows to must be able to
   * carry them — which means the same card `kompakt` already is.
   */
  it('expands minimal to exactly the kompakt card', () => {
    expect(WIDGET_LAYOUTS.minimal.expanded).toEqual(WIDGET_LAYOUTS.kompakt.card)
  })

  /**
   * The collapsed card clips its content (`overflow: hidden`). The closing
   * spring is damped at 0.56, which dips about 12 % below the resting size — the
   * timer's line box has to survive that dip or the number is cut off at the
   * bottom of every collapse.
   */
  it('keeps the timer inside the card at the deepest point of the closing spring', () => {
    const { card, expanded } = WIDGET_LAYOUTS.minimal
    if (expanded === null) throw new Error('minimal must expand')

    /** Damping 0.56 on the way back: about 12 % of the distance, below the rest. */
    const UNDERSHOOT = 0.12
    const travel = expanded.height - card.height
    const dip = card.height - travel * UNDERSHOOT

    /** The 22 px timer at line-height 1.04, sitting 10 px below the card's top. */
    const timerBottom = 10 + 22 * 1.04

    expect(dip).toBeGreaterThan(timerBottom)
  })
})
