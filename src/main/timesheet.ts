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
 *
 * ## A change can have to wait for another
 *
 * Factorial checks each request against the shifts as recorded and ignores
 * pending requests. A block moving into time another block only *asks* to give
 * up is refused, in any order, until that request is approved. Factorial's own
 * client has no way round this either. So such a change is held back
 * (`held-changes.ts`) and sent by `releaseHeld` once the way is clear, rather
 * than leaving half an edit filed and an error on the screen.
 */

import { reconstructInstant } from '@shared/time'
import {
  daysOfMonth,
  diffDay,
  blockersOf,
  formatMinuteOfDay,
  heldState,
  isAlreadyRequested,
  minuteOfDay,
  normaliseBlocks,
  parseIsoDate,
  parseTimeOfDay,
  type DayEdit,
  type DaySaveResult,
  type HeldChange,
  type PendingRequest,
  type TimesheetBlock,
  type TimesheetDay,
  type TimesheetMonth,
} from '@shared/timesheet'
import type { Operations } from './factorial/operations'
import type { HeldEntry, HeldStore } from './held-changes'
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
  /** The workplace ("Standort") for a created work block without one; the widget's last. */
  defaultWorkplaceId?: () => number | null
  /** Injected so tests are deterministic. */
  now?: () => Date
  /** Called after a day was written, with the day; `index.ts` refreshes the store for today. */
  onSaved?: (date: string) => void
  /** Changes waiting until Factorial would accept them. */
  held: HeldStore
  /**
   * Held changes went out without anybody pressing a button just now. An HR
   * request sent in the background is something the user should hear about.
   */
  onReleased?: (date: string, count: number) => void
}

export interface Timesheet {
  getMonth(year: number, month: number): Promise<TimesheetMonth>
  /** Requests the diff and returns the day as Factorial still holds it. */
  saveDay(edit: DayEdit): Promise<DaySaveResult>
  /** Takes a pending request back and returns its day without it. */
  withdraw(requestId: string, date: string): Promise<TimesheetDay>
  /** Forgets a held change, which was never sent, and returns its day without it. */
  discardHeld(heldId: string, date: string): Promise<TimesheetDay>
  /**
   * Sends the held changes nothing stands in the way of any more. Never
   * rejects, and does not touch the network when nothing is held, so it is safe
   * to call on a timer.
   */
  releaseHeld(): Promise<void>
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
    workplaceId: record.workplaceId,
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
    locationType: record.locationType,
  }
}

/** Groups records and requests by day; blocks ordered, requests as they came. */
export function daysFromRecords(
  dates: readonly string[],
  records: readonly ShiftRecord[],
  expected: ReadonlyMap<string, number | null>,
  requests: readonly EditRequestRecord[] = [],
  held: readonly HeldEntry[] = [],
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
  return dates.map((date) => {
    const day = {
      date,
      blocks: normaliseBlocks(byDate.get(date) ?? []),
      expectedMinutes: expected.get(date) ?? null,
      requests: pendingByDate.get(date) ?? [],
    }
    return { ...day, held: heldOfDay(day, held.filter((entry) => entry.date === date)) }
  })
}

/** The held changes worth showing: one already settled is about to be forgotten. */
function heldOfDay(day: Pick<TimesheetDay, 'blocks' | 'requests'>, entries: readonly HeldEntry[]): HeldChange[] {
  const blocks = entries.map((entry) => entry.block)
  const out: HeldChange[] = []
  for (const entry of entries) {
    const state = heldState(entry.block, day, blocks)
    if (state !== 'settled') out.push({ id: entry.id, block: entry.block, waiting: state !== 'stuck' })
  }
  return out
}

