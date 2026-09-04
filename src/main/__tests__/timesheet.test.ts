import { describe, expect, it, vi } from 'vitest'
import type { EditRequestRecord, ShiftRecord } from '../factorial/types'
import { blockFromRecord, createTimesheet, daysFromRecords, pendingFromRecord, type TimesheetOperations } from '../timesheet'

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
    expect(days[0]).toEqual({ date: '2026-09-03', blocks: [], expectedMinutes: null, requests: [] })
    expect(days[1]?.expectedMinutes).toBe(480)
    expect(days[1]?.blocks.map((b) => b.id)).toEqual(['1', '2'])
  })
})

function editRequest(over: Partial<EditRequestRecord>): EditRequestRecord {
  return {
    id: '9',
    approved: null,
    requestType: 'update_shift',
    date: '2026-09-04',
    shiftId: '1',
    clockIn: '13:12',
    clockOut: '18:08',
    workable: null,
    breakConfigurationId: null,
    ...over,
  }
}

describe('pendingFromRecord', () => {
  it('drops answered requests — approved ones are in the blocks, rejected ones are history', () => {
    expect(pendingFromRecord(editRequest({ approved: true }))).toBeNull()
    expect(pendingFromRecord(editRequest({ approved: false }))).toBeNull()
    expect(pendingFromRecord(editRequest({}))).toMatchObject({ id: '9', start: 792, end: 1088 })
  })

  it('keeps a delete request that carries no times', () => {
    expect(pendingFromRecord(editRequest({ requestType: 'delete_shift', clockIn: null, clockOut: null }))).toMatchObject({
      requestType: 'delete_shift',
      start: null,
      end: null,
    })
  })
})

describe('createTimesheet.saveDay', () => {
  function fakeOps(records: ShiftRecord[], requests: EditRequestRecord[] = []): TimesheetOperations & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      fetchShifts: vi.fn(async () => records),
      fetchExpectedMinutesByDay: vi.fn(async () => new Map()),
      fetchEditRequests: vi.fn(async () => requests),
      withdrawTimesheetEdit: vi.fn(async (input) => {
        calls.push(`withdraw ${input.id}`)
      }),
      requestTimesheetEdit: vi.fn(async (input) => {
        const times = input.clockIn === null ? '' : ` ${input.clockIn}-${input.clockOut}`
        calls.push(`${input.requestType} ${input.shiftId ?? 'new'}${times}`)
      }),
    }
  }

  it('requests only what moved, deletes first, and reports how many went out', async () => {
    const ops = fakeOps([record({ id: '1' }), record({ id: '2', clockIn: '2000-01-01T13:00:00+02:00', clockOut: '2000-01-01T17:00:00+02:00' })])
    const onSaved = vi.fn()
    const sheet = createTimesheet({ ops, employeeId: 1, defaultLocationType: () => 'work_from_home', onSaved })
    const result = await sheet.saveDay({
      date: '2026-09-04',
      blocks: [
        { id: '1', kind: 'work', start: 510, end: 735, breakConfigurationId: null, breakName: null, locationType: 'office' },
        { id: null, kind: 'work', start: 780, end: 1000, breakConfigurationId: null, breakName: null, locationType: null },
      ],
    })
    expect(ops.calls).toEqual(['delete_shift 2', 'create_shift new 13:00-16:40'])
    expect(ops.requestTimesheetEdit).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 1, locationType: 'work_from_home', date: '2026-09-04', workable: true }),
    )
    expect(result.requested).toBe(2)
    expect(onSaved).toHaveBeenCalledWith('2026-09-04')
  })

  it('returns the day Factorial still holds, not the edit that was requested', async () => {
    const ops = fakeOps([record({ id: '1' })])
    const sheet = createTimesheet({ ops, employeeId: 1, defaultLocationType: () => 'office' })
    const result = await sheet.saveDay({
      date: '2026-09-04',
      blocks: [{ id: '1', kind: 'work', start: 480, end: 735, breakConfigurationId: null, breakName: null, locationType: 'office' }],
    })
    // A request changes nothing until it is approved, so the unmoved 08:30 is
    // the honest answer — 08:00 is only what was asked for.
    expect(result.day.blocks.map((b) => b.start)).toEqual([510])
  })

  it('moves a block in place', async () => {
    const ops = fakeOps([record({ id: '1' })])
    const sheet = createTimesheet({ ops, employeeId: 1, defaultLocationType: () => 'office' })
    await sheet.saveDay({
      date: '2026-09-04',
      blocks: [{ id: '1', kind: 'work', start: 480, end: 735, breakConfigurationId: null, breakName: null, locationType: 'office' }],
    })
    expect(ops.calls).toEqual(['update_shift 1 08:00-12:15'])
  })

  it('lists only the pending requests of a day, with their times as minutes', async () => {
    const pending = editRequest({ id: '9', clockOut: '18:55' })
    const ops = fakeOps([record({ id: '1' })], [pending, editRequest({ id: '8', approved: true }), editRequest({ id: '7', approved: false })])
    const sheet = createTimesheet({ ops, employeeId: 1, defaultLocationType: () => 'office' })
    const month = await sheet.getMonth(2026, 9)
    const day = month.days.find((d) => d.date === '2026-09-04')
    expect(day?.requests).toEqual([
      { id: '9', requestType: 'update_shift', shiftId: '1', start: 792, end: 1135, workable: null, breakConfigurationId: null },
    ])
  })

  it('withdraws a request and answers with the day re-read', async () => {
    const ops = fakeOps([record({ id: '1' })], [editRequest({ id: '9' })])
    const sheet = createTimesheet({ ops, employeeId: 1, defaultLocationType: () => 'office' })
    const day = await sheet.withdraw('9', '2026-09-04')
    expect(ops.calls).toEqual(['withdraw 9'])
    expect(day.date).toBe('2026-09-04')
    expect(ops.fetchEditRequests).toHaveBeenCalledTimes(1)
  })

  it('refuses a date it cannot read', async () => {
    const sheet = createTimesheet({ ops: fakeOps([]), employeeId: 1, defaultLocationType: () => 'office' })
    await expect(sheet.saveDay({ date: 'yesterday', blocks: [] })).rejects.toThrow(/unparseable date/)
  })
})
