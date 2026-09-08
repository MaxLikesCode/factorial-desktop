import { describe, expect, it } from 'vitest'
import type { TimesheetBlock } from '@shared/timesheet'
import { dragTo, grabPart, rangeOf, reachOf } from '@renderer/app/Timeline'

function block(start: number, end: number | null): TimesheetBlock {
  return { id: '1', kind: 'break', start, end, breakConfigurationId: '19613', breakName: 'Mittagspause', locationType: null, workplaceId: null }
}

const OPEN = { floor: 0, ceiling: 24 * 60 }

describe('dragTo', () => {
  it('snaps to the five-minute marks of the day, not to steps from the block', () => {
    // The real case: a break that began at 11:52, dragged longer. 12:57 under
    // the pointer is 12:55 on the strip.
    expect(dragTo(block(712, 772), 'end', 777.4, 5, OPEN)).toEqual({ start: 712, end: 775 })
    expect(dragTo(block(712, 772), 'start', 707.2, 5, OPEN)).toEqual({ start: 705, end: 772 })
  })

  it('snaps a moved block where it lands and keeps its length', () => {
    expect(dragTo(block(712, 772), 'body', 763.5, 5, OPEN)).toEqual({ start: 765, end: 825 })
  })

  it('drags by the minute with the fine step', () => {
    expect(dragTo(block(712, 772), 'end', 777.4, 1, OPEN)).toEqual({ start: 712, end: 777 })
    expect(dragTo(block(712, 772), 'body', 763.5, 1, OPEN)).toEqual({ start: 764, end: 824 })
  })

  it('stops at the neighbours and never shrinks a block to nothing', () => {
    expect(dragTo(block(712, 772), 'end', 900, 5, { floor: 0, ceiling: 800 })).toEqual({ start: 712, end: 800 })
    expect(dragTo(block(712, 772), 'end', 600, 5, OPEN)).toEqual({ start: 712, end: 717 })
    expect(dragTo(block(712, 772), 'start', 800, 5, OPEN)).toEqual({ start: 767, end: 772 })
    expect(dragTo(block(712, 772), 'body', 0, 5, { floor: 700, ceiling: 24 * 60 })).toEqual({ start: 700, end: 760 })
  })

  it('refuses to move the running record', () => {
    expect(dragTo(block(712, null), 'body', 800, 5, OPEN)).toBeNull()
  })
})

describe('grabPart', () => {
  it('takes hold of the end the press is nearest', () => {
    expect(grabPart(0, 120)).toBe('start')
    expect(grabPart(11, 120)).toBe('start')
    expect(grabPart(60, 120)).toBe('body')
    expect(grabPart(109, 120)).toBe('end')
    expect(grabPart(120, 120)).toBe('end')
  })

  it('splits a short block in three rather than letting its ends reach across', () => {
    // The five-minute block the user cannot grab: the right of it still
    // resizes to the right, which fixed-width grips got backwards.
    expect(grabPart(1, 12)).toBe('start')
    expect(grabPart(6, 12)).toBe('body')
    expect(grabPart(11, 12)).toBe('end')
  })
})

describe('reachOf', () => {
  // A fourteen-hour strip 840 px wide: one minute is one pixel.
  it('offers a grip of empty strip beside a block that has none of its own', () => {
    expect(reachOf(600, 1)).toBe(12)
  })

  it('never reaches further than the gap, so a neighbour keeps its own end', () => {
    expect(reachOf(7, 1)).toBe(7)
    expect(reachOf(0, 1)).toBe(0)
  })

  it('offers nothing where there is too little to aim at', () => {
    expect(reachOf(3, 1)).toBe(0)
  })
})

describe('rangeOf', () => {
  it('shows 06 to 20 on an ordinary day and widens for what falls outside', () => {
    expect(rangeOf([], null)).toEqual([6 * 60, 20 * 60])
    expect(rangeOf([block(240, 300)], null)).toEqual([3 * 60, 20 * 60])
  })
})
