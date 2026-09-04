/**
 * What the tray says and what it offers — without Electron, so it can be tested.
 *
 * `tray.ts` next door owns the real `Tray`, the icons and the timer that
 * re-renders it. Everything decided here is a pure function of the snapshot:
 * the label in the menubar, the line Windows reads the time from, the tooltip,
 * the tone the Windows icon is coloured by, and the menu itself.
 *
 * Three rules shaped this file:
 *
 * 1. **The time is recomputed, never counted up.** Same rule as the widget
 *    (DESIGN.md, "Zeitberechnung"): every render subtracts `state.since` from
 *    the current clock, so standby cannot drift it, and a clock that jumped
 *    backwards renders `0:00` rather than a negative.
 * 2. **The tray and the widget must not disagree.** While clocked in the label
 *    is the *day's* worked time — `todayMinutes` plus the running segment —
 *    which is exactly what the widget shows. (An earlier draft showed
 *    the running segment alone; see the note on `trayLabel`.)
 * 3. **No second German table.** A failed tray action is phrased by
 *    `src/shared/errors.ts`, the same module the widget's toast uses
 *    (`docs/DESIGN.md`).
 */

import type { MenuItemConstructorOptions } from 'electron'
import { breakMinutes } from '@shared/day-timeline'
import { describeActionError, describeActionFailure, describeStaleReason } from '@shared/errors'
import type { Translate } from '@shared/i18n'
import type { AppSnapshot } from '@shared/ipc-contract'
import type { MainWindowPage } from '@shared/ipc-contract'
import { classifyActionError } from './ipc-handlers'
import { type UpdateStatus, updateMenuEntry } from './update-policy'

/** Drives the colour-coded Windows icon; macOS uses one template icon for all. */
export type TrayTone = 'idle' | 'active' | 'paused' | 'alert'

/** What a menu entry can ask the app to do. Wired to the store in `tray.ts`. */
export interface TrayActions {
  clockIn: () => void
  startBreak: (breakId: string) => void
  endBreak: () => void
  clockOut: () => void
  /** Drops the rejected cookie and opens the login window — same as the widget. */
  signIn: () => void
  /** Drops the *current* session and offers the login page — the same call. */
  signOut: () => void
  toggleWindow: () => void
  refresh: () => void
  /** Switches the language; `system` follows the OS. */
  /**
   * Asks the release feed now and reports either way.
   *
   * Separate from the automatic check because a requested check must answer —
   * "you are up to date" is the useful outcome most of the time, and an entry
   * that silently does nothing reads as broken.
   */
  checkForUpdates: () => void
  /** Opens the app window at a section. */
  openWindow: (page: MainWindowPage) => void
  quit: () => void
}

export interface TrayMenuInput {
  snapshot: AppSnapshot
  now: Date
  windowVisible: boolean
  /** The last tray action that failed, already translated, or `null`. */
  lastActionError: string | null
  actions: TrayActions
  /** Read per render, so a language change shows on the next one. */
  t: Translate
  /**
   * What the updater is doing. The "check for updates" entry doubles as the
   * progress display — a 119 MB download that reports nothing looks like an
   * entry that did nothing.
   */
  updateStatus: UpdateStatus
}

const STATE_KEY = {
  unknown: 'state.unknown',
  unauthenticated: 'state.unauthenticated',
  out: 'state.out',
  in: 'state.in',
  break: 'state.break',
} as const

const TONE: Record<AppSnapshot['state']['kind'], TrayTone> = {
  unknown: 'idle',
  unauthenticated: 'alert',
  out: 'idle',
  in: 'active',
  break: 'paused',
}

/**
 * `H:MM`, uncapped and never negative.
 *
 * Not `formatHoursMinutes` from `@shared/time`: that pads the hour to two digits
 * for the widget's aligned columns, and a menubar title is charged for every
 * pixel it uses. Same rounding rule, one character shorter.
 */
function formatTrayTime(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}

/** Guards a clock that jumped backwards (NTP correction, resume from standby). */
function elapsedMs(since: Date, now: Date): number {
  return Math.max(0, now.getTime() - since.getTime())
}

/**
 * The number this state is about, in milliseconds, or `null` when there is none
 * to show.
 *
 * - clocked in: the day's worked time — closed shifts plus the running segment.
 *   The store keeps the open shift out of `todayMinutes` by id, so nothing is
 *   counted twice.
 * - on a break: the break's own duration. Break time is not worked time, so the
 *   day sum stands still here; showing it counting up would be a lie.
 * - clocked out: the day's worked time, or nothing at all if that is zero.
 */
