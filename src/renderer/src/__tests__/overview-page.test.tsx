import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OverviewInsights } from '@shared/overview'
import { OverviewPage } from '@renderer/app/OverviewPage'
import { EMPTY_SNAPSHOT, installBridge } from './fake-bridge'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))

/** The real 5 September 2026: two holidays booked, one requested, the month a little behind. */
const INSIGHTS: OverviewInsights = {
  leaves: [
    { id: '33401718', startOn: '2026-11-19', finishOn: '2026-11-20', approved: true, name: 'Urlaub', color: '07A2AD', days: 2 },
    { id: '33401760', startOn: '2026-11-23', finishOn: '2026-11-27', approved: true, name: 'Urlaub', color: '07A2AD', days: 5 },
    { id: '9', startOn: '2026-12-24', finishOn: '2026-12-24', approved: null, name: 'Sonderurlaub', color: null, days: 1 },
  ],
  month: { startOn: '2026-09-01', endOn: '2026-09-30', workedMinutes: 1856, expectedToDate: 1920, expectedTotal: 10560, pendingInconsistencies: 1 },
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function mount(insights: OverviewInsights | Error = INSIGHTS) {
  const bridge = installBridge({ state: { kind: 'out' }, todayMinutes: 0 })
  bridge.getOverviewInsights = vi.fn(async () => {
    if (insights instanceof Error) throw insights
    return insights
  })
  render(<OverviewPage onEditToday={vi.fn()} />)
  await act(async () => {})
  return bridge
}

describe('OverviewPage cards', () => {
  it('lists the upcoming absences with their days, and marks the one still requested', async () => {
    await mount()
    const card = document.querySelector('[data-slot="absences"]')
    expect(card?.textContent).toContain('Abwesenheiten')
    expect(card?.textContent).toContain('2 Tage')
    expect(card?.textContent).toContain('5 Tage')
    expect(card?.textContent).toContain('1 Tag')
    expect(card?.textContent).toContain('Sonderurlaub')
    expect(card?.querySelectorAll('.app-pending-badge')).toHaveLength(1)
    expect(card?.querySelectorAll('li')).toHaveLength(3)
  })

  it('says so when nothing is booked', async () => {
    await mount({ ...INSIGHTS, leaves: [] })
    expect(screen.getByText('Keine bevorstehenden Abwesenheiten')).toBeTruthy()
  })

  it('shows the month’s worked time and its balance against the target to date', async () => {
    await mount()
    const card = document.querySelector('[data-slot="month"]')
    expect(card?.textContent).toContain('30:56 h')
    expect(card?.querySelector('[data-slot="balance"]')?.textContent).toBe('−1:04 h')
    expect(card?.textContent).toContain('Soll bis heute 32:00 h')
    expect(card?.textContent).toContain('Soll im Monat 176:00 h')
    expect(card?.textContent).toContain('1 zu vervollständigen')
  })

  it('does not ask while the clock is not known yet, and asks once it is', async () => {
    const bridge = installBridge({ state: { kind: 'unknown' } })
    render(<OverviewPage onEditToday={vi.fn()} />)
    await act(async () => {})
    expect(bridge.getOverviewInsights).not.toHaveBeenCalled()

    await act(async () => {
      bridge.push({ ...EMPTY_SNAPSHOT, state: { kind: 'out' } })
    })
    expect(bridge.getOverviewInsights).toHaveBeenCalledTimes(1)
  })

  it('shows the reason when the cards cannot be loaded', async () => {
    await mount(new Error('factorial-action-error/network: offline'))
    expect(document.querySelector('[data-slot="absences"]')?.textContent).toContain('Konnte nicht geladen werden')
  })
})
