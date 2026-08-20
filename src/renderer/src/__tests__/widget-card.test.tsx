import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot } from '@shared/ipc-contract'
import { CARD } from '@shared/widget-size'
import { StatusWidget } from '@renderer/components/StatusWidget'
import { installBridge, type FakeBridge } from './fake-bridge'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const NOW = new Date('2026-08-12T10:00:00+02:00')

const CLOCKED_IN: Partial<AppSnapshot> = {
  state: {
    kind: 'in',
    shiftId: '1',
    since: new Date(NOW.getTime() - 90_000),
    locationType: 'office',
    workplaceId: null,
  },
  todayMinutes: 120,
  daySegments: [{ kind: 'work', minutes: 120 }],
  expectedMinutes: 480,
}

async function mount(
  direction: 'right' | 'left' = 'right',
  snapshot: Partial<AppSnapshot> = CLOCKED_IN,
): Promise<FakeBridge> {
  const bridge = installBridge(snapshot, { expandDirection: direction })
  render(<StatusWidget />)
  await act(async () => {})
  await act(async () => {
    vi.advanceTimersByTime(32)
  })
  return bridge
}

const card = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>('[data-slot="minimal-card"]')
  if (!el) throw new Error('card not rendered')
  return el
}

const control = (): HTMLElement =>
  screen.getByRole('button', { name: /Aktionen zeigen|Widget verkleinern/ })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the two states', () => {
  it('starts collapsed, at the size that is on screen all day', async () => {
    await mount()
    expect(card().dataset.open).toBe('false')
    expect(card().style.width).toBe(`${CARD.collapsed.width}px`)
    expect(card().style.height).toBe(`${CARD.collapsed.height}px`)
  })

  /**
   * Everything in one step. The expanded card is not a view to sit in — it is
   * opened to press Pause or clock out and then closed — so making someone open
   * it twice to reach the work location would be the wrong shape entirely.
   */
  it('opens straight to everything: actions, location and the break total', async () => {
    await mount('right', {
      ...CLOCKED_IN,
      daySegments: [
        { kind: 'work', minutes: 270 },
        { kind: 'break', minutes: 33 },
      ],
    })

    expect(screen.queryByRole('button', { name: 'Ausstempeln' })).toBeNull()

    await act(async () => void control().click())

    expect(card().dataset.open).toBe('true')
    expect(card().style.width).toBe(`${CARD.expanded.width}px`)
    expect(screen.getByRole('button', { name: 'Ausstempeln' })).toBeTruthy()
    expect(screen.getByText('Eingestempelt')).toBeTruthy()
    expect(screen.getByText('Büro')).toBeTruthy()
    expect(screen.getByText('Pause 00:33')).toBeTruthy()
  })

  it('closes again, all the way back', async () => {
    await mount()
    await act(async () => void control().click())
    expect(card().dataset.open).toBe('true')

    await act(async () => void control().click())
    expect(card().dataset.open).toBe('false')
    expect(card().style.height).toBe(`${CARD.collapsed.height}px`)
  })

  /**
   * The rows stay in the DOM the whole time — they have to, or there would be
   * nothing to fade in — so a row nobody can see must not be reachable either.
   * Without this, Tab walks into an invisible "Ausstempeln" and Enter files the
   * end of somebody's shift with nothing on screen to show for it.
   */
  it('keeps the hidden rows out of reach while collapsed', async () => {
    await mount()
    for (const row of document.querySelectorAll('.morph-late')) {
      expect(row.getAttribute('aria-hidden')).toBe('true')
    }
  })

  it('shows the advisory line only when there is something to say', async () => {
    await mount()
    await act(async () => void control().click())
    expect(screen.queryByText(/Verbindung|unvollständig/)).toBeNull()
    cleanup()

    await mount('right', { ...CLOCKED_IN, stale: true, lastErrorKind: 'network' })
    await act(async () => void control().click())
    expect(screen.getByText(/keine Verbindung/)).toBeTruthy()
  })
})

describe('the expand direction', () => {
  it('pins the card against the edge it does not grow into', async () => {
    await mount('right')
    expect(card().classList.contains('left-0')).toBe(true)
    cleanup()

    await mount('left')
    expect(card().classList.contains('right-0')).toBe(true)
  })

  /**
   * The whole reason the direction is offered: growing left, the card's right
   * edge does not move, so the control keeps both coordinates and the pointer
   * that opened the card can close it without travelling.
   */
  it('leaves the control exactly where it was when growing left', async () => {
    await mount('left')
    const before = control().style.top

    await act(async () => void control().click())
    expect(card().dataset.open).toBe('true')
    expect(control().style.top).toBe(before)
    expect(control().classList.contains('right-2.5')).toBe(true)
  })

  it('moves the control down out of the way when growing right', async () => {
    await mount('right')
    expect(control().style.top).toBe('12px')
    await act(async () => void control().click())
    expect(control().style.top).toBe('84px')
  })

  it('follows a direction change pushed from the tray', async () => {
    const bridge = await mount('right')
    expect(card().classList.contains('left-0')).toBe(true)

    act(() => bridge.pushSettings({ expandDirection: 'left' }))
    expect(card().classList.contains('right-0')).toBe(true)
  })
})

