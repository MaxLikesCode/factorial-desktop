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
    blocks: [{ id: '554387733', kind: 'work', start: 792, end: 1087, breakConfigurationId: null, breakName: null, locationType: 'office' }],
    expectedMinutes: 480,
    requests: [
      { id: '13542375', requestType: 'update_shift', shiftId: '554387733', start: 792, end: 1135, workable: null, breakConfigurationId: null },
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

    expect(screen.getByText('Beantragte Änderungen')).toBeTruthy()
    const row = document.querySelector('[data-slot="pending-row"]')
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
    expect(screen.queryByText('Beantragte Änderungen')).toBeNull()
    expect(document.querySelector('[data-slot="ghost"]')).toBeNull()
  })
})

describe('ghostsOf', () => {
  it('draws a deletion over the record it would remove, and skips one whose record is gone', () => {
    const d = day({
      requests: [
        { id: 'a', requestType: 'delete_shift', shiftId: '554387733', start: null, end: null, workable: null, breakConfigurationId: null },
        { id: 'b', requestType: 'delete_shift', shiftId: 'gone', start: null, end: null, workable: null, breakConfigurationId: null },
        { id: 'c', requestType: 'create_shift', shiftId: null, start: 540, end: 600, workable: true, breakConfigurationId: null },
      ],
    })
    expect(ghostsOf(d, 'Neu')).toEqual([
      { id: 'a', kind: 'delete', start: 792, end: 1087, label: '13:12 – 18:07' },
      { id: 'c', kind: 'change', start: 540, end: 600, label: 'Neu 09:00 – 10:00' },
    ])
  })
})
