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
async function mount(
  snapshot: Partial<AppSnapshot>,
  settings: Partial<Parameters<typeof installBridge>[1]> = {},
): Promise<FakeBridge> {
  const bridge = installBridge(snapshot, settings)
  render(<StatusWidget />)
  await act(async () => {})
  // The progress bar fills itself in on the frame after mount, so its first
  // frame is deliberately empty. Every assertion here is about the settled bar,
  // so carry the clock past that frame. 32 ms is under a second and therefore
  // cannot move any of the timer readings below.
  await act(async () => {
    vi.advanceTimersByTime(32)
  })
  return bridge
}

/**
 * The whole timer reading.
 *
 * The seconds render in a nested span (they carry less contrast than the rest),
 * and Testing Library's `getByText` concatenates only an element's *direct*
 * text children — so it sees "2:01" and ":30" and never the reading itself.
 * Reading `textContent` off the timer is both correct and stricter: it asserts
 * the exact string, on the one element that is allowed to show it.
 */
function timer(): string {
  const el = document.querySelector('[data-slot="worked-timer"]')
  if (!el) throw new Error('timer not rendered')
  return el.textContent ?? ''
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
    await mount({ state: { kind: 'out' }, todayMinutes: 125, expectedMinutes: 480 })

    expect(screen.getByText('Ausgestempelt')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Einstempeln' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Ausstempeln' })).toBeNull()
    // 125 closed minutes and nothing running: 2:05:00 worked, 08:00 - 2:05 left.
    expect(timer()).toBe('2:05:00')
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
    expect(timer()).toBe('2:01:30')
    expect(screen.getByRole('button', { name: 'Ausstempeln' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy()
  })

  /**
   * Reported from the real app: the shift was running on "Mobiles Arbeiten" and
   * the footer read "Büro" — the saved preference, not the shift. The preference
   * only says what the *next* clock-in would use, and the two diverge as soon as
   * someone clocks in from the web or their phone.
   */
  it('shows the running shift’s location, not the saved preference', async () => {
    await mount(
      {
        state: {
          kind: 'in',
          shiftId: '1',
          since: NOW,
          locationType: 'work_from_home',
          workplaceId: 3333333,
        },
      },
      { lastLocationType: 'office' },
    )

    expect(screen.getByText('Mobiles Arbeiten')).toBeTruthy()
    expect(screen.queryByText('Büro')).toBeNull()
  })

  it('keeps showing the shift’s location during a break', async () => {
    await mount(
      {
        state: {
          kind: 'break',
          shiftId: '1',
          since: NOW,
          breakId: '19613',
          breakName: 'Mittagspause',
          locationType: 'work_from_home',
        },
      },
      { lastLocationType: 'office' },
    )

    expect(screen.getByText('Mobiles Arbeiten')).toBeTruthy()
  })

  it('falls back to the preference when the open shift carries no location', async () => {
    await mount(
      { state: { kind: 'in', shiftId: '1', since: NOW, locationType: null, workplaceId: null } },
      { lastLocationType: 'business_trip' },
    )

    expect(screen.getByText('Dienstreise')).toBeTruthy()
  })

  it('shows the preference while clocked out — there it is the honest answer', async () => {
    await mount({ state: { kind: 'out' } }, { lastLocationType: 'work_from_home' })

    expect(screen.getByText('Mobiles Arbeiten')).toBeTruthy()
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
    expect(timer()).toBe('2:01:30')

    // Two seconds of wall clock; the widget must read the clock, not increment.
    act(() => void vi.advanceTimersByTime(2_000))
    expect(timer()).toBe('2:01:32')
  })

  it('on break: the worked timer freezes, the break gets its own running time', async () => {
    await mount({
      state: {
        kind: 'break',
        shiftId: '2',
        since: new Date(NOW.getTime() - 754_000),
        breakId: '19613',
        breakName: 'Mittagspause',
        locationType: 'office',
      },
      todayMinutes: 120,
    })

    expect(screen.getByText('In einer Pause')).toBeTruthy()
    // Break time is not worked time: the day total stays at the closed shifts.
    expect(timer()).toBe('2:00:00')
    expect(screen.getByText('Mittagspause · 0:12:34')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Fortsetzen' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ausstempeln' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
  })

  it('unknown: shows a placeholder, never a fabricated 0:00:00', async () => {
    await mount({ state: { kind: 'unknown' } })

    expect(screen.getByText('Lädt …')).toBeTruthy()
    expect(timer()).toBe(UNKNOWN_TIME)
    expect(timer()).not.toBe('0:00:00')
    // Without a known worked time there is no honest "remaining" either.
    expect(screen.queryByText(/Verbleibende Zeit/)).toBeNull()
  })

  it('unauthenticated: offers a way back in rather than a dead disabled button', async () => {
    const bridge = await mount({ state: { kind: 'unauthenticated' } })

    expect(screen.getByText('Nicht angemeldet')).toBeTruthy()
    expect(timer()).toBe(UNKNOWN_TIME)
    const button = screen.getByRole('button', { name: 'Anmelden' })
    await act(async () => void button.click())
    expect(bridge.signOut).toHaveBeenCalledTimes(1)
  })
})

