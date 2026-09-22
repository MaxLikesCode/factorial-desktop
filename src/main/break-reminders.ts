import { toLocalDate } from '@shared/time'
import type { AttendanceSnapshot } from './attendance'

export interface BreakReminderSettings {
  breakDurationReminderMinutes: number | null
  lunchReminderTime: string | null
  lunchReminderHours: number | null
}

export function isReminderTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

export function isBreakReminderMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 5 && value <= 180
}

interface BreakReminderDeps {
  getSnapshot: () => AttendanceSnapshot
  getSettings: () => BreakReminderSettings
  now?: () => Date
  notify: (kind: 'takeBreak' | 'endBreak', minutes: number) => void
}

/** Notifications only: neither reminder changes the attendance record. */
export function watchBreakReminders(deps: BreakReminderDeps): () => void {
  const now = deps.now ?? (() => new Date())
  let remindedBreakId: string | null = null
  let remindedLunchDate: string | null = null

  function tick(): void {
    const snapshot = deps.getSnapshot()
    const { state } = snapshot
    if (snapshot.stale || (state.kind !== 'in' && state.kind !== 'break')) return
    // Optimistic records are provisional and can roll back after a failed write.
    if (state.shiftId === 'optimistic') return
    const settings = deps.getSettings()
    const current = now()
    const elapsedMinutes = Math.max(0, (current.getTime() - state.since.getTime()) / 60_000)

    if (state.kind === 'break') {
      const limit = settings.breakDurationReminderMinutes
      if (limit !== null && elapsedMinutes >= limit && remindedBreakId !== state.shiftId) {
        remindedBreakId = state.shiftId
        deps.notify('endBreak', Math.floor(elapsedMinutes))
      }
      return
    }

    const today = toLocalDate(current)
    if (remindedLunchDate === today || snapshot.daySegments.some((segment) => segment.kind === 'break')) return
    const workDue = settings.lunchReminderHours !== null &&
      snapshot.todayMinutes + elapsedMinutes >= settings.lunchReminderHours * 60
    const time = settings.lunchReminderTime
    const timeDue = time !== null && isReminderTime(time) &&
      current.getHours() * 60 + current.getMinutes() >= Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
    if (workDue || timeDue) {
      remindedLunchDate = today
      deps.notify('takeBreak', 0)
    }
  }

  const timer = setInterval(tick, 60_000)
  tick()
  return () => clearInterval(timer)
}
