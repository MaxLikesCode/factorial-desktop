import { describe, expect, it, vi } from 'vitest'
import type { EditRequestRecord, ShiftRecord } from '../factorial/types'
import type { HeldEntry, HeldStore } from '../held-changes'
import { blockFromRecord, createTimesheet, daysFromRecords, pendingFromRecord, type TimesheetOperations } from '../timesheet'

function memoryHeld(): HeldStore & { entries: HeldEntry[] } {
  let next = 1
  const store = {
    entries: [] as HeldEntry[],
    list: (employeeId: number) => store.entries.filter((entry) => entry.employeeId === employeeId),
    add(employeeId: number, date: string, block: HeldEntry['block']) {
      const entry = { id: `held-${next++}`, employeeId, date, block }
      store.entries = [...store.entries, entry]
      return entry
    },
    remove(ids: readonly string[]) {
      store.entries = store.entries.filter((entry) => !ids.includes(entry.id))
    },
  }
  return store
}

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
    expect(days[0]).toEqual({ date: '2026-09-03', blocks: [], expectedMinutes: null, requests: [], held: [] })
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
    locationType: null,
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

  it('requests only what moved, deletes first, and reports how many went out and how many stayed', async () => {
    const ops = fakeOps([record({ id: '1' }), record({ id: '2', clockIn: '2000-01-01T13:00:00+02:00', clockOut: '2000-01-01T17:00:00+02:00' })])
    const onSaved = vi.fn()
    const sheet = createTimesheet({ held: memoryHeld(), ops, employeeId: 1, defaultLocationType: () => 'work_from_home', onSaved })
    const result = await sheet.saveDay({
      date: '2026-09-04',
      blocks: [
        { id: '1', kind: 'work', start: 510, end: 735, breakConfigurationId: null, breakName: null, locationType: 'office', workplaceId: null },
        { id: null, kind: 'work', start: 780, end: 1000, breakConfigurationId: null, breakName: null, locationType: null, workplaceId: null },
      ],
    })
    // The replacement overlaps the record until the delete is approved.
    expect(ops.calls).toEqual(['delete_shift 2'])
    expect(result.requested).toBe(1)
    expect(result.held).toBe(1)
    expect(onSaved).toHaveBeenCalledWith('2026-09-04')
  })

  it('returns the day Factorial still holds, not the edit that was requested', async () => {
    const ops = fakeOps([record({ id: '1' })])
    const sheet = createTimesheet({ held: memoryHeld(), ops, employeeId: 1, defaultLocationType: () => 'office' })
    const result = await sheet.saveDay({
      date: '2026-09-04',
      blocks: [{ id: '1', kind: 'work', start: 480, end: 735, breakConfigurationId: null, breakName: null, locationType: 'office', workplaceId: null }],
    })
    // A request changes nothing until it is approved, so the unmoved 08:30 is
    // the honest answer — 08:00 is only what was asked for.
    expect(result.day.blocks.map((b) => b.start)).toEqual([510])
  })

  it('moves a block in place', async () => {
    const ops = fakeOps([record({ id: '1' })])
    const sheet = createTimesheet({ held: memoryHeld(), ops, employeeId: 1, defaultLocationType: () => 'office' })
    await sheet.saveDay({
      date: '2026-09-04',
      blocks: [{ id: '1', kind: 'work', start: 480, end: 735, breakConfigurationId: null, breakName: null, locationType: 'office', workplaceId: null }],
    })
    expect(ops.calls).toEqual(['update_shift 1 08:00-12:15'])
    // The location did not move, so it is not sent along.
    expect(ops.requestTimesheetEdit).toHaveBeenCalledWith(expect.objectContaining({ locationType: null }))
  })

  it('sends the new location with an update when that is what changed', async () => {
    const ops = fakeOps([record({ id: '1' })])
    const sheet = createTimesheet({ held: memoryHeld(), ops, employeeId: 1, defaultLocationType: () => 'office' })
    await sheet.saveDay({
      date: '2026-09-04',
      blocks: [{ id: '1', kind: 'work', start: 510, end: 735, breakConfigurationId: null, breakName: null, locationType: 'work_from_home', workplaceId: null }],
    })
    expect(ops.calls).toEqual(['update_shift 1 08:30-12:15'])
    expect(ops.requestTimesheetEdit).toHaveBeenCalledWith(
      expect.objectContaining({ requestType: 'update_shift', shiftId: '1', locationType: 'work_from_home' }),
    )
  })

  it('keeps the workplace on a change of place, so approval does not drop it', async () => {
    const ops = fakeOps([record({ id: '1', workplaceId: 3333333 })])
    const sheet = createTimesheet({ held: memoryHeld(), ops, employeeId: 1, defaultLocationType: () => 'office' })
    await sheet.saveDay({
      date: '2026-09-04',
      blocks: [{ id: '1', kind: 'work', start: 510, end: 735, breakConfigurationId: null, breakName: null, locationType: 'work_from_home', workplaceId: 3333333 }],
    })
    expect(ops.requestTimesheetEdit).toHaveBeenCalledWith(expect.objectContaining({ locationType: 'work_from_home', workplaceId: 3333333 }))
  })

  it('books a new work block at the widget\'s last workplace when the editor names none', async () => {
    const ops = fakeOps([])
    const sheet = createTimesheet({ held: memoryHeld(), ops, employeeId: 1, defaultLocationType: () => 'office', defaultWorkplaceId: () => 4444 })
    await sheet.saveDay({
      date: '2026-09-04',
      blocks: [{ id: null, kind: 'work', start: 510, end: 735, breakConfigurationId: null, breakName: null, locationType: null, workplaceId: null }],
    })
    expect(ops.requestTimesheetEdit).toHaveBeenCalledWith(expect.objectContaining({ requestType: 'create_shift', workplaceId: 4444 }))
  })

  it('lists only the pending requests of a day, with their times as minutes', async () => {
    const pending = editRequest({ id: '9', clockOut: '18:55' })
    const ops = fakeOps([record({ id: '1' })], [pending, editRequest({ id: '8', approved: true }), editRequest({ id: '7', approved: false })])
    const sheet = createTimesheet({ held: memoryHeld(), ops, employeeId: 1, defaultLocationType: () => 'office' })
    const month = await sheet.getMonth(2026, 9)
    const day = month.days.find((d) => d.date === '2026-09-04')
    expect(day?.requests).toEqual([
      { id: '9', requestType: 'update_shift', shiftId: '1', start: 792, end: 1135, workable: null, breakConfigurationId: null, locationType: null },
    ])
  })

  it('withdraws a request and answers with the day re-read', async () => {
    const ops = fakeOps([record({ id: '1' })], [editRequest({ id: '9' })])
    const sheet = createTimesheet({ held: memoryHeld(), ops, employeeId: 1, defaultLocationType: () => 'office' })
    const day = await sheet.withdraw('9', '2026-09-04')
    expect(ops.calls).toEqual(['withdraw 9'])
    expect(day.date).toBe('2026-09-04')
    expect(ops.fetchEditRequests).toHaveBeenCalledTimes(1)
  })

  it('books a held new work block with the default place once it goes out', async () => {
    const records = [record({ id: '2', clockIn: '2000-01-01T13:00:00+02:00', clockOut: '2000-01-01T17:00:00+02:00' })]
    const ops = fakeOps(records)
    const sheet = createTimesheet({ held: memoryHeld(), ops, employeeId: 1, defaultLocationType: () => 'work_from_home' })
    await sheet.saveDay({
      date: '2026-09-04',
      blocks: [{ id: null, kind: 'work', start: 780, end: 1000, breakConfigurationId: null, breakName: null, locationType: null, workplaceId: null }],
    })
    records.length = 0
    await sheet.releaseHeld()
    expect(ops.requestTimesheetEdit).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestType: 'create_shift', employeeId: 1, locationType: 'work_from_home', date: '2026-09-04', workable: true }),
    )
  })

  it('refuses a date it cannot read', async () => {
    const sheet = createTimesheet({ held: memoryHeld(), ops: fakeOps([]), employeeId: 1, defaultLocationType: () => 'office' })
    await expect(sheet.saveDay({ date: 'yesterday', blocks: [] })).rejects.toThrow(/unparseable date/)
  })
})

