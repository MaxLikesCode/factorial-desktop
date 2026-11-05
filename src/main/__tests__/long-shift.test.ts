import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttendanceState } from '@shared/attendance-state'
import { asHoursSetting, longShiftDecision, watchLongShifts } from '../long-shift'

const since = new Date(2026, 8, 4, 8, 0, 0)
const at = (hours: number): Date => new Date(since.getTime() + hours * 3_600_000)
const clockedIn: AttendanceState = { kind: 'in', shiftId: '7', since, locationType: 'office', workplaceId: null }

describe('longShiftDecision', () => {
  it('clocks out after eight hours of work split by a 45-minute break', () => {
    const input = {
      state: { ...clockedIn, since: at(4.75), shiftId: 'after-break' },
      todayMinutes: 240,
      settings: { longShiftReminderHours: null, autoClockOutHours: 8 },
      remindedShiftId: null,
      clockedOutShiftId: null,
    }
    expect(longShiftDecision({ ...input, now: at(8) })).toBeNull()
    expect(longShiftDecision({ ...input, now: at(8.75) })).toBe('clockOut')
  })

  it('does not count a running break as worked time', () => {
    const input = {
      state: { kind: 'break', shiftId: '8', since: at(4), breakId: '1', breakName: 'Lunch', locationType: null } as AttendanceState,
      todayMinutes: 240,
      now: at(12),
      settings: { longShiftReminderHours: null, autoClockOutHours: 8 },
      remindedShiftId: null,
      clockedOutShiftId: null,
    }
    expect(longShiftDecision(input)).toBeNull()
    expect(longShiftDecision({ ...input, todayMinutes: 480 })).toBe('clockOut')
  })

  const settings = { longShiftReminderHours: 8, autoClockOutHours: 10 }

  it('does nothing before the reminder hour, and nothing when clocked out', () => {
    expect(longShiftDecision({ todayMinutes: 0, state: clockedIn, now: at(7.9), settings, remindedShiftId: null, clockedOutShiftId: null })).toBeNull()
    expect(longShiftDecision({ todayMinutes: 0, state: { kind: 'out' }, now: at(20), settings, remindedShiftId: null, clockedOutShiftId: null })).toBeNull()
  })

  it('reminds once per shift, then clocks out once per shift', () => {
    expect(longShiftDecision({ todayMinutes: 0, state: clockedIn, now: at(8), settings, remindedShiftId: null, clockedOutShiftId: null })).toBe('remind')
    expect(longShiftDecision({ todayMinutes: 0, state: clockedIn, now: at(9), settings, remindedShiftId: '7', clockedOutShiftId: null })).toBeNull()
    expect(longShiftDecision({ todayMinutes: 0, state: clockedIn, now: at(10), settings, remindedShiftId: '7', clockedOutShiftId: null })).toBe('clockOut')
    expect(longShiftDecision({ todayMinutes: 0, state: clockedIn, now: at(11), settings, remindedShiftId: '7', clockedOutShiftId: '7' })).toBeNull()
  })

  it('reminds during a break only when the worked total has reached the limit', () => {
    const onBreak: AttendanceState = { kind: 'break', shiftId: '8', since, breakId: '1', breakName: 'Mittag', locationType: null }
    expect(longShiftDecision({ todayMinutes: 0, state: onBreak, now: at(8), settings, remindedShiftId: null, clockedOutShiftId: null })).toBeNull()
    expect(longShiftDecision({ todayMinutes: 480, state: onBreak, now: at(1), settings, remindedShiftId: null, clockedOutShiftId: null })).toBe('remind')
  })

  it('respects each setting being off', () => {
    expect(longShiftDecision({ todayMinutes: 0, state: clockedIn, now: at(20), settings: { longShiftReminderHours: null, autoClockOutHours: null }, remindedShiftId: null, clockedOutShiftId: null })).toBeNull()
    expect(longShiftDecision({ todayMinutes: 0, state: clockedIn, now: at(20), settings: { longShiftReminderHours: null, autoClockOutHours: 10 }, remindedShiftId: null, clockedOutShiftId: null })).toBe('clockOut')
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
  it('reminds at eight worked hours across a break without repeating every minute', async () => {
    vi.useFakeTimers()
    let now = at(8.74)
    const remind = vi.fn()
    const stop = watchLongShifts({
      getSnapshot: () => ({ state: { ...clockedIn, since: at(4.75) }, todayMinutes: 240 }),
      getSettings: () => ({ longShiftReminderHours: 8, autoClockOutHours: null }),
      now: () => now,
      remind,
      clockOut: vi.fn(async () => {}),
    })
    try {
      expect(remind).not.toHaveBeenCalled()
      now = at(8.75)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(remind).toHaveBeenCalledExactlyOnceWith(8)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(remind).toHaveBeenCalledTimes(1)
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  it('uses closed work from the snapshot when checking the automatic limit', async () => {
    vi.useFakeTimers()
    let now = at(8.74)
    const clockOut = vi.fn(async () => {})
    const stop = watchLongShifts({
      getSnapshot: () => ({
        state: { ...clockedIn, shiftId: 'after-break', since: at(4.75) },
        todayMinutes: 240,
      }),
      getSettings: () => ({ longShiftReminderHours: null, autoClockOutHours: 8 }),
      now: () => now,
      remind: vi.fn(),
      clockOut,
    })
    try {
      expect(clockOut).not.toHaveBeenCalled()
      now = at(8.75)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(clockOut).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(clockOut).toHaveBeenCalledTimes(1)
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  it('reminds, then clocks out, each once, and marks the clock-out before calling it', async () => {
    vi.useFakeTimers()
    let now = at(0)
    const remind = vi.fn()
    const clockOut = vi.fn(async () => {})
    const stop = watchLongShifts({
      getSnapshot: () => ({ state: clockedIn, todayMinutes: 0 }),
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

/**
 * Factorial keeps a clock-out to the minute, so a check that lands up to a minute
 * late turned about every second eight-hour day into 8:01.
 */
describe('watchLongShifts at the exact moment', () => {
  const clockIn = new Date(2026, 10, 5, 9, 0, 40)
  const MINUTE = 60_000
  const HOUR = 60 * MINUTE

  /** Runs the watcher on the real clock calls, with the time faked underneath. */
  function start(over: {
    state?: AttendanceState
    todayMinutes?: number
    settings?: { longShiftReminderHours: number | null; autoClockOutHours: number | null }
    startedAt?: Date
  } = {}) {
    vi.useFakeTimers()
    vi.setSystemTime(over.startedAt ?? clockIn)
    const firedAt: number[] = []
    const remindedAt: number[] = []
    const snapshot = { state: over.state ?? ({ ...clockedIn, since: clockIn } as AttendanceState), todayMinutes: over.todayMinutes ?? 0 }
    const settings = over.settings ?? { longShiftReminderHours: null, autoClockOutHours: 8 }
    const stop = watchLongShifts({
      getSnapshot: () => snapshot,
      getSettings: () => settings,
      remind: () => void remindedAt.push(Date.now()),
      clockOut: vi.fn(async () => void firedAt.push(Date.now())),
    })
    return { stop, firedAt, remindedAt, snapshot, settings }
  }

  afterEach(() => vi.useRealTimers())

  it.each([0, 1, 17, 30, 59])('clocks out exactly at the limit when the app started %i seconds after clock-in', async (seconds) => {
    const { stop, firedAt } = start({ startedAt: new Date(clockIn.getTime() + seconds * 1000) })
    await vi.advanceTimersByTimeAsync(8 * HOUR)
    expect(firedAt).toEqual([clockIn.getTime() + 8 * HOUR])
    stop()
  })

  it('counts recorded work before the break and the running record after it', async () => {
    const resumed = new Date(2026, 10, 5, 13, 45, 23)
    const { stop, firedAt } = start({ state: { ...clockedIn, shiftId: 'after-break', since: resumed }, todayMinutes: 240, startedAt: resumed })
    await vi.advanceTimersByTimeAsync(4 * HOUR)
    expect(firedAt).toEqual([resumed.getTime() + 4 * HOUR])
    stop()
  })

  it('does not clock out a moment before the limit', async () => {
    const { stop, firedAt } = start()
    await vi.advanceTimersByTimeAsync(8 * HOUR - 1)
    expect(firedAt).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(firedAt).toHaveLength(1)
    stop()
  })

  it('reminds exactly at its own limit, and then still clocks out exactly at the other', async () => {
    const { stop, firedAt, remindedAt } = start({ settings: { longShiftReminderHours: 8, autoClockOutHours: 9 } })
    await vi.advanceTimersByTimeAsync(9 * HOUR)
    expect(remindedAt).toEqual([clockIn.getTime() + 8 * HOUR])
    expect(firedAt).toEqual([clockIn.getTime() + 9 * HOUR])
    stop()
  })

  it('stays exact with a limit in a total that is awkward in floating point', async () => {
    // 17 / 60 hours has no exact binary form. Counted in hours, this could stop
    // just short of the limit at the very moment the timer was aimed at.
    const resumed = new Date(2026, 10, 5, 9, 17, 11)
    const { stop, firedAt } = start({ state: { ...clockedIn, since: resumed }, todayMinutes: 17, startedAt: resumed })
    await vi.advanceTimersByTimeAsync(8 * HOUR - 17 * MINUTE)
    expect(firedAt).toEqual([resumed.getTime() + 8 * HOUR - 17 * MINUTE])
    stop()
  })

  it('notices a changed setting within a minute, and is exact from then on', async () => {
    const { stop, firedAt, settings } = start({ settings: { longShiftReminderHours: null, autoClockOutHours: null } })
    await vi.advanceTimersByTimeAsync(HOUR)
    settings.autoClockOutHours = 2
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(firedAt).toEqual([clockIn.getTime() + 2 * HOUR])
    stop()
  })

  it('waits during a break, and is exact again after it', async () => {
    const onBreak: AttendanceState = { kind: 'break', shiftId: '8', since: clockIn, breakId: '1', breakName: 'Mittag', locationType: null }
    const { stop, firedAt, snapshot } = start({ state: onBreak, todayMinutes: 240 })
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(firedAt).toEqual([])

    const resumed = new Date(clockIn.getTime() + HOUR)
    snapshot.state = { ...clockedIn, shiftId: 'after-break', since: resumed }
    await vi.advanceTimersByTimeAsync(4 * HOUR)
    expect(firedAt).toEqual([resumed.getTime() + 4 * HOUR])
    stop()
  })

  it('clocks out only once, and does nothing after being stopped', async () => {
    const { stop, firedAt } = start()
    await vi.advanceTimersByTimeAsync(10 * HOUR)
    expect(firedAt).toHaveLength(1)

    const other = start()
    other.stop()
    await vi.advanceTimersByTimeAsync(10 * HOUR)
    expect(other.firedAt).toEqual([])
    stop()
  })

  it('keeps watching after a reminder throws', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(clockIn)
    const clockOut = vi.fn(async () => {})
    const stop = watchLongShifts({
      getSnapshot: () => ({ state: { ...clockedIn, since: clockIn }, todayMinutes: 0 }),
      getSettings: () => ({ longShiftReminderHours: 1, autoClockOutHours: 2 }),
      remind: () => {
        throw new Error('no notifications here')
      },
      clockOut,
    })
    await vi.advanceTimersByTimeAsync(2 * HOUR)
    expect(clockOut).toHaveBeenCalledTimes(1)
    stop()
  })
})

