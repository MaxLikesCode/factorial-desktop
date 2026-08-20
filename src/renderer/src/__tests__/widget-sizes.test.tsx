import { act, cleanup, render, screen } from '@testing-library/react'
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

async function mount(size: 'standard' | 'kompakt' | 'minimal'): Promise<FakeBridge> {
  const bridge = installBridge(CLOCKED_IN, { widgetSize: size })
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
