/**
 * The only vocabulary the renderer and the main process share: channel names,
 * the snapshot shape that travels between them, and the codec that carries a
 * failed action across the boundary.
 *
 * Three constraints shaped this file.
 *
 * 1. **Nothing but plain data crosses IPC.** Electron structured-clones every
 *    payload, and a `Date` arrives as something the renderer cannot use as a
 *    `Date`. The one date in the snapshot — the shift's start, which the whole
 *    running timer hangs on — is therefore serialised explicitly to epoch
 *    milliseconds and rebuilt on the other side. Nothing here may hold a class
 *    instance, a function or an `undefined`.
 * 2. **`AppSnapshot` mirrors the store's `AttendanceSnapshot` exactly.** It is
 *    declared here (and not imported from `src/main/attendance.ts`) because
 *    `src/shared` must stay importable from the renderer bundle, which never
 *    pulls in main-process code. To keep the two from drifting apart,
 *    `src/main/ipc-handlers.ts` asserts at compile time that they are mutually
 *    assignable — adding a field to the store's snapshot without adding it here
 *    fails `npm run typecheck`.
 * 3. **A rejected action must arrive in a shape the UI can phrase in German.**
 *    Only an error's *message string* reliably survives `ipcMain.handle` →
 *    `ipcRenderer.invoke` (Electron wraps it in "Error invoking remote method
 *    …"), so the machine-readable kind is encoded into that string and decoded
 *    in the renderer. See `encodeActionError`.
 */

import type { AttendanceState } from './attendance-state'

export const IPC = {
  getSnapshot: 'attendance:getSnapshot',
  snapshotChanged: 'attendance:snapshotChanged',
  clockIn: 'attendance:clockIn',
  startBreak: 'attendance:startBreak',
  endBreak: 'attendance:endBreak',
  clockOut: 'attendance:clockOut',
  refresh: 'attendance:refresh',
  signOut: 'auth:signOut',
  getSettings: 'settings:get',
  setSettings: 'settings:set',
} as const

/** Every channel the renderer may `invoke`; `snapshotChanged` is push-only. */
export type InvokeChannel = Exclude<(typeof IPC)[keyof typeof IPC], typeof IPC.snapshotChanged>

export interface BreakOption {
  id: string
  name: string
}

/**
 * Mirrors `SnapshotErrorKind` in `src/main/attendance.ts` (which is
 * `FactorialError.kind` plus a catch-all). The UI phrases its German text from
 * this, not from `lastError`, whose wording comes from the server.
 */
export type SnapshotErrorKind = 'unauthenticated' | 'graphql' | 'network' | 'malformed' | 'unknown'

/** The store's snapshot, field for field. See note 2 in the file header. */
export interface AppSnapshot {
  state: AttendanceState
  /** Closed shifts only — the running one is recomputed from `state.since`. */
  todayMinutes: number
  /** How many of today's records arrived without `minutes` (C4): day sum is provisional. */
  incompleteShifts: number
  /**
   * The day's target in minutes (`expectedMinutes`, K8), or null when the API
   * has none — a day off, an absence, or a target lookup that failed. `0` is a
   * real answer too and is passed through as itself: filling either case in with
   * eight hours would put a goal on a day nobody is expected to work.
   */
  expectedMinutes: number | null
  breakOptions: BreakOption[]
  /**
   * The most recent failure *ever seen*, in the server's own words. A later
   * successful refresh clears `stale` but deliberately not this — so the UI must
   * key "we are out of touch" off `stale`, never off `lastError !== null`.
   */
  lastError: string | null
  lastErrorKind: SnapshotErrorKind | null
  /** True when the last read failed: what is shown is the last known state. */
  stale: boolean
}

/** `since` travels as epoch milliseconds; a Date does not survive IPC as a Date. */
export type SerialisedState =
  | { kind: 'unknown' }
  | { kind: 'unauthenticated' }
  | { kind: 'out' }
  | {
      kind: 'in'
      shiftId: string
      sinceMs: number
      locationType: string | null
      workplaceId: number | null
    }
  | {
      kind: 'break'
      shiftId: string
      sinceMs: number
      breakId: string
      breakName: string
      locationType: string | null
    }

export interface SerialisedSnapshot extends Omit<AppSnapshot, 'state'> {
  state: SerialisedState
}

export function serialiseSnapshot(snapshot: AppSnapshot): SerialisedSnapshot {
  const state = snapshot.state
  const serialised: SerialisedState =
    state.kind === 'in'
      ? {
          kind: 'in',
          shiftId: state.shiftId,
          sinceMs: state.since.getTime(),
          locationType: state.locationType,
          workplaceId: state.workplaceId,
        }
      : state.kind === 'break'
        ? {
            kind: 'break',
            shiftId: state.shiftId,
            sinceMs: state.since.getTime(),
            breakId: state.breakId,
            breakName: state.breakName,
            locationType: state.locationType,
          }
        : { kind: state.kind }
  return { ...snapshot, state: serialised }
}

