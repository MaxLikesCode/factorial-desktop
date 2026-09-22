/**
 * The shift that was forgotten.
 *
 * Two settings, both off by nothing but their value: `longShiftReminderHours`
 * says after how many worked hours today a notification is shown, and
 * `autoClockOutHours` after how many worked hours today the app clocks out. The
 * decision is `longShiftDecision`, pure and tested; `watchLongShifts` is the
 * timer around it.
 *
 * Automatic clock-out writes to a real timesheet without a click, which is
 * why it is a separate setting with no default. If both limits are reached,
 * automatic clock-out takes priority. Both fire at most once per shift, keyed by
 * the shift id, so a reminder does not repeat every minute and a clock-out
 * that failed is not retried into a second record.
 */

import type { AttendanceState } from '@shared/attendance-state'

export interface LongShiftSettings {
  longShiftReminderHours: number | null
  autoClockOutHours: number | null
}

export type LongShiftAction = 'remind' | 'clockOut'

export interface LongShiftInput {
  state: AttendanceState
  /** Closed work records today, excluding breaks and the running record. */
  todayMinutes: number
  now: Date
  settings: LongShiftSettings
  /** The shift already reminded about, if any. */
  remindedShiftId: string | null
  /** The shift already clocked out by the app, if any. */
  clockedOutShiftId: string | null
}

/**
 * Both limits use the same daily work total as the widget. Factorial
 * opens a new record after every break, so `since` alone loses earlier work.
 */
export function longShiftDecision(input: LongShiftInput): LongShiftAction | null {
  const { state, settings } = input
  if (state.kind !== 'in' && state.kind !== 'break') return null
  const hours = (input.now.getTime() - state.since.getTime()) / 3_600_000
  const workedHours = input.todayMinutes / 60 + (state.kind === 'in' ? Math.max(0, hours) : 0)

  if (
    settings.autoClockOutHours !== null &&
    workedHours >= settings.autoClockOutHours &&
    input.clockedOutShiftId !== state.shiftId
  ) {
    return 'clockOut'
  }
  if (
    settings.longShiftReminderHours !== null &&
    workedHours >= settings.longShiftReminderHours &&
    input.remindedShiftId !== state.shiftId
  ) {
    return 'remind'
  }
  return null
}

/** Whole hours between 1 and 24, or null for "off". Anything else is off. */
export function asHoursSetting(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.round(value)
  return rounded >= 1 && rounded <= 24 ? rounded : null
}

export interface LongShiftWatcherDeps {
  getSnapshot: () => Pick<LongShiftInput, 'state' | 'todayMinutes'>
  getSettings: () => LongShiftSettings
  now?: () => Date
  remind: (hours: number) => void
  clockOut: () => Promise<void>
  /** Called with a description when the automatic clock-out failed. */
  onClockOutFailed?: (reason: string) => void
  intervalMs?: number
}

/** Checks once a minute. Returns the stop function. */
export function watchLongShifts(deps: LongShiftWatcherDeps): () => void {
  const now = deps.now ?? (() => new Date())
  let remindedShiftId: string | null = null
  let clockedOutShiftId: string | null = null
  let busy = false

  async function tick(): Promise<void> {
    if (busy) return
    const { state, todayMinutes } = deps.getSnapshot()
    const settings = deps.getSettings()
    const action = longShiftDecision({
      state,
      todayMinutes,
      now: now(),
      settings,
      remindedShiftId,
      clockedOutShiftId,
    })
    if (action === null || (state.kind !== 'in' && state.kind !== 'break')) return

    if (action === 'remind') {
      remindedShiftId = state.shiftId
      deps.remind(settings.longShiftReminderHours ?? 0)
      return
    }

    // Marked before the call, not after: a clock-out that throws must not be
    // tried again a minute later against a record that may well have closed.
    clockedOutShiftId = state.shiftId
    busy = true
    try {
      await deps.clockOut()
    } catch (error) {
      deps.onClockOutFailed?.(error instanceof Error ? error.message : String(error))
    } finally {
      busy = false
    }
  }

  const timer = setInterval(() => void tick(), deps.intervalMs ?? 60_000)
  void tick()
  return () => clearInterval(timer)
}
