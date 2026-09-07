import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TimesheetDay } from '@shared/timesheet'
import { DayEditor, ghostsOf } from '@renderer/app/DayEditor'
import { installBridge } from './fake-bridge'

const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess, info: vi.fn() } }))

/** The real 1 September: one work block, one request to end it later. */
function day(over: Partial<TimesheetDay> = {}): TimesheetDay {
  return {
    date: '2026-09-01',
    blocks: [{ id: '554387733', kind: 'work', start: 792, end: 1087, breakConfigurationId: null, breakName: null, locationType: 'office', workplaceId: null }],
    expectedMinutes: 480,
    requests: [
      { id: '13542375', requestType: 'update_shift', shiftId: '554387733', start: 792, end: 1135, workable: null, breakConfigurationId: null, locationType: null },
    ],
    ...over,
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('DayEditor with pending requests', () => {
  it('shows what is recorded next to what was asked for, and draws the request on the strip', async () => {
    installBridge()
    render(<DayEditor day={day()} breakOptions={[]} now={null} onSaved={vi.fn()} />)
    await act(async () => {})

    // The request hangs off the row of the record it is about.
    const block = document.querySelector('[data-slot="rows"] > [data-slot="block"][data-pending]')
    const row = block?.querySelector('[data-slot="pending-row"]')
    expect(block?.querySelector('[data-slot="block-row"]')).toBeTruthy()
    expect(row?.textContent).toContain('Beantragt')
    expect(row?.textContent).toContain('13:12 – 18:07')
    expect(row?.textContent).toContain('13:12 – 18:55')
    // The field still says 18:07: the request is not in the timesheet.
    expect((screen.getAllByRole('textbox')[1] as HTMLInputElement).value).toBe('18:07')
    expect(document.querySelector('[data-slot="ghost"]')?.getAttribute('title')).toBe('13:12 – 18:55')
  })

  it('withdraws a request and hands the re-read day back', async () => {
    const bridge = installBridge()
    const onSaved = vi.fn()
    render(<DayEditor day={day()} breakOptions={[]} now={null} onSaved={onSaved} />)
    await act(async () => {})

    await act(async () => void screen.getByRole('button', { name: 'Zurückziehen' }).click())

    expect(bridge.withdrawTimesheetRequest).toHaveBeenCalledWith('13542375', '2026-09-01')
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-09-01', requests: [] }))
    expect(toastSuccess).toHaveBeenCalledWith('Antrag zurückgezogen')
  })

  it('shows nothing of the kind on a settled day', async () => {
    installBridge()
    render(<DayEditor day={day({ requests: [] })} breakOptions={[]} now={null} onSaved={vi.fn()} />)
    await act(async () => {})
    expect(document.querySelector('[data-slot="pending-row"]')).toBeNull()
    expect(document.querySelector('[data-slot="ghost"]')).toBeNull()
  })
})

describe('DayEditor work location', () => {
  it('offers the place on a work block and requests the day with it changed', async () => {
    const bridge = installBridge()
    render(<DayEditor day={day({ requests: [] })} breakOptions={[]} now={null} onSaved={vi.fn()} />)
    await act(async () => {})

    const chip = screen.getByRole('button', { name: 'Büro' })
    await act(async () => void chip.click())
    await act(async () => void screen.getByRole('option', { name: 'Mobiles Arbeiten' }).click())
    expect(screen.getByRole('button', { name: 'Mobiles Arbeiten' })).toBeTruthy()

    await act(async () => void screen.getByRole('button', { name: 'Änderungen beantragen' }).click())
    expect(bridge.saveTimesheetDay).toHaveBeenCalledWith({
      date: '2026-09-01',
      blocks: [expect.objectContaining({ id: '554387733', locationType: 'work_from_home' })],
    })
  })

  it('shows the place a request moves the record to, next to the one it has', async () => {
    installBridge()
    const request = { ...day().requests[0]!, end: 1087, locationType: 'work_from_home' }
    render(<DayEditor day={day({ requests: [request] })} breakOptions={[]} now={null} onSaved={vi.fn()} />)
    await act(async () => {})
    const row = document.querySelector('[data-slot="pending-row"]')?.textContent ?? ''
    expect(row).toContain('Büro')
    expect(row).toContain('Mobiles Arbeiten')
    // Nothing moved in time, so the times are not repeated on both sides.
    expect(row).not.toContain('13:12')
  })

  it('shows times and place together when both move', async () => {
    installBridge()
    const request = { ...day().requests[0]!, locationType: 'business_trip' }
    render(<DayEditor day={day({ requests: [request] })} breakOptions={[]} now={null} onSaved={vi.fn()} />)
    await act(async () => {})
    const row = document.querySelector('[data-slot="pending-row"]')?.textContent ?? ''
    expect(row).toContain('13:12 – 18:07 · Büro')
    expect(row).toContain('13:12 – 18:55 · Dienstreise')
  })

  it('falls back to naming a change of place when the request does not say where', async () => {
    installBridge()
    render(<DayEditor day={day({ requests: [{ ...day().requests[0]!, end: 1087 }] })} breakOptions={[]} now={null} onSaved={vi.fn()} />)
    await act(async () => {})
    expect(document.querySelector('[data-slot="pending-row"]')?.textContent).toContain('Arbeitsort geändert')
  })
})

describe('DayEditor projected sum', () => {
  it('shows what the day would sum to once the request is approved', async () => {
    installBridge()
    // 13:12–18:07 is 4:55 h; the request ends it at 18:55, which is 5:43 h.
    render(<DayEditor day={day()} breakOptions={[]} now={null} onSaved={vi.fn()} />)
    await act(async () => {})
    expect(document.querySelector('[data-slot="sums"]')?.textContent).toContain('4:55 h')
    const projected = document.querySelector('[data-slot="projected"]')?.textContent ?? ''
    expect(projected).toContain('5:43 h')
    expect(projected).toContain('(−2:17 h)')
    expect(projected).toContain('nach Genehmigung')
  })

  it('shows no projection when the request changes no time', async () => {
    installBridge()
    render(<DayEditor day={day({ requests: [{ ...day().requests[0]!, end: 1087, locationType: 'work_from_home' }] })} breakOptions={[]} now={null} onSaved={vi.fn()} />)
    await act(async () => {})
    expect(document.querySelector('[data-slot="projected"]')).toBeNull()
  })
})

describe('DayEditor with a requested new block', () => {
  it('puts the block that was only asked for where it would sit, marked new', async () => {
    installBridge()
    const created = { id: 'c', requestType: 'create_shift' as const, shiftId: null, start: 540, end: 600, workable: true, breakConfigurationId: null, locationType: 'office' }
    render(<DayEditor day={day({ requests: [created] })} breakOptions={[]} now={null} onSaved={vi.fn()} />)
    await act(async () => {})
    const rows = [...document.querySelectorAll('[data-slot="rows"] > [data-slot="block"], [data-slot="rows"] > [data-slot="pending-row"]')]
    // 09:00 comes before the 13:12 record.
    expect(rows.map((r) => r.getAttribute('data-slot'))).toEqual(['pending-row', 'block'])
    expect(rows[0]?.textContent).toContain('Neu')
    expect(rows[0]?.textContent).toContain('09:00 – 10:00 · Büro')
  })
})

describe('ghostsOf', () => {
  it('draws a deletion over the record it would remove, and skips one whose record is gone', () => {
    const d = day({
      requests: [
        { id: 'a', requestType: 'delete_shift', shiftId: '554387733', start: null, end: null, workable: null, breakConfigurationId: null, locationType: null },
        { id: 'b', requestType: 'delete_shift', shiftId: 'gone', start: null, end: null, workable: null, breakConfigurationId: null, locationType: null },
        { id: 'c', requestType: 'create_shift', shiftId: null, start: 540, end: 600, workable: true, breakConfigurationId: null, locationType: null },
      ],
    })
    expect(ghostsOf(d, 'Neu')).toEqual([
      { id: 'a', kind: 'delete', start: 792, end: 1087, label: '13:12 – 18:07' },
      { id: 'c', kind: 'change', start: 540, end: 600, label: 'Neu 09:00 – 10:00' },
    ])
  })
})
