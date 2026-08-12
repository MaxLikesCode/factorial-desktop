import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAttendance, useTicker } from '@renderer/hooks/useAttendance'
import { installBridge } from './fake-bridge'

function Probe(): React.JSX.Element {
  const snapshot = useAttendance()
  const since = snapshot.state.kind === 'in' ? snapshot.state.since : null
  return (
    <div>
      <span data-testid="kind">{snapshot.state.kind}</span>
      <span data-testid="since">{since === null ? '-' : String(since instanceof Date)}</span>
      <span data-testid="since-ms">{since === null ? '-' : String(since.getTime())}</span>
      <span data-testid="minutes">{snapshot.todayMinutes}</span>
    </div>
  )
}

afterEach(() => {
  // Unmount first: the ticker's interval is cleared by React, and clearing the
  // fake clock out from under it would leak the timer into the next test.
  // Vitest runs without `globals`, so Testing Library registers no auto-cleanup.
  cleanup()
  vi.useRealTimers()
})

describe('useAttendance', () => {
  it('starts at "unknown" so nothing is shown before the first answer', () => {
    installBridge({ state: { kind: 'out' } })
    render(<Probe />)
    // Synchronously, before the `getSnapshot` promise resolves.
    expect(screen.getByTestId('kind').textContent).toBe('unknown')
  })

  it('pulls the current snapshot once on mount', async () => {
    installBridge({ state: { kind: 'out' }, todayMinutes: 125 })
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('kind').textContent).toBe('out'))
    expect(screen.getByTestId('minutes').textContent).toBe('125')
  })

  it('rebuilds `since` as a real Date — it crosses IPC as epoch milliseconds', async () => {
    const bridge = installBridge()
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('kind').textContent).toBe('unknown'))

    const since = new Date('2026-08-12T07:49:05+02:00')
    act(() =>
      bridge.push({
        state: { kind: 'in', shiftId: '1', since, locationType: 'office', workplaceId: 3333333 },
        todayMinutes: 0,
        incompleteShifts: 0,
        breakOptions: [],
        lastError: null,
        lastErrorKind: null,
        stale: false,
      }),
    )

    expect(screen.getByTestId('since').textContent).toBe('true')
    expect(screen.getByTestId('since-ms').textContent).toBe(String(since.getTime()))
  })

  it('unsubscribes on unmount so listeners do not pile up', async () => {
    const bridge = installBridge()
    const view = render(<Probe />)
    await waitFor(() => expect(bridge.listenerCount).toBe(1))
    view.unmount()
    expect(bridge.listenerCount).toBe(0)
  })
})

function TickProbe({ active }: { active: boolean }): React.JSX.Element {
  const tick = useTicker(active)
  return <span data-testid="tick">{tick}</span>
}

describe('useTicker', () => {
  it('does not tick while inactive', () => {
    vi.useFakeTimers()
    render(<TickProbe active={false} />)
    const before = screen.getByTestId('tick').textContent
    act(() => void vi.advanceTimersByTime(5_000))
    expect(screen.getByTestId('tick').textContent).toBe(before)
  })

  it('ticks once a second while active', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-12T10:00:00+02:00'))
    render(<TickProbe active />)
    const before = Number(screen.getByTestId('tick').textContent)
    act(() => void vi.advanceTimersByTime(1_000))
    expect(Number(screen.getByTestId('tick').textContent)).toBe(before + 1_000)
  })

  it('resyncs the moment it becomes active, so no stale value is rendered', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-12T10:00:00+02:00'))
    const view = render(<TickProbe active={false} />)
    const mounted = Number(screen.getByTestId('tick').textContent)

    // Ten minutes pass with the widget clocked out, then a clock-in arrives. If
    // the ticker kept its mount-time value the first rendered frame would show a
    // timer ten minutes short — a wrong time, which is the failure this app
    // cannot afford.
    act(() => void vi.advanceTimersByTime(600_000))
    view.rerender(<TickProbe active />)
    expect(Number(screen.getByTestId('tick').textContent)).toBe(mounted + 600_000)
  })
})
