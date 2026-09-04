/**
 * The timesheet: a month of days for the app window, and the writes that
 * make an edited day true in Factorial.
 *
 * Separate from `attendance.ts`, which is about *now* — the open shift, the
 * running timer, today's total. This is about recorded time: any day, both
 * ends of every record. The two meet only at the edges: a saved day that is
 * today makes the attendance store refresh, so the widget's day bar and sum
 * follow the edit.
 *
 * The one rule: **the writes are the diff, nothing more.** A saved day is
 * compared record by record with what Factorial holds, and only records that
 * actually moved are written (`diffDay` in `src/shared/timesheet.ts`). An
 * untouched record is never re-sent, so a timesheet that is edited for one
 * block keeps every other block's `source`, observations and timestamps
 * exactly as they were.
 *
 * ## Saving does not change the timesheet
 *
 * It asks for it to be changed. An ordinary Factorial account may not write
 * attendance shifts at all — `create/update/deleteAttendanceShift` refuse it —
 * and the web interface does not use them either: its pencil opens "Änderungen
 * beantragen". So each changed block becomes one
 * `createAttendanceEditTimesheetRequest`, and the day itself stays exactly as it
 * was until somebody with the permission approves.
 *
 * This is why `saveDay` returns the *reloaded* day rather than the edit, and a
 * count beside it. The editor must not draw the requested times as though they
 * were recorded; they are a proposal, and the day is the answer.
 */

import { reconstructInstant } from '@shared/time'
import {
  daysOfMonth,
  diffDay,
  formatMinuteOfDay,
  minuteOfDay,
  normaliseBlocks,
  parseIsoDate,
  parseTimeOfDay,
  type DayEdit,
  type DaySaveResult,
  type PendingRequest,
  type TimesheetBlock,
  type TimesheetDay,
  type TimesheetMonth,
} from '@shared/timesheet'
import type { Operations } from './factorial/operations'
import {
  isLocationType,
  type EditRequestRecord,
  type EditRequestType,
  type LocationType,
  type ShiftRecord,
} from './factorial/types'

export type TimesheetOperations = Pick<
  Operations,
  'fetchShifts' | 'fetchExpectedMinutesByDay' | 'fetchEditRequests' | 'requestTimesheetEdit' | 'withdrawTimesheetEdit'
>

export interface TimesheetDeps {
  ops: TimesheetOperations
  employeeId: number
  /** Where a created work block is booked when the editor does not say. */
  defaultLocationType: () => string
  /** Injected so tests are deterministic. */
  now?: () => Date
  /** Called after a day was written, with the day; `index.ts` refreshes the store for today. */
  onSaved?: (date: string) => void
}

export interface Timesheet {
  getMonth(year: number, month: number): Promise<TimesheetMonth>
  /** Requests the diff and returns the day as Factorial still holds it. */
  saveDay(edit: DayEdit): Promise<DaySaveResult>
  /** Takes a pending request back and returns its day without it. */
  withdraw(requestId: string, date: string): Promise<TimesheetDay>
}

/**
 * A record's ends as minutes of its own day. A record that runs past midnight
 * is cut at 24:00 — the editor draws one day, and Factorial files the record
 * under `date` anyway. Returns null for a record without a usable start.
 */
export function blockFromRecord(record: ShiftRecord): TimesheetBlock | null {
  if (record.clockIn === null || record.clockInOffset === null) return null
  let start: number
  try {
    start = minuteOfDay(reconstructInstant(record.date, record.clockIn, record.clockInOffset))
  } catch {
    return null
  }
  let end: number | null = null
  if (record.clockOut !== null) {
    try {
      const out = reconstructInstant(
        record.date,
        record.clockOut,
        record.clockOutOffset ?? record.clockInOffset,
      )
      // The timestamp's date is worthless (docs/api-discovery.md), so a
      // record past midnight can only be recognised by ending before it
      // started. The day the record belongs to has no more minutes than 24:00.
      const minute = minuteOfDay(out)
      end = minute < start ? 24 * 60 : minute
    } catch {
      end = null
    }
  }
  const isBreak = record.workable === false || record.breakConfiguration !== null
  return {
    id: record.id,
    kind: isBreak ? 'break' : 'work',
    start,
    end,
    breakConfigurationId: record.breakConfiguration?.id ?? null,
    breakName: record.breakConfiguration?.name ?? null,
    locationType: record.locationType,
  }
}

/**
 * A request as the editor shows it, or null for one that is answered already:
 * an approved request is in the blocks by now, a rejected one is history, and
 * neither is a change still waiting on anybody.
 */
export function pendingFromRecord(record: EditRequestRecord): PendingRequest | null {
  if (record.approved !== null) return null
  return {
    id: record.id,
    requestType: record.requestType,
    shiftId: record.shiftId,
    start: record.clockIn === null ? null : parseTimeOfDay(record.clockIn),
    end: record.clockOut === null ? null : parseTimeOfDay(record.clockOut),
    workable: record.workable,
    breakConfigurationId: record.breakConfigurationId,
  }
}

