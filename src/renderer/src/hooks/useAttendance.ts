import { useEffect, useState } from 'react'
import { deserialiseSnapshot, type AppSnapshot } from '@shared/ipc-contract'

/**
 * What the widget shows before the main process has answered. `unknown` is a
 * real state of the store, not a placeholder: the UI renders it as "Lädt …" and
 * shows no time at all, because a fabricated `0:00:00` in a time tracker is
 * worse than an honest dash.
 */
const INITIAL: AppSnapshot = {
  state: { kind: 'unknown' },
  todayMinutes: 0,
  incompleteShifts: 0,
  breakOptions: [],
  lastError: null,
  lastErrorKind: null,
  stale: false,
}

/**
 * The store's snapshot, mirrored into React state.
 *
 * Deliberately read-only and deliberately dumb: it subscribes, deserialises and
 * hands the result on. The main process owns the state (DESIGN.md, "Main-Prozess
 * besitzt Netzwerk und State") and a second copy that could be edited here would
 * be the divergence source that architecture exists to avoid.
 */
export function useAttendance(): AppSnapshot {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(INITIAL)

  useEffect(() => {
    // The push subscription is registered *before* the initial read is awaited,
    // so a change happening between the two is not lost. `active` then keeps a
    // late-resolving initial read from overwriting a newer push.
    let active = true
    const off = window.factorial.onSnapshot((s) => setSnapshot(deserialiseSnapshot(s)))
    void window.factorial.getSnapshot().then((s) => {
      if (active) setSnapshot(deserialiseSnapshot(s))
    })
    return () => {
      active = false
      off()
    }
  }, [])

  return snapshot
}

/**
 * Re-renders once a second so the running timer stays current.
 *
 * Returns the current epoch milliseconds rather than a counter: the timer is
 * always recomputed as `now - since`, never incremented (DESIGN.md,
 * "Zeitberechnung"). That is what makes it survive standby and drift-free.
 *
 * The value is resynchronised the moment `active` turns true. Without that, a
 * widget that sat clocked out for ten minutes would render one frame of a timer
 * ten minutes short before the first interval fired.
 */
export function useTicker(active: boolean): number {
  const [tick, setTick] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return
    setTick(Date.now())
    const id = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])

  return tick
}
