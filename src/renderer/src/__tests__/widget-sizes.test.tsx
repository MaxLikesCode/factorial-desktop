import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot } from '@shared/ipc-contract'
import { WIDGET_LAYOUTS } from '@shared/widget-size'
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
  expectedMinutes: 480,
}

async function mount(
  size: 'standard' | 'kompakt' | 'minimal',
  direction: 'right' | 'left' = 'right',
): Promise<FakeBridge> {
  const bridge = installBridge(CLOCKED_IN, { widgetSize: size, expandDirection: direction })
  render(<StatusWidget />)
  await act(async () => {})
  await act(async () => {
    vi.advanceTimersByTime(32)
  })
  return bridge
}

const minimalCard = (): HTMLElement => {
  const card = document.querySelector<HTMLElement>('[data-slot="minimal-card"]')
  if (!card) throw new Error('minimal card not rendered')
  return card
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the three sizes', () => {
  it('shows the work location only where there is room for it', async () => {
    await mount('standard')
    expect(screen.getByText('Büro')).toBeTruthy()
    cleanup()

    // Kompakt drops the select; the location is reached through the tray, where
    // it belongs as a preference anyway.
    await mount('kompakt')
    expect(screen.queryByText('Büro')).toBeNull()
  })

  it('keeps the actions and the status label in both full sizes', async () => {
    for (const size of ['standard', 'kompakt'] as const) {
      await mount(size)
      expect(screen.getByRole('button', { name: 'Ausstempeln' })).toBeTruthy()
      expect(screen.getByText('Eingestempelt')).toBeTruthy()
      cleanup()
    }
  })

  /**
   * The overflow the footer row caused. A card with a fixed height and an empty
   * 16 px row plus its 8 px gap had 24 px less room than its content needed, so
   * the content pushed the row out through the bottom edge — in every state, not
   * only the one that put text in it.
   */
  it('renders no footer row in a size that has nothing to put in it', async () => {
    await mount('standard')
    expect(document.querySelector('[data-slot="card-footer"]')).toBeTruthy()
    cleanup()

    await mount('kompakt')
    expect(document.querySelector('[data-slot="card-footer"]')).toBeNull()
  })

  /**
   * Twice now the same 24 px row has pushed kompakt's content out through its
   * own bottom edge — first as an empty footer, then as one conjured up to hold
   * the day's break total. The row exists only where the work-location select
   * already made room for it, which is `standard` alone.
   */
  it('never grows a footer row in kompakt, not even to report a break', async () => {
    installBridge(
      {
        ...CLOCKED_IN,
        daySegments: [
          { kind: 'work', minutes: 270 },
          { kind: 'break', minutes: 33 },
        ],
      },
      { widgetSize: 'kompakt' },
    )
    render(<StatusWidget />)
    await act(async () => {})

    expect(document.querySelector('[data-slot="card-footer"]')).toBeNull()
    expect(screen.queryByText(/^Pause /)).toBeNull()
  })

  it('follows a size change pushed from the tray, without a remount', async () => {
    const bridge = await mount('standard')
    expect(screen.getByText('Büro')).toBeTruthy()

    act(() => bridge.pushSettings({ widgetSize: 'minimal' }))
    expect(screen.queryByText('Büro')).toBeNull()
    expect(minimalCard()).toBeTruthy()
  })
})

describe('the minimal card', () => {
  it('starts collapsed at its resting size', async () => {
    await mount('minimal')
    const card = minimalCard()
    expect(card.dataset.open).toBe('false')
    expect(card.style.width).toBe(`${WIDGET_LAYOUTS.minimal.card.width}px`)
    expect(card.style.height).toBe(`${WIDGET_LAYOUTS.minimal.card.height}px`)
  })

  it('grows to exactly the kompakt card when opened, and back again', async () => {
    await mount('minimal')
    const expanded = WIDGET_LAYOUTS.minimal.expanded
    if (expanded === null) throw new Error('minimal must expand')

    const toggle = screen.getByRole('button', { name: 'Aktionen zeigen' })
    await act(async () => void toggle.click())

    const card = minimalCard()
    expect(card.dataset.open).toBe('true')
    expect(card.style.width).toBe(`${expanded.width}px`)
    expect(card.style.height).toBe(`${expanded.height}px`)

    await act(async () => void screen.getByRole('button', { name: 'Widget verkleinern' }).click())
    expect(minimalCard().dataset.open).toBe('false')
  })

  /**
   * The collapsed card has no buttons at all — that is the whole reason it fits
   * in 156 × 44. They arrive with the expansion.
   */
  it('offers no actions until it is opened', async () => {
    await mount('minimal')
    expect(screen.queryByRole('button', { name: 'Ausstempeln' })).toBeNull()

    await act(async () => void screen.getByRole('button', { name: 'Aktionen zeigen' }).click())
    expect(screen.getByRole('button', { name: 'Ausstempeln' })).toBeTruthy()
  })

  /**
   * The window is larger than the card and always on top. Left interactive it
   * would swallow a rectangle of desktop with nothing on screen to explain it,
   * so the renderer gives the clicks away until the pointer is over the card.
   */
  it('lets clicks through until the pointer is over the card', async () => {
    const bridge = await mount('minimal')
    expect(bridge.setWindowInteractive).toHaveBeenCalledWith(false)

    const card = minimalCard()
    card.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 156, bottom: 44 }) as DOMRect

    await act(async () => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 20 }))
    })
    expect(bridge.setWindowInteractive).toHaveBeenLastCalledWith(true)

    await act(async () => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 20 }))
    })
    expect(bridge.setWindowInteractive).toHaveBeenLastCalledWith(false)
  })

  it('gives the clicks back when the size changes away from minimal', async () => {
    const bridge = await mount('minimal')
    vi.mocked(bridge.setWindowInteractive).mockClear()

    act(() => bridge.pushSettings({ widgetSize: 'standard' }))
    expect(bridge.setWindowInteractive).toHaveBeenLastCalledWith(true)
  })
})

