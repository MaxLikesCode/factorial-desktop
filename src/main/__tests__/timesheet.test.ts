import { describe, expect, it, vi } from 'vitest'
import type { ShiftRecord } from '../factorial/types'
import { blockFromRecord, createTimesheet, daysFromRecords, type TimesheetOperations } from '../timesheet'

function record(over: Partial<ShiftRecord>): ShiftRecord {
  return {
    id: '1',
    date: '2026-09-04',
    minutes: 225,
    workable: true,
    breakConfiguration: null,
    clockIn: '2000-01-01T08:30:00+02:00',
    clockOut: '2000-01-01T12:15:00+02:00',
    clockInWithSeconds: null,
    clockInOffset: '+02:00',
    clockOutOffset: '+02:00',
    locationType: 'office',
    workplaceId: null,
    ...over,
  }
}

describe('blockFromRecord', () => {
  it('turns a record into minutes of its day, in the local zone', () => {
    // TZ is pinned to Europe/Berlin by vitest.config.ts, so +02:00 is local time.
    expect(blockFromRecord(record({}))).toMatchObject({ id: '1', kind: 'work', start: 510, end: 735 })
  })

  it('reads a break from either signal and keeps its type', () => {
    const b = blockFromRecord(record({ workable: false, breakConfiguration: { id: '19613', name: 'Mittag' } }))
    expect(b).toMatchObject({ kind: 'break', breakConfigurationId: '19613', breakName: 'Mittag' })
    expect(blockFromRecord(record({ workable: null, breakConfiguration: { id: '1', name: null } }))?.kind).toBe('break')
  })

  it('leaves the running record open and cuts a record at midnight', () => {
    expect(blockFromRecord(record({ clockOut: null, clockOutOffset: null }))?.end).toBeNull()
    expect(blockFromRecord(record({ clockIn: '2000-01-01T22:00:00+02:00', clockOut: '2000-01-02T02:00:00+02:00' }))).toMatchObject({
      start: 1320,
      end: 1440,
    })
  })

  it('drops a record it cannot place', () => {
    expect(blockFromRecord(record({ clockIn: null }))).toBeNull()
    expect(blockFromRecord(record({ clockIn: 'garbage' }))).toBeNull()
  })
})

describe('daysFromRecords', () => {
  it('files records under their day, in order, with the target', () => {
    const days = daysFromRecords(
      ['2026-09-03', '2026-09-04'],
      [record({ id: '2', clockIn: '2000-01-01T13:00:00+02:00', clockOut: '2000-01-01T17:00:00+02:00' }), record({ id: '1' })],
      new Map([['2026-09-04', 480]]),
    )
    expect(days[0]).toEqual({ date: '2026-09-03', blocks: [], expectedMinutes: null })
    expect(days[1]?.expectedMinutes).toBe(480)
    expect(days[1]?.blocks.map((b) => b.id)).toEqual(['1', '2'])
  })
})

describe('createTimesheet.saveDay', () => {
  function fakeOps(records: ShiftRecord[]): TimesheetOperations & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      fetchShifts: vi.fn(async () => records),
      fetchExpectedMinutesByDay: vi.fn(async () => new Map()),
      createShift: vi.fn(async (input) => {
        calls.push(`create ${input.workable ? 'work' : 'break'} ${input.clockIn.getHours()}:${input.clockIn.getMinutes()}-${input.clockOut.getHours()}:${input.clockOut.getMinutes()}`)
      }),
      updateShift: vi.fn(async (input) => {
        calls.push(`update ${input.id} ${input.clockIn.getHours()}:${input.clockIn.getMinutes()}-${input.clockOut.getHours()}:${input.clockOut.getMinutes()}`)
      }),
      deleteShift: vi.fn(async (input) => {
        calls.push(`delete ${input.id}`)
      }),
    }
  }

  it('writes only what moved, deletes first, and reports the saved day', async () => {
    const ops = fakeOps([record({ id: '1' }), record({ id: '2', clockIn: '2000-01-01T13:00:00+02:00', clockOut: '2000-01-01T17:00:00+02:00' })])
    const onSaved = vi.fn()
    const sheet = createTimesheet({ ops, employeeId: 1, defaultLocationType: () => 'work_from_home', onSaved })
    await sheet.saveDay({
      date: '2026-09-04',
      blocks: [
        { id: '1', kind: 'work', start: 510, end: 735, breakConfigurationId: null, breakName: null, locationType: 'office' },
        { id: null, kind: 'work', start: 780, end: 1000, breakConfigurationId: null, breakName: null, locationType: null },
      ],
    })
    expect(ops.calls).toEqual(['delete 2', 'create work 13:0-16:40'])
    expect(ops.createShift).toHaveBeenCalledWith(expect.objectContaining({ locationType: 'work_from_home', date: '2026-09-04' }))
    expect(onSaved).toHaveBeenCalledWith('2026-09-04')
  })

  it('moves a block in place', async () => {
    const ops = fakeOps([record({ id: '1' })])
    const sheet = createTimesheet({ ops, employeeId: 1, defaultLocationType: () => 'office' })
    await sheet.saveDay({
      date: '2026-09-04',
      blocks: [{ id: '1', kind: 'work', start: 480, end: 735, breakConfigurationId: null, breakName: null, locationType: 'office' }],
    })
    expect(ops.calls).toEqual(['update 1 8:0-12:15'])
  })

  it('refuses a date it cannot read', async () => {
    const sheet = createTimesheet({ ops: fakeOps([]), employeeId: 1, defaultLocationType: () => 'office' })
    await expect(sheet.saveDay({ date: 'yesterday', blocks: [] })).rejects.toThrow(/unparseable date/)
  })
})