/**
 * The real 4 November 2026: a break that ran on until 18:01 because nobody ended
 * it, and the afternoon's work behind it. Both have to move, and Factorial
 * refuses the second request while the first is only pending.
 */
describe('a change that has to wait for another', () => {
  const DATE = '2026-11-04'
  const breakRecord = (): ShiftRecord =>
    record({
      id: '10',
      date: DATE,
      workable: false,
      breakConfiguration: { id: '19613', name: 'Mittagspause' },
      clockIn: '2000-01-01T12:44:00+01:00',
      clockOut: '2000-01-01T18:01:00+01:00',
      clockInOffset: '+01:00',
      clockOutOffset: '+01:00',
    })
  const workRecord = (): ShiftRecord =>
    record({ id: '11', date: DATE, clockIn: '2000-01-01T18:01:00+01:00', clockOut: '2000-01-01T19:05:00+01:00', clockInOffset: '+01:00', clockOutOffset: '+01:00' })

  const edit = {
    date: DATE,
    blocks: [
      { id: '10', kind: 'break' as const, start: 764, end: 825, breakConfigurationId: '19613', breakName: 'Mittagspause', locationType: 'office', workplaceId: null },
      { id: '11', kind: 'work' as const, start: 825, end: 1145, breakConfigurationId: null, breakName: null, locationType: 'office', workplaceId: null },
    ],
  }

  /** Answers like Factorial: pending requests change nothing, recorded overlaps are refused. */
  function factorial() {
    const records = [breakRecord(), workRecord()]
    const requests: EditRequestRecord[] = []
    const calls: string[] = []
    const ops: TimesheetOperations = {
      fetchShifts: vi.fn(async () => records),
      fetchExpectedMinutesByDay: vi.fn(async () => new Map()),
      fetchEditRequests: vi.fn(async () => requests),
      withdrawTimesheetEdit: vi.fn(async ({ id }) => {
        requests.splice(requests.findIndex((r) => r.id === id), 1)
      }),
      requestTimesheetEdit: vi.fn(async (input) => {
        const start = Number(input.clockIn?.slice(0, 2)) * 60 + Number(input.clockIn?.slice(3))
        const end = Number(input.clockOut?.slice(0, 2)) * 60 + Number(input.clockOut?.slice(3))
        for (const other of records) {
          const block = blockFromRecord(other)
          if (block === null || block.id === input.shiftId || block.end === null) continue
          if (block.start < end && start < block.end) throw new Error('Überschneidet sich mit der Schicht')
        }
        calls.push(`${input.requestType} ${input.shiftId} ${input.clockIn}-${input.clockOut}`)
        requests.push(
          editRequest({ id: String(100 + requests.length), date: DATE, requestType: input.requestType, shiftId: input.shiftId, clockIn: input.clockIn, clockOut: input.clockOut }),
        )
      }),
    }
    return { records, requests, calls, ops }
  }

  function approveBreak(server: ReturnType<typeof factorial>): void {
    server.records[0] = { ...breakRecord(), clockOut: '2000-01-01T13:45:00+01:00' }
    server.requests[0] = { ...server.requests[0]!, approved: true }
  }

  it('sends what Factorial accepts and holds the rest, instead of failing halfway', async () => {
    const server = factorial()
    const held = memoryHeld()
    const sheet = createTimesheet({ held, ops: server.ops, employeeId: 1, defaultLocationType: () => 'office' })

    const result = await sheet.saveDay(edit)

    expect(server.calls).toEqual(['update_shift 10 12:44-13:45'])
    expect(result.requested).toBe(1)
    expect(result.held).toBe(1)
    expect(result.day.held).toEqual([{ id: 'held-1', block: edit.blocks[1], waiting: true }])
    // The day itself is untouched: neither change is in the timesheet yet.
    expect(result.day.blocks.map((b) => [b.start, b.end])).toEqual([[764, 1081], [1081, 1145]])
  })

  it('does not send the held change while the first is only pending', async () => {
    const server = factorial()
    const held = memoryHeld()
    const onReleased = vi.fn()
    const sheet = createTimesheet({ held, ops: server.ops, employeeId: 1, defaultLocationType: () => 'office', onReleased })
    await sheet.saveDay(edit)

    await sheet.releaseHeld()

    expect(server.calls).toHaveLength(1)
    expect(held.entries).toHaveLength(1)
    expect(onReleased).not.toHaveBeenCalled()
  })

  it('sends the held change once the first is approved, and says so', async () => {
    const server = factorial()
    const held = memoryHeld()
    const onReleased = vi.fn()
    const sheet = createTimesheet({ held, ops: server.ops, employeeId: 1, defaultLocationType: () => 'office', onReleased })
    await sheet.saveDay(edit)

    approveBreak(server)
    await sheet.releaseHeld()

    expect(server.calls).toEqual(['update_shift 10 12:44-13:45', 'update_shift 11 13:45-19:05'])
    expect(held.entries).toEqual([])
    expect(onReleased).toHaveBeenCalledWith(DATE, 1)
  })

  it('notices the approval when the month is opened', async () => {
    const server = factorial()
    const sheet = createTimesheet({ held: memoryHeld(), ops: server.ops, employeeId: 1, defaultLocationType: () => 'office' })
    await sheet.saveDay(edit)
    approveBreak(server)

    const month = await sheet.getMonth(2026, 11)

    const day = month.days.find((d) => d.date === DATE)
    expect(day?.held).toEqual([])
    expect(day?.requests.map((r) => r.shiftId)).toEqual(['11'])
  })

  it('files no duplicate when the same edit is saved again', async () => {
    const server = factorial()
    const held = memoryHeld()
    const sheet = createTimesheet({ held, ops: server.ops, employeeId: 1, defaultLocationType: () => 'office' })
    await sheet.saveDay(edit)

    const again = await sheet.saveDay(edit)

    expect(server.calls).toEqual(['update_shift 10 12:44-13:45'])
    expect(again.requested).toBe(0)
    expect(held.entries).toHaveLength(1)
  })

  it('picks up the state the old version left behind: first request pending, second never sent', async () => {
    const server = factorial()
    server.requests.push(editRequest({ id: '100', date: DATE, shiftId: '10', clockIn: '12:44', clockOut: '13:45' }))
    const sheet = createTimesheet({ held: memoryHeld(), ops: server.ops, employeeId: 1, defaultLocationType: () => 'office' })

    const result = await sheet.saveDay(edit)

    expect(server.calls).toEqual([])
    expect(result.requested).toBe(0)
    expect(result.held).toBe(1)
  })

  it('stops waiting when the request it waited on is withdrawn, but keeps the change', async () => {
    const server = factorial()
    const held = memoryHeld()
    const sheet = createTimesheet({ held, ops: server.ops, employeeId: 1, defaultLocationType: () => 'office' })
    await sheet.saveDay(edit)

    const day = await sheet.withdraw('100', DATE)

    expect(day.held).toEqual([{ id: 'held-1', block: edit.blocks[1], waiting: false }])
    await sheet.releaseHeld()
    expect(server.calls).toHaveLength(1)
  })

  it('stops waiting when the request it waited on is rejected', async () => {
    const server = factorial()
    const sheet = createTimesheet({ held: memoryHeld(), ops: server.ops, employeeId: 1, defaultLocationType: () => 'office' })
    await sheet.saveDay(edit)
    server.requests[0] = { ...server.requests[0]!, approved: false }

    const month = await sheet.getMonth(2026, 11)

    expect(month.days.find((d) => d.date === DATE)?.held[0]?.waiting).toBe(false)
    expect(server.calls).toHaveLength(1)
  })

  it('forgets a discarded change without telling Factorial anything', async () => {
    const server = factorial()
    const held = memoryHeld()
    const sheet = createTimesheet({ held, ops: server.ops, employeeId: 1, defaultLocationType: () => 'office' })
    await sheet.saveDay(edit)

    const day = await sheet.discardHeld('held-1', DATE)

    expect(day.held).toEqual([])
    expect(server.calls).toHaveLength(1)
    approveBreak(server)
    await sheet.releaseHeld()
    expect(server.calls).toHaveLength(1)
  })

  it('lets a newer edit of the record replace what was held for it', async () => {
    const server = factorial()
    const held = memoryHeld()
    const sheet = createTimesheet({ held, ops: server.ops, employeeId: 1, defaultLocationType: () => 'office' })
    await sheet.saveDay(edit)

    await sheet.saveDay({ ...edit, blocks: [edit.blocks[0]!, { ...edit.blocks[1]!, start: 840 }] })

    expect(held.entries.map((entry) => entry.block.start)).toEqual([840])
  })

  it('keeps a held change when sending it is refused, and tries again later', async () => {
    const server = factorial()
    const held = memoryHeld()
    const sheet = createTimesheet({ held, ops: server.ops, employeeId: 1, defaultLocationType: () => 'office' })
    await sheet.saveDay(edit)
    approveBreak(server)
    vi.mocked(server.ops.requestTimesheetEdit).mockRejectedValueOnce(new Error('offline'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    await sheet.releaseHeld()
    expect(held.entries).toHaveLength(1)

    await sheet.releaseHeld()
    expect(held.entries).toEqual([])
    expect(server.calls).toHaveLength(2)
    log.mockRestore()
  })

  it('does not send one account\'s held change for another', async () => {
    const server = factorial()
    const held = memoryHeld()
    await createTimesheet({ held, ops: server.ops, employeeId: 1, defaultLocationType: () => 'office' }).saveDay(edit)
    approveBreak(server)

    await createTimesheet({ held, ops: server.ops, employeeId: 2, defaultLocationType: () => 'office' }).releaseHeld()

    expect(server.calls).toHaveLength(1)
    expect(held.entries).toHaveLength(1)
  })

  it('costs no request while nothing is held', async () => {
    const server = factorial()
    await createTimesheet({ held: memoryHeld(), ops: server.ops, employeeId: 1, defaultLocationType: () => 'office' }).releaseHeld()
    expect(server.ops.fetchShifts).not.toHaveBeenCalled()
  })
})
