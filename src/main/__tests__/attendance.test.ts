import { describe, it, expect, vi } from 'vitest'
import type { OpenShift } from '@shared/attendance-state'
import {
  ACTION_IN_FLIGHT_MESSAGE,
  createAttendanceStore,
  type AttendanceStoreDeps,
} from '../attendance'
import { FactorialError } from '../factorial/client'
import type { BreakConfigOption, LocationType, ShiftSummary } from '../factorial/types'

const EMPLOYEE_ID = 1111111
const TODAY = '2026-08-12'
/** Fixed clock: 2026-08-12 09:00:00 local (vitest pins TZ to Europe/Berlin). */
const NOW = new Date(2026, 7, 12, 9, 0, 0)

const OPEN: OpenShift = {
  id: '543343386',
  date: TODAY,
  clockIn: '2000-01-01T08:30:00Z',
  clockInOffset: '+02:00',
  locationType: 'office',
  workplaceId: 3333333,
  timeSettingsBreakConfiguration: null,
}

const ON_BREAK: OpenShift = {
  ...OPEN,
  id: '543343999',
  clockIn: '2000-01-01T12:00:00Z',
  timeSettingsBreakConfiguration: { id: '19613', name: 'Mittagspause' },
}

/**
 * The operations the store consumes, all scripted. Behaviour is set per test via
 * the mock helpers rather than through constructor overrides, so every mock keeps
 * its precise type.
 */
/**
 * A day record. Work by default — a break is a shift record like any other and
 * differs only in these two fields, which is exactly what made it easy to add
 * into the worked total by accident.
 */
function shift(
  id: string,
  minutes: number | null,
  kind: 'work' | 'break' = 'work',
  /** Time of day the record started, for the order the day is drawn in. */
  startedAt = '08:00:00',
): ShiftSummary {
  return {
    id,
    date: TODAY,
    minutes,
    workable: kind === 'work',
    breakConfiguration: kind === 'break' ? { id: '19613', name: 'Mittagspause' } : null,
    clockInWithSeconds: `${TODAY}T${startedAt}+00:00`,
    clockInOffset: '+02:00',
  }
}

function makeOps() {
  return {
    fetchOpenShift: vi.fn(async (_employeeId: number): Promise<OpenShift | null> => null),
    fetchTodayShifts: vi.fn(
      async (_employeeId: number, _date: string): Promise<ShiftSummary[]> => [
        shift('1', 120),
      ],
    ),
    fetchExpectedMinutes: vi.fn(
      async (_employeeId: number, _date: string): Promise<number | null> => 480,
    ),
    fetchBreakConfigurations: vi.fn(
      async (): Promise<BreakConfigOption[]> => [{ id: '19613', name: 'Mittagspause' }],
    ),
    clockIn: vi.fn(
      async (_input: {
        now: Date
        locationType: LocationType
        workplaceId: number | null
      }): Promise<void> => {},
    ),
    breakStart: vi.fn(async (_input: { now: Date; breakConfigurationId: string }): Promise<void> => {}),
    breakEnd: vi.fn(async (_input: { now: Date }): Promise<void> => {}),
    clockOut: vi.fn(async (_input: { now: Date }): Promise<void> => {}),
  }
}

type Ops = ReturnType<typeof makeOps>

function makeStore(ops: Ops, extra: Partial<AttendanceStoreDeps> = {}) {
  return createAttendanceStore({ ops, employeeId: EMPLOYEE_ID, now: () => NOW, ...extra })
}

/** A promise plus its resolver, for holding a call open until the test says go. */
function gate(): { wait: Promise<void>; release: () => void } {
  let release: () => void = () => {}
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}

/** Lets pending microtasks and already-resolved promises run to completion. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** A hand-cranked clock for the poll loop: nothing sleeps until the test says so. */
function makeSleeper() {
  const sleepers: (() => void)[] = []
  return {
    pending: () => sleepers.length,
    sleep: (_ms: number) =>
      new Promise<void>((resolve) => {
        sleepers.push(resolve)
      }),
    wake: () => {
      const next = sleepers.shift()
      if (!next) throw new Error('nothing is sleeping')
      next()
    },
  }
}

