/**
 * Both pickers open a NATIVE menu rather than drawing one in the page.
 *
 * The widget's window is 321 x 179, and a menu inside it is clipped — the break
 * list was cut off after two entries with the rest behind a scrollbar. No window
 * size fixes that: the list is however long an employer configured it, and this
 * window's size is fixed by the animation. So what is testable here is no longer
 * the menu's markup but the request: the right rows, the right anchor, and what
 * the component does with the answer.
 */

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BreakMenu } from '@renderer/components/BreakMenu'
import { LOCATIONS, LocationSelect } from '@renderer/components/LocationSelect'
import { installBridge, type FakeBridge } from './fake-bridge'

afterEach(cleanup)

/** Makes the next `popupMenu` resolve as if the user had picked `id`. */
function bridgeAnswering(id: string | null): FakeBridge {
  const bridge = installBridge()
  vi.mocked(bridge.popupMenu).mockResolvedValue(id)
  return bridge
}

describe('BreakMenu', () => {
  const options = [
    { id: '19613', name: 'Mittagspause' },
    { id: '20261', name: 'Arztbesuch' },
  ]

  it('offers every break type the store knows, and reports the chosen id', async () => {
    const bridge = bridgeAnswering('19613')
    const onSelect = vi.fn()
    render(<BreakMenu options={options} disabled={false} onSelect={onSelect} />)

    await act(async () => void screen.getByRole('button', { name: 'Break' }).click())

    expect(bridge.popupMenu).toHaveBeenCalledWith(
      [
        { id: '19613', label: 'Mittagspause' },
        { id: '20261', label: 'Arztbesuch' },
      ],
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    )
    expect(onSelect).toHaveBeenCalledWith('19613')
  })

  /** Dismissing the menu is not choosing the first entry. */
  it('starts nothing when the menu is dismissed', async () => {
    bridgeAnswering(null)
    const onSelect = vi.fn()
    render(<BreakMenu options={options} disabled={false} onSelect={onSelect} />)

    await act(async () => void screen.getByRole('button', { name: 'Break' }).click())
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('is disabled when the store has no break types to offer', () => {
    render(<BreakMenu options={[]} disabled={false} onSelect={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Break' }).hasAttribute('disabled')).toBe(true)
  })

  it('is disabled while another action runs', () => {
    render(<BreakMenu options={options} disabled onSelect={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Break' }).hasAttribute('disabled')).toBe(true)
  })
})

describe('LocationSelect', () => {
  /**
   * Rendered on its own, before any settings have arrived, so this is the
   * fallback language — which is the system's, and English under jsdom. The
   * point of the assertion is unchanged: a label, never the enum member. Showing
   * `work_from_home` in the footer was a real bug once.
   */
  it('shows a label for the current value, not the enum member', () => {
    render(<LocationSelect value="work_from_home" disabled={false} onChange={vi.fn()} />)
    expect(screen.getByText('Remote work')).toBeTruthy()
    expect(screen.queryByText('work_from_home')).toBeNull()
  })

  /**
   * And the same control once the stored language has arrived. This is the path
   * that broke when the labels were hard-coded German: the words have to follow
   * the setting, not the build.
   */
  it('follows the stored language once the settings arrive', async () => {
    const bridge = installBridge()
    render(<LocationSelect value="work_from_home" disabled={false} onChange={vi.fn()} />)
    await act(async () => {
      bridge.pushSettings({ language: 'de' })
    })
    expect(screen.getByText('Mobiles Arbeiten')).toBeTruthy()

    await act(async () => {
      bridge.pushSettings({ language: 'es' })
    })
    expect(screen.getByText('Teletrabajo')).toBeTruthy()
  })

  /**
   * The current value is marked, which is what makes the platform draw the rows
   * as a radio group — the menu then answers "which one is set" without being
   * read.
   */
  it('marks the current location so the menu reads as a choice already made', async () => {
    const bridge = bridgeAnswering('business_trip')
    const onChange = vi.fn()
    render(<LocationSelect value="work_from_home" disabled={false} onChange={onChange} />)

    await act(async () => void screen.getByRole('button', { name: 'Work location' }).click())

    expect(bridge.popupMenu).toHaveBeenCalledWith(
      [
        { id: 'office', label: 'Office', checked: false },
        { id: 'work_from_home', label: 'Remote work', checked: true },
        { id: 'business_trip', label: 'Business trip', checked: false },
      ],
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    )
    expect(onChange).toHaveBeenCalledWith('business_trip')
  })

  it('offers exactly the three values the schema accepts', () => {
    expect(LOCATIONS.map((l) => l.value)).toEqual(['office', 'work_from_home', 'business_trip'])
  })
})
