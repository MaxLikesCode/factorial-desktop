/**
 * The attendance store: one place that knows what the app currently believes
 * about the clock, and the only place that decides when to ask the server again.
 *
 * It knows nothing about windows, the tray or IPC — it publishes a snapshot and
 * whoever cares subscribes. That is what lets the widget and the tray show the
 * same numbers without a second state living next to this one.
 *
 * Three rules shape everything below:
 *
 * 1. **The API is the truth.** Every state is derived from `openShift` by
 *    `deriveState`; nothing here keeps a parallel "am I clocked in" flag. An
 *    optimistic state is explicitly a guess and lives only until the very next
 *    refresh answers.
 * 2. **A failed write is never shown as a success, and never retried.** This app
 *    writes to a real HR time record. Repeating a clock-in a minute later would
 *    file a time that never happened, so a failure rolls back, says so, and
 *    reloads reality (DESIGN.md, "Kein Offline-Queue").
 * 3. **A failed *read* keeps the last known state** and only marks the snapshot
 *    stale. Blanking the widget because one poll missed would be worse than
 *    showing a slightly old number with a stale hint next to it.
 *
 * Carry-forward C2 (request timeout) is deliberately *not* implemented here.
 * `createNetFetch` in `session.ts` already gives every request a 15 s deadline,
 * and a second racing timeout in the store would only produce two different
 * error messages for one hung socket. What the store owes C2 is the other half:
 * the poll loop is sequential — it awaits the previous round before it starts
 * sleeping — so a slow network stretches the interval instead of stacking
 * requests up behind each other. That is why this is a loop and not a
 * `setInterval` (deviation from the PLAN.md snippet, which used one).
 */

import { deriveState, FALLBACK_BREAK_NAME, type AttendanceState } from '@shared/attendance-state'
import { toLocalDate } from '@shared/time'
import { FactorialError, type FactorialErrorKind } from './factorial/client'
import type { Operations } from './factorial/operations'
import type { BreakConfigOption, LocationType, ShiftSummary } from './factorial/types'

/**
 * Exactly the operations this store calls. Narrower than `Operations` on
 * purpose: `fetchMe` belongs to the auth flow. It also keeps the tests honest —
 * a fake only has to provide what is really used.
 */
export type AttendanceOperations = Pick<
  Operations,
  | 'fetchOpenShift'
  | 'fetchTodayShifts'
  | 'fetchExpectedMinutes'
  | 'fetchBreakConfigurations'
  | 'clockIn'
  | 'breakStart'
  | 'breakEnd'
  | 'clockOut'
>

/** `FactorialError.kind`, plus the bucket for anything that is not one. */
export type SnapshotErrorKind = FactorialErrorKind | 'unknown'

export interface AttendanceSnapshot {
  /** The whole UI hangs off this; `unknown` until the first load answers. */
  state: AttendanceState
  /**
   * Minutes from the day's *closed* shifts only. The running shift is excluded
   * on purpose: its elapsed time is recomputed from `state.since` on every tick
   * (the timer must not count up by itself — DESIGN.md, "Zeitberechnung"), and
   * counting it here as well would show it twice.
   */
  todayMinutes: number
  /**
   * How many of today's closed records arrived without `minutes` (C4). Such a
   * record has not been totalled by Factorial yet, which is a different fact
   * from "worked zero minutes" — it contributes 0 to `todayMinutes`, but not
   * silently: the UI shows the day sum as incomplete while this is above zero.
   */
  incompleteShifts: number
  /**
   * The day's target in minutes — `expectedMinutes` of
   * `attendanceEstimatedTimesConnection` (K8), which the ring compares the
   * worked time against.
   *
   * Three things this deliberately is not: it is not `contractMinutes` (720
   * against a 480 target — a different quantity), it is not that query's own
   * `minutes` (which read 480 at zero minutes worked, so it is no Ist-Zeit), and
   * it is never filled in with eight hours. `null` means "no target known" — a
   * day off, an absence, or a lookup that failed — and `0` is a real target that
   * is passed through as itself.
   */
  expectedMinutes: number | null
  breakOptions: BreakConfigOption[]
  /** The raw reason, in whatever language the server used. */
  lastError: string | null
  /**
   * The machine-readable half of `lastError`. The UI phrases the German text
   * from this — DESIGN.md wants "keine Verbindung" for a network failure and the
   * server's own message for a rejected mutation, and only the kind tells them
   * apart.
   */
  lastErrorKind: SnapshotErrorKind | null
  /** True when the last read failed: what is shown is the last known state. */
  stale: boolean
}

