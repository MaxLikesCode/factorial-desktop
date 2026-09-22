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

  fireEvent.click(row('An Mittagspause erinnern um').getByRole('switch'))
  await act(async () => {})
  expect(bridge.setSettings).toHaveBeenLastCalledWith({ lunchReminderTime: '12:30' })
  act(() => bridge.pushSettings({ lunchReminderTime: '12:30' }))
  fireEvent.change(screen.getByLabelText('An Mittagspause erinnern um'), { target: { value: '13:00' } })
  await act(async () => {})
  expect(bridge.setSettings).toHaveBeenLastCalledWith({ lunchReminderTime: '13:00' })
  act(() => bridge.pushSettings({ lunchReminderTime: '13:00' }))

  fireEvent.click(row('An Mittagspause erinnern nach').getByRole('button'))
  fireEvent.click(screen.getByRole('option', { name: '4 h' }))
  await act(async () => {})
  expect(bridge.setSettings).toHaveBeenLastCalledWith({ lunchReminderHours: 4 })
  act(() => bridge.pushSettings({ lunchReminderHours: 4 }))
  expect((screen.getByLabelText('An Mittagspause erinnern um') as HTMLInputElement).value).toBe('13:00')

  fireEvent.click(row('An Mittagspause erinnern um').getByRole('switch'))
  await act(async () => {})
  expect(bridge.setSettings).toHaveBeenLastCalledWith({ lunchReminderTime: null })
  expect(row('An Mittagspause erinnern nach').getByRole('button').textContent).toContain('4 h')
})
