/**
 * The types the Factorial operations hand out. These are *our* shapes, already
 * validated and normalised — every id is a string here even though the schema
 * sends Ints (K4), so nothing downstream has to remember which is which.
 *
 * The one exception is `Identity.employeeId`: it stays a number because
 * `attendance.employee(id:)` demands `Int!` and it is fed straight back in.
 */

export interface Identity {
  email: string
  /** Numeric on purpose — every attendance query takes it as `Int!`. */
  employeeId: number
  fullName: string
  companyId: number
  companyName: string
}

export interface BreakConfigOption {
  id: string
  name: string
}

/**
 * One record from `attendanceShiftsConnection`. This is a *closed*
 * `AttendanceShift` — unlike `AttendanceOpenShift` it carries `minutes` (K7).
 * A break splits a working day into several of these, so the day's worked time
 * is the sum over all of them plus the running shift.
 */
import type { BreakConfiguration } from '@shared/attendance-state'

export interface ShiftSummary {
  id: string
  date: string
  /**
   * Kept nullable rather than defaulted to 0: a record without minutes has not
   * been totalled by Factorial yet, which is a different fact from "worked zero
   * minutes". Whether the still-running shift appears in this connection at all
   * is unverified — the consumer decides how to add it up.
   */
  minutes: number | null
  /**
   * Whether this record is time that counts as work.
   *
   * A break is a shift record of its own — starting one closes the work record
   * and opens a break record, which is why `openShift.timeSettingsBreakConfiguration`
   * can identify the state at all (DESIGN.md, "Zustandsmodell"). For the day's
   * total that means the two kinds arrive in the same list and have to be told
   * apart, and `workable` is the field that answers exactly that question:
   * `false` on a break, `true` on work. Confirmed live on 2026-08-12 for the
   * open shift; the same field is listed on the closed-shift query in the spec.
   *
   * Nullable because it is not worth crashing the day sum over, and because a
   * record that answers neither way is covered by `breakConfiguration` below.
   */
  workable: boolean | null
  /**
   * The break this record IS, if it is one.
   *
   * A second signal for the same question, and deliberately not a second truth:
   * both are read, and either one saying "break" is enough to keep the record
   * out of the worked total. They are expected to agree — the correlation is
   * confirmed for the open shift — and neither is confirmed for a *closed*
   * record, which is the whole reason for reading both.
   */
  breakConfiguration: BreakConfiguration | null
  /**
   * When this record started, for putting the day in order.
   *
   * `attendanceShiftsConnection` promises no ordering, and a day drawn out of
   * order puts the break in the wrong place. The pair is what
   * `reconstructInstant` needs: the timestamp carries a usable time-of-day and a
   * worthless date, the offset says which zone it belongs to. Nullable because a
   * record without them can still be summed and drawn — only not placed.
   */
  clockInWithSeconds: string | null
  clockInOffset: string | null
}

/**
 * One closed-or-open record with both ends, for the timesheet editor. What
 * `ShiftSummary` has plus the clock-out, which the widget never needed and
 * the editor cannot do without. `clockOut` is null on the running record.
 */
export interface ShiftRecord extends ShiftSummary {
  clockIn: string | null
  clockOut: string | null
  clockOutOffset: string | null
  locationType: string | null
  workplaceId: number | null
}

/**
 * `AttendanceShiftLocationTypeEnum`, verified against the live schema. Sending
 * anything outside this set fails the mutation in-band with HTTP 200.
 */
export const LOCATION_TYPES = ['office', 'work_from_home', 'business_trip'] as const

export type LocationType = (typeof LOCATION_TYPES)[number]

/** Guards the boundary where a persisted or IPC-supplied string becomes an enum. */
export function isLocationType(value: string): value is LocationType {
  return (LOCATION_TYPES as readonly string[]).includes(value)
}

/** The request kinds live in `@shared/timesheet`, because the renderer shows them too. */
import type { EditRequestType } from '@shared/timesheet'
export type { EditRequestType }

/**
 * One `AttendanceEditTimesheetRequest`, as read back. `approved` is the whole
 * state machine: null is pending, true was applied, false was turned down.
 * The times are `HH:MM` strings — the same shape the request was sent with.
 */
export interface EditRequestRecord {
  id: string
  approved: boolean | null
  requestType: EditRequestType
  date: string
  shiftId: string | null
  clockIn: string | null
  clockOut: string | null
  workable: boolean | null
  breakConfigurationId: string | null
}

/**
 * One member of `errors: [MutationError!]!` (K5), after unpacking.
 *
 * On the wire this is a GraphQL union discriminated by `__typename`, which is
 * why the queries need inline fragments. Here it carries a `kind` TypeScript can
 * narrow on plus the original `typename`, and a catch-all member: the union may
 * grow a type that did not exist when this was written, and an unrecognised
 * failure is still a failure.
 */
export type MutationError =
  | { kind: 'simple'; typename: string; message: string | null; type: string | null }
  | { kind: 'structured'; typename: string; field: string | null; messages: string[] }
  | { kind: 'unknown'; typename: string }

/**
 * One `TimeoffLeave` from `timeoff.leavesConnection`, as the overview's
 * absences card shows it. The same shape as `UpcomingLeave` in
 * `@shared/overview` — it is the shared type, re-exported under the name this
 * module uses for what it reads.
 */
import type { UpcomingLeave } from '@shared/overview'
export type LeaveRecord = UpcomingLeave

/** `attendanceAggregatedWorkedTime` plus the pending inconsistency count. */
export interface MonthWorkedTime {
  minutes: number
  pendingInconsistencies: number | null
}