describe('refresh', () => {
  it('starts in the unknown state before anything is loaded', () => {
    const snapshot = makeStore(makeOps()).getSnapshot()
    expect(snapshot.state.kind).toBe('unknown')
    expect(snapshot.stale).toBe(false)
    expect(snapshot.lastError).toBeNull()
  })

  it('reports clocked out after refreshing with no open shift', async () => {
    const store = makeStore(makeOps())
    await store.refresh()
    expect(store.getSnapshot().state.kind).toBe('out')
  })

  it('reports clocked in when a shift is open', async () => {
    const ops = makeOps()
    ops.fetchOpenShift.mockResolvedValue(OPEN)
    const store = makeStore(ops)
    await store.refresh()

    const state = store.getSnapshot().state
    expect(state.kind).toBe('in')
    if (state.kind !== 'in') throw new Error('unreachable')
    // 08:30 local at +02:00 == 06:30Z. A wrong instant here is the expensive bug.
    expect(state.since.toISOString()).toBe('2026-08-12T06:30:00.000Z')
  })

  it('queries the day the injected clock reports, not the machine clock', async () => {
    const ops = makeOps()
    const store = makeStore(ops)
    await store.refresh()
    expect(ops.fetchTodayShifts).toHaveBeenCalledWith(EMPLOYEE_ID, TODAY)
    expect(ops.fetchOpenShift).toHaveBeenCalledWith(EMPLOYEE_ID)
  })

  /**
   * Reported from the real account: the widget read 7:56 for a day Factorial had
   * at 7:23 — the 33 minutes of break, added into the worked total.
   *
   * Starting a break closes the work record and opens a break record, so both
   * arrive in the same list, and the day query used to ask only for `id date
   * minutes`. With nothing to tell them apart, every break was worked time. On a
   * widget people use to decide when to clock out, that sends them home early.
   */
  it('leaves break records out of the day’s worked minutes', async () => {
    const ops = makeOps()
    ops.fetchTodayShifts.mockResolvedValue([
      shift('1', 90),
      shift('2', 33, 'break'),
      shift('3', 45),
    ])
    const store = makeStore(ops)
    await store.refresh()

    expect(store.getSnapshot().todayMinutes).toBe(135)
  })

  /**
   * Neither field is confirmed on a CLOSED record, so both are read and either
   * one is believed. They are not two truths about one question — they are one
   * question asked twice, and a record that answers it only once still answers.
   */
  it('believes either signal on its own', async () => {
    const ops = makeOps()
    ops.fetchTodayShifts.mockResolvedValue([
      shift('1', 90),
      // Says it is not workable, but names no break configuration.
      {
        id: '2',
        date: TODAY,
        minutes: 20,
        workable: false,
        breakConfiguration: null,
        clockInWithSeconds: `${TODAY}T09:00:00+00:00`,
        clockInOffset: '+02:00',
      },
      // Names a break configuration, but does not say it is unworkable.
      {
        id: '3',
        date: TODAY,
        minutes: 13,
        workable: null,
        breakConfiguration: { id: '19613', name: 'Mittagspause' },
        clockInWithSeconds: `${TODAY}T10:00:00+00:00`,
        clockInOffset: '+02:00',
      },
    ])
    const store = makeStore(ops)
    await store.refresh()

    expect(store.getSnapshot().todayMinutes).toBe(90)
  })

  /**
   * A break Factorial has not totalled yet says nothing about how complete the
   * day's WORKED time is. Letting it mark the day incomplete would put a warning
   * under a number that is already right.
   */
  it('does not let an untotalled break mark the day incomplete', async () => {
    const ops = makeOps()
    ops.fetchTodayShifts.mockResolvedValue([shift('1', 90), shift('2', null, 'break')])
    const store = makeStore(ops)
    await store.refresh()

    expect(store.getSnapshot().todayMinutes).toBe(90)
    expect(store.getSnapshot().incompleteShifts).toBe(0)
  })

  /**
   * The bar draws the day in the order it happened, and
   * `attendanceShiftsConnection` promises no order at all — so a day that came
   * back shuffled would put the break in the wrong place.
   */
  it('puts the day in the order it happened, whatever order it arrived in', async () => {
    const ops = makeOps()
    ops.fetchTodayShifts.mockResolvedValue([
      shift('3', 173, 'work', '13:03:00'),
      shift('1', 270, 'work', '08:00:00'),
      shift('2', 33, 'break', '12:30:00'),
    ])
    const store = makeStore(ops)
    await store.refresh()

    expect(store.getSnapshot().daySegments).toEqual([
      { kind: 'work', minutes: 270 },
      { kind: 'break', minutes: 33 },
      { kind: 'work', minutes: 173 },
    ])
    // And the same records still sum the way they did before.
    expect(store.getSnapshot().todayMinutes).toBe(443)
  })

  /**
   * A start that cannot be read costs the record its position, not its length:
   * losing the whole bar over one bad timestamp would be the larger failure.
   */
  it('keeps a record whose start is unreadable, at the end', async () => {
    const ops = makeOps()
    ops.fetchTodayShifts.mockResolvedValue([
      { ...shift('1', 60, 'work'), clockInWithSeconds: null, clockInOffset: null },
      shift('2', 90, 'work', '09:00:00'),
    ])
    const store = makeStore(ops)
    await store.refresh()

    expect(store.getSnapshot().daySegments).toEqual([
      { kind: 'work', minutes: 90 },
      { kind: 'work', minutes: 60 },
    ])
    expect(store.getSnapshot().todayMinutes).toBe(150)
  })

  it('sums today’s minutes across the shifts a break split apart', async () => {
    const ops = makeOps()
    ops.fetchTodayShifts.mockResolvedValue([
      shift('1', 90),
      shift('2', 45),
    ])
    const store = makeStore(ops)
    await store.refresh()
    expect(store.getSnapshot().todayMinutes).toBe(135)
    expect(store.getSnapshot().incompleteShifts).toBe(0)
  })

  it('leaves the running shift out of the day sum, so the live timer cannot double count', async () => {
    const ops = makeOps()
    ops.fetchOpenShift.mockResolvedValue(OPEN)
    ops.fetchTodayShifts.mockResolvedValue([
      shift('1', 90),
      shift(OPEN.id, 25),
    ])
    const store = makeStore(ops)
    await store.refresh()
    expect(store.getSnapshot().todayMinutes).toBe(90)
  })

  it('counts a record without minutes instead of silently adding it as zero', async () => {
    const ops = makeOps()
    ops.fetchTodayShifts.mockResolvedValue([
      shift('1', 90),
      shift('2', null),
    ])
    const store = makeStore(ops)
    await store.refresh()
    expect(store.getSnapshot().todayMinutes).toBe(90)
    expect(store.getSnapshot().incompleteShifts).toBe(1)
  })

  it('notifies subscribers when the snapshot changes', async () => {
    const store = makeStore(makeOps())
    const listener = vi.fn()
    store.subscribe(listener)
    await store.refresh()
    expect(listener).toHaveBeenCalled()
  })

  it('stops notifying after unsubscribe', async () => {
    const store = makeStore(makeOps())
    const listener = vi.fn()
    store.subscribe(listener)()
    await store.refresh()
    expect(listener).not.toHaveBeenCalled()
  })

  it('loads the break options once and keeps them across refreshes', async () => {
    const ops = makeOps()
    const store = makeStore(ops)
    await store.refresh()
    await store.refresh()
    expect(ops.fetchBreakConfigurations).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().breakOptions).toEqual([{ id: '19613', name: 'Mittagspause' }])
  })

  it('survives a failing break-option load without marking the snapshot stale', async () => {
    const ops = makeOps()
    ops.fetchBreakConfigurations.mockRejectedValue(new Error('offline'))
    const store = makeStore(ops)
    await store.refresh()
    expect(store.getSnapshot().stale).toBe(false)
    expect(store.getSnapshot().breakOptions).toEqual([])
    expect(store.getSnapshot().state.kind).toBe('out')
  })

  it('marks the snapshot stale when a refresh fails, keeping the last known state', async () => {
    const ops = makeOps()
    ops.fetchOpenShift.mockResolvedValue(OPEN)
    const store = makeStore(ops)
    await store.refresh()

    ops.fetchOpenShift.mockRejectedValueOnce(new Error('offline'))
    await store.refresh()
    expect(store.getSnapshot().state.kind).toBe('in')
    expect(store.getSnapshot().stale).toBe(true)
  })

  it('carries the error kind so the UI can phrase it in German', async () => {
    const ops = makeOps()
    ops.fetchOpenShift.mockRejectedValue(new FactorialError('network', 'request timed out after 15000 ms'))
    const store = makeStore(ops)
    await store.refresh()
    expect(store.getSnapshot().lastErrorKind).toBe('network')
    expect(store.getSnapshot().lastError).toMatch(/timed out/)
  })

  it('retires the error once a read succeeds again', async () => {
    const ops = makeOps()
    ops.fetchOpenShift.mockRejectedValueOnce(new FactorialError('network', 'request timed out after 15000 ms'))
    const store = makeStore(ops)

    await store.refresh()
    expect(store.getSnapshot().lastError).toMatch(/timed out/)
    expect(store.getSnapshot().stale).toBe(true)

    await store.refresh()
    expect(store.getSnapshot().stale).toBe(false)
    // Without this the widget shows a recovered hiccup for the rest of the day.
    expect(store.getSnapshot().lastError).toBeNull()
    expect(store.getSnapshot().lastErrorKind).toBeNull()
  })

  it('reports an unparseable shift as stale rather than showing a guessed time', async () => {
    const ops = makeOps()
    ops.fetchOpenShift.mockResolvedValue({ ...OPEN, clockInOffset: 'nonsense' })
    const store = makeStore(ops)
    await store.refresh()
    expect(store.getSnapshot().state.kind).toBe('unknown')
    expect(store.getSnapshot().stale).toBe(true)
    expect(store.getSnapshot().lastErrorKind).toBe('unknown')
  })

  it('reports an expired session as unauthenticated rather than merely stale', async () => {
    const ops = makeOps()
    ops.fetchOpenShift.mockRejectedValue(new FactorialError('unauthenticated', 'session rejected (HTTP 401)'))
    const store = makeStore(ops)
    await store.refresh()
    expect(store.getSnapshot().state.kind).toBe('unauthenticated')
    expect(store.getSnapshot().stale).toBe(false)
  })

  it('clears the stale flag once a refresh succeeds again', async () => {
    const ops = makeOps()
    ops.fetchOpenShift.mockRejectedValueOnce(new Error('offline'))
    const store = makeStore(ops)
    await store.refresh()
    expect(store.getSnapshot().stale).toBe(true)
    await store.refresh()
    expect(store.getSnapshot().stale).toBe(false)
  })

  it('ignores a slow refresh that lands after a newer one', async () => {
    const ops = makeOps()
    const slow = gate()
    ops.fetchOpenShift.mockImplementationOnce(async () => {
      await slow.wait
      return null
    })
    const store = makeStore(ops)

    const first = store.refresh()
    ops.fetchOpenShift.mockResolvedValue(OPEN)
    await store.refresh()
    expect(store.getSnapshot().state.kind).toBe('in')

    slow.release()
    await first
    // The stale answer must not overwrite the newer one with "clocked out".
    expect(store.getSnapshot().state.kind).toBe('in')
  })
})

