import { describe, it, expect, vi } from 'vitest'
import { IPC, decodeActionError, type AppSettings, type SerialisedSnapshot } from '@shared/ipc-contract'
import { ACTION_IN_FLIGHT_MESSAGE, type AttendanceSnapshot } from '../attendance'
import { FactorialError } from '../factorial/client'
import { createIpcHandlers, createSnapshotBroadcaster, type IpcStore } from '../ipc-handlers'

const SNAPSHOT: AttendanceSnapshot = {
  state: { kind: 'out' },
  todayMinutes: 0,
  incompleteShifts: 0,
  expectedMinutes: null,
  breakOptions: [],
  lastError: null,
  lastErrorKind: null,
  stale: false,
}

const SETTINGS: AppSettings = {
  openAtLogin: true,
  alwaysOnTop: true,
  lastLocationType: 'office',
  lastWorkplaceId: null,
  theme: 'system',
  widgetSize: 'standard',
  expandDirection: 'right',
}

function fakeStore(overrides: Partial<IpcStore> = {}): IpcStore & { listeners: (() => void)[] } {
  const listeners: (() => void)[] = []
  return {
    listeners,
    getSnapshot: () => SNAPSHOT,
    subscribe: (listener: () => void) => {
      listeners.push(listener)
      return () => {
        const at = listeners.indexOf(listener)
        if (at >= 0) listeners.splice(at, 1)
      }
    },
    refresh: async () => {},
    clockIn: async () => {},
    startBreak: async () => {},
    endBreak: async () => {},
    clockOut: async () => {},
    ...overrides,
  }
}

function fakeSettings(current: AppSettings = SETTINGS) {
  const set = vi.fn((patch: Partial<AppSettings>) => ({ ...current, ...patch }))
  return { get: () => current, set }
}

function handlersFor(store: IpcStore, settings = fakeSettings(), onSignOut = vi.fn(async () => {})) {
  const setWindowInteractive = vi.fn()
  const setWindowDragging = vi.fn()
  return {
    handlers: createIpcHandlers({
      store,
      settings,
      onSignOut,
      setWindowInteractive,
      setWindowDragging,
    }),
    settings,
    onSignOut,
    setWindowInteractive,
    setWindowDragging,
  }
}

/** Every rejection crosses IPC as a string; this is how the renderer reads it. */
async function rejection(promise: Promise<unknown>): Promise<{ kind: string; message: string }> {
  try {
    await promise
  } catch (error) {
    return decodeActionError(error instanceof Error ? error.message : String(error))
  }
  throw new Error('expected a rejection')
}

describe('createIpcHandlers', () => {
  it('registers exactly the invoke channels, and not the push channel', () => {
    const { handlers } = handlersFor(fakeStore())
    expect(Object.keys(handlers).sort()).toEqual(
      [
        IPC.getSnapshot,
        IPC.clockIn,
        IPC.startBreak,
        IPC.endBreak,
        IPC.clockOut,
        IPC.refresh,
        IPC.signOut,
        IPC.getSettings,
        IPC.setSettings,
        IPC.setWindowInteractive,
        IPC.setWindowDragging,
      ].sort(),
    )
    expect(Object.keys(handlers)).not.toContain(IPC.snapshotChanged)
  })

  it('serialises the snapshot on its way out', async () => {
    const since = new Date(2026, 7, 12, 8, 30, 0)
    const store = fakeStore({
      getSnapshot: () => ({
        ...SNAPSHOT,
        state: { kind: 'in', shiftId: '5', since, locationType: 'office', workplaceId: 3333333 },
      }),
    })
    const { handlers } = handlersFor(store)
    const payload = (await handlers[IPC.getSnapshot](undefined)) as SerialisedSnapshot
    if (payload.state.kind !== 'in') throw new Error('unreachable')
    expect(payload.state.sinceMs).toBe(since.getTime())
    // Structured clone would drop a Date's identity; nothing here may be one.
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })
})