function primaryMs(snapshot: AppSnapshot, now: Date): number | null {
  const { state } = snapshot
  if (state.kind === 'in') return snapshot.todayMinutes * 60_000 + elapsedMs(state.since, now)
  if (state.kind === 'break') return elapsedMs(state.since, now)
  if (state.kind === 'out') return snapshot.todayMinutes > 0 ? snapshot.todayMinutes * 60_000 : null
  return null
}

/**
 * The menubar title: the day's running time, or `Pause 0:15` during a break, or
 * nothing at all.
 *
 * PLATFORM: this is macOS-only. `tray.setTitle` does not exist on Windows —
 * there the same text reaches the user through the tooltip and the first,
 * disabled menu entry (`trayStatusLine`).
 *
 * Two things here are deliberate:
 *
 * - It shows the **day's** worked time while clocked in, not the current
 *   segment, so the menubar and the widget's ring cannot show different numbers
 *   for "how long today".
 * - A break is marked with the word `Pause`, not the plan's `❙❙`. The label also
 *   ends up in a Windows tooltip and menu, where block glyphs render as an emoji
 *   or a replacement box — the reason Task 11 already dropped that glyph from
 *   the widget (`docs/DESIGN.md`).
 */
export function trayLabel(t: Translate, snapshot: AppSnapshot, now: Date): string {
  const { state } = snapshot
  if (state.kind === 'in') return formatTrayTime(primaryMs(snapshot, now) ?? 0)
  if (state.kind === 'break')
    return t('tray.breakWithTime', { time: formatTrayTime(elapsedMs(state.since, now)) })
  // Clocked out, still loading, or signed out: an empty title keeps the menubar
  // clean and, more importantly, states nothing that could be wrong.
  return ''
}

/**
 * The one line that says everything: state, time, break name, and whether the
 * numbers are current.
 *
 * PLATFORM: on Windows this is the only place the running time appears, as the
 * first (disabled) menu entry and inside the tooltip.
 */
export function trayStatusLine(t: Translate, snapshot: AppSnapshot, now: Date): string {
  const { state } = snapshot
  const parts: string[] = [t(STATE_KEY[state.kind])]

  if (state.kind === 'break') parts.push(state.breakName)

  const ms = primaryMs(snapshot, now)
  if (ms !== null) {
    const time = formatTrayTime(ms)
    parts.push(state.kind === 'out' ? t('tray.today', { time }) : time)
  }

  // C4: a record Factorial has not totalled yet counts as zero minutes, which
  // makes the day sum a lower bound. Say so rather than let it read as a fact.
  if (snapshot.incompleteShifts > 0) parts.push(t('tray.incomplete'))

  // Keyed off `stale`, never off `lastError !== null`: a successful refresh
  // clears `stale` but keeps `lastError` for the rest of the session (see the
  // note on `AppSnapshot.lastError`), so the other test would glue this on
  // permanently.
  if (snapshot.stale) parts.push(describeStaleReason(t, snapshot.lastErrorKind))

  return parts.join(' · ')
}

/**
 * How long today's breaks have been, all told, or `null` when none were taken.
 *
 * Its own line under the status rather than another clause on it: the status
 * line already carries state, time, break name and staleness, and the one number
 * somebody opens this menu to check should not be the fifth thing on a row.
 *
 * A running break is included — the store keeps the open record out of
 * `daySegments`, so the elapsed part is added here from the same `since` the
 * status line's own clock uses.
 *
 * `null` rather than "0:00" on a day without one: a zero here would be a
 * reminder nobody asked for, every morning.
 */
export function trayBreakLine(t: Translate, snapshot: AppSnapshot, now: Date): string | null {
  const { state } = snapshot
  const running = state.kind === 'break' ? elapsedMs(state.since, now) / 60_000 : 0
  const total = breakMinutes(snapshot.daySegments) + running
  if (total < 1) return null
  return t('tray.breakToday', { time: formatTrayTime(total * 60_000) })
}

/** A tray icon has no caption; the tooltip is it. */
export function trayTooltip(t: Translate, snapshot: AppSnapshot, now: Date): string {
  return t('tray.tooltip', { status: trayStatusLine(t, snapshot, now) })
}

export function trayTone(snapshot: AppSnapshot): TrayTone {
  return TONE[snapshot.state.kind]
}

/**
 * German for a rejected tray action.
 *
 * The tray calls the store directly, so a rejection arrives as the error object
 * itself — a `FactorialError`, or the store's English in-flight refusal, which
 * is exactly what a tray click racing a widget click produces. Both are
 * classified by the same function the IPC layer uses and phrased by the same
 * table the widget's toast uses; an error that already crossed IPC (encoded in
 * its message) is understood as well.
 */
