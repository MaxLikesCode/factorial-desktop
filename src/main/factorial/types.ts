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
