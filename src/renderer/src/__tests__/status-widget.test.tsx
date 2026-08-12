import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeActionError, type AppSnapshot } from '@shared/ipc-contract'
import { StatusWidget, UNKNOWN_TIME } from '@renderer/components/StatusWidget'
import { EMPTY_SNAPSHOT, installBridge, type FakeBridge } from './fake-bridge'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))

/** Fixed so every duration in the assertions below is exact, not "about". */
const NOW = new Date('2026-08-12T10:00:00+02:00')

/** Mounts the widget and flushes the two promises it fires on mount. */
async function mount(snapshot: Partial<AppSnapshot>): Promise<FakeBridge> {
  const bridge = installBridge(snapshot)
  render(<StatusWidget />)
  await act(async () => {})
  return bridge
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  toastError.mockClear()
})

afterEach(() => {
  // Unmount before the clock is restored, and by hand: vitest runs without
  // `globals`, so Testing Library registers no auto-cleanup of its own.
  cleanup()
  vi.useRealTimers()
})

describe('StatusWidget — the three states', () => {
  it('clocked out: grey label, one button, no invented timer', async () => {
    await mount({ state: { kind: 'out' }, todayMinutes: 125 })

    expect(screen.getByText('Ausgestempelt')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Einstempeln' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Ausstempeln' })).toBeNull()
    // 125 closed minutes and nothing running: 2:05:00 worked, 08:00 - 2:05 left.
    expect(screen.getByText('2:05:00')).toBeTruthy()
    expect(screen.getByText('Verbleibende Zeit 05:55')).toBeTruthy()
  })

  it('clocked in: the running shift is added to the day, both actions offered', async () => {
    await mount({
      state: {
        kind: 'in',
        shiftId: '543343386',
        since: new Date(NOW.getTime() - 90_000),
        locationType: 'office',
        workplaceId: 3333333,
      },
      todayMinutes: 120,
    })

    expect(screen.getByText('Eingestempelt')).toBeTruthy()
    expect(screen.getByText('2:01:30')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ausstempeln' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy()
  })

  it('recomputes the timer from `since` on every tick instead of counting up', async () => {
    await mount({
      state: {
        kind: 'in',
        shiftId: '1',
        since: new Date(NOW.getTime() - 90_000),
        locationType: 'office',
        workplaceId: null,
      },
      todayMinutes: 120,
    })
    expect(screen.getByText('2:01:30')).toBeTruthy()

    // Two seconds of wall clock; the widget must read the clock, not increment.
    act(() => void vi.advanceTimersByTime(2_000))
    expect(screen.getByText('2:01:32')).toBeTruthy()
  })

  it('on break: the worked timer freezes, the break gets its own running time', async () => {
    await mount({
      state: {
        kind: 'break',
        shiftId: '2',
        since: new Date(NOW.getTime() - 754_000),
        breakId: '19613',
        breakName: 'Mittagspause',
      },
      todayMinutes: 120,
    })

    expect(screen.getByText('In einer Pause')).toBeTruthy()
    // Break time is not worked time: the day total stays at the closed shifts.
    expect(screen.getByText('2:00:00')).toBeTruthy()
    expect(screen.getByText('Mittagspause · 0:12:34')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Fortsetzen' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ausstempeln' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
  })

  it('unknown: shows a placeholder, never a fabricated 0:00:00', async () => {
    await mount({ state: { kind: 'unknown' } })

    expect(screen.getByText('Lädt …')).toBeTruthy()
    expect(screen.getByText(UNKNOWN_TIME)).toBeTruthy()
    expect(screen.queryByText('0:00:00')).toBeNull()
    // Without a known worked time there is no honest "remaining" either.
    expect(screen.queryByText(/Verbleibende Zeit/)).toBeNull()
  })

  it('unauthenticated: offers a way back in rather than a dead disabled button', async () => {
    const bridge = await mount({ state: { kind: 'unauthenticated' } })

    expect(screen.getByText('Nicht angemeldet')).toBeTruthy()
    expect(screen.getByText(UNKNOWN_TIME)).toBeTruthy()
    const button = screen.getByRole('button', { name: 'Anmelden' })
    await act(async () => void button.click())
    expect(bridge.signOut).toHaveBeenCalledTimes(1)
  })
})

