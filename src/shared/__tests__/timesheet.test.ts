import { describe, expect, it } from 'vitest'
import {
  applyRequests,
  breakMinutes,
  daysOfMonth,
  diffDay,
  formatHours,
  formatMinuteOfDay,
  hasChanges,
  normaliseBlocks,
  parseIsoDate,
  parseTimeOfDay,
  setBlockTime,
  workedMinutes,
  type PendingRequest,
  type TimesheetBlock,
} from '../timesheet'

function work(id: string | null, start: number, end: number | null): TimesheetBlock {
  return { id, kind: 'work', start, end, breakConfigurationId: null, breakName: null, locationType: 'office', workplaceId: null }
}
function rest(id: string | null, start: number, end: number | null): TimesheetBlock {
  return { id, kind: 'break', start, end, breakConfigurationId: '19613', breakName: 'Mittagspause', locationType: null, workplaceId: null }
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

describe('normaliseBlocks pushes rather than drops', () => {
  it('moves a block off the neighbour it was typed into instead of losing it', () => {
    // 9:00 work typed to start at 12:30, in a day whose break runs to 13:00.
    const out = normaliseBlocks([rest('1', 720, 780), work('2', 750, 755)])
    expect(out.map((b) => [b.id, b.start, b.end])).toEqual([
      ['1', 720, 780],
      ['2', 780, 785],
    ])
  })

  it('leaves a record shorter than the grid at the length Factorial holds', () => {
    expect(normaliseBlocks([rest('1', 700, 702)]).map((b) => [b.start, b.end])).toEqual([[700, 702]])
  })
})

describe('setBlockTime', () => {
  it('takes the end along when the start is typed past it', () => {
    expect(setBlockTime(work('1', 540, 600), 'start', 660)).toMatchObject({ start: 660, end: 665 })
  })

  it('takes the start along when the end is typed before it', () => {
    expect(setBlockTime(work('1', 540, 600), 'end', 480)).toMatchObject({ start: 475, end: 480 })
  })

  it('leaves the other end alone when the times still make sense', () => {
    expect(setBlockTime(work('1', 540, 600), 'start', 570)).toMatchObject({ start: 570, end: 600 })
    expect(setBlockTime(work('1', 540, 600), 'end', 630)).toMatchObject({ start: 540, end: 630 })
  })

  it('keeps a running block running', () => {
    expect(setBlockTime(work('1', 540, null), 'start', 660)).toMatchObject({ start: 660, end: null })
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

  it('updates a work block whose location changed, times untouched', () => {
    const after = [{ ...work('1', 510, 735), locationType: 'work_from_home' }, rest('2', 735, 765), work('3', 765, 1012)]
    const changes = diffDay(before, after)
    expect(changes.update.map((b) => b.id)).toEqual(['1'])
    expect(changes.create).toEqual([])
    expect(changes.delete).toEqual([])
  })

  it('leaves the running block alone', () => {
    const running = [work('1', 510, 735), work('9', 735, null)]
    const after = [work('1', 500, 735), work('9', 700, null)]
    const changes = diffDay(running, after)
    expect(changes.update.map((b) => b.id)).toEqual(['1'])
    expect(changes.delete).toEqual([])
  })
})

describe('applyRequests', () => {
  const blocks = [work('1', 510, 735), rest('2', 735, 765), work('3', 765, 1100)]
  const pending = (over: Partial<PendingRequest>): PendingRequest => ({
    id: 'r',
    requestType: 'update_shift',
    shiftId: '3',
    start: 765,
    end: 1012,
    workable: null,
    breakConfigurationId: null,
    locationType: null,
    ...over,
  })

  it('shortens a record the way the request asks, and sums accordingly', () => {
    const after = applyRequests(blocks, [pending({})])
    expect(after.find((b) => b.id === '3')).toMatchObject({ start: 765, end: 1012, locationType: 'office' })
    expect(workedMinutes(after)).toBe(225 + 247)
  })

  it('drops a deleted record and adds a requested one, as its kind', () => {
    const after = applyRequests(blocks, [
      pending({ id: 'd', requestType: 'delete_shift', shiftId: '2', start: null, end: null }),
      pending({ id: 'c', requestType: 'create_shift', shiftId: null, start: 1100, end: 1130, workable: false, breakConfigurationId: '19613' }),
    ])
    expect(after.map((b) => [b.id, b.kind])).toEqual([['1', 'work'], ['3', 'work'], [null, 'break']])
  })

  it('changes nothing without requests', () => {
    expect(applyRequests(blocks, [])).toEqual(blocks)
  })
})