describe('daily target', () => {
  it('is null before the first refresh', () => {
    expect(makeStore(makeOps()).getSnapshot().expectedMinutes).toBeNull()
  })

  it('carries the day’s expectedMinutes into the snapshot', async () => {
    const ops = makeOps()
    const store = makeStore(ops)
    await store.refresh()
    expect(store.getSnapshot().expectedMinutes).toBe(480)
    expect(ops.fetchExpectedMinutes).toHaveBeenCalledWith(EMPLOYEE_ID, TODAY)
  })

  it('stays null on a day the API has no target for', async () => {
    const ops = makeOps()
    ops.fetchExpectedMinutes.mockResolvedValue(null)
    const store = makeStore(ops)
    await store.refresh()
    expect(store.getSnapshot().expectedMinutes).toBeNull()
  })

  it('passes a zero target through instead of inventing eight hours', async () => {
    // A public holiday really does answer 0. A `?? 8 * 60` fallback here would
    // put an eight-hour goal on a day nobody is expected to work.
    const ops = makeOps()
    ops.fetchExpectedMinutes.mockResolvedValue(0)
    const store = makeStore(ops)
    await store.refresh()
    expect(store.getSnapshot().expectedMinutes).toBe(0)
  })

  it('keeps the rest of the refresh alive when only the target lookup fails', async () => {
    // A missing target must not blank the timer — it only costs the ring its goal.
    const ops = makeOps()
    ops.fetchExpectedMinutes.mockRejectedValue(new FactorialError('network', 'boom'))
    const store = makeStore(ops)
    await store.refresh()
    const snapshot = store.getSnapshot()
    expect(snapshot.state.kind).toBe('out')
    expect(snapshot.todayMinutes).toBe(120)
    expect(snapshot.expectedMinutes).toBeNull()
    // The read as a whole worked, so nothing is stale and no error is shown.
    expect(snapshot.stale).toBe(false)
    expect(snapshot.lastError).toBeNull()
  })

  it('drops a target that a later refresh could no longer read', async () => {
    const ops = makeOps()
    const store = makeStore(ops)
    await store.refresh()
    expect(store.getSnapshot().expectedMinutes).toBe(480)

    ops.fetchExpectedMinutes.mockRejectedValue(new FactorialError('network', 'boom'))
    await store.refresh()
    // Keeping yesterday's goal on the ring would be a quietly wrong number.
    expect(store.getSnapshot().expectedMinutes).toBeNull()
  })
})