describe('StatusWidget — staleness', () => {
  it('shows the hint only while `stale` is set', async () => {
    const bridge = await mount({ state: { kind: 'out' }, todayMinutes: 60 })
    expect(screen.queryByText(/keine Verbindung/)).toBeNull()

    act(() =>
      bridge.push({
        ...EMPTY_SNAPSHOT,
        state: { kind: 'out' },
        todayMinutes: 60,
        lastError: 'request timed out after 15000 ms',
        lastErrorKind: 'network',
        stale: true,
      }),
    )
    expect(screen.getByText(/keine Verbindung/)).toBeTruthy()
    // The raw sentence from the main process must not reach the window.
    expect(screen.queryByText(/timed out/)).toBeNull()
  })

  it('drops the hint again once a refresh succeeds, even though lastError sticks', async () => {
    // The store clears `stale` but deliberately keeps `lastError` forever
    // (contract note on `AppSnapshot.lastError`). Keying off `lastError !== null`
    // would leave "keine Verbindung" glued to the widget for the whole session.
    const bridge = await mount({
      state: { kind: 'out' },
      lastError: 'request timed out after 15000 ms',
      lastErrorKind: 'network',
      stale: true,
    })
    expect(screen.getByText(/keine Verbindung/)).toBeTruthy()

    act(() =>
      bridge.push({
        ...EMPTY_SNAPSHOT,
        state: { kind: 'out' },
        lastError: 'request timed out after 15000 ms',
        lastErrorKind: 'network',
        stale: false,
      }),
    )
    expect(screen.queryByText(/keine Verbindung/)).toBeNull()
  })

  it('marks the day sum as provisional when a record arrived without minutes (C4)', async () => {
    await mount({ state: { kind: 'out' }, todayMinutes: 60, incompleteShifts: 1 })
    expect(screen.getByText(/Tagessumme unvollständig/)).toBeTruthy()
  })
})

describe('StatusWidget — actions', () => {
  it('clocks in with the remembered location', async () => {
    const bridge = await mount({ state: { kind: 'out' } })
    await act(async () => void screen.getByRole('button', { name: 'Einstempeln' }).click())
    expect(bridge.clockIn).toHaveBeenCalledWith({ locationType: 'office', workplaceId: null })
  })

  it('clocks out', async () => {
    const bridge = await mount({
      state: { kind: 'in', shiftId: '1', since: NOW, locationType: 'office', workplaceId: null },
    })
    await act(async () => void screen.getByRole('button', { name: 'Ausstempeln' }).click())
    expect(bridge.clockOut).toHaveBeenCalledTimes(1)
  })

  it('ends a break', async () => {
    const bridge = await mount({
      state: { kind: 'break', shiftId: '1', since: NOW, breakId: '19613', breakName: 'Mittagspause' },
    })
    await act(async () => void screen.getByRole('button', { name: 'Fortsetzen' }).click())
    expect(bridge.endBreak).toHaveBeenCalledTimes(1)
  })

  it('phrases a rejected action in German, never in the store’s own words', async () => {
    const bridge = await mount({ state: { kind: 'out' } })
    vi.mocked(bridge.clockIn).mockRejectedValueOnce(
      new Error(
        `Error invoking remote method 'attendance:clockIn': Error: ${encodeActionError(
          'busy',
          'another action is already in flight',
        )}`,
      ),
    )

    await act(async () => void screen.getByRole('button', { name: 'Einstempeln' }).click())

    expect(toastError).toHaveBeenCalledWith('Es läuft bereits eine Aktion. Bitte einen Moment warten.')
  })

  it('locks the buttons while an action is in flight', async () => {
    const bridge = await mount({ state: { kind: 'out' } })
    let release = (): void => {}
    vi.mocked(bridge.clockIn).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )

    const button = screen.getByRole('button', { name: 'Einstempeln' })
    await act(async () => void button.click())
    expect(screen.getByRole('button', { name: 'Einstempeln' }).hasAttribute('disabled')).toBe(true)

    await act(async () => {
      release()
    })
    expect(screen.getByRole('button', { name: 'Einstempeln' }).hasAttribute('disabled')).toBe(false)
  })
})
