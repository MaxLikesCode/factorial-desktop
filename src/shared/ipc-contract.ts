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
import type { LanguageSetting } from './i18n'
import type { DayEdit, DaySaveResult, TimesheetDay, TimesheetMonth } from './timesheet'
import type { OverviewInsights } from './overview'

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
  settingsChanged: 'settings:changed',
  setWindowInteractive: 'widget:setInteractive',
  setWindowDragging: 'widget:setDragging',
  popupMenu: 'widget:popupMenu',
  cursorMoved: 'widget:cursorMoved',
  getTimesheetMonth: 'timesheet:getMonth',
  saveTimesheetDay: 'timesheet:saveDay',
  withdrawTimesheetRequest: 'timesheet:withdrawRequest',
  getOverviewInsights: 'overview:getInsights',
  openMainWindow: 'window:openMain',
  navigate: 'window:navigate',
  getAppInfo: 'app:getInfo',
  checkForUpdates: 'update:check',
  controlWindow: 'window:control',
} as const

/**
 * Every channel the renderer may `invoke`.
 *
 * `snapshotChanged`, `settingsChanged` and `cursorMoved` are push-only: the main
 * process sends them, nobody answers them. Excluding them here is what makes
 * `Record<InvokeChannel, IpcHandler>` fail to compile if a handler is forgotten
 * — and refuse a handler for a channel that can never carry one.
 */
export type InvokeChannel = Exclude<
  (typeof IPC)[keyof typeof IPC],
  | typeof IPC.snapshotChanged
  | typeof IPC.settingsChanged
  | typeof IPC.cursorMoved
  | typeof IPC.navigate
>

/** The sections of the app window; what `openMainWindow` can ask for. */
export type MainWindowPage = 'overview' | 'timesheet' | 'settings'

export const MAIN_WINDOW_PAGES: readonly MainWindowPage[] = ['overview', 'timesheet', 'settings']

export function isMainWindowPage(value: unknown): value is MainWindowPage {
  return typeof value === 'string' && (MAIN_WINDOW_PAGES as readonly string[]).includes(value)
}

export type WindowControl = 'minimize' | 'close'

export function isWindowControl(value: unknown): value is WindowControl {
  return value === 'minimize' || value === 'close'
}

/** What the settings page's About section shows. */
export interface AppInfo {
  version: string
  electron: string
  chromium: string
  /** Who is signed in, as Factorial names them. */
  user: { fullName: string; email: string; companyName: string }
}

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
  /**
   * Today's CLOSED records in the order they happened, work and break alike.
   *
   * What the bar draws. Lengths and order only, no clock times — nothing here
   * needs serialising beyond numbers and a word, and the running record is added
   * by the renderer, which is the only place that knows the current second.
   *
   * The work entries sum to `todayMinutes` by construction; they are not a
   * second copy of it so much as the same fact with its shape kept.
   */
  daySegments: DaySegment[]
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

/**
 * How the widget's card is drawn. `simple` is the card as it always was and
 * the default; `glass` is the app window's look (app.css) on the card —
 * translucent gradient, a light edge on top and a dark one below, pill
 * buttons, the Factorial orange for the primary action.
 */
export type WidgetDesign = 'simple' | 'glass'

export const WIDGET_DESIGNS: readonly WidgetDesign[] = ['simple', 'glass']

export function isWidgetDesign(value: string): value is WidgetDesign {
  return (WIDGET_DESIGNS as readonly string[]).includes(value)
}

export const THEME_SETTINGS: readonly ThemeSetting[] = ['system', 'light', 'dark']

export function isThemeSetting(value: string): value is ThemeSetting {
  return (THEME_SETTINGS as readonly string[]).includes(value)
}

import type { DaySegment } from './day-timeline'
import type { ExpandDirection } from './widget-size'
export type { DaySegment }
export type { ExpandDirection }

/** One row of a native menu. `checked` renders the group as radios. */
export interface PopupMenuItem {
  id: string
  label: string
  checked?: boolean
}

/** A point in window coordinates. */
export interface Point {
  x: number
  y: number
}

