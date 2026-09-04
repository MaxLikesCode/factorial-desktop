import { describe, expect, it } from 'vitest'
import {
  breakMinutes,
  daysOfMonth,
  diffDay,
  formatHours,
  formatMinuteOfDay,
  hasChanges,
  normaliseBlocks,
  parseIsoDate,
  parseTimeOfDay,
  workedMinutes,
  type TimesheetBlock,
} from '../timesheet'

function work(id: string | null, start: number, end: number | null): TimesheetBlock {
  return { id, kind: 'work', start, end, breakConfigurationId: null, breakName: null, locationType: 'office' }
}
function rest(id: string | null, start: number, end: number | null): TimesheetBlock {
  return { id, kind: 'break', start, end, breakConfigurationId: '19613', breakName: 'Mittagspause', locationType: null }
}

describe('sums', () => {
  it('counts work and breaks separately, the running block up to now', () => {
    const blocks = [work('1', 510, 735), rest('2', 735, 765), work('3', 765, null)]
    expect(workedMinutes(blocks, 1012)).toBe(225 + 247)
    expect(breakMinutes(blocks, 1012)).toBe(30)
    // Without a "now" the running block is simply not counted.
    expect(workedMinutes(blocks)).toBe(225)
  })
})

describe('formatting and parsing', () => {
  it('formats minutes of the day and hours', () => {
    expect(formatMinuteOfDay(510)).toBe('08:30')
    expect(formatMinuteOfDay(1440)).toBe('24:00')
    expect(formatMinuteOfDay(-5)).toBe('00:00')
    expect(formatHours(472)).toBe('7:52 h')
  })

  it('reads what people type', () => {
    expect(parseTimeOfDay('8:30')).toBe(510)
    expect(parseTimeOfDay('08:30')).toBe(510)
    expect(parseTimeOfDay('830')).toBe(510)
    expect(parseTimeOfDay('8.30')).toBe(510)
    expect(parseTimeOfDay('8')).toBe(480)
    expect(parseTimeOfDay('24:00')).toBe(1440)
  })

  it('refuses what it cannot be sure about', () => {
    expect(parseTimeOfDay('')).toBeNull()
    expect(parseTimeOfDay('8:')).toBeNull()
    expect(parseTimeOfDay('25:00')).toBeNull()
    expect(parseTimeOfDay('8:60')).toBeNull()
    expect(parseTimeOfDay('24:01')).toBeNull()
  })

  it('handles dates', () => {
    expect(parseIsoDate('2026-09-04')).toEqual({ year: 2026, month: 9, day: 4 })
    expect(parseIsoDate('2026-13-04')).toBeNull()
    expect(daysOfMonth(2026, 2)).toHaveLength(28)
    expect(daysOfMonth(2028, 2)).toHaveLength(29)
    expect(daysOfMonth(2026, 9)[0]).toBe('2026-09-01')
  })
})

describe('normaliseBlocks', () => {
  it('sorts, clamps to neighbours and drops empty blocks', () => {
    const out = normaliseBlocks([work('2', 700, 800), work('1', 480, 720), work('3', 800, 800)])
    expect(out.map((b) => [b.id, b.start, b.end])).toEqual([
      ['1', 480, 720],
      ['2', 720, 800],
    ])
  })

  it('keeps a running block and clamps the ones after its start', () => {
    const out = normaliseBlocks([work('1', 480, null), work('2', 470, 500)])
    expect(out.map((b) => [b.id, b.start, b.end])).toEqual([
      ['2', 470, 500],
      ['1', 500, null],
    ])
  })
})

describe('diffDay', () => {
  const before = [work('1', 510, 735), rest('2', 735, 765), work('3', 765, 1012)]

  it('sees no change in an untouched day', () => {
    expect(hasChanges(diffDay(before, before))).toBe(false)
  })

  it('updates a moved block, creates a new one and deletes a removed one', () => {
    const after = [work('1', 500, 735), rest('2', 735, 765), work(null, 765, 1000)]
    const changes = diffDay(before, after)
    expect(changes.update.map((b) => b.id)).toEqual(['1'])
    expect(changes.create.map((b) => [b.start, b.end])).toEqual([[765, 1000]])
    expect(changes.delete).toEqual(['3'])
  })

  it('replaces a block whose kind changed, since update cannot flip workable', () => {
    const after = [work('1', 510, 735), work('2', 735, 765), work('3', 765, 1012)]
    const changes = diffDay(before, after)
    expect(changes.delete).toEqual(['2'])
    expect(changes.create.map((b) => b.kind)).toEqual(['work'])
    expect(changes.update).toEqual([])
  })

  it('leaves the running block alone', () => {
    const running = [work('1', 510, 735), work('9', 735, null)]
    const after = [work('1', 500, 735), work('9', 700, null)]
    const changes = diffDay(running, after)
    expect(changes.update.map((b) => b.id)).toEqual(['1'])
    expect(changes.delete).toEqual([])
  })
})