export interface ClockInInput {
  locationType: LocationType
  workplaceId: number | null
}

export interface AttendanceStoreDeps {
  ops: AttendanceOperations
  /** `Int!` in every attendance query — see `Identity.employeeId`. */
  employeeId: number
  /** Injected so tests are deterministic; production passes the real clock. */
  now?: () => Date
  /** Injected for the same reason: the poll loop must be drivable in a test. */
  sleep?: (ms: number) => Promise<void>
  pollIntervalMs?: number
}

/** DESIGN.md, "Synchronisation": background reload every 60 s. */
export const POLL_INTERVAL_MS = 60_000

/**
 * Internal, English on purpose: this never reaches the user. The UI disables the
 * buttons while an action runs, so a caller seeing this has a bug, not a user.
 */
export const ACTION_IN_FLIGHT_MESSAGE = 'another action is already in flight'

/** Marks a state the server has not confirmed yet. Replaced by the next refresh. */
const OPTIMISTIC_SHIFT_ID = 'optimistic'

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface Failure {
  lastError: string
  lastErrorKind: SnapshotErrorKind
}

function describeFailure(error: unknown): Failure {
  if (error instanceof FactorialError) return { lastError: error.message, lastErrorKind: error.kind }
  return {
    lastError: error instanceof Error ? error.message : String(error),
    lastErrorKind: 'unknown',
  }
}

/**
 * The day's worked minutes, and how much of the answer was unusable.
 *
 * Whether the running shift shows up in `attendanceShiftsConnection` at all is
 * unverified, so it is filtered out by id rather than trusted to be absent —
 * double counting the current shift would inflate every day sum.
 */
function summariseDay(
  shifts: ShiftSummary[],
  openShiftId: string | null,
): { todayMinutes: number; incompleteShifts: number } {
  let todayMinutes = 0
  let incompleteShifts = 0
  for (const shift of shifts) {
    if (openShiftId !== null && shift.id === openShiftId) continue
    if (shift.minutes === null) {
      incompleteShifts += 1
      continue
    }
    todayMinutes += shift.minutes
  }
  return { todayMinutes, incompleteShifts }
}