export interface AppSettings {
  openAtLogin: boolean
  alwaysOnTop: boolean
  lastLocationType: string
  /** Int in the schema (K4); stored as a number so no conversion is needed later. */
  lastWorkplaceId: number | null
  theme: ThemeSetting
  /**
   * How much screen the widget takes. Changing it resizes the window and
   * re-clamps its remembered position — see `src/shared/widget-size.ts` for why
   * the window is not always the same size as the card.
   */
  /** Which way the card grows when it opens. */
  expandDirection: ExpandDirection
  /**
   * Which language the app speaks. `system` follows the OS and is the default.
   *
   * The renderer needs it as well as the main process — the widget and the tray
   * say some of the same words — so it travels with the rest of the settings
   * rather than on a channel of its own.
   */
  language: LanguageSetting
  /**
   * Download a new version without asking and offer the restart once it is
   * in. Off by default: the first offer's checkbox is where this is switched
   * on, and the tray's settings submenu is where it is switched off again.
   */
  autoInstallUpdates: boolean
  /**
   * A version the user said "skip" to. Held until a *different* version shows
   * up — unlike "later", which only lasts the session — and ignored by a check
   * the user asks for by hand, since that is a request to see it again.
   */
  skippedUpdateVersion: string | null
  /**
   * Ask where the work happens before every clock-in, as a menu on the
   * button. Off, the remembered location is used without a question.
   */
  askLocationOnClockIn: boolean
  /** Hours on the clock before a reminder notification; null is off. */
  longShiftReminderHours: number | null
  /** Hours on the clock before the app clocks out by itself; null is off. */
  autoClockOutHours: number | null
  /** The widget card's look. See `WidgetDesign`. */
  widgetDesign: WidgetDesign
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
  /**
   * Fires whenever the settings change, from wherever.
   *
   * The widget is not the only writer: the tray's "Einstellungen" submenu writes
   * the same store, and since the widget's own size is now one of those settings
   * it can no longer read them once at mount and be right afterwards. Returns
   * its own unsubscribe, like `onSnapshot`.
   */
  onSettings(callback: (settings: AppSettings) => void): () => void
  /**
   * Lets clicks through the window's transparent margin, or takes them back.
   *
   * Only the sizes that grow have such a margin (`hasTransparentMargin`). While
   * the pointer is anywhere but over the card, the window must not swallow
   * clicks meant for whatever is behind it — an always-on-top window that eats a
   * 320 x 137 rectangle of desktop is worse than the big widget ever was.
   *
   * The renderer decides, because only the renderer knows where the card
   * currently is; the main process owns the window and does it.
   */
  setWindowInteractive(interactive: boolean): Promise<void>
  /**
   * The pointer's position in window coordinates, pushed by the main process
   * while the window is click-through.
   *
   * PLATFORM: on Windows this is the *only* way the card learns the pointer has
   * arrived. `setIgnoreMouseEvents(true, { forward: true })` is documented to
   * keep delivering mouse *moves*, and that is what makes click-through
   * recoverable — but on Windows it delivers none. Measured against a bare
   * transparent window: 29 `mousemove` while interactive, 0 while forwarding,
   * focused or not. Without this channel the card goes click-through once and
   * never comes back, which is a widget nobody can use.
   *
   * Coordinates match `MouseEvent.clientX/clientY`, so the renderer can treat a
   * push and a real move as the same thing. Returns its own unsubscribe.
   */
  onCursorMoved(callback: (position: { x: number; y: number }) => void): () => void
  /**
   * Starts and stops moving the window with the pointer.
   *
   * The Minimal card cannot use `-webkit-app-region: drag`: a draggable region
   * is a title bar to the platform, which then keeps the double click for
   * itself, and the double click is the card's second way to open. So the drag
   * is run by hand — the renderer says when, and the main process follows the
   * cursor.
   *
   * Deliberately carries no coordinates. The main process reads the cursor from
   * the screen instead, because the renderer's own coordinates are relative to a
   * window that is moving underneath them, and a drag built on those chases its
   * own tail.
   */
  setWindowDragging(dragging: boolean): Promise<void>
  /**
   * Opens a native menu at a point in the window and resolves what was picked.
   *
   * The widget's window is 321 x 179. A menu drawn inside the page is clipped by
   * it, and there is no size that fixes that — the break list is however long an
   * employer configured it. A native menu is the platform's own window and is
   * bounded by the screen instead, which is also what makes it flip and scroll
   * on its own near an edge.
   *
   * `anchor` is in window coordinates, which is what `getBoundingClientRect`
   * already returns for a page that fills its window. Resolves `null` when the
   * menu is dismissed without a choice.
   */
  popupMenu(items: PopupMenuItem[], anchor: Point): Promise<string | null>
  /** A month of the timesheet — every day, with its records as blocks. */
  getTimesheetMonth(year: number, month: number): Promise<TimesheetMonth>
  /** Requests an edited day; resolves with the day as Factorial still holds it. */
  saveTimesheetDay(edit: DayEdit): Promise<DaySaveResult>
  /** Takes one pending change request back; resolves with its day, re-read. */
  withdrawTimesheetRequest(requestId: string, date: string): Promise<TimesheetDay>
  /** The overview's absences and month cards, read fresh. */
  getOverviewInsights(): Promise<OverviewInsights>
  /** Opens the app window, optionally at a section. */
  openMainWindow(page?: MainWindowPage): Promise<void>
  /** The app window is told which section to show; returns its own unsubscribe. */
  onNavigate(callback: (page: MainWindowPage) => void): () => void
  getAppInfo(): Promise<AppInfo>
  /** A manual update check; the answer arrives in the update window. */
  checkForUpdates(): Promise<void>
  /** The frameless app window's own minimise / maximise / close. */
  controlWindow(action: WindowControl): Promise<void>
}
