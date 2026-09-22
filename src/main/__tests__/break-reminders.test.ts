import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttendanceSnapshot } from '../attendance'
import { watchBreakReminders, type BreakReminderSettings } from '../break-reminders'

const at = (h: number, m = 0, day = 22) => new Date(2026, 8, day, h, m)
const working: AttendanceSnapshot = {
  state: { kind: 'in', shiftId: 'work', since: at(8), locationType: null, workplaceId: null },
  todayMinutes: 0, daySegments: [], incompleteShifts: 0, expectedMinutes: 480,
  breakOptions: [], lastError: null, lastErrorKind: null, stale: false,
}
const enabled: BreakReminderSettings = {
  breakDurationReminderMinutes: 30, lunchReminderTime: '12:30', lunchReminderHours: 4,
}
afterEach(() => vi.useRealTimers())

function setup(settings = enabled) {
  vi.useFakeTimers()
  let now = at(8)
  let snapshot = working
  const notify = vi.fn()
  const stop = watchBreakReminders({ getSnapshot: () => snapshot, getSettings: () => settings, now: () => now, notify })
  return {
    notify, stop,
    async tick(time: Date, next = snapshot) {
      now = time
      snapshot = next
      await vi.advanceTimersByTimeAsync(60_000)
    },
  }
}

describe('break reminders', () => {
  it('reminds once after a running break reaches its duration, and again for a new break', async () => {
    const t = setup()
    const paused: AttendanceSnapshot = { ...working, state: { kind: 'break', shiftId: 'break-1', since: at(12), breakId: 'lunch', breakName: 'Lunch', locationType: null } }
    await t.tick(at(12, 29), paused)
    expect(t.notify).not.toHaveBeenCalled()
    await t.tick(at(12, 30))
    expect(t.notify).toHaveBeenCalledExactlyOnceWith('endBreak', 30)
    await t.tick(at(13))
    expect(t.notify).toHaveBeenCalledTimes(1)
    await t.tick(at(14, 30), { ...paused, state: { ...paused.state as Extract<AttendanceSnapshot['state'], { kind: 'break' }>, shiftId: 'break-2', since: at(14) } })
    expect(t.notify).toHaveBeenCalledTimes(2)
    t.stop()
  })

  it('uses the first lunch trigger and does not repeat when the second becomes due', async () => {
    const t = setup()
    await t.tick(at(11, 59))
    expect(t.notify).not.toHaveBeenCalled()
    await t.tick(at(12))
    expect(t.notify).toHaveBeenCalledExactlyOnceWith('takeBreak', 0)
    await t.tick(at(12, 30))
    expect(t.notify).toHaveBeenCalledTimes(1)
    await t.tick(at(12, 30, 23), { ...working, state: { ...working.state as Extract<AttendanceSnapshot['state'], { kind: 'in' }>, since: at(8, 0, 23) } })
    expect(t.notify).toHaveBeenCalledTimes(2)
    t.stop()
  })

  it('supports a clock time without a work-duration trigger', async () => {
    const t = setup({ ...enabled, lunchReminderHours: null })
    await t.tick(at(12, 29))
    expect(t.notify).not.toHaveBeenCalled()
    await t.tick(at(12, 30))
    expect(t.notify).toHaveBeenCalledExactlyOnceWith('takeBreak', 0)
    t.stop()
  })

  it('skips lunch reminders after a recorded break or while clocked out or stale', async () => {
    const t = setup()
    await t.tick(at(13), { ...working, daySegments: [{ kind: 'break', minutes: 30 }] })
    await t.tick(at(13), { ...working, state: { kind: 'out' } })
    await t.tick(at(13), { ...working, stale: true })
    expect(t.notify).not.toHaveBeenCalled()
    t.stop()
  })

  it('keeps all reminders off when disabled', async () => {
    const t = setup({ breakDurationReminderMinutes: null, lunchReminderTime: null, lunchReminderHours: null })
    await t.tick(at(18))
    await t.tick(at(18), { ...working, state: { kind: 'break', shiftId: 'b', since: at(12), breakId: 'lunch', breakName: 'Lunch', locationType: null } })
    expect(t.notify).not.toHaveBeenCalled()
    t.stop()
  })
})
