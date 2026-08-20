/**
 * What the main process does when the renderer asks for something — without any
 * Electron import, so it is unit tested like `auth-flow.ts` and
 * `session-fetch.ts`. `ipc.ts` is the thin wiring that puts these handlers on
 * `ipcMain` and sends the pushes to real windows.
 *
 * Two jobs live here, and both are boundary work:
 *
 * 1. **Validate what comes in.** Everything arriving over IPC is `unknown`. The
 *    renderer is our own code, but the type system stops at the channel: a
 *    payload is checked here or it is not checked at all. The clock-in location
 *    is the sharp case — the schema accepts three values (K4/`LOCATION_TYPES`)
 *    and rejects everything else in-band with HTTP 200, so a typo would look
 *    like a server problem instead of a caller bug.
 * 2. **Make a failure readable on the other side.** The store's action methods
 *    reject (with the rollback already applied) and the renderer needs that
 *    rejection for its toast. Only the message string survives the trip, so the
 *    kind is encoded into it — see `encodeActionError` in the contract. That is
 *    also what turns the store's internal, English `ACTION_IN_FLIGHT_MESSAGE`
 *    into the machine-readable kind `busy`, which the UI and the tray can put
 *    into German words.
 */

import {
  IPC,
  encodeActionError,
  serialiseSnapshot,
  type ActionErrorKind,
  isThemeSetting,
  type AppSettings,
  type AppSnapshot,
  type InvokeChannel,
  type SerialisedSnapshot,
} from '@shared/ipc-contract'
import {
  ACTION_IN_FLIGHT_MESSAGE,
  type AttendanceSnapshot,
  type AttendanceStore,
  type ClockInInput,
} from './attendance'
import { FactorialError } from './factorial/client'
import { isExpandDirection, isWidgetSize } from '@shared/widget-size'
import { isLocationType } from './factorial/types'

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type AssertTrue<T extends true> = T

/**
 * The contract's snapshot and the store's snapshot must stay the same shape.
 * `src/shared` cannot import from `src/main` (the renderer bundle would drag
 * main-process code in), so this is the guard instead: add or rename a field on
 * either side without touching the other and this line stops compiling.
 */
export type SnapshotContractMatchesStore = AssertTrue<Exact<AttendanceSnapshot, AppSnapshot>>

/** Exactly the store methods IPC exposes. `startPolling` is lifecycle, not UI. */
export type IpcStore = Pick<
  AttendanceStore,
  'getSnapshot' | 'subscribe' | 'refresh' | 'clockIn' | 'startBreak' | 'endBreak' | 'clockOut'
>

/** Structurally what `createSettings` (Task 9) returns. */
export interface IpcSettings {
  get(): AppSettings
  set(patch: Partial<AppSettings>): AppSettings
}

export interface IpcHandlerDeps {
  store: IpcStore
  settings: IpcSettings
  /**
   * Lets clicks through the window's transparent margin, or takes them back.
   * Injected rather than reached for, so these handlers stay free of Electron.
   */
  setWindowInteractive: (interactive: boolean) => void
  /** Clears the session cookie and offers a new sign-in. Owned by `index.ts`. */
  onSignOut: () => Promise<void>
}

export type IpcHandler = (payload: unknown) => Promise<unknown>

export type IpcHandlers = Record<InvokeChannel, IpcHandler>

/**
 * Why an action failed, from the error object alone.
 *
 * Exported because the tray calls the store directly and needs the same verdict
 * without going through IPC (`trayActionErrorText` in `tray-menu.ts`). One
 * classifier for both paths means a new error kind cannot be German in the
 * widget and English in the tray.
 */
export function classifyActionError(error: unknown): ActionErrorKind {
  if (error instanceof FactorialError) return error.kind
  // Compared against the store's exported constant, so renaming the sentence
  // there is a compile-time visible change here, not a silent regression.
  if (error instanceof Error && error.message === ACTION_IN_FLIGHT_MESSAGE) return 'busy'
  return 'unknown'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Every handler funnels through this, so no rejection ever crosses undecodable. */
function guard(handler: IpcHandler): IpcHandler {
  return async (payload) => {
    try {
      return await handler(payload)
    } catch (error) {
      throw new Error(encodeActionError(classifyActionError(error), describe(error)))
    }
  }
}

function asRecord(payload: unknown, channel: string): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`${channel} expects an object payload, got ${typeof payload}`)
  }
  return payload as Record<string, unknown>
}

/** `Int` in the schema (K4): a numeric string would be rejected by the mutation. */
function asWorkplaceId(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`workplaceId must be an integer or null, got ${JSON.stringify(value)}`)
  }
  return value
}