/**
 * The whole card is the handle, and the drag is this component's own.
 *
 * `-webkit-app-region: drag` is not used here: it makes the card a title bar as
 * far as the platform is concerned, and the platform then keeps the double click
 * for itself. So the card watches its own pointer instead, which is testable —
 * unlike an app region, which jsdom has no window to hit-test against.
 */
describe('dragging the collapsed card', () => {
  const down = (target: Element, x: number, y: number): void => {
    fireEvent.pointerDown(target, { pointerId: 1, button: 0, clientX: x, clientY: y })
  }

  it('starts no drag until the pointer has actually travelled', async () => {
    const bridge = await mount('minimal')
    const card = minimalCard()

    down(card, 40, 20)
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 41, clientY: 21 })
    // Two pixels is still a click. Spinning up a loop in the main process to
    // move the window nowhere is not free, and it would fight the double click.
    expect(bridge.setWindowDragging).not.toHaveBeenCalled()

    fireEvent.pointerMove(card, { pointerId: 1, clientX: 60, clientY: 20 })
    expect(bridge.setWindowDragging).toHaveBeenCalledWith(true)

    fireEvent.pointerUp(card, { pointerId: 1 })
    expect(bridge.setWindowDragging).toHaveBeenLastCalledWith(false)
  })

  /**
   * The one exception the user asked for: everywhere except the controls.
   */
  it('does not drag from a control', async () => {
    const bridge = await mount('minimal')
    const toggle = screen.getByRole('button', { name: 'Aktionen zeigen' })

    down(toggle, 130, 20)
    fireEvent.pointerMove(minimalCard(), { pointerId: 1, clientX: 200, clientY: 20 })
    expect(bridge.setWindowDragging).not.toHaveBeenCalled()
  })

  /** A gesture that never became a drag must not report the end of one. */
  it('reports no end for a drag that never began', async () => {
    const bridge = await mount('minimal')
    const card = minimalCard()

    down(card, 40, 20)
    fireEvent.pointerUp(card, { pointerId: 1 })
    expect(bridge.setWindowDragging).not.toHaveBeenCalled()
  })
})

/**
 * Which way the card grows, and what that costs the pointer.
 *
 * Growing right, the expand control rides the card's far corner: it moves right
 * with the card's right edge and drops to sit opposite the action buttons, so
 * the pointer that opened the card has to chase it to close again. Growing left,
 * the card's right edge does not move and the control keeps both coordinates —
 * click, act, click again without moving the mouse. That is the whole feature,
 * and it rests on two positions being exactly equal, so it is asserted rather
 * than looked at.
 */
describe('the expand direction', () => {
  const control = (): HTMLElement => screen.getByRole('button', { name: /Aktionen zeigen|verkleinern/ })

  it('pins the card against the edge it does not grow into', async () => {
    await mount('minimal', 'right')
    expect(minimalCard().classList.contains('left-0')).toBe(true)
    cleanup()

    await mount('minimal', 'left')
    expect(minimalCard().classList.contains('right-0')).toBe(true)
  })

  it('leaves the control exactly where it was when growing left', async () => {
    await mount('minimal', 'left')
    const before = control().style.top

    await act(async () => void control().click())
    expect(minimalCard().dataset.open).toBe('true')
    // Same offset from the top, and still 10 px from a right edge that has not
    // moved — so the pointer is still on it.
    expect(control().style.top).toBe(before)
    expect(control().classList.contains('right-2.5')).toBe(true)
  })

  it('moves the control down out of the way when growing right', async () => {
    await mount('minimal', 'right')
    expect(control().style.top).toBe('12px')

    await act(async () => void control().click())
    expect(control().style.top).toBe('88px')
  })

  it('follows a direction change pushed from the tray', async () => {
    const bridge = await mount('minimal', 'right')
    expect(minimalCard().classList.contains('left-0')).toBe(true)

    act(() => bridge.pushSettings({ expandDirection: 'left' }))
    expect(minimalCard().classList.contains('right-0')).toBe(true)
  })
})

/**
 * The second way to open the card.
 *
 * Whether the gesture ever arrives is the platform's answer: a draggable region
 * is a title bar as far as the window manager is concerned, and a title-bar
 * double click is its to handle. What is testable is the handler itself and the
 * one way it can go wrong — a double click on the chevron is already two
 * toggles, and letting it bubble would add a third and leave the card exactly
 * where it started.
 */
describe('double clicking the collapsed card', () => {
  it('toggles the card, both ways', async () => {
    await mount('minimal')
    expect(minimalCard().dataset.open).toBe('false')

    await act(async () => void fireEvent.dblClick(minimalCard()))
    expect(minimalCard().dataset.open).toBe('true')

    await act(async () => void fireEvent.dblClick(minimalCard()))
    expect(minimalCard().dataset.open).toBe('false')
  })

  it('ignores a double click that landed on a control', async () => {
    await mount('minimal')
    const toggle = screen.getByRole('button', { name: 'Aktionen zeigen' })

    // Two clicks on the chevron: open, then closed. The dblclick that follows
    // them must not make it three.
    await act(async () => {
      toggle.click()
      toggle.click()
      fireEvent.dblClick(toggle)
    })
    expect(minimalCard().dataset.open).toBe('false')
  })
})