export function trayActionErrorText(t: Translate, error: unknown): string {
  const kind = classifyActionError(error)
  if (kind !== 'unknown') {
    return describeActionFailure(t, kind, error instanceof Error ? error.message : String(error))
  }
  // Not one of ours by identity — it may still carry an encoded kind.
  return describeActionError(t, error)
}

/**
 * The "Einstellungen" submenu — the app's only settings surface.
 *
 * DESIGN.md lists three items under "Einstellungen" (Autostart, Always-on-Top,
 * Abmelden) and names the entry in the tray's context menu; the appearance
 * picker joins them here for want of anywhere else to put it. Nothing else in the
 * app offers them: the widget has no settings UI, and its "Anmelden" button
 * exists only in the signed-out state, so an authenticated user would otherwise
 * have no way to sign out at all.
 *
 * Both toggles invert the *stored* value rather than the menu item's own
 * `checked` flag. Electron flips that flag by itself on click, and a menu built
 * by an earlier render would then write back the value that is already set.
 *
 * The label is "Autostart", not DESIGN.md's longer "Autostart beim Login": this
 * menu already uses "Anmelden"/"Abmelden" for the Factorial session, and
 * "Beim Anmelden starten" three lines above "Abmelden" reads as if it were about
 * the same login.
 */
export function buildTrayMenu({
  snapshot,
  now,
  windowVisible,
  lastActionError,
  actions,
  t,
  updateStatus,
}: TrayMenuInput): MenuItemConstructorOptions[] {
  const { state } = snapshot

  const items: MenuItemConstructorOptions[] = [
    { label: trayStatusLine(t, snapshot, now), enabled: false },
  ]

  // Right under the status, which is where somebody who opened this menu to
  // check their break is already looking.
  const breakLine = trayBreakLine(t, snapshot, now)
  if (breakLine !== null) items.push({ label: breakLine, enabled: false })

  // The tray can act while the widget is hidden, so a failure needs somewhere to
  // be read. It stays until the next action starts (see `tray.ts`).
  if (lastActionError !== null) items.push({ label: lastActionError, enabled: false })

  items.push({ type: 'separator' })

  if (state.kind === 'out') {
    items.push({ label: t('tray.clockIn'), click: () => actions.clockIn() })
  }

  if (state.kind === 'in') {
    // An empty list means the break types have not arrived yet, never "no
    // breaks configured" — the store only ever fills it from the API. Offering
    // an empty submenu would look like the second thing.
    items.push(
      snapshot.breakOptions.length === 0
        ? { label: t('tray.break'), enabled: false }
        : {
            label: t('tray.break'),
            submenu: snapshot.breakOptions.map((option) => ({
              label: option.name,
              click: () => actions.startBreak(option.id),
            })),
          },
    )
  }

  if (state.kind === 'break') {
    items.push({ label: t('tray.resume'), click: () => actions.endBreak() })
  }

  if (state.kind === 'in' || state.kind === 'break') {
    items.push({ label: t('tray.clockOut'), click: () => actions.clockOut() })
  }

  if (state.kind === 'unauthenticated') {
    // Same call as the widget's button: it drops the rejected cookie and opens
    // Factorial's login page (`onSignOut` in `index.ts`).
    items.push({ label: t('tray.signIn'), click: () => actions.signIn() })
  }

  // `unknown` deliberately offers no clock action: before the first answer the
  // app does not know what a click would mean, and this one writes to a real
  // time record.

  items.push(
    { type: 'separator' },
    {
      label: windowVisible ? t('tray.hideWindow') : t('tray.showWindow'),
      click: () => actions.toggleWindow(),
    },
    { label: t('tray.refresh'), click: () => actions.refresh() },
    { type: 'separator' },
    // The app window, at each of its sections. Every setting the tray used
    // to carry as a submenu lives there now; the tray keeps the actions and
    // the way in.
    { label: t('tray.openWindow'), click: () => actions.openWindow('overview') },
    { label: t('tray.timesheet'), click: () => actions.openWindow('timesheet') },
    { label: t('tray.settings'), click: () => actions.openWindow('settings') },
    // Label and clickability come from the updater's state: idle asks, a
    // download reports its percentage, and a staged update offers the restart.
    // Kept in the tray because a download in progress needs a surface that
    // is always there, and the app window is not.
    { ...updateMenuEntry(t, updateStatus), click: () => actions.checkForUpdates() },
    { type: 'separator' },
    // Always present, in every state: closing the widget only hides it and the
    // window is kept out of the taskbar, so this is the only way out of the app
    // on Windows.
    { label: t('tray.quit'), click: () => actions.quit() },
  )

  return items
}
