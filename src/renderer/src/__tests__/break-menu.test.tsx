/**
 * K11: these two components are the ones the plan wrote against Radix props.
 * Nova is Base UI, so the trigger takes `render` instead of `asChild` and the
 * item takes `onClick` instead of `onSelect`. A rename that happens to stay
 * type-compatible would not be caught by `tsc` — clicking through it is.
 */

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BreakMenu } from '@renderer/components/BreakMenu'
import { LOCATIONS, LocationSelect } from '@renderer/components/LocationSelect'

// Vitest runs without `globals`, so Testing Library registers no auto-cleanup.
afterEach(cleanup)

describe('BreakMenu', () => {
  const options = [
    { id: '19613', name: 'Mittagspause' },
    { id: '20261', name: 'Arztbesuch' },
  ]

  it('reports the chosen break id', async () => {
    const onSelect = vi.fn()
    render(<BreakMenu options={options} disabled={false} onSelect={onSelect} />)

    await act(async () => void screen.getByRole('button', { name: 'Pause' }).click())
    await act(async () => void screen.getByText('Mittagspause').click())

    expect(onSelect).toHaveBeenCalledWith('19613')
  })

  it('is disabled when the store has no break types to offer', () => {
    render(<BreakMenu options={[]} disabled={false} onSelect={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Pause' }).hasAttribute('disabled')).toBe(true)
  })

  it('is disabled while another action runs', () => {
    render(<BreakMenu options={options} disabled onSelect={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Pause' }).hasAttribute('disabled')).toBe(true)
  })
})

describe('LocationSelect', () => {
  it('shows the German label of the current value, not the enum member', () => {
    render(<LocationSelect value="work_from_home" disabled={false} onChange={vi.fn()} />)
    expect(screen.getByText('Homeoffice')).toBeTruthy()
    expect(screen.queryByText('work_from_home')).toBeNull()
  })

  it('offers exactly the three values the schema accepts', () => {
    expect(LOCATIONS.map((l) => l.value)).toEqual(['office', 'work_from_home', 'business_trip'])
  })
})