describe('optimistic updates', () => {
  it('shows the clocked-in state immediately, before the server confirms', async () => {
    const ops = makeOps()
    const pending = gate()
    ops.clockIn.mockImplementation(async () => {
      await pending.wait
    })
    const store = makeStore(ops)
    await store.refresh()

    const running = store.clockIn({ locationType: 'office', workplaceId: 3333333 })
    const optimistic = store.getSnapshot().state
    expect(optimistic.kind).toBe('in')
    if (optimistic.kind !== 'in') throw new Error('unreachable')
    expect(optimistic.since).toEqual(NOW)
    expect(optimistic.locationType).toBe('office')

    ops.fetchOpenShift.mockResolvedValue(OPEN)
    pending.release()
    await running
    expect(store.getSnapshot().state.kind).toBe('in')
    // The confirmed state replaces the guess, down to the shift id.
    const confirmed = store.getSnapshot().state
    if (confirmed.kind !== 'in') throw new Error('unreachable')
    expect(confirmed.shiftId).toBe(OPEN.id)
  })

  it('sends the mutation with the injected clock and the chosen location', async () => {
    const ops = makeOps()
    const store = makeStore(ops)
    await store.refresh()
    await store.clockIn({ locationType: 'work_from_home', workplaceId: null })
    expect(ops.clockIn).toHaveBeenCalledWith({
      now: NOW,
      locationType: 'work_from_home',
      workplaceId: null,
    })
  })

  it('rolls back to the previous state when the mutation fails', async () => {
    const ops = makeOps()
    ops.clockIn.mockRejectedValue(new Error('Already clocked in'))
    const store = makeStore(ops)
    await store.refresh()
    expect(store.getSnapshot().state.kind).toBe('out')

    await expect(store.clockIn({ locationType: 'office', workplaceId: null })).rejects.toThrow()
    expect(store.getSnapshot().state.kind).toBe('out')
    expect(store.getSnapshot().lastError).toMatch(/Already clocked in/)
  })

  it('keeps the failed action as the reason even when the reload fails too', async () => {
    const ops = makeOps()
    ops.clockIn.mockRejectedValue(new Error('Already clocked in'))
    ops.fetchOpenShift.mockRejectedValue(new Error('offline'))
    const store = makeStore(ops)

    await expect(store.clockIn({ locationType: 'office', workplaceId: null })).rejects.toThrow()
    expect(store.getSnapshot().lastError).toMatch(/Already clocked in/)
    expect(store.getSnapshot().stale).toBe(true)
  })

  it('reloads the real state after a failed mutation', async () => {
    const ops = makeOps()
    ops.clockIn.mockRejectedValue(new Error('boom'))
    const store = makeStore(ops)
    await store.refresh()
    const before = ops.fetchOpenShift.mock.calls.length

    await expect(store.clockIn({ locationType: 'office', workplaceId: null })).rejects.toThrow()
    expect(ops.fetchOpenShift.mock.calls.length).toBe(before + 1)
  })

  it('never retries a failed mutation, because a late clock-in writes a wrong time', async () => {
    const ops = makeOps()
    ops.clockIn.mockRejectedValue(new Error('boom'))
    const store = makeStore(ops)
    await store.refresh()
    await expect(store.clockIn({ locationType: 'office', workplaceId: null })).rejects.toThrow()
    expect(ops.clockIn).toHaveBeenCalledTimes(1)
  })

  it('rejects a second action while one is still in flight', async () => {
    const ops = makeOps()
    const pending = gate()
    ops.clockIn.mockImplementation(async () => {
      await pending.wait
    })
    const store = makeStore(ops)
    await store.refresh()

    const first = store.clockIn({ locationType: 'office', workplaceId: null })
    await expect(store.clockIn({ locationType: 'office', workplaceId: null })).rejects.toThrow(
      new RegExp(ACTION_IN_FLIGHT_MESSAGE, 'i'),
    )
    // The refused second click must not disturb what the first one is showing.
    expect(store.getSnapshot().state.kind).toBe('in')
    expect(store.getSnapshot().lastError).toBeNull()
    expect(ops.clockIn).toHaveBeenCalledTimes(1)

    pending.release()
    await first
  })

  it('accepts the next action once the previous one finished', async () => {
    const ops = makeOps()
    const store = makeStore(ops)
    await store.refresh()
    await store.clockIn({ locationType: 'office', workplaceId: null })
    await store.clockOut()
    expect(ops.clockOut).toHaveBeenCalledTimes(1)
  })

  it('starts a break optimistically with the chosen label', async () => {
    const ops = makeOps()
    ops.fetchOpenShift.mockResolvedValue(OPEN)
    const pending = gate()
    ops.breakStart.mockImplementation(async () => {
      await pending.wait
    })
    const store = makeStore(ops)
    await store.refresh()

    const running = store.startBreak('19613')
    const optimistic = store.getSnapshot().state
    expect(optimistic.kind).toBe('break')
    if (optimistic.kind !== 'break') throw new Error('unreachable')
    expect(optimistic.breakName).toBe('Mittagspause')
    expect(optimistic.breakId).toBe('19613')

    ops.fetchOpenShift.mockResolvedValue(ON_BREAK)
    pending.release()
    await running
    expect(ops.breakStart).toHaveBeenCalledWith({ now: NOW, breakConfigurationId: '19613' })
    expect(store.getSnapshot().state.kind).toBe('break')
  })

  it('falls back to a generic break label when the id is not in the loaded options', async () => {
    const ops = makeOps()
    ops.fetchOpenShift.mockResolvedValue(OPEN)
    const pending = gate()
    ops.breakStart.mockImplementation(async () => {
      await pending.wait
    })
    const store = makeStore(ops)
    await store.refresh()

    const running = store.startBreak('99999')
    const optimistic = store.getSnapshot().state
    if (optimistic.kind !== 'break') throw new Error('unreachable')
    expect(optimistic.breakName).toBe('Pause')

    pending.release()
    await running
  })

  it('shows the clocked-in state while a break is being ended', async () => {
    const ops = makeOps()
    ops.fetchOpenShift.mockResolvedValue(ON_BREAK)
    const pending = gate()
    ops.breakEnd.mockImplementation(async () => {
      await pending.wait
    })
    const store = makeStore(ops)
    await store.refresh()
    expect(store.getSnapshot().state.kind).toBe('break')

    const running = store.endBreak()
    expect(store.getSnapshot().state.kind).toBe('in')

    ops.fetchOpenShift.mockResolvedValue(OPEN)
    pending.release()
    await running
    expect(ops.breakEnd).toHaveBeenCalledWith({ now: NOW })
  })

  it('shows the clocked-out state while clocking out', async () => {
    const ops = makeOps()
    ops.fetchOpenShift.mockResolvedValue(OPEN)
    const pending = gate()
    ops.clockOut.mockImplementation(async () => {
      await pending.wait
    })
    const store = makeStore(ops)
    await store.refresh()

    const running = store.clockOut()
    expect(store.getSnapshot().state.kind).toBe('out')

    ops.fetchOpenShift.mockResolvedValue(null)
    pending.release()
    await running
    expect(ops.clockOut).toHaveBeenCalledWith({ now: NOW })
    expect(store.getSnapshot().state.kind).toBe('out')
  })
})

