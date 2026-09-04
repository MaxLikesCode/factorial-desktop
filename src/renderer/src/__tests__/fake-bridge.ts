/**
 * A stand-in for what `contextBridge` exposes as `window.factorial`.
 *
 * Not a test file (the vitest `include` only collects `*.test.ts(x)`): it is the
 * shared harness for the renderer tests, which have no main process to talk to.
 * It implements the real `FactorialBridge` interface so a change to the contract
 * breaks the tests at compile time instead of at runtime.
 */

import { vi } from 'vitest'
import {
  serialiseSnapshot,
  type AppSettings,
  type AppSnapshot,
  type FactorialBridge,
  type SerialisedSnapshot,
} from '@shared/ipc-contract'

export const EMPTY_SNAPSHOT: AppSnapshot = {
  state: { kind: 'unknown' },
  todayMinutes: 0,
  daySegments: [],
  incompleteShifts: 0,
  expectedMinutes: null,
  breakOptions: [],
  lastError: null,
  lastErrorKind: null,
  stale: false,
}

export const TEST_SETTINGS: AppSettings = {
  openAtLogin: true,
  alwaysOnTop: true,
  lastLocationType: 'office',
  lastWorkplaceId: null,
  theme: 'system',
  expandDirection: 'right',
  // German, because the widget assertions were written in it and now double
  // as a check that the German catalogue still says those words. The
  // switching itself is covered in i18n.test.ts.
  language: 'de',
  autoInstallUpdates: false,
  skippedUpdateVersion: null,
  askLocationOnClockIn: false,
  longShiftReminderHours: 8,
  autoClockOutHours: null,
  widgetDesign: 'simple',
}

export interface FakeBridge extends FactorialBridge {
  /** Pushes a new snapshot to every subscriber, exactly as the main process does. */
  push(snapshot: AppSnapshot): void
  /** Pushes changed settings the same way the tray's writes reach the widget. */
  pushSettings(patch: Partial<AppSettings>): void
  /**
   * Pushes a pointer position the way the main process does while the window is
   * click-through — on Windows the only source of those the card ever gets.
   */
  pushCursor(position: { x: number; y: number }): void
  /** How many cursor subscriptions are live; a leak shows up here as a number that never falls. */
  readonly cursorListenerCount: number
  readonly listenerCount: number
}

export function createFakeBridge(
  initial: Partial<AppSnapshot> = {},
  settings: Partial<AppSettings> = {},
): FakeBridge {
  const listeners = new Set<(snapshot: SerialisedSnapshot) => void>()
  const settingsListeners = new Set<(settings: AppSettings) => void>()
  const cursorListeners = new Set<(position: { x: number; y: number }) => void>()
  let current: AppSnapshot = { ...EMPTY_SNAPSHOT, ...initial }
  let currentSettings: AppSettings = { ...TEST_SETTINGS, ...settings }

  return {
    getSnapshot: vi.fn(async () => serialiseSnapshot(current)),
    onSnapshot: (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
    clockIn: vi.fn(async () => {}),
    startBreak: vi.fn(async () => {}),
    endBreak: vi.fn(async () => {}),
    clockOut: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    getSettings: vi.fn(async () => currentSettings),
    setSettings: vi.fn(async (patch: Partial<AppSettings>) => {
      currentSettings = { ...currentSettings, ...patch }
      return currentSettings
    }),
    onSettings: (callback) => {
      settingsListeners.add(callback)
      return () => {
        settingsListeners.delete(callback)
      }
    },
    setWindowInteractive: vi.fn(async () => {}),
    onCursorMoved: (callback) => {
      cursorListeners.add(callback)
      return () => {
        cursorListeners.delete(callback)
      }
    },
    setWindowDragging: vi.fn(async () => {}),
    popupMenu: vi.fn(async () => null),
    getTimesheetMonth: vi.fn(async () => ({ year: 2026, month: 9, days: [] })),
    saveTimesheetDay: vi.fn(async (edit) => ({ date: edit.date, blocks: edit.blocks, expectedMinutes: null })),
    openMainWindow: vi.fn(async () => {}),
    onNavigate: () => () => {},
    getAppInfo: vi.fn(async () => ({ version: '0.0.0', electron: '0', chromium: '0', user: { fullName: 'Max', email: 'm@x', companyName: 'X' } })),
    checkForUpdates: vi.fn(async () => {}),
    pushSettings(patch) {
      currentSettings = { ...currentSettings, ...patch }
      for (const listener of [...settingsListeners]) listener(currentSettings)
    },
    pushCursor(position) {
      for (const listener of [...cursorListeners]) listener(position)
    },
    push(snapshot) {
      current = snapshot
      for (const listener of [...listeners]) listener(serialiseSnapshot(snapshot))
    },
    get listenerCount() {
      return listeners.size
    },
    get cursorListenerCount() {
      return cursorListeners.size
    },
  }
}

/** Installs the fake as `window.factorial` and hands it back. */
export function installBridge(
  initial: Partial<AppSnapshot> = {},
  settings: Partial<AppSettings> = {},
): FakeBridge {
  const bridge = createFakeBridge(initial, settings)
  window.factorial = bridge
  return bridge
}
