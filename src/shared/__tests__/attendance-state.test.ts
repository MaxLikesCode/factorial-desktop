import { describe, it, expect } from 'vitest'
import { deriveState, type OpenShift } from '@shared/attendance-state'

// Shape verified against a live AttendanceOpenShift (K7): sentinel clock-in date,
// its own clockInOffset, workplaceId as an Int.
const openShift: OpenShift = {
  id: '543343386',
  date: '2026-08-12',
  clockIn: '2000-01-01T08:30:00Z',
  clockInOffset: '+02:00',
  locationType: 'office',
  workplaceId: 3333333,
  timeSettingsBreakConfiguration: null,
}

describe('deriveState', () => {
  it('reports clocked out when there is no open shift', () => {
    expect(deriveState(null)).toEqual({ kind: 'out' })
  })

  it('reports clocked in when a shift is open without a break', () => {
    const state = deriveState(openShift)
    expect(state.kind).toBe('in')
    if (state.kind !== 'in') throw new Error('unreachable')
    expect(state.shiftId).toBe('543343386')
    expect(state.locationType).toBe('office')
    expect(state.workplaceId).toBe(3333333)
    expect(state.since.toISOString()).toBe('2026-08-12T06:30:00.000Z')
  })

  it('reports a break when the shift carries a break configuration', () => {
    const state = deriveState({
      ...openShift,
      timeSettingsBreakConfiguration: { id: '19613', name: 'Mittagspause' },
    })
    expect(state.kind).toBe('break')
    if (state.kind !== 'break') throw new Error('unreachable')
    expect(state.breakId).toBe('19613')
    expect(state.breakName).toBe('Mittagspause')
  })

  it('falls back to a generic break label when the name is missing', () => {
    const state = deriveState({
      ...openShift,
      timeSettingsBreakConfiguration: { id: '19613', name: null },
    })
    if (state.kind !== 'break') throw new Error('unreachable')
    expect(state.breakName).toBe('Pause')
  })

  it('uses the shift date, not the sentinel date, for the start time', () => {
    const state = deriveState({ ...openShift, clockIn: '2000-01-01T08:30:00Z' })
    if (state.kind !== 'in') throw new Error('unreachable')
    expect(state.since.getFullYear()).toBe(2026)
  })

  it('honours the shift’s own offset instead of the machine’s zone', () => {
    // Same wall clock, different offset -> a different instant. If this passes
    // with the machine zone hard-wired, the offset is being ignored.
    const state = deriveState({ ...openShift, clockInOffset: '+00:00' })
    if (state.kind !== 'in') throw new Error('unreachable')
    expect(state.since.toISOString()).toBe('2026-08-12T08:30:00.000Z')
  })

  // --- Beyond the plan: pinning behaviour later tasks depend on ------------

  it('carries the shift id and start time into the break state as well', () => {
    // The break branch must not lose the identity or the start instant: the tray
    // renders a running timer in both states (Task 8) and the IPC contract
    // serialises `shiftId` and `since` for 'in' and 'break' alike (Task 8/9).
    const state = deriveState({
      ...openShift,
      timeSettingsBreakConfiguration: { id: '19613', name: 'Mittagspause' },
    })
    if (state.kind !== 'break') throw new Error('unreachable')
    expect(state.shiftId).toBe('543343386')
    expect(state.since.toISOString()).toBe('2026-08-12T06:30:00.000Z')
  })

  it('treats an empty break name as missing rather than rendering a blank label', () => {
    const state = deriveState({
      ...openShift,
      timeSettingsBreakConfiguration: { id: '19613', name: '   ' },
    })
    if (state.kind !== 'break') throw new Error('unreachable')
    expect(state.breakName).toBe('Pause')
  })

  it('lets a malformed timestamp throw instead of inventing a start time', () => {
    // reconstructInstant is total but throws on data it cannot parse. Swallowing
    // that here would hand the UI a plausible-looking wrong timer; the store
    // (Task 6) catches it and marks the snapshot stale instead.
    expect(() => deriveState({ ...openShift, clockInOffset: 'CEST' })).toThrow()
    expect(() => deriveState({ ...openShift, clockIn: 'nonsense' })).toThrow()
    expect(() => deriveState({ ...openShift, date: '12.08.2026' })).toThrow()
  })

  it('is pure: the same shift derives an equal state twice, and nothing is mutated', () => {
    const input: OpenShift = { ...openShift }
    const first = deriveState(input)
    const second = deriveState(input)
    expect(first).toEqual(second)
    expect(input).toEqual(openShift)
  })

  it('does not treat the meta states as derivable from a shift', () => {
    // 'unknown' and 'unauthenticated' exist in the union but are set by the
    // store, never by this function — no open shift can produce them.
    for (const shift of [null, openShift]) {
      expect(['unknown', 'unauthenticated']).not.toContain(deriveState(shift).kind)
    }
  })
})