export function deserialiseSnapshot(snapshot: SerialisedSnapshot): AppSnapshot {
  const state = snapshot.state
  const restored: AttendanceState =
    state.kind === 'in'
      ? {
          kind: 'in',
          shiftId: state.shiftId,
          since: new Date(state.sinceMs),
          locationType: state.locationType,
          workplaceId: state.workplaceId,
        }
      : state.kind === 'break'
        ? {
            kind: 'break',
            shiftId: state.shiftId,
            since: new Date(state.sinceMs),
            breakId: state.breakId,
            breakName: state.breakName,
            locationType: state.locationType,
          }
        : { kind: state.kind }
  return { ...snapshot, state: restored }
}

/**
 * How the app picks its colour scheme.
 *
 * The three values are exactly Electron's `nativeTheme.themeSource`, so the
 * wiring in `index.ts` is one assignment rather than a translation table — and
 * `themeSource` is also the whole mechanism: Chromium reports it to the renderer
 * as `prefers-color-scheme`, which is what the stylesheet keys its dark tokens
 * off. There is deliberately no theme state in React and no IPC channel for it.
 */
export type ThemeSetting = 'system' | 'light' | 'dark'

export const THEME_SETTINGS: readonly ThemeSetting[] = ['system', 'light', 'dark']

export function isThemeSetting(value: string): value is ThemeSetting {
  return (THEME_SETTINGS as readonly string[]).includes(value)
}

export interface AppSettings {
  openAtLogin: boolean
  alwaysOnTop: boolean
  lastLocationType: string
  /** Int in the schema (K4); stored as a number so no conversion is needed later. */
  lastWorkplaceId: number | null
  theme: ThemeSetting
}

/**
 * Why an action failed. `busy` is the one kind the server never produces: the
 * store refuses a second action while one is in flight, and that refusal must
 * not reach a user as the store's internal English sentence.
 */
export type ActionErrorKind = SnapshotErrorKind | 'busy'

const ACTION_ERROR_KINDS: readonly ActionErrorKind[] = [
  'unauthenticated',
  'graphql',
  'network',
  'malformed',
  'unknown',
  'busy',
]

function isActionErrorKind(value: string): value is ActionErrorKind {
  return (ACTION_ERROR_KINDS as readonly string[]).includes(value)
}

/** Marks a message as one this codec wrote. Deliberately unlikely to occur in prose. */
export const ACTION_ERROR_PREFIX = 'factorial-action-error/'

/**
 * Packs a failure into an error message.
 *
 * Custom properties on an `Error` do not survive the trip from the main process
 * through `contextBridge` into the renderer — the message does. So the kind
 * rides inside the message and is unpacked again by `decodeActionError`.
 */
export function encodeActionError(kind: ActionErrorKind, message: string): string {
  return `${ACTION_ERROR_PREFIX}${kind}: ${message}`
}

/**
 * The inverse, tolerant by design: Electron prefixes the message with
 * "Error invoking remote method '…': Error: ", and an error that never went
 * through `encodeActionError` (a crash in the preload, say) must still yield
 * something showable rather than throwing a second time.
 */
export function decodeActionError(raw: string): { kind: ActionErrorKind; message: string } {
  const at = raw.indexOf(ACTION_ERROR_PREFIX)
  if (at < 0) return { kind: 'unknown', message: raw }

  const body = raw.slice(at + ACTION_ERROR_PREFIX.length)
  const separator = body.indexOf(':')
  if (separator < 0) return { kind: 'unknown', message: body }

  const kind = body.slice(0, separator)
  if (!isActionErrorKind(kind)) return { kind: 'unknown', message: body }
  // One space after the colon is the separator this codec wrote; anything beyond
  // that belongs to the message.
  return { kind, message: body.slice(separator + 1).replace(/^ /, '') }
}

/** What `contextBridge` exposes as `window.factorial`. */
export interface FactorialBridge {
  getSnapshot(): Promise<SerialisedSnapshot>
  /** Returns the unsubscribe function; call it on unmount or listeners pile up. */
  onSnapshot(callback: (snapshot: SerialisedSnapshot) => void): () => void
  /**
   * `locationType` is a plain string here and is validated in the main process
   * against `AttendanceShiftLocationTypeEnum` — the renderer must not be the
   * place that decides what the API accepts.
   */
  clockIn(input: { locationType: string; workplaceId: number | null }): Promise<void>
  startBreak(breakId: string): Promise<void>
  endBreak(): Promise<void>
  clockOut(): Promise<void>
  refresh(): Promise<void>
  signOut(): Promise<void>
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
}
