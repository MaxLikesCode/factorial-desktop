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
}

export interface FakeBridge extends FactorialBridge {
  /** Pushes a new snapshot to every subscriber, exactly as the main process does. */
  push(snapshot: AppSnapshot): void
  readonly listenerCount: number
}

export function createFakeBridge(
  initial: Partial<AppSnapshot> = {},
  settings: Partial<AppSettings> = {},
): FakeBridge {
  const listeners = new Set<(snapshot: SerialisedSnapshot) => void>()
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
    push(snapshot) {
      current = snapshot
      for (const listener of [...listeners]) listener(serialiseSnapshot(snapshot))
    },
    get listenerCount() {
      return listeners.size
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
