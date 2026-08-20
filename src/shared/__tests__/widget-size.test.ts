import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CARD,
  EXPAND_DIRECTIONS,
  OVERSHOOT,
  cardOffsetFor,
  isExpandDirection,
  keepCardInPlace,
  windowSize,
} from '@shared/widget-size'

describe('the two states', () => {
  /**
   * The point of the collapsed state: it is what is on screen all day, so it has
   * to be small enough that having it there costs nothing.
   */
  it('makes the collapsed card a small fraction of the expanded one', () => {
    const collapsed = CARD.collapsed.width * CARD.collapsed.height
    const expanded = CARD.expanded.width * CARD.expanded.height
    expect(collapsed).toBeLessThan(expanded * 0.2)
  })

  it('grows in both directions, so the card never only stretches', () => {
    expect(CARD.expanded.width).toBeGreaterThan(CARD.collapsed.width)
    expect(CARD.expanded.height).toBeGreaterThan(CARD.collapsed.height)
  })
})

describe('isExpandDirection', () => {
  it('accepts exactly the two directions', () => {
    for (const direction of EXPAND_DIRECTIONS) expect(isExpandDirection(direction)).toBe(true)
    for (const value of ['Right', 'up', 'down', '']) expect(isExpandDirection(value)).toBe(false)
  })
})

describe('windowSize', () => {
  /**
   * The regression this module exists for. The opening spring overshoots, and a
   * window sized to the *settled* card clips the peak — the spring is then
   * silently gone, with nothing to see but a slightly abrupt stop.
   */
  it('leaves room for the opening spring to overshoot', () => {
    const win = windowSize()
    const peakWidth =
      CARD.collapsed.width + (CARD.expanded.width - CARD.collapsed.width) * (1 + OVERSHOOT)
    const peakHeight =
      CARD.collapsed.height + (CARD.expanded.height - CARD.collapsed.height) * (1 + OVERSHOOT)

    expect(win.width).toBeGreaterThanOrEqual(peakWidth)
    expect(win.height).toBeGreaterThanOrEqual(peakHeight)
    // And genuinely larger than the settled card, or the test above would pass
    // for the wrong reason.
    expect(win.width).toBeGreaterThan(CARD.expanded.width)
    expect(win.height).toBeGreaterThan(CARD.expanded.height)
  })

  it('rounds up, never down — a rounded-down window clips the peak', () => {
    const win = windowSize()
    expect(Number.isInteger(win.width)).toBe(true)
    expect(Number.isInteger(win.height)).toBe(true)
  })

  it('hands out a copy, so a caller cannot resize the card', () => {
    const win = windowSize()
    win.width = 9999
    expect(CARD.expanded.width).toBe(300)
  })
})

describe('cardOffsetFor', () => {
  /**
   * The card sits against the edge it does NOT grow into, so the transparent
   * remainder is exactly the room the expansion needs.
   */
  it('pins the card against the edge it does not grow into', () => {
    expect(cardOffsetFor('right')).toEqual({ x: 0, y: 0 })
    expect(cardOffsetFor('left')).toEqual({
      x: windowSize().width - CARD.collapsed.width,
      y: 0,
    })
  })

  /**
   * Both directions grow downwards. That is what keeps the expand control's y
   * fixed when growing left, which is the whole point of offering it — a control
   * that moved vertically would still make the pointer chase it.
   */
  it('never offsets vertically, in either direction', () => {
    for (const direction of EXPAND_DIRECTIONS) {
      expect(cardOffsetFor(direction).y).toBe(0)
    }
  })
})

describe('keepCardInPlace', () => {
  const at = (x: number, y: number) => ({ x, y })

  it('does not move a window whose direction did not change', () => {
    expect(keepCardInPlace(at(400, 300), 'right', 'right')).toEqual(at(400, 300))
  })

  /**
   * The card is what the user is looking at, and flipping the direction
   * otherwise slides it the full width of the growth room for no reason anybody
   * asked for.
   */
  it('shifts the window so the card stays put when the direction flips', () => {
    const room = windowSize().width - CARD.collapsed.width

    const toLeft = keepCardInPlace(at(400, 300), 'right', 'left')
    expect(toLeft).toEqual(at(400 - room, 300))

    // And exactly back again — the two directions must not drift apart over
    // repeated switching.
    expect(keepCardInPlace(toLeft, 'left', 'right')).toEqual(at(400, 300))
  })
})

/**
 * The springs live in `styles.css` as `linear()` easings, and two facts about
 * them are load-bearing outside CSS: the window has to be big enough for the
 * outward peak, and the closing dip has to stay clear of the collapsed timer.
 * Neither is checkable by eye, and both were wrong once.
 */
describe('the springs in styles.css', () => {
  const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

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
   * A damped spring has not settled when its duration ends, so writing `1` as
   * the final stop on top of an unscaled curve left the last frame covering
   * 1.4 % of the distance in one go — two pixels, snapping into place after the
   * motion had visibly stopped.
   */
  it.each([
    ['spring-out', OUT],
    ['spring-back', BACK],
  ])('%s does not jump on its final frame', (_name, curve) => {
    const last = curve[curve.length - 2]
    if (last === undefined) throw new Error('easing needs at least two stops')
    expect(1 - last).toBeLessThan(0.003)
  })

  it('peaks no higher outward than the window reserves room for', () => {
    expect(Math.max(...OUT) - 1).toBeLessThanOrEqual(OVERSHOOT)
  })

  /** The closing dip must leave the collapsed timer's line box intact. */
  it('does not dip the collapsed card below its own timer on the way back', () => {
    const overshoot = Math.max(...BACK) - 1
    const travel = CARD.expanded.height - CARD.collapsed.height
    const dip = CARD.collapsed.height - travel * overshoot
    /** The 22 px timer at line-height 1.04, sitting 10 px below the card's top. */
    const timerBottom = 10 + 22 * 1.04

    expect(dip).toBeGreaterThan(timerBottom)
  })
})