export function createTimesheet(deps: TimesheetDeps): Timesheet {
  const { ops, employeeId, held } = deps

  // One write at a time. A timer's release running into a save could otherwise
  // send a held change the save is just replacing, or send one twice.
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work)
    queue = run.catch(() => undefined)
    return run
  }

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
    return daysFromRecords(dates, records, expected, requests, held.list(employeeId))
  }

  async function reload(date: string): Promise<TimesheetDay> {
    const [day] = await loadDays([date])
    return day ?? { date, blocks: [], expectedMinutes: null, requests: [], held: [] }
  }

  /** Every request carries the day and the employee; the rest is the change. */
  async function request(
    date: string,
    requestType: EditRequestType,
    fields: {
      shiftId?: string | null
      clockIn?: string | null
      clockOut?: string | null
      workable?: boolean | null
      breakConfigurationId?: string | null
      locationType?: LocationType | null
      workplaceId?: number | null
    },
  ): Promise<void> {
    await ops.requestTimesheetEdit({
      employeeId,
      requestType,
      date,
      shiftId: fields.shiftId ?? null,
      clockIn: fields.clockIn ?? null,
      clockOut: fields.clockOut ?? null,
      workable: fields.workable ?? null,
      breakConfigurationId: fields.breakConfigurationId ?? null,
      locationType: fields.locationType ?? null,
      workplaceId: fields.workplaceId ?? null,
    })
  }

  async function requestUpdate(date: string, block: TimesheetBlock, original: TimesheetBlock | undefined): Promise<void> {
    if (block.id === null || block.end === null) return
    // The location rides along only when it is what moved: an untouched
    // one is not re-sent, same as everything else about the record. The
    // workplace goes with it, because Factorial reads a request that names
    // a place but no workplace as "Standort: none" (seen in the web app's
    // own request tooltip on 2026-09-07).
    const location = block.locationType
    const moved = block.kind === 'work' && location !== null && location !== original?.locationType && isLocationType(location)
    await request(date, 'update_shift', {
      shiftId: block.id,
      clockIn: formatMinuteOfDay(block.start),
      clockOut: formatMinuteOfDay(block.end),
      locationType: moved ? location : null,
      workplaceId: moved ? block.workplaceId : null,
    })
  }

  async function requestCreate(date: string, block: TimesheetBlock): Promise<void> {
    if (block.end === null) return
    const location = block.locationType ?? deps.defaultLocationType()
    const workplace = block.workplaceId ?? deps.defaultWorkplaceId?.() ?? null
    await request(date, 'create_shift', {
      clockIn: formatMinuteOfDay(block.start),
      clockOut: formatMinuteOfDay(block.end),
      workable: block.kind === 'work',
      breakConfigurationId: block.kind === 'break' ? block.breakConfigurationId : null,
      locationType: block.kind === 'work' && isLocationType(location) ? location : null,
      workplaceId: block.kind === 'work' ? workplace : null,
    })
  }

  async function sendHeld(date: string, entries: readonly HeldEntry[]): Promise<void> {
    const [day] = await loadDays([date])
    if (day === undefined) return
    const targets = entries.map((entry) => entry.block)
    let sent = 0
    for (const entry of entries) {
      const state = heldState(entry.block, day, targets)
      if (state === 'settled') {
        held.remove([entry.id])
      } else if (state === 'ready') {
        const original = day.blocks.find((b) => b.id === entry.block.id)
        try {
          if (entry.block.id === null) await requestCreate(date, entry.block)
          else await requestUpdate(date, entry.block, original)
        } catch (error) {
          // Still held, and tried again next time. A refusal costs nothing,
          // and dropping it would lose half of what the user asked for.
          console.error('[timesheet] held change could not be sent yet:', error)
          continue
        }
        held.remove([entry.id])
        sent += 1
      }
    }
    if (sent > 0) {
      deps.onSaved?.(date)
      deps.onReleased?.(date, sent)
    }
  }

  async function releaseAll(): Promise<void> {
    const entries = held.list(employeeId)
    for (const date of new Set(entries.map((entry) => entry.date))) {
      try {
        await sendHeld(date, entries.filter((entry) => entry.date === date))
      } catch (error) {
        console.error('[timesheet] could not check held changes:', error)
      }
    }
  }

  const releaseHeld = (): Promise<void> => serial(releaseAll)

  return {
    async getMonth(year, month) {
      // Looking at the timesheet is the moment an approval gets noticed, and
      // the month should already show the follow-up as requested.
      await releaseHeld()
      return { year, month, days: await loadDays(daysOfMonth(year, month)) }
    },

    saveDay(edit) {
      return serial(async () => {
        if (parseIsoDate(edit.date) === null) throw new Error(`unparseable date: ${edit.date}`)
        const [current] = await loadDays([edit.date])
        const before = current?.blocks ?? []
        const pending = current?.requests ?? []
        const after = normaliseBlocks(edit.blocks)
        const changes = diffDay(before, after)
        const toHold: TimesheetBlock[] = []
        let requested = 0

        // Whether this change goes out now. An identical pending request means
        // it already has: a retry after a refusal must not file a second one.
        const sendable = (block: TimesheetBlock, original: TimesheetBlock | undefined): boolean => {
          if (isAlreadyRequested(block, original, pending)) return false
          if (blockersOf(block, before).length === 0) return true
          toHold.push(block)
          return false
        }

        // Deletes first, then the rest in the order of the day. A delete has no
        // times, so nothing can overlap it.
        for (const id of changes.delete) {
          if (pending.some((r) => r.requestType === 'delete_shift' && r.shiftId === id)) continue
          await request(edit.date, 'delete_shift', { shiftId: id })
          requested += 1
        }
        for (const block of changes.update) {
          if (block.id === null || block.end === null) continue
          const original = before.find((b) => b.id === block.id)
          if (!sendable(block, original)) continue
          await requestUpdate(edit.date, block, original)
          requested += 1
        }
        for (const block of changes.create) {
          if (block.end === null || !sendable(block, undefined)) continue
          await requestCreate(edit.date, block)
          requested += 1
        }

        // A newer word about a record replaces what was held for it. Only now:
        // if a request above was refused, the save failed and nothing changed.
        const superseded = new Set<string | null>([...changes.delete, ...changes.update.map((b) => b.id)])
        const previous = held.list(employeeId).filter((entry) => entry.date === edit.date)
        held.remove(
          previous
            .filter((entry) =>
              entry.block.id !== null
                ? superseded.has(entry.block.id)
                : changes.create.some((b) => b.start === entry.block.start && b.end === entry.block.end),
            )
            .map((entry) => entry.id),
        )
        for (const block of toHold) held.add(employeeId, edit.date, block)

        // An approval can land immediately where the company configures it that
        // way, so the day is re-read rather than assumed unchanged.
        deps.onSaved?.(edit.date)
        return { day: await reload(edit.date), requested, held: toHold.length }
      })
    },

    withdraw(requestId, date) {
      return serial(async () => {
        if (parseIsoDate(date) === null) throw new Error(`unparseable date: ${date}`)
        await ops.withdrawTimesheetEdit({ id: requestId })
        return reload(date)
      })
    },

    discardHeld(heldId, date) {
      return serial(async () => {
        if (parseIsoDate(date) === null) throw new Error(`unparseable date: ${date}`)
        held.remove([heldId])
        return reload(date)
      })
    },

    releaseHeld,
  }
}
