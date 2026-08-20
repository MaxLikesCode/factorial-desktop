import { describe, expect, it } from 'vitest'
import {
  BOTTOM_CLEARANCE,
  CARD,
  DAY_BAR_HEIGHT,
  EXPANDED_ROWS,
  EXPAND_DIRECTIONS,
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

describe('the expanded card’s rows', () => {
  const rows = Object.entries(EXPANDED_ROWS).map(([name, row]) => ({ name, ...row }))
  const bottomOf = (row: { top: number; height: number }) => row.top + row.height

  /**
   * The bug this block exists for. The footer sat 3 px above the day's bar and
   * read as resting on it — because the work-location select is 24 px tall, not
   * the 16 of a line of text, so the row ends 8 px lower than it looks in the
   * source. Nothing was doing this arithmetic.
   */
  it('leaves the day’s bar room to breathe under the lowest row', () => {
    const lowest = Math.max(...rows.map(bottomOf))
    const barTop = CARD.expanded.height - DAY_BAR_HEIGHT

    expect(barTop - lowest).toBeGreaterThanOrEqual(BOTTOM_CLEARANCE)
  })

  it('keeps every row inside the card', () => {
    for (const row of rows) {
      expect(row.top).toBeGreaterThanOrEqual(0)
      expect(bottomOf(row)).toBeLessThanOrEqual(CARD.expanded.height - DAY_BAR_HEIGHT)
    }
  })

  /**
   * The hint deliberately sits in the gap between the timer and the buttons —
   * that is what makes it free. It must fit there rather than land on either.
   */
  it('fits the advisory line into the gap it was promised', () => {
    const { timer, hint, actions } = EXPANDED_ROWS
    expect(hint.top).toBeGreaterThanOrEqual(bottomOf(timer))
    expect(bottomOf(hint)).toBeLessThanOrEqual(actions.top)
  })

  it('does not let any two rows overlap', () => {
    const ordered = [...rows].sort((a, b) => a.top - b.top)
    for (let i = 1; i < ordered.length; i++) {
      const above = ordered[i - 1]
      const below = ordered[i]
      if (above === undefined || below === undefined) throw new Error('rows expected')
      expect(below.top).toBeGreaterThanOrEqual(bottomOf(above))
    }
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
   * The day's bar sits at the card's very bottom edge, so a window sized to the
   * card exactly loses it to sub-pixel rounding mid-animation — which is how it
   * disappeared once already, back when the window reserved an overshoot to the
   * pixel and got nothing to spare for it.
   */
  it('is larger than the card it holds, by more than rounding', () => {
    const win = windowSize()
    expect(win.width - CARD.expanded.width).toBeGreaterThan(1)
    expect(win.height - CARD.expanded.height).toBeGreaterThan(1)
  })

  it('is whole pixels', () => {
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