describe('clock-in payload validation', () => {
  it('passes a valid location straight through', async () => {
    const clockIn = vi.fn(async () => {})
    const { handlers } = handlersFor(fakeStore({ clockIn }))
    await handlers[IPC.clockIn]({ locationType: 'work_from_home', workplaceId: 3333333 })
    expect(clockIn).toHaveBeenCalledWith({ locationType: 'work_from_home', workplaceId: 3333333 })
  })

  it('defaults a missing workplace to null rather than sending undefined', async () => {
    const clockIn = vi.fn(async () => {})
    const { handlers } = handlersFor(fakeStore({ clockIn }))
    await handlers[IPC.clockIn]({ locationType: 'office' })
    expect(clockIn).toHaveBeenCalledWith({ locationType: 'office', workplaceId: null })
  })

  it('refuses a location the schema does not know, instead of failing at the API', async () => {
    const clockIn = vi.fn(async () => {})
    const { handlers } = handlersFor(fakeStore({ clockIn }))
    const failure = await rejection(handlers[IPC.clockIn]({ locationType: 'beach' }))
    expect(failure.message).toMatch(/beach/)
    expect(clockIn).not.toHaveBeenCalled()
  })

  it('refuses a workplace id that is not an Int (K4)', async () => {
    const clockIn = vi.fn(async () => {})
    const { handlers } = handlersFor(fakeStore({ clockIn }))
    await rejection(
      handlers[IPC.clockIn]({ locationType: 'office', workplaceId: '3333333' }),
    )
    expect(clockIn).not.toHaveBeenCalled()
  })

  it('refuses a payload that is not an object at all', async () => {
    const { handlers } = handlersFor(fakeStore())
    await rejection(handlers[IPC.clockIn](null))
  })

  it('refuses an empty break id', async () => {
    const startBreak = vi.fn(async () => {})
    const { handlers } = handlersFor(fakeStore({ startBreak }))
    await rejection(handlers[IPC.startBreak](''))
    expect(startBreak).not.toHaveBeenCalled()
  })

  it('forwards a break id', async () => {
    const startBreak = vi.fn(async () => {})
    const { handlers } = handlersFor(fakeStore({ startBreak }))
    await handlers[IPC.startBreak]('19613')
    expect(startBreak).toHaveBeenCalledWith('19613')
  })
})

describe('failure propagation', () => {
  it('keeps the server’s own words and tags them as a GraphQL failure', async () => {
    const store = fakeStore({
      clockOut: async () => {
        throw new FactorialError('graphql', 'Shift already closed')
      },
    })
    const { handlers } = handlersFor(store)
    expect(await rejection(handlers[IPC.clockOut](undefined))).toEqual({
      kind: 'graphql',
      message: 'Shift already closed',
    })
  })

  it('tags a network failure so the UI can say "keine Verbindung"', async () => {
    const store = fakeStore({
      clockIn: async () => {
        throw new FactorialError('network', 'request timed out after 15000 ms')
      },
    })
    const { handlers } = handlersFor(store)
    const failure = await rejection(
      handlers[IPC.clockIn]({ locationType: 'office', workplaceId: null }),
    )
    expect(failure.kind).toBe('network')
  })

  it('marks a refused second click as busy, so no English internals reach a user', async () => {
    // The store throws this when an action is already running. Without a kind of
    // its own the renderer (and the tray, which has no disabled buttons) would
    // show the raw English sentence.
    const store = fakeStore({
      clockOut: async () => {
        throw new Error(ACTION_IN_FLIGHT_MESSAGE)
      },
    })
    const { handlers } = handlersFor(store)
    expect((await rejection(handlers[IPC.clockOut](undefined))).kind).toBe(
      'busy',
    )
  })

  it('classifies anything else as unknown rather than swallowing it', async () => {
    const store = fakeStore({
      endBreak: async () => {
        throw new Error('cannot read properties of undefined')
      },
    })
    const { handlers } = handlersFor(store)
    expect(await rejection(handlers[IPC.endBreak](undefined))).toEqual({
      kind: 'unknown',
      message: 'cannot read properties of undefined',
    })
  })

  it('survives a thrown non-Error', async () => {
    const store = fakeStore({
      clockOut: async () => {
        throw 'plain string'
      },
    })
    const { handlers } = handlersFor(store)
    expect(await rejection(handlers[IPC.clockOut](undefined))).toEqual({
      kind: 'unknown',
      message: 'plain string',
    })
  })
})

