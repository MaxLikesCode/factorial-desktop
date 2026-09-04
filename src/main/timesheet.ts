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
 */

import { reconstructInstant } from '@shared/time'
import {
  daysOfMonth,
  diffDay,
  minuteOfDay,
  normaliseBlocks,
  parseIsoDate,
  type DayEdit,
  type TimesheetBlock,
  type TimesheetDay,
  type TimesheetMonth,
} from '@shared/timesheet'
import type { Operations } from './factorial/operations'
import { isLocationType, type ShiftRecord } from './factorial/types'

export type TimesheetOperations = Pick<
  Operations,
  'fetchShifts' | 'fetchExpectedMinutesByDay' | 'createShift' | 'updateShift' | 'deleteShift'
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
  /** Writes the diff and returns the day as Factorial now holds it. */
  saveDay(edit: DayEdit): Promise<TimesheetDay>
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

/** Groups records by day and turns them into ordered blocks. */
export function daysFromRecords(
  dates: readonly string[],
  records: readonly ShiftRecord[],
  expected: ReadonlyMap<string, number | null>,
): TimesheetDay[] {
  const byDate = new Map<string, TimesheetBlock[]>()
  for (const record of records) {
    const block = blockFromRecord(record)
    if (block === null) continue
    const list = byDate.get(record.date) ?? []
    list.push(block)
    byDate.set(record.date, list)
  }
  return dates.map((date) => ({
    date,
    blocks: normaliseBlocks(byDate.get(date) ?? []),
    expectedMinutes: expected.get(date) ?? null,
  }))
}

/** Local midnight of `date` plus `minute`, as an instant with the machine's offset. */
function instantOf(date: string, minute: number): Date {
  const parts = parseIsoDate(date)
  if (parts === null) throw new Error(`unparseable date: ${date}`)
  return new Date(parts.year, parts.month - 1, parts.day, 0, minute, 0, 0)
}

export function createTimesheet(deps: TimesheetDeps): Timesheet {
  const { ops, employeeId } = deps

  async function loadDays(dates: readonly string[]): Promise<TimesheetDay[]> {
    const first = dates[0]
    const last = dates[dates.length - 1]
    if (first === undefined || last === undefined) return []
    const [records, expected] = await Promise.all([
      ops.fetchShifts(employeeId, first, last),
      // Targets decorate; a day list without them is still a day list.
      ops.fetchExpectedMinutesByDay(employeeId, first, last).catch(() => new Map<string, number | null>()),
    ])
    return daysFromRecords(dates, records, expected)
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

      // Deletes first, so a block that replaces a re-typed one cannot overlap
      // the record it stands in for while both exist.
      for (const id of changes.delete) await ops.deleteShift({ id })
      for (const block of changes.update) {
        if (block.id === null || block.end === null) continue
        await ops.updateShift({
          id: block.id,
          clockIn: instantOf(edit.date, block.start),
          clockOut: instantOf(edit.date, block.end),
        })
      }
      for (const block of changes.create) {
        if (block.end === null) continue
        const location = block.locationType ?? deps.defaultLocationType()
        await ops.createShift({
          date: edit.date,
          clockIn: instantOf(edit.date, block.start),
          clockOut: instantOf(edit.date, block.end),
          workable: block.kind === 'work',
          breakConfigurationId: block.kind === 'break' ? block.breakConfigurationId : null,
          locationType: block.kind === 'work' && isLocationType(location) ? location : null,
        })
      }

      deps.onSaved?.(edit.date)
      const [saved] = await loadDays([edit.date])
      return saved ?? { date: edit.date, blocks: [], expectedMinutes: null }
    },
  }
}
