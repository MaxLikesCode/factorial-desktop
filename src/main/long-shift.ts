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
 *
 * ## Why the timer aims rather than polls
 *
 * Factorial keeps a clock-out to the minute. A check once a minute lands up to a
 * minute after the limit, and whenever that carries into the next minute an
 * eight-hour day is recorded as 8:01, which on average is every second day. So
 * the watcher works out when the limit is reached and wakes exactly then.
 * Clock-in has whole seconds and `now` is sent in whole seconds, so waking a few
 * milliseconds late still sends the right second.
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

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000

/**
 * Both limits use the same daily work total as the widget. Factorial
 * opens a new record after every break, so `since` alone loses earlier work.
 *
 * In whole milliseconds rather than fractions of an hour: a total like 17/60 h
 * has no exact binary form, and it could fall just short of the limit at the very
 * moment the timer was aimed at.
 */
function workedMs(input: Pick<LongShiftInput, 'state' | 'todayMinutes' | 'now'>): number {
  const { state } = input
  const running = state.kind === 'in' ? Math.max(0, input.now.getTime() - state.since.getTime()) : 0
  return input.todayMinutes * MS_PER_MINUTE + running
}

export function longShiftDecision(input: LongShiftInput): LongShiftAction | null {
  const { state, settings } = input
  if (state.kind !== 'in' && state.kind !== 'break') return null
  const worked = workedMs(input)

  if (
    settings.autoClockOutHours !== null &&
    worked >= settings.autoClockOutHours * MS_PER_HOUR &&
    input.clockedOutShiftId !== state.shiftId
  ) {
    return 'clockOut'
  }
  if (
    settings.longShiftReminderHours !== null &&
    worked >= settings.longShiftReminderHours * MS_PER_HOUR &&
    input.remindedShiftId !== state.shiftId
  ) {
    return 'remind'
  }
  return null
}

/**
 * How long until the next limit that has yet to fire, or null when nothing is
 * coming: no limit is left, or the total is not growing because nobody is working.
 */
export function msUntilNextLimit(input: LongShiftInput): number | null {
  const { state, settings } = input
  if (state.kind !== 'in') return null
  const worked = workedMs(input)
  const limits: number[] = []
  if (settings.autoClockOutHours !== null && input.clockedOutShiftId !== state.shiftId) limits.push(settings.autoClockOutHours)
  if (settings.longShiftReminderHours !== null && input.remindedShiftId !== state.shiftId) limits.push(settings.longShiftReminderHours)
  if (limits.length === 0) return null
  return Math.max(0, Math.min(...limits) * MS_PER_HOUR - worked)
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

/**
 * Wakes when the next limit is reached, and at least once a minute (`intervalMs`)
 * so that a changed setting, a break or a new shift is noticed. Returns the stop
 * function.
 */
export function watchLongShifts(deps: LongShiftWatcherDeps): () => void {
  const now = deps.now ?? (() => new Date())
  const intervalMs = deps.intervalMs ?? MS_PER_MINUTE
  let remindedShiftId: string | null = null
  let clockedOutShiftId: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  function input(): LongShiftInput {
    const { state, todayMinutes } = deps.getSnapshot()
    return { state, todayMinutes, now: now(), settings: deps.getSettings(), remindedShiftId, clockedOutShiftId }
  }

  async function tick(): Promise<void> {
    const current = input()
    const { state, settings } = current
    const action = longShiftDecision(current)
    if (action === null || (state.kind !== 'in' && state.kind !== 'break')) return

    if (action === 'remind') {
      remindedShiftId = state.shiftId
      deps.remind(settings.longShiftReminderHours ?? 0)
      return
    }

    // Marked before the call, not after: a clock-out that throws must not be
    // tried again a minute later against a record that may well have closed.
    clockedOutShiftId = state.shiftId
    try {
      await deps.clockOut()
    } catch (error) {
      deps.onClockOutFailed?.(error instanceof Error ? error.message : String(error))
    }
  }

  // The next wake is only set once this one is finished, so a slow clock-out
  // cannot overlap the check after it. A failed check must not end the watching:
  // the next limit may be the clock-out somebody is relying on.
  async function run(): Promise<void> {
    try {
      await tick()
    } catch (error) {
      console.error('[long-shift] check failed:', error)
    }
    if (stopped) return
    const due = msUntilNextLimit(input())
    timer = setTimeout(() => void run(), due === null ? intervalMs : Math.min(intervalMs, due))
  }

  void run()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