describe('polling', () => {
  it('refreshes once immediately and then on every wake-up', async () => {
    const ops = makeOps()
    const sleeper = makeSleeper()
    const store = makeStore(ops, { sleep: sleeper.sleep, pollIntervalMs: 60_000 })

    store.startPolling()
    await settle()
    expect(ops.fetchOpenShift).toHaveBeenCalledTimes(1)

    sleeper.wake()
    await settle()
    expect(ops.fetchOpenShift).toHaveBeenCalledTimes(2)

    store.stopPolling()
  })

  it('waits for the previous request before sleeping, so requests never stack up', async () => {
    const ops = makeOps()
    const sleeper = makeSleeper()
    const slow = gate()
    ops.fetchOpenShift.mockImplementation(async () => {
      await slow.wait
      return null
    })
    const store = makeStore(ops, { sleep: sleeper.sleep, pollIntervalMs: 60_000 })

    store.startPolling()
    await settle()
    // The request is still open: nothing is sleeping and nothing was re-issued.
    expect(ops.fetchOpenShift).toHaveBeenCalledTimes(1)
    expect(sleeper.pending()).toBe(0)

    slow.release()
    await settle()
    expect(sleeper.pending()).toBe(1)

    store.stopPolling()
  })

  it('stops polling when told to, even while asleep', async () => {
    const ops = makeOps()
    const sleeper = makeSleeper()
    const store = makeStore(ops, { sleep: sleeper.sleep, pollIntervalMs: 60_000 })

    store.startPolling()
    await settle()
    store.stopPolling()
    await settle()

    expect(ops.fetchOpenShift).toHaveBeenCalledTimes(1)
    // A sleeper that wakes after the stop must not start another round.
    if (sleeper.pending() > 0) sleeper.wake()
    await settle()
    expect(ops.fetchOpenShift).toHaveBeenCalledTimes(1)
  })

  it('does not leave two loops running when a stop is followed straight by a start', async () => {
    // The suspend/resume path does exactly this. The old loop is parked inside
    // its sleep, so it re-reads `polling` only after `startPolling` has already
    // set it back to true.
    const ops = makeOps()
    const sleeper = makeSleeper()
    const store = makeStore(ops, { sleep: sleeper.sleep, pollIntervalMs: 60_000 })

    store.startPolling()
    await settle()
    expect(sleeper.pending()).toBe(1)

    store.stopPolling()
    store.startPolling()
    await settle()

    // Two refreshes so far: one per start.
    expect(ops.fetchOpenShift).toHaveBeenCalledTimes(2)
    // Two sleepers are registered, but one of them belongs to the orphaned loop:
    // `stopPolling` resolves the race promise, not the fake sleeper's timer.
    expect(sleeper.pending()).toBe(2)

    // Wake both. The orphan must fall out of its loop without refreshing; only
    // the live loop may come round again. Before the generation guard both woke
    // into a refresh and the count went to 4.
    sleeper.wake()
    await settle()
    sleeper.wake()
    await settle()
    expect(ops.fetchOpenShift).toHaveBeenCalledTimes(3)

    store.stopPolling()
  })

  it('does not start a second loop when startPolling is called twice', async () => {
    const ops = makeOps()
    const sleeper = makeSleeper()
    const store = makeStore(ops, { sleep: sleeper.sleep, pollIntervalMs: 60_000 })

    store.startPolling()
    store.startPolling()
    await settle()
    expect(ops.fetchOpenShift).toHaveBeenCalledTimes(1)
    expect(sleeper.pending()).toBe(1)

    store.stopPolling()
  })

  it('keeps polling after a failed poll', async () => {
    const ops = makeOps()
    const sleeper = makeSleeper()
    ops.fetchOpenShift.mockRejectedValue(new Error('offline'))
    const store = makeStore(ops, { sleep: sleeper.sleep, pollIntervalMs: 60_000 })

    store.startPolling()
    await settle()
    expect(store.getSnapshot().stale).toBe(true)

    sleeper.wake()
    await settle()
    expect(ops.fetchOpenShift).toHaveBeenCalledTimes(2)

    store.stopPolling()
  })
})
