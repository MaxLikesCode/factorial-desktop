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
 *    which is exactly what the widget's ring shows. (PLAN.md's snippet showed
 *    the running segment alone; see the note on `trayLabel`.)
 * 3. **No second German table.** A failed tray action is phrased by
 *    `src/shared/errors.ts`, the same module the widget's toast uses
 *    (`docs/WINDOWS.md` §6).
 */

import type { MenuItemConstructorOptions } from 'electron'
import { describeActionError, describeActionFailure, describeStaleReason } from '@shared/errors'
import type { AppSnapshot } from '@shared/ipc-contract'
import { classifyActionError } from './ipc-handlers'

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
  toggleWindow: () => void
  refresh: () => void
  quit: () => void
}

export interface TrayMenuInput {
  snapshot: AppSnapshot
  now: Date
  windowVisible: boolean
  /** The last tray action that failed, already in German, or `null`. */
  lastActionError: string | null
  actions: TrayActions
}

const STATE_LABEL = {
  unknown: 'Lädt …',
  unauthenticated: 'Nicht angemeldet',
  out: 'Ausgestempelt',
  in: 'Eingestempelt',
  break: 'In einer Pause',
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
 * Two deviations from the PLAN.md snippet, both deliberate:
 *
 * - It shows the **day's** worked time while clocked in, not the current
 *   segment, so the menubar and the widget's ring cannot show different numbers
 *   for "how long today".
 * - A break is marked with the word `Pause`, not the plan's `❙❙`. The label also
 *   ends up in a Windows tooltip and menu, where block glyphs render as an emoji
 *   or a replacement box — the reason Task 11 already dropped that glyph from
 *   the widget (`docs/WINDOWS.md` §3).
 */
export function trayLabel(snapshot: AppSnapshot, now: Date): string {
  const { state } = snapshot
  if (state.kind === 'in') return formatTrayTime(primaryMs(snapshot, now) ?? 0)
  if (state.kind === 'break') return `Pause ${formatTrayTime(elapsedMs(state.since, now))}`
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
export function trayStatusLine(snapshot: AppSnapshot, now: Date): string {
  const { state } = snapshot
  const parts: string[] = [STATE_LABEL[state.kind]]

  if (state.kind === 'break') parts.push(state.breakName)

  const ms = primaryMs(snapshot, now)
  if (ms !== null) parts.push(state.kind === 'out' ? `heute ${formatTrayTime(ms)}` : formatTrayTime(ms))

  // C4: a record Factorial has not totalled yet counts as zero minutes, which
  // makes the day sum a lower bound. Say so rather than let it read as a fact.
  if (snapshot.incompleteShifts > 0) parts.push('unvollständig')

  // Keyed off `stale`, never off `lastError !== null`: a successful refresh
  // clears `stale` but keeps `lastError` for the rest of the session (see the
  // note on `AppSnapshot.lastError`), so the other test would glue this on
  // permanently.
  if (snapshot.stale) parts.push(describeStaleReason(snapshot.lastErrorKind))

  return parts.join(' · ')
}

/** A tray icon has no caption; the tooltip is it. */
export function trayTooltip(snapshot: AppSnapshot, now: Date): string {
  return `Factorial · ${trayStatusLine(snapshot, now)}`
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
export function trayActionErrorText(error: unknown): string {
  const kind = classifyActionError(error)
  if (kind !== 'unknown') {
    return describeActionFailure(kind, error instanceof Error ? error.message : String(error))
  }
  // Not one of ours by identity — it may still carry an encoded kind.
  return describeActionError(error)
}

export function buildTrayMenu({
  snapshot,
  now,
  windowVisible,
  lastActionError,
  actions,
}: TrayMenuInput): MenuItemConstructorOptions[] {
  const { state } = snapshot

  const items: MenuItemConstructorOptions[] = [
    { label: trayStatusLine(snapshot, now), enabled: false },
  ]

  // The tray can act while the widget is hidden, so a failure needs somewhere to
  // be read. It stays until the next action starts (see `tray.ts`).
  if (lastActionError !== null) items.push({ label: lastActionError, enabled: false })

  items.push({ type: 'separator' })

  if (state.kind === 'out') {
    items.push({ label: 'Einstempeln', click: () => actions.clockIn() })
  }

  if (state.kind === 'in') {
    // An empty list means the break types have not arrived yet, never "no
    // breaks configured" — the store only ever fills it from the API. Offering
    // an empty submenu would look like the second thing.
    items.push(
      snapshot.breakOptions.length === 0
        ? { label: 'Pause', enabled: false }
        : {
            label: 'Pause',
            submenu: snapshot.breakOptions.map((option) => ({
              label: option.name,
              click: () => actions.startBreak(option.id),
            })),
          },
    )
  }

  if (state.kind === 'break') {
    items.push({ label: 'Fortsetzen', click: () => actions.endBreak() })
  }

  if (state.kind === 'in' || state.kind === 'break') {
    items.push({ label: 'Ausstempeln', click: () => actions.clockOut() })
  }

  if (state.kind === 'unauthenticated') {
    // Same call as the widget's button: it drops the rejected cookie and opens
    // Factorial's login page (`onSignOut` in `index.ts`).
    items.push({ label: 'Anmelden', click: () => actions.signIn() })
  }

  // `unknown` deliberately offers no clock action: before the first answer the
  // app does not know what a click would mean, and this one writes to a real
  // time record.

  items.push(
    { type: 'separator' },
    {
      label: windowVisible ? 'Fenster ausblenden' : 'Fenster zeigen',
      click: () => actions.toggleWindow(),
    },
    { label: 'Aktualisieren', click: () => actions.refresh() },
    { type: 'separator' },
    // Always present, in every state: closing the widget only hides it and the
    // window is kept out of the taskbar, so this is the only way out of the app
    // on Windows (docs/WINDOWS.md §4).
    { label: 'Beenden', click: () => actions.quit() },
  )

  return items
}