function asClockInInput(payload: unknown): ClockInInput {
  const raw = asRecord(payload, IPC.clockIn)
  const locationType = raw.locationType
  if (typeof locationType !== 'string' || !isLocationType(locationType)) {
    throw new Error(`unsupported location type: ${JSON.stringify(locationType)}`)
  }
  return { locationType, workplaceId: asWorkplaceId(raw.workplaceId) }
}

function asBreakId(payload: unknown): string {
  if (typeof payload !== 'string' || payload.trim() === '') {
    throw new Error(`${IPC.startBreak} expects a non-empty break id`)
  }
  return payload
}

/**
 * Copies only the keys this app knows, with the types it knows them by. The
 * settings store sanitises again when it writes; this keeps a malformed patch
 * from getting that far and makes the drop visible in one place.
 *
 * Every unusable value is dropped silently and the rest of the patch is applied.
 * Rejecting the whole call is reserved for an action that would otherwise write
 * a wrong time — a preference the UI got wrong is not that, and taking the valid
 * keys down with the bad one only makes the bug harder to see.
 */
function asSettingsPatch(payload: unknown): Partial<AppSettings> {
  const raw = asRecord(payload, IPC.setSettings)
  const patch: Partial<AppSettings> = {}
  if (typeof raw.openAtLogin === 'boolean') patch.openAtLogin = raw.openAtLogin
  if (typeof raw.alwaysOnTop === 'boolean') patch.alwaysOnTop = raw.alwaysOnTop
  // Whitelisted here as well as in the settings store: a value that is not in
  // `LOCATION_TYPES` fails the clock-in mutation in-band with HTTP 200, so it
  // must never be offered a way to become the remembered default.
  if (typeof raw.lastLocationType === 'string' && isLocationType(raw.lastLocationType)) {
    patch.lastLocationType = raw.lastLocationType
  }
  // K4: `Int`. A fraction is as unusable as a string and is dropped the same way.
  if (raw.lastWorkplaceId === null) {
    patch.lastWorkplaceId = null
  } else if (typeof raw.lastWorkplaceId === 'number' && Number.isInteger(raw.lastWorkplaceId)) {
    patch.lastWorkplaceId = raw.lastWorkplaceId
  }
  // Whitelisted for the same reason as the store does it: the value ends up as
  // `nativeTheme.themeSource`, which throws on anything outside the three.
  if (typeof raw.theme === 'string' && isThemeSetting(raw.theme)) patch.theme = raw.theme
  // Same reasoning: an unknown size has no entry in the layout table.
  if (typeof raw.widgetSize === 'string' && isWidgetSize(raw.widgetSize)) {
    patch.widgetSize = raw.widgetSize
  }
  if (typeof raw.expandDirection === 'string' && isExpandDirection(raw.expandDirection)) {
    patch.expandDirection = raw.expandDirection
  }
  return patch
}

export function createIpcHandlers({
  store,
  settings,
  onSignOut,
  setWindowInteractive,
}: IpcHandlerDeps): IpcHandlers {
  const handlers: IpcHandlers = {
    [IPC.getSnapshot]: async () => serialiseSnapshot(store.getSnapshot()),
    [IPC.clockIn]: async (payload) => {
      await store.clockIn(asClockInInput(payload))
    },
    [IPC.startBreak]: async (payload) => {
      await store.startBreak(asBreakId(payload))
    },
    [IPC.endBreak]: async () => {
      await store.endBreak()
    },
    [IPC.clockOut]: async () => {
      await store.clockOut()
    },
    // `refresh` never rejects — it turns a failed read into a stale snapshot —
    // but it goes through the same guard so the contract holds if that changes.
    [IPC.refresh]: async () => {
      await store.refresh()
    },
    [IPC.signOut]: async () => {
      await onSignOut()
    },
    [IPC.getSettings]: async () => settings.get(),
    [IPC.setSettings]: async (payload) => settings.set(asSettingsPatch(payload)),
    // Anything but a literal `true` means "let clicks through". The default has
    // to be the safe one: a window stuck interactive swallows a rectangle of
    // somebody's desktop, and nothing on screen would explain why.
    [IPC.setWindowInteractive]: async (payload) => {
      setWindowInteractive(payload === true)
    },
  }

  for (const channel of Object.keys(handlers) as InvokeChannel[]) {
    handlers[channel] = guard(handlers[channel])
  }
  return handlers
}

/**
 * Pushes every state change to the renderer. Returns the unsubscribe function:
 * a broadcaster that outlives its windows would keep serialising into nothing.
 */
export function createSnapshotBroadcaster(
  store: Pick<IpcStore, 'getSnapshot' | 'subscribe'>,
  send: (snapshot: SerialisedSnapshot) => void,
): () => void {
  return store.subscribe(() => send(serialiseSnapshot(store.getSnapshot())))
}
