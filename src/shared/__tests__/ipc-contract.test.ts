import { describe, it, expect } from 'vitest'
import {
  decodeActionError,
  deserialiseSnapshot,
  encodeActionError,
  serialiseSnapshot,
  type ActionErrorKind,
  type AppSnapshot,
} from '@shared/ipc-contract'

/** Everything a snapshot needs beyond `state`, so the cases below stay readable. */
const REST = {
  todayMinutes: 0,
  incompleteShifts: 0,
  expectedMinutes: null,
  breakOptions: [],
  lastError: null,
  lastErrorKind: null,
  stale: false,
} satisfies Omit<AppSnapshot, 'state'>

describe('snapshot serialisation', () => {
  it('round-trips a clocked-in snapshot, preserving the start instant', () => {
    const since = new Date(2026, 7, 12, 8, 30, 0)
    const original: AppSnapshot = {
      ...REST,
      state: { kind: 'in', shiftId: '1', since, locationType: 'office', workplaceId: 3333333 },
      todayMinutes: 120,
      breakOptions: [{ id: '19613', name: 'Mittagspause' }],
    }
    const restored = deserialiseSnapshot(serialiseSnapshot(original))
    expect(restored.state.kind).toBe('in')
    if (restored.state.kind !== 'in') throw new Error('unreachable')
    expect(restored.state.since).toBeInstanceOf(Date)
    expect(restored.state.since.getTime()).toBe(since.getTime())
    expect(restored.state.workplaceId).toBe(3333333)
    expect(restored.todayMinutes).toBe(120)
    expect(restored.breakOptions).toEqual([{ id: '19613', name: 'Mittagspause' }])
  })

  it('round-trips a break snapshot', () => {
    const since = new Date(2026, 7, 12, 12, 0, 0)
    const restored = deserialiseSnapshot(
      serialiseSnapshot({
        ...REST,
        state: { kind: 'break', shiftId: '1', since, breakId: '19613', breakName: 'Mittagspause' },
      }),
    )
    if (restored.state.kind !== 'break') throw new Error('unreachable')
    expect(restored.state.breakName).toBe('Mittagspause')
    expect(restored.state.since.getTime()).toBe(since.getTime())
  })

  it('round-trips states that carry no date', () => {
    for (const kind of ['unknown', 'unauthenticated', 'out'] as const) {
      const restored = deserialiseSnapshot(serialiseSnapshot({ ...REST, state: { kind } }))
      expect(restored.state).toEqual({ kind })
    }
  })

  it('carries the two fields the store added beyond the original contract', () => {
    // `incompleteShifts` (C4) and `lastErrorKind` exist on the store's snapshot;
    // dropping them here would leave the UI unable to say why the day sum is
    // provisional or to phrase the error in German.
    const restored = deserialiseSnapshot(
      serialiseSnapshot({
        ...REST,
        state: { kind: 'out' },
        incompleteShifts: 2,
        lastError: 'no connection',
        lastErrorKind: 'network',
        stale: true,
      }),
    )
    expect(restored.incompleteShifts).toBe(2)
    expect(restored.lastError).toBe('no connection')
    expect(restored.lastErrorKind).toBe('network')
    expect(restored.stale).toBe(true)
  })

  it('carries the day’s target across, including the "no target" case', () => {
    // The ring's goal (K8, `expectedMinutes`). `null` and `0` are both real
    // answers — a day off — and must arrive as themselves, not as a helpful 480.
    for (const expectedMinutes of [480, 0, null]) {
      const restored = deserialiseSnapshot(
        serialiseSnapshot({ ...REST, state: { kind: 'out' }, expectedMinutes }),
      )
      expect(restored.expectedMinutes).toBe(expectedMinutes)
    }
  })

  it('produces a structured-clone-safe payload with no Date instances', () => {
    const payload = serialiseSnapshot({
      ...REST,
      state: { kind: 'in', shiftId: '1', since: new Date(), locationType: null, workplaceId: null },
    })
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })

  it('sends the start time as a number, because a Date does not survive IPC as a Date', () => {
    const since = new Date(2026, 7, 12, 8, 30, 0)
    const payload = serialiseSnapshot({
      ...REST,
      state: { kind: 'in', shiftId: '1', since, locationType: null, workplaceId: null },
    })
    if (payload.state.kind !== 'in') throw new Error('unreachable')
    expect(payload.state.sinceMs).toBe(since.getTime())
    expect(typeof payload.state.sinceMs).toBe('number')
  })

  it('leaves the snapshot it was handed untouched', () => {
    const original: AppSnapshot = { ...REST, state: { kind: 'out' } }
    serialiseSnapshot(original)
    expect(original.state).toEqual({ kind: 'out' })
  })
})

describe('action error codec', () => {
  const KINDS: ActionErrorKind[] = [
    'unauthenticated',
    'graphql',
    'network',
    'malformed',
    'unknown',
    'busy',
  ]

  it('round-trips every kind', () => {
    for (const kind of KINDS) {
      expect(decodeActionError(encodeActionError(kind, 'boom'))).toEqual({ kind, message: 'boom' })
    }
  })

  it('survives the wrapping Electron puts around a rejected invoke', () => {
    // A handler rejection reaches the renderer as
    // "Error invoking remote method 'attendance:clockIn': Error: <message>",
    // so only the message text can be relied on to cross the boundary.
    const wrapped = `Error invoking remote method 'attendance:clockIn': Error: ${encodeActionError('network', 'fetch timed out')}`
    expect(decodeActionError(wrapped)).toEqual({ kind: 'network', message: 'fetch timed out' })
  })

  it('keeps a message that contains colons intact', () => {
    const message = 'clockInAttendanceShift: not allowed: 12:30'
    expect(decodeActionError(encodeActionError('graphql', message))).toEqual({
      kind: 'graphql',
      message,
    })
  })

  it('treats an unencoded message as an unknown failure instead of losing it', () => {
    expect(decodeActionError('something else broke')).toEqual({
      kind: 'unknown',
      message: 'something else broke',
    })
  })

  it('does not trust a kind it has never heard of', () => {
    expect(decodeActionError('factorial-action-error/teapot: brewing')).toEqual({
      kind: 'unknown',
      message: 'teapot: brewing',
    })
  })

  it('keeps an empty message decodable', () => {
    expect(decodeActionError(encodeActionError('busy', ''))).toEqual({ kind: 'busy', message: '' })
  })
})
