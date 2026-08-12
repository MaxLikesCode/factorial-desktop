import { reconstructInstant } from './time'

export interface BreakConfiguration {
  id: string
  name: string | null
}

/**
 * The subset of `AttendanceOpenShift` the derivation needs. Note that this is a
 * *different type* from `AttendanceShift`: it has `clockIn`, not
 * `clockInWithSeconds`, and no `minutes` at all (K7).
 *
 * `workable` is deliberately absent. It correlates fully with the break state in
 * the live run, but keeping it here would create a second truth next to
 * `timeSettingsBreakConfiguration` — the design names the latter as the
 * authoritative one.
 */
export interface OpenShift {
  id: string
  date: string
  /** Sentinel date `2000-01-01` plus the local time-of-day. Never an instant. */
  clockIn: string
  /** The real local offset, e.g. "+02:00". Without it the time is unusable. */
  clockInOffset: string
  locationType: string | null
  /** Int in the schema (K4) — e.g. 3333333. */
  workplaceId: number | null
  timeSettingsBreakConfiguration: BreakConfiguration | null
}

export type AttendanceState =
  | { kind: 'unknown' }
  | { kind: 'unauthenticated' }
  | { kind: 'out' }
  | {
      kind: 'in'
      shiftId: string
      since: Date
      locationType: string | null
      workplaceId: number | null
    }
  | {
      kind: 'break'
      shiftId: string
      since: Date
      breakId: string
      breakName: string
      /**
       * For display only. A break does not choose a work location — it inherits
       * the one the open shift already carries, and the widget must show that
       * rather than the user's saved preference for the *next* clock-in.
       */
      locationType: string | null
    }

/**
 * Shown when the API gives a break configuration no usable label. Exported so
 * the store's optimistic break state uses the very same word the derived one
 * does — two spellings of the same fallback would flicker in the widget.
 */
export const FALLBACK_BREAK_NAME = 'Pause'

/**
 * The single source of truth for "am I clocked in?". Everything is derived from
 * `openShift`; no parallel flag is kept anywhere.
 *
 * Pure and clock-independent: the shift carries its own offset, so there is
 * nothing to inject and nothing to guess.
 *
 * `unknown` and `unauthenticated` are never produced here — they are meta states
 * the store sets before the first load and after a rejected session.
 *
 * This function *throws* when `reconstructInstant` cannot parse the shift's date,
 * time or offset. That is on purpose: a start time is the one value the whole UI
 * hangs on, and a swallowed parse error would show a confidently wrong timer.
 * The store treats the throw like any other refresh failure — last known state
 * kept, snapshot marked stale.
 */
export function deriveState(openShift: OpenShift | null): AttendanceState {
  if (!openShift) return { kind: 'out' }

  const since = reconstructInstant(openShift.date, openShift.clockIn, openShift.clockInOffset)
  const brk = openShift.timeSettingsBreakConfiguration

  if (brk) {
    const name = brk.name?.trim()
    return {
      kind: 'break',
      shiftId: openShift.id,
      since,
      breakId: brk.id,
      // A blank name is as unusable as a missing one and would render an empty
      // label in the widget and the tray menu.
      breakName: name ? name : FALLBACK_BREAK_NAME,
      locationType: openShift.locationType,
    }
  }

  return {
    kind: 'in',
    shiftId: openShift.id,
    since,
    locationType: openShift.locationType,
    workplaceId: openShift.workplaceId,
  }
}
