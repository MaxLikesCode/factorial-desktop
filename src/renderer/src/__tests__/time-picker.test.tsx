import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { TimePicker } from '../app/TimePicker'
import { installBridge } from './fake-bridge'

afterEach(cleanup)

it('keeps minute precision, supports keyboard selection and only saves on Apply', async () => {
  installBridge()
  const onChange = vi.fn()
  render(<TimePicker label="Lunch" value="12:37" onChange={onChange} />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Lunch: 12:37' }))
  const minutes = within(screen.getByRole('listbox', { name: 'Minute' }))
  expect(minutes.getByRole('option', { name: '37' }).getAttribute('aria-selected')).toBe('true')
  fireEvent.keyDown(minutes.getByRole('option', { name: '37' }), { key: 'ArrowDown' })
  expect(minutes.getByRole('option', { name: '38' }).getAttribute('aria-selected')).toBe('true')
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }))
  expect(onChange).toHaveBeenCalledExactlyOnceWith('12:38')
})

it('discards changes on Escape and reopens at the saved time', async () => {
  installBridge()
  const onChange = vi.fn()
  render(<TimePicker label="Lunch" value="12:37" onChange={onChange} />)
  await act(async () => {})
  const trigger = screen.getByRole('button', { name: 'Lunch: 12:37' })
  fireEvent.click(trigger)
  const hour = within(screen.getByRole('listbox', { name: 'Stunde' })).getByRole('option', { name: '14' })
  fireEvent.click(hour)
  fireEvent.keyDown(hour, { key: 'Escape' })
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.click(trigger)
  expect(within(screen.getByRole('listbox', { name: 'Stunde' })).getByRole('option', { name: '12' }).getAttribute('aria-selected')).toBe('true')
})