describe('settings and session channels', () => {
  it('hands out the current settings', async () => {
    const { handlers } = handlersFor(fakeStore())
    await expect(handlers[IPC.getSettings](undefined)).resolves.toEqual(SETTINGS)
  })

  it('keeps only known keys of a patch', async () => {
    const { handlers, settings } = handlersFor(fakeStore())
    await handlers[IPC.setSettings]({
      alwaysOnTop: false,
      lastWorkplaceId: 3333333,
      ancientFlag: true,
    })
    expect(settings.set).toHaveBeenCalledWith({ alwaysOnTop: false, lastWorkplaceId: 3333333 })
  })

  it('drops a value of the wrong type instead of persisting it', async () => {
    const { handlers, settings } = handlersFor(fakeStore())
    await handlers[IPC.setSettings]({ alwaysOnTop: 'yes', lastWorkplaceId: '3333333' })
    expect(settings.set).toHaveBeenCalledWith({})
  })

  it('drops a non-integer workplace id instead of rejecting the whole call (K4)', async () => {
    // Every other wrong-typed value is dropped silently; a fraction used to
    // throw and take the valid keys of the same patch down with it.
    const { handlers, settings } = handlersFor(fakeStore())
    await handlers[IPC.setSettings]({ alwaysOnTop: false, lastWorkplaceId: 1.5 })
    expect(settings.set).toHaveBeenCalledWith({ alwaysOnTop: false })
  })

  it('drops a location type the API does not know', async () => {
    const { handlers, settings } = handlersFor(fakeStore())
    await handlers[IPC.setSettings]({ lastLocationType: 'moon_base' })
    expect(settings.set).toHaveBeenCalledWith({})
  })

  it('passes a known location type through', async () => {
    const { handlers, settings } = handlersFor(fakeStore())
    await handlers[IPC.setSettings]({ lastLocationType: 'work_from_home' })
    expect(settings.set).toHaveBeenCalledWith({ lastLocationType: 'work_from_home' })
  })

  it('passes a known appearance through', async () => {
    const { handlers, settings } = handlersFor(fakeStore())
    await handlers[IPC.setSettings]({ theme: 'dark' })
    expect(settings.set).toHaveBeenCalledWith({ theme: 'dark' })
  })

  /**
   * The value is assigned straight to `nativeTheme.themeSource`, which throws on
   * anything outside the three — so a bad one must not get past this layer even
   * though the store whitelists it a second time.
   */
  it('drops an appearance that is not one of the three', async () => {
    const { handlers, settings } = handlersFor(fakeStore())
    await handlers[IPC.setSettings]({ theme: 'midnight' })
    expect(settings.set).toHaveBeenCalledWith({})
  })

  it('passes a known widget size through', async () => {
    const { handlers, settings } = handlersFor(fakeStore())
    await handlers[IPC.setSettings]({ widgetSize: 'kompakt' })
    expect(settings.set).toHaveBeenCalledWith({ widgetSize: 'kompakt' })
  })

  it('passes a known expand direction through', async () => {
    const { handlers, settings } = handlersFor(fakeStore())
    await handlers[IPC.setSettings]({ expandDirection: 'left' })
    expect(settings.set).toHaveBeenCalledWith({ expandDirection: 'left' })
  })

  it('drops an expand direction that is not one of the two', async () => {
    const { handlers, settings } = handlersFor(fakeStore())
    await handlers[IPC.setSettings]({ expandDirection: 'up' })
    expect(settings.set).toHaveBeenCalledWith({})
  })

  it('drops a widget size that has no layout', async () => {
    const { handlers, settings } = handlersFor(fakeStore())
    await handlers[IPC.setSettings]({ widgetSize: 'winzig' })
    expect(settings.set).toHaveBeenCalledWith({})
  })

  /**
   * A window stuck interactive swallows a rectangle of somebody's desktop, and
   * nothing on screen explains why — so anything but a literal `true` has to
   * mean "let the clicks through".
   */
  it('treats every non-true payload as a request to let clicks through', async () => {
    const { handlers, setWindowInteractive } = handlersFor(fakeStore())
    for (const payload of [true, false, undefined, null, 'true', 1, {}]) {
      await handlers[IPC.setWindowInteractive](payload)
    }
    expect(setWindowInteractive.mock.calls.map(([value]) => value)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ])
  })

  it('accepts an explicit null workplace, which means "no workplace"', async () => {
    const { handlers, settings } = handlersFor(fakeStore())
    await handlers[IPC.setSettings]({ lastWorkplaceId: null })
    expect(settings.set).toHaveBeenCalledWith({ lastWorkplaceId: null })
  })

  it('returns the settings the store actually stored', async () => {
    const { handlers } = handlersFor(fakeStore())
    await expect(handlers[IPC.setSettings]({ alwaysOnTop: false })).resolves.toEqual({
      ...SETTINGS,
      alwaysOnTop: false,
    })
  })

  it('delegates sign-out', async () => {
    const { handlers, onSignOut } = handlersFor(fakeStore())
    await handlers[IPC.signOut](undefined)
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })

  it('delegates a manual refresh', async () => {
    const refresh = vi.fn(async () => {})
    const { handlers } = handlersFor(fakeStore({ refresh }))
    await handlers[IPC.refresh](undefined)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

describe('createSnapshotBroadcaster', () => {
  it('pushes a serialised snapshot on every change', () => {
    const since = new Date(2026, 7, 12, 8, 30, 0)
    let current: AttendanceSnapshot = SNAPSHOT
    const store = fakeStore({ getSnapshot: () => current })
    const send = vi.fn()
    createSnapshotBroadcaster(store, send)

    current = {
      ...SNAPSHOT,
      state: { kind: 'in', shiftId: '5', since, locationType: null, workplaceId: null },
    }
    for (const listener of store.listeners) listener()

    expect(send).toHaveBeenCalledTimes(1)
    const payload = send.mock.calls[0]?.[0] as SerialisedSnapshot
    if (payload.state.kind !== 'in') throw new Error('unreachable')
    expect(payload.state.sinceMs).toBe(since.getTime())
  })

  it('stops pushing once it is disposed', () => {
    const store = fakeStore()
    const send = vi.fn()
    const dispose = createSnapshotBroadcaster(store, send)
    dispose()
    for (const listener of store.listeners) listener()
    expect(send).not.toHaveBeenCalled()
  })
})