export function createAttendanceStore({
  ops,
  employeeId,
  now = () => new Date(),
  sleep = defaultSleep,
  pollIntervalMs = POLL_INTERVAL_MS,
}: AttendanceStoreDeps) {
  let snapshot: AttendanceSnapshot = {
    state: { kind: 'unknown' },
    todayMinutes: 0,
    incompleteShifts: 0,
    expectedMinutes: null,
    breakOptions: [],
    lastError: null,
    lastErrorKind: null,
    stale: false,
  }

  const listeners = new Set<() => void>()
  let actionInFlight = false

  // Refreshes can overlap — a poll, a window focus and a mutation's reload all
  // trigger one. Responses may come back out of order, so each round takes a
  // ticket and an older ticket never overwrites a newer answer. Without this a
  // slow poll started before a clock-in could land after it and put the widget
  // back to "ausgestempelt".
  let startedRefreshes = 0
  let appliedRefresh = 0

  let polling = false
  /** Bumped on every start and stop; only the newest poll loop may run. */
  let loopGeneration = 0
  let wakeFromSleep: () => void = () => {}

  function emit(next: Partial<AttendanceSnapshot>): void {
    snapshot = { ...snapshot, ...next }
    // Copied: a listener is allowed to unsubscribe itself while being notified.
    for (const listener of [...listeners]) listener()
  }

  async function loadBreakOptions(): Promise<void> {
    if (snapshot.breakOptions.length > 0) return
    try {
      emit({ breakOptions: await ops.fetchBreakConfigurations() })
    } catch {
      // Non-fatal and deliberately not marked stale: the break menu stays empty
      // until the next refresh retries. Clocking in and out works without it.
    }
  }

  /**
   * Reads the truth and publishes it. Never throws: it is called from the poll
   * loop and from the mutation path, and both need "the read failed" to be a
   * state, not an exception.
   */
  async function refresh(): Promise<void> {
    const ticket = (startedRefreshes += 1)
    try {
      const today = toLocalDate(now())
      const [openShift, shifts, expectedMinutes] = await Promise.all([
        ops.fetchOpenShift(employeeId),
        ops.fetchTodayShifts(employeeId, today),
        // The target only decorates the ring; the timer has to work without it.
        // So its rejection is neutralised *before* it joins the two hard queries
        // and can never drag the state down with it. (PLAN.md fetches it in a
        // second, sequential `try` after this `Promise.all`. Same guarantee,
        // one round trip fewer, and no extra `await` between the ticket check
        // and the emit below — every added await widens the window in which a
        // newer refresh can overtake this one.)
        ops.fetchExpectedMinutes(employeeId, today).catch(() => null),
      ])
      if (ticket < appliedRefresh) return
      appliedRefresh = ticket
      emit({
        // Reset rather than kept: a goal that could not be re-read is a number
        // the ring should stop showing, not one to carry forward silently.
        expectedMinutes,
        // Throws on an unparseable timestamp, by design — caught below and shown
        // as stale. A guessed start time is worse than an old one.
        state: deriveState(openShift),
        ...summariseDay(shifts, openShift?.id ?? null),
        stale: false,
        // A read that worked retires the previous reason for failing. Without
        // this the widget keeps a recovered network hiccup on screen forever.
        // Safe for the mutation path: `mutate` restates its own failure right
        // after the reload precisely so the user still reads about their click.
        lastError: null,
        lastErrorKind: null,
      })
    } catch (error) {
      if (ticket < appliedRefresh) return
      appliedRefresh = ticket
      // An expired session is a verdict, not a hiccup: surface it so the UI can
      // offer a new sign-in instead of showing a frozen timer forever.
      if (error instanceof FactorialError && error.kind === 'unauthenticated') {
        emit({
          state: { kind: 'unauthenticated' },
          stale: false,
          ...describeFailure(error),
        })
        return
      }
      // Everything else: keep the last known state rather than blanking the widget.
      emit({ stale: true, ...describeFailure(error) })
      return
    }
    await loadBreakOptions()
  }

  /**
   * Show the target state at once, then confirm it against the server.
   *
   * On failure the previous state comes back, the reason is kept, and reality is
   * reloaded — but the write is never repeated. A clock-in that is retried a
   * minute later records a minute that nobody worked.
   */
  async function mutate(optimistic: AttendanceState, action: () => Promise<void>): Promise<void> {
    // Thrown before anything is emitted: a refused second click must leave the
    // snapshot of the first one completely untouched.
    if (actionInFlight) throw new Error(ACTION_IN_FLIGHT_MESSAGE)

    const previous = snapshot.state
    actionInFlight = true
    emit({ state: optimistic, lastError: null, lastErrorKind: null })
    try {
      try {
        await action()
      } catch (error) {
        const failure = describeFailure(error)
        emit({ state: previous, ...failure })
        // The rollback target may itself be out of date — the mutation might
        // have failed *because* the server state moved. So reload, then restate
        // the reason: the reload can overwrite `lastError` with its own trouble,
        // and the user needs to read about the click they just made.
        await refresh()
        emit(failure)
        throw error
      }
      // Confirm: the mutation returns the new shift (C5), but the store reloads
      // instead of trusting the payload. One round trip slower, one source of
      // truth fewer.
      await refresh()
    } finally {
      actionInFlight = false
    }
  }

  /**
   * The provisional "clocked in" state. Built directly rather than round-tripped
   * through an `OpenShift` and `deriveState`: the round trip would push a
   * timestamp through a parser that is allowed to throw, and it would drop the
   * sub-second part for no gain. `since` is the click, which is exactly the
   * `now` the mutation is sent with.
   */
  function optimisticClockedIn(location: {
    locationType: string | null
    workplaceId: number | null
  }): AttendanceState {
    return { kind: 'in', shiftId: OPTIMISTIC_SHIFT_ID, since: now(), ...location }
  }

  async function pollLoop(generation: number): Promise<void> {
    // `polling` alone is not enough to own the loop. A stop immediately followed
    // by a start — which is exactly what suspend/resume does — flips the flag
    // back to true before this loop's continuation gets to re-read it, so the
    // old loop would sail past the check and run alongside the new one, doubling
    // the request rate against a real HR API. The generation makes ownership
    // explicit: only the newest loop keeps going.
    const owns = (): boolean => polling && generation === loopGeneration
    while (owns()) {
      try {
        await refresh()
      } catch {
        // `refresh` handles its own failures; this only catches a listener that
        // threw. One bad tick must not end background synchronisation for good.
      }
      if (!owns()) break
      // Racing the sleep against `stopPolling` keeps shutdown immediate instead
      // of waiting out a full minute.
      await new Promise<void>((resolve) => {
        wakeFromSleep = resolve
        void sleep(pollIntervalMs).then(resolve)
      })
    }
  }

  return {
    getSnapshot: (): AttendanceSnapshot => snapshot,

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    refresh,

    async clockIn(input: ClockInInput): Promise<void> {
      await mutate(optimisticClockedIn(input), () => ops.clockIn({ now: now(), ...input }))
    },

    async startBreak(breakConfigurationId: string): Promise<void> {
      const option = snapshot.breakOptions.find((o) => o.id === breakConfigurationId)
      await mutate(
        {
          kind: 'break',
          shiftId: OPTIMISTIC_SHIFT_ID,
          // A break opens its own shift record, so its clock starts now. Which
          // `clockIn` the server reports for an open break shift is unverified;
          // the refresh a moment later replaces this either way.
          since: now(),
          breakId: breakConfigurationId,
          breakName: option?.name ?? FALLBACK_BREAK_NAME,
          // Carried over from the shift being interrupted: a break inherits the
          // work location, it does not pick a new one. Taken from the state
          // rather than from settings, because settings hold the preference for
          // the *next* clock-in, which may differ from where this shift runs.
          locationType: snapshot.state.kind === 'in' ? snapshot.state.locationType : null,
        },
        () => ops.breakStart({ now: now(), breakConfigurationId }),
      )
    },

    async endBreak(): Promise<void> {
      // Location is left null rather than guessed: resuming opens a new record
      // and the refresh right after carries the real one.
      await mutate(optimisticClockedIn({ locationType: null, workplaceId: null }), () =>
        ops.breakEnd({ now: now() }),
      )
    },

    async clockOut(): Promise<void> {
      await mutate({ kind: 'out' }, () => ops.clockOut({ now: now() }))
    },

    /** Idempotent: a second call joins the loop that is already running. */
    startPolling(): void {
      if (polling) return
      polling = true
      void pollLoop((loopGeneration += 1))
    },

    stopPolling(): void {
      polling = false
      // Orphans any loop still suspended in its sleep, so a start on the very
      // next line cannot revive it.
      loopGeneration += 1
      wakeFromSleep()
    },
  }
}

export type AttendanceStore = ReturnType<typeof createAttendanceStore>