describe('dragging the card', () => {
  const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

  const down = (target: Element, x: number, y: number): void => {
    fireEvent.pointerDown(target, { pointerId: 1, button: 0, clientX: x, clientY: y })
  }

  it('starts no drag until the pointer has actually travelled', async () => {
    const bridge = await mount()
    down(card(), 40, 20)
    fireEvent.pointerMove(card(), { pointerId: 1, clientX: 41, clientY: 21 })
    expect(bridge.setWindowDragging).not.toHaveBeenCalled()

    fireEvent.pointerMove(card(), { pointerId: 1, clientX: 60, clientY: 20 })
    expect(bridge.setWindowDragging).toHaveBeenCalledWith(true)

    fireEvent.pointerUp(card(), { pointerId: 1 })
    expect(bridge.setWindowDragging).toHaveBeenLastCalledWith(false)
  })

  it('does not drag from a control', async () => {
    const bridge = await mount()
    down(control(), 130, 20)
    fireEvent.pointerMove(card(), { pointerId: 1, clientX: 200, clientY: 20 })
    expect(bridge.setWindowDragging).not.toHaveBeenCalled()
  })

  it('reports no end for a drag that never began', async () => {
    const bridge = await mount()
    down(card(), 40, 20)
    fireEvent.pointerUp(card(), { pointerId: 1 })
    expect(bridge.setWindowDragging).not.toHaveBeenCalled()
  })

  /**
   * `-webkit-app-region` is resolved by Chromium's window hit testing rather
   * than by event dispatch, so it cannot be evaluated in jsdom. What can be
   * checked is that the card claims no drag region at all — it moves itself.
   */
  it('is not a drag region, which is what lets the double click through', async () => {
    await mount()
    expect(card().classList.contains('drag-region')).toBe(false)
    expect(css).not.toContain("morph-card[data-open='false'] .morph-late")
  })
})

describe('double clicking the card', () => {
  it('toggles it, both ways', async () => {
    await mount()
    await act(async () => void fireEvent.dblClick(card()))
    expect(card().dataset.open).toBe('true')

    await act(async () => void fireEvent.dblClick(card()))
    expect(card().dataset.open).toBe('false')
  })

  it('ignores a double click that landed on a control', async () => {
    await mount()
    await act(async () => {
      control().click()
      control().click()
      fireEvent.dblClick(control())
    })
    expect(card().dataset.open).toBe('false')
  })
})

describe('letting the desktop through', () => {
  /**
   * The window is larger than the card and always on top. Left interactive it
   * would swallow a rectangle of desktop with nothing on screen to explain it.
   */
  it('lets clicks through until the pointer is over the card', async () => {
    const bridge = await mount()
    expect(bridge.setWindowInteractive).toHaveBeenCalledWith(false)

    card().getBoundingClientRect = () => ({ left: 0, top: 0, right: 156, bottom: 44 }) as DOMRect

    await act(async () => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 20 }))
    })
    expect(bridge.setWindowInteractive).toHaveBeenLastCalledWith(true)

    await act(async () => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 20 }))
    })
    expect(bridge.setWindowInteractive).toHaveBeenLastCalledWith(false)
  })

  /**
   * The Windows half of the same behaviour, and the reason it exists.
   *
   * A click-through window is supposed to keep receiving forwarded mouse moves,
   * and the test above is that contract. On Windows it receives none — measured
   * against a bare transparent window: 29 moves while interactive, 0 while
   * forwarding. Everything above would still pass while the real widget sat
   * there unclickable, so what the main process pushes instead is asserted
   * separately: same question, same answer, different source.
   */
  it('takes the pointer from the main process too, since Windows forwards none', async () => {
    const bridge = await mount()
    expect(bridge.setWindowInteractive).toHaveBeenCalledWith(false)

    card().getBoundingClientRect = () => ({ left: 0, top: 0, right: 156, bottom: 44 }) as DOMRect

    await act(async () => {
      bridge.pushCursor({ x: 40, y: 20 })
    })
    expect(bridge.setWindowInteractive).toHaveBeenLastCalledWith(true)

    await act(async () => {
      bridge.pushCursor({ x: 300, y: 20 })
    })
    expect(bridge.setWindowInteractive).toHaveBeenLastCalledWith(false)
  })

  it('stops listening for pushed positions when the card goes away', async () => {
    const bridge = await mount()
    expect(bridge.cursorListenerCount).toBe(1)

    cleanup()

    // Asserted as a count rather than through a later push: unmounting also
    // hands interactivity back, and `setInteractive` drops a repeat of the value
    // it already sent — so a leaked listener would go on being called and the
    // spy would still look untouched.
    expect(bridge.cursorListenerCount).toBe(0)
    expect(bridge.setWindowInteractive).toHaveBeenLastCalledWith(true)
  })
})
