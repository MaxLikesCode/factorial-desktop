import { afterEach, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { SettingsPage } from '../app/SettingsPage'
import { installBridge } from './fake-bridge'

afterEach(cleanup)

it('configures duration, lunch time and worked-hours reminders independently', async () => {
  const bridge = installBridge()
  render(<SettingsPage />)
  await act(async () => {})

  const row = (label: string) => within(screen.getByText(label).closest('label')!)
  fireEvent.click(row('An laufende Pause erinnern nach').getByRole('button'))
  fireEvent.click(screen.getByRole('option', { name: '60 Min.' }))
  await act(async () => {})
  expect(bridge.setSettings).toHaveBeenLastCalledWith({ breakDurationReminderMinutes: 60 })
  act(() => bridge.pushSettings({ breakDurationReminderMinutes: 60 }))

  fireEvent.click(row('An Mittagspause erinnern um').getByRole('button'))
  fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }))
  await act(async () => {})
  expect(bridge.setSettings).toHaveBeenLastCalledWith({ lunchReminderTime: '12:30' })
  act(() => bridge.pushSettings({ lunchReminderTime: '12:30' }))
  fireEvent.click(row('An Mittagspause erinnern um').getByRole('button'))
  fireEvent.click(within(screen.getByRole('listbox', { name: 'Stunde' })).getByRole('option', { name: '13' }))
  fireEvent.click(within(screen.getByRole('listbox', { name: 'Minute' })).getByRole('option', { name: '00' }))
  fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }))
  await act(async () => {})
  expect(bridge.setSettings).toHaveBeenLastCalledWith({ lunchReminderTime: '13:00' })
  act(() => bridge.pushSettings({ lunchReminderTime: '13:00' }))

  fireEvent.click(row('An Mittagspause erinnern nach').getByRole('button'))
  const lunchChoices = within(screen.getByRole('listbox'))
  expect(lunchChoices.getAllByRole('option').map((option) => option.textContent)).toEqual(['Aus', '1 h', '2 h', '3 h', '4 h'])
  fireEvent.click(lunchChoices.getByRole('option', { name: '1 h' }))
  await act(async () => {})
  expect(bridge.setSettings).toHaveBeenLastCalledWith({ lunchReminderHours: 1 })
  act(() => bridge.pushSettings({ lunchReminderHours: 1 }))
  expect(row('An Mittagspause erinnern um').getByRole('button').textContent).toContain('13:00')

  fireEvent.click(row('An Mittagspause erinnern um').getByRole('button'))
  fireEvent.click(screen.getByRole('button', { name: 'Aus' }))
  await act(async () => {})
  expect(bridge.setSettings).toHaveBeenLastCalledWith({ lunchReminderTime: null })
  expect(row('An Mittagspause erinnern nach').getByRole('button').textContent).toContain('1 h')
})