describe('StatusWidget — the day’s target', () => {
  /** The filled share of the track, or null when no bar is rendered at all. */
  function fill(): string | null {
    const bar = document.querySelector<HTMLElement>('[data-slot="progress-bar-fill"]')
    return bar === null ? null : bar.style.width
  }

  it('uses the target the API sent, not a hard-coded eight hours', async () => {
    // 300 minutes of goal, 120 worked: 03:00 left and 40 % of the track filled.
    await mount({ state: { kind: 'out' }, todayMinutes: 120, expectedMinutes: 300 })
    expect(screen.getByText('Verbleibende Zeit 03:00')).toBeTruthy()
    expect(fill()).toBe('40%')
  })

  it('counts the running shift towards the target while clocked in', async () => {
    await mount({
      state: {
        kind: 'in',
        shiftId: '1',
        since: new Date(NOW.getTime() - 30 * 60_000),
        locationType: 'office',
        workplaceId: null,
      },
      todayMinutes: 120,
      expectedMinutes: 480,
    })
    expect(screen.getByText('Verbleibende Zeit 05:30')).toBeTruthy()
  })

  /**
   * An empty track is not neutral: it claims "0 % of something". On a day with
   * no goal there is no something, so the bar must be absent rather than empty —
   * the same rule that makes the timer a dash instead of 0:00:00.
   */
  it('drops the comparison when the API has no target for the day', async () => {
    await mount({ state: { kind: 'out' }, todayMinutes: 125, expectedMinutes: null })
    expect(screen.queryByText(/Verbleibende Zeit/)).toBeNull()
    expect(timer()).toBe('2:05:00')
    expect(fill()).toBeNull()
  })

  it('treats a zero target the same way — a holiday is not "done for today"', async () => {
    await mount({ state: { kind: 'out' }, todayMinutes: 125, expectedMinutes: 0 })
    expect(screen.queryByText(/Verbleibende Zeit/)).toBeNull()
    expect(fill()).toBeNull()
  })

  /**
   * Past the goal the remaining time is always 00:00, which reports the nothing
   * that is left instead of the surplus — the only interesting number at that
   * point in the day.
   */
  it('reports the surplus once the target is met, not a zero remainder', async () => {
    await mount({ state: { kind: 'out' }, todayMinutes: 540, expectedMinutes: 480 })
    expect(screen.getByText('Soll erfüllt · +1:00')).toBeTruthy()
    expect(screen.queryByText(/Verbleibende Zeit/)).toBeNull()
    expect(fill()).toBe('100%')
  })

  /**
   * The switch is on the rounded surplus, so the reading never contradicts what
   * it prints. Half a minute over would otherwise show "+0:00", which looks
   * like a bug rather than like a day that has just come due.
   */
  it('does not flip to a "+0:00" surplus in the seconds around the goal', async () => {
    await mount({ state: { kind: 'out' }, todayMinutes: 480, expectedMinutes: 480 })
    expect(screen.getByText('Verbleibende Zeit 00:00')).toBeTruthy()
    expect(screen.queryByText(/Soll erfüllt/)).toBeNull()
  })

  it('shows no remaining time before the first snapshot, even with a target', async () => {
    await mount({ state: { kind: 'unknown' }, expectedMinutes: 480 })
    expect(screen.queryByText(/Verbleibende Zeit/)).toBeNull()
    expect(timer()).toBe(UNKNOWN_TIME)
    // No worked time either, so there is nothing to be a fraction of yet.
    expect(fill()).toBeNull()
  })
})

describe('StatusWidget — the advisory line', () => {
  /**
   * Regression. The two hints used to render as separate stacked lines, which
   * added 28 px to a card with 7 px of room and pushed the work-location select
   * clean off the bottom edge — a control the user could no longer reach.
   */
  it('puts both hints on one line rather than stacking them', async () => {
    await mount({
      state: { kind: 'out' },
      todayMinutes: 233,
      expectedMinutes: 480,
      incompleteShifts: 1,
      stale: true,
      lastErrorKind: 'network',
      lastError: 'request timed out after 15000 ms',
    })

    const line = screen.getByText(/keine Verbindung · Tagessumme unvollständig/)
    expect(line).toBeTruthy()
    // One element carries both, so the card grows by one line and not by two.
    expect(screen.queryAllByText(/Tagessumme unvollständig/)).toHaveLength(1)
  })

  it('shows the connection problem first — it explains why the rest may be old', async () => {
    await mount({
      state: { kind: 'out' },
      incompleteShifts: 1,
      stale: true,
      lastErrorKind: 'network',
    })
    expect(screen.getByText(/^keine Verbindung/)).toBeTruthy()
  })

  it('renders no advisory line at all when there is nothing to say', async () => {
    await mount({ state: { kind: 'out' }, incompleteShifts: 0, stale: false })
    expect(screen.queryByText(/Verbindung|unvollständig/)).toBeNull()
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
      state: {
        kind: 'break',
        shiftId: '1',
        since: NOW,
        breakId: '19613',
        breakName: 'Mittagspause',
        locationType: 'office',
      },
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