/** Groups records and requests by day; blocks ordered, requests as they came. */
export function daysFromRecords(
  dates: readonly string[],
  records: readonly ShiftRecord[],
  expected: ReadonlyMap<string, number | null>,
  requests: readonly EditRequestRecord[] = [],
): TimesheetDay[] {
  const byDate = new Map<string, TimesheetBlock[]>()
  for (const record of records) {
    const block = blockFromRecord(record)
    if (block === null) continue
    const list = byDate.get(record.date) ?? []
    list.push(block)
    byDate.set(record.date, list)
  }
  const pendingByDate = new Map<string, PendingRequest[]>()
  for (const record of requests) {
    const pending = pendingFromRecord(record)
    if (pending === null) continue
    const list = pendingByDate.get(record.date) ?? []
    list.push(pending)
    pendingByDate.set(record.date, list)
  }
  return dates.map((date) => ({
    date,
    blocks: normaliseBlocks(byDate.get(date) ?? []),
    expectedMinutes: expected.get(date) ?? null,
    requests: pendingByDate.get(date) ?? [],
  }))
}

export function createTimesheet(deps: TimesheetDeps): Timesheet {
  const { ops, employeeId } = deps

  async function loadDays(dates: readonly string[]): Promise<TimesheetDay[]> {
    const first = dates[0]
    const last = dates[dates.length - 1]
    if (first === undefined || last === undefined) return []
    const [records, expected, requests] = await Promise.all([
      ops.fetchShifts(employeeId, first, last),
      // Targets decorate; a day list without them is still a day list.
      ops.fetchExpectedMinutesByDay(employeeId, first, last).catch(() => new Map<string, number | null>()),
      // Requests do not: a day shown without its pending changes would say the
      // timesheet is settled when it is not, so this read is allowed to fail
      // the month.
      ops.fetchEditRequests(employeeId, first, last),
    ])
    return daysFromRecords(dates, records, expected, requests)
  }

  async function reload(date: string): Promise<TimesheetDay> {
    const [day] = await loadDays([date])
    return day ?? { date, blocks: [], expectedMinutes: null, requests: [] }
  }

  return {
    async getMonth(year, month) {
      return { year, month, days: await loadDays(daysOfMonth(year, month)) }
    },

    async saveDay(edit) {
      if (parseIsoDate(edit.date) === null) throw new Error(`unparseable date: ${edit.date}`)
      const [current] = await loadDays([edit.date])
      const before = current?.blocks ?? []
      const after = normaliseBlocks(edit.blocks)
      const changes = diffDay(before, after)
      let requested = 0

      /** Every request carries the day and the employee; the rest is the change. */
      async function request(
        requestType: EditRequestType,
        fields: {
          shiftId?: string | null
          clockIn?: string | null
          clockOut?: string | null
          workable?: boolean | null
          breakConfigurationId?: string | null
          locationType?: LocationType | null
        },
      ): Promise<void> {
        await ops.requestTimesheetEdit({
          employeeId,
          requestType,
          date: edit.date,
          shiftId: fields.shiftId ?? null,
          clockIn: fields.clockIn ?? null,
          clockOut: fields.clockOut ?? null,
          workable: fields.workable ?? null,
          breakConfigurationId: fields.breakConfigurationId ?? null,
          locationType: fields.locationType ?? null,
        })
        requested += 1
      }

      // Deletes first, so a block that replaces a re-typed one cannot overlap
      // the record it stands in for while both exist.
      for (const id of changes.delete) await request('delete_shift', { shiftId: id })
      for (const block of changes.update) {
        if (block.id === null || block.end === null) continue
        await request('update_shift', {
          shiftId: block.id,
          clockIn: formatMinuteOfDay(block.start),
          clockOut: formatMinuteOfDay(block.end),
        })
      }
      for (const block of changes.create) {
        if (block.end === null) continue
        const location = block.locationType ?? deps.defaultLocationType()
        await request('create_shift', {
          clockIn: formatMinuteOfDay(block.start),
          clockOut: formatMinuteOfDay(block.end),
          workable: block.kind === 'work',
          breakConfigurationId: block.kind === 'break' ? block.breakConfigurationId : null,
          locationType: block.kind === 'work' && isLocationType(location) ? location : null,
        })
      }

      // An approval can land immediately where the company configures it that
      // way, so the day is re-read rather than assumed unchanged.
      deps.onSaved?.(edit.date)
      return { day: await reload(edit.date), requested }
    },

    async withdraw(requestId, date) {
      if (parseIsoDate(date) === null) throw new Error(`unparseable date: ${date}`)
      await ops.withdrawTimesheetEdit({ id: requestId })
      return reload(date)
    },
  }
}
