import { describe, expect, it, vi } from 'vitest'
import type { AttendanceState } from '@shared/attendance-state'
import { asHoursSetting, longShiftDecision, watchLongShifts } from '../long-shift'

const since = new Date(2026, 8, 4, 8, 0, 0)
const at = (hours: number): Date => new Date(since.getTime() + hours * 3_600_000)
const clockedIn: AttendanceState = { kind: 'in', shiftId: '7', since, locationType: 'office', workplaceId: null }

describe('longShiftDecision', () => {
  const settings = { longShiftReminderHours: 8, autoClockOutHours: 10 }

  it('does nothing before the reminder hour, and nothing when clocked out', () => {
    expect(longShiftDecision({ state: clockedIn, now: at(7.9), settings, remindedShiftId: null, clockedOutShiftId: null })).toBeNull()
    expect(longShiftDecision({ state: { kind: 'out' }, now: at(20), settings, remindedShiftId: null, clockedOutShiftId: null })).toBeNull()
  })

  it('reminds once per shift, then clocks out once per shift', () => {
    expect(longShiftDecision({ state: clockedIn, now: at(8), settings, remindedShiftId: null, clockedOutShiftId: null })).toBe('remind')
    expect(longShiftDecision({ state: clockedIn, now: at(9), settings, remindedShiftId: '7', clockedOutShiftId: null })).toBeNull()
    expect(longShiftDecision({ state: clockedIn, now: at(10), settings, remindedShiftId: '7', clockedOutShiftId: null })).toBe('clockOut')
    expect(longShiftDecision({ state: clockedIn, now: at(11), settings, remindedShiftId: '7', clockedOutShiftId: '7' })).toBeNull()
  })

  it('counts a break as being on the clock', () => {
    const onBreak: AttendanceState = { kind: 'break', shiftId: '8', since, breakId: '1', breakName: 'Mittag', locationType: null }
    expect(longShiftDecision({ state: onBreak, now: at(8), settings, remindedShiftId: null, clockedOutShiftId: null })).toBe('remind')
  })

  it('respects each setting being off', () => {
    expect(longShiftDecision({ state: clockedIn, now: at(20), settings: { longShiftReminderHours: null, autoClockOutHours: null }, remindedShiftId: null, clockedOutShiftId: null })).toBeNull()
    expect(longShiftDecision({ state: clockedIn, now: at(20), settings: { longShiftReminderHours: null, autoClockOutHours: 10 }, remindedShiftId: null, clockedOutShiftId: null })).toBe('clockOut')
  })
})

describe('asHoursSetting', () => {
  it('keeps whole hours between 1 and 24 and turns everything else off', () => {
    expect(asHoursSetting(8)).toBe(8)
    expect(asHoursSetting(8.4)).toBe(8)
    expect(asHoursSetting(0)).toBeNull()
    expect(asHoursSetting(25)).toBeNull()
    expect(asHoursSetting('8')).toBeNull()
    expect(asHoursSetting(null)).toBeNull()
  })
})

describe('watchLongShifts', () => {
  it('reminds, then clocks out, each once, and marks the clock-out before calling it', async () => {
    vi.useFakeTimers()
    let now = at(0)
    const remind = vi.fn()
    const clockOut = vi.fn(async () => {})
    const stop = watchLongShifts({
      getState: () => clockedIn,
      getSettings: () => ({ longShiftReminderHours: 8, autoClockOutHours: 9 }),
      now: () => now,
      remind,
      clockOut,
      intervalMs: 1000,
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(remind).not.toHaveBeenCalled()

    now = at(8)
    await vi.advanceTimersByTimeAsync(1000)
    expect(remind).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(remind).toHaveBeenCalledTimes(1)

    now = at(9)
    await vi.advanceTimersByTimeAsync(1000)
    expect(clockOut).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(clockOut).toHaveBeenCalledTimes(1)

    stop()
    vi.useRealTimers()
  })
})
