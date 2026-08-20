import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EXPAND_DIRECTIONS,
  OVERSHOOT,
  cardOffsetFor,
  isExpandDirection,
  keepCardInPlace,
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

describe('cardOffsetFor', () => {
  it('accepts exactly the two directions', () => {
    for (const direction of EXPAND_DIRECTIONS) expect(isExpandDirection(direction)).toBe(true)
    for (const value of ['Right', 'up', 'down', '']) expect(isExpandDirection(value)).toBe(false)
  })

  it('leaves a size that fills its own window at the origin, whatever the direction', () => {
    for (const size of ['standard', 'kompakt'] as const) {
      for (const direction of EXPAND_DIRECTIONS) {
        expect(cardOffsetFor(size, direction)).toEqual({ x: 0, y: 0 })
      }
    }
  })

  /**
   * The card sits against the edge it does NOT grow into, so the transparent
   * remainder is exactly the room the expansion needs.
   */
  it('pins the minimal card against the edge it does not grow into', () => {
    const { card } = WIDGET_LAYOUTS.minimal
    const win = windowSizeFor('minimal')

    expect(cardOffsetFor('minimal', 'right')).toEqual({ x: 0, y: 0 })
    expect(cardOffsetFor('minimal', 'left')).toEqual({ x: win.width - card.width, y: 0 })
  })

  /**
   * Both directions grow downwards. That is what keeps the expand control's y
   * fixed when growing left, which is the whole point of offering that
   * direction — a control that moved vertically would still make the pointer
   * chase it.
   */
  it('never offsets vertically, in either direction', () => {
    for (const direction of EXPAND_DIRECTIONS) {
      expect(cardOffsetFor('minimal', direction).y).toBe(0)
    }
  })
})

describe('keepCardInPlace', () => {
  const at = (x: number, y: number) => ({ x, y })

  it('does not move a window whose card sits in the same place as before', () => {
    const origin = at(400, 300)
    expect(
      keepCardInPlace(origin, { size: 'minimal', direction: 'right' }, { size: 'minimal', direction: 'right' }),
    ).toEqual(origin)
  })

  /**
   * The regression this exists for: the card is what the user is looking at, and
   * flipping the direction otherwise slides it the full width of the growth room
   * for no reason anybody asked for.
   */
  it('shifts the window so the card stays put when the direction flips', () => {
    const { card } = WIDGET_LAYOUTS.minimal
    const room = windowSizeFor('minimal').width - card.width

    const toLeft = keepCardInPlace(
      at(400, 300),
      { size: 'minimal', direction: 'right' },
      { size: 'minimal', direction: 'left' },
    )
    expect(toLeft).toEqual(at(400 - room, 300))

    // And exactly back again — the two directions must not drift apart over
    // repeated switching.
    expect(
      keepCardInPlace(toLeft, { size: 'minimal', direction: 'left' }, { size: 'minimal', direction: 'right' }),
    ).toEqual(at(400, 300))
  })

  it('keeps the card in place when leaving minimal for a size that fills its window', () => {
    const room = windowSizeFor('minimal').width - WIDGET_LAYOUTS.minimal.card.width

    expect(
      keepCardInPlace(at(400, 300), { size: 'minimal', direction: 'left' }, { size: 'standard', direction: 'left' }),
    ).toEqual(at(400 + room, 300))
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

/**
 * The springs live in `styles.css` as `linear()` easings, and two facts about
 * them are load-bearing outside CSS: the window has to be big enough for the
 * outward peak, and the closing dip has to stay clear of the collapsed timer.
 * Neither is checkable by reading the stylesheet by eye, and both were wrong
 * once — so they are read back out of the file and asserted here.
 */
describe('the springs in styles.css', () => {
  const css = readFileSync(
    join(process.cwd(), 'src/renderer/src/styles.css'),
    'utf8',
  )

  function stops(name: string): number[] {
    const match = new RegExp(`--${name}:\\s*linear\\(([^)]*)\\)`).exec(css)
    if (!match?.[1]) throw new Error(`--${name} is not a linear() easing`)
    return match[1].split(',').map((value) => Number(value.trim()))
  }

  const OUT = stops('spring-out')
  const BACK = stops('spring-back')

  it.each([
    ['spring-out', OUT],
    ['spring-back', BACK],
  ])('%s starts at 0 and lands exactly on 1', (_name, curve) => {
    expect(curve[0]).toBe(0)
    expect(curve[curve.length - 1]).toBe(1)
  })

  /**
   * The regression this describe block exists for. A damped spring has not
   * settled when its duration ends, so writing `1` as the final stop on top of
   * an unscaled curve left the last frame covering 1.4 % of the distance in one
   * go — two pixels of width, snapping into place after the motion had visibly
   * stopped. Anything under about a quarter of a pixel is invisible; the widest
   * travel here is 144 px, so 0.3 % is the ceiling.
   */
  it.each([
    ['spring-out', OUT],
    ['spring-back', BACK],
  ])('%s does not jump on its final frame', (_name, curve) => {
    const last = curve[curve.length - 2]
    if (last === undefined) throw new Error('easing needs at least two stops')
    expect(1 - last).toBeLessThan(0.003)
  })

  /**
   * `OVERSHOOT` is what reserves the window's headroom. If the easing is ever
   * retuned to peak higher than the constant claims, the window clips the peak
   * and the spring is silently gone — the failure has nothing to see.
   */
  it('peaks no higher outward than the window reserves room for', () => {
    expect(Math.max(...OUT) - 1).toBeLessThanOrEqual(OVERSHOOT)
  })

  /** The closing dip must leave the collapsed timer's line box intact. */
  it('does not dip the collapsed card below its own timer on the way back', () => {
    const { card, expanded } = WIDGET_LAYOUTS.minimal
    if (expanded === null) throw new Error('minimal must expand')

    const overshoot = Math.max(...BACK) - 1
    const dip = card.height - (expanded.height - card.height) * overshoot
    const timerBottom = 10 + 22 * 1.04

    expect(dip).toBeGreaterThan(timerBottom)
  })
})
