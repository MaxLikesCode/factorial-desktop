import { useState } from 'react'
import { toast } from 'sonner'
import { formatDuration, formatHoursMinutes, formatOvertime } from '@shared/time'
import { describeActionError, describeStaleReason } from '@renderer/lib/errors'
import { useAttendance, useTicker } from '@renderer/hooks/useAttendance'
import { useSettings } from '@renderer/hooks/useSettings'
import { ActionBar } from './ActionBar'
import { LocationSelect } from './LocationSelect'
import { MinimalCard } from './MinimalCard'
import { StatusCard } from './StatusCard'
import type { WidgetView } from './WidgetView'

/**
 * Placeholder for a time this app does not know yet. It is not `0:00:00` on
 * purpose: a zero reads as a fact ("you have worked nothing today") and this
 * app writes to a real time record, where a confidently wrong number is the
 * expensive failure. A dash says "not loaded" and cannot be misread.
 */
export const UNKNOWN_TIME = '–:––:––'

const LABEL = {
  unknown: 'Lädt …',
  unauthenticated: 'Nicht angemeldet',
  out: 'Ausgestempelt',
  in: 'Eingestempelt',
  break: 'In einer Pause',
} as const

const DOT = {
  unknown: 'bg-muted-foreground/40',
  unauthenticated: 'bg-destructive',
  out: 'bg-muted-foreground/40',
  in: 'bg-emerald-500',
  break: 'bg-amber-500',
} as const

const TONE = {
  unknown: 'idle',
  unauthenticated: 'idle',
  out: 'idle',
  in: 'active',
  break: 'paused',
} as const

export function StatusWidget(): React.JSX.Element {
  const snapshot = useAttendance()
  const state = snapshot.state
  const [busy, setBusy] = useState(false)
  const settings = useSettings()
  const size = settings?.widgetSize ?? 'standard'
  /**
   * Whether the smallest size is currently showing its actions.
   *
   * Keyed off nothing but a click. It deliberately does NOT reset when the
   * attendance state changes: the card popping shut under someone who opened it
   * to clock out, because a poll happened to land, would be the worst kind of
   * surprise in a window that writes to a real time record.
   */
  const [expanded, setExpanded] = useState(false)

  // Only `in` and `break` carry a start; `since` is what the timer is recomputed
  // from on every tick, and the ticker only runs while there is one.
  const since = state.kind === 'in' || state.kind === 'break' ? state.since : null
  const tick = useTicker(since !== null)
  // `Math.max(0, …)` guards a clock that jumped backwards (NTP correction, a
  // resume from standby): a negative segment would render as a shrinking timer.
  const segmentMs = since === null ? 0 : Math.max(0, tick - since.getTime())

  /**
   * Worked milliseconds today, or `null` while the state is not known.
   *
   * Break time is not worked time, so the running segment is added only in `in`.
   * `todayMinutes` holds the *closed* shifts alone (the store excludes the open
   * one by id), which is why adding the segment here cannot double count.
   */
  const workedMs =
    state.kind === 'out' || state.kind === 'in' || state.kind === 'break'
      ? snapshot.todayMinutes * 60_000 + (state.kind === 'in' ? segmentMs : 0)
      : null

  /**
   * The day's goal, or `null` when there is none to compare against.
   *
   * A zero target counts as "none" as well: on a holiday the API answers either
   * `expectedMinutes: 0` or an empty node list (which `fetchExpectedMinutes`
   * reports as `null`), and rendering the first of those as „Verbleibende Zeit
   * 00:00" would read as "you are done for today" on a day that never had a
   * goal. DESIGN.md, "Soll-Zeit und Fortschrittsbalken": on a day off the
   * comparison is dropped and the card shows plain elapsed time.
   */
  const target =
    snapshot.expectedMinutes !== null && snapshot.expectedMinutes > 0
      ? snapshot.expectedMinutes
      : null

  /**
   * The fraction of the day's goal that is done, or `null` when there is no
   * comparison to draw. Both halves matter: without a goal there is nothing to
   * be a fraction of, and before the first snapshot there is no worked time.
   *
   * `null` means the bar is not rendered at all rather than rendered empty. An
   * empty track is not neutral — it claims "0 % of something", which on a
   * holiday or before the first answer is a statement this app does not have.
   * Same reasoning as `UNKNOWN_TIME` above.
   */
  const progress = workedMs === null || target === null ? null : workedMs / 60_000 / target

  /** Minutes past the goal; negative while there is still time owed. */
  const overtimeMinutes = workedMs === null || target === null ? null : workedMs / 60_000 - target

  /**
   * The line beside the status.
   *
   * Past the goal it switches from what is left to what is already over.
   * „Verbleibende Zeit 00:00" was true and useless — it reported the nothing
   * that remained instead of the surplus, which is the only interesting number
   * at that point in the day.
   *
   * The switch is on the *rounded* surplus, so the two readings never disagree
   * with what they print: a tenth of a minute past the goal still shows
   * „Verbleibende Zeit 00:00" rather than a „+0:00" that looks like a bug.
   */
  const goalLine =
    // A break hands the timer over to its own duration, so the day's worked time
    // moves up here — it is the number this app exists for and must not simply
    // disappear for the length of a lunch. The goal comparison steps aside for
    // that: it is frozen too, and the less interesting of the two.
    state.kind === 'break'
      ? workedMs === null
        ? null
        : `Gearbeitet ${formatHoursMinutes(workedMs / 60_000)}`
      : overtimeMinutes === null
        ? null
        : Math.round(overtimeMinutes) > 0
          ? `Soll erfüllt · ${formatOvertime(overtimeMinutes)}`
          : `Verbleibende Zeit ${formatHoursMinutes(-overtimeMinutes)}`

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      // Never the raw message: it is the main process's internal English.
      toast.error(describeActionError(error))
    } finally {
      setBusy(false)
    }
  }

  /**
   * What the footer shows.
   *
   * While a shift is open this is the location **that shift actually runs on**,
   * read back from the API. It is not the saved preference: that is only what
   * the *next* clock-in would use, and the two differ the moment someone clocks
   * in from the web, from their phone, or picks something else and forgets. It
   * showed "Büro" for a shift running on "Mobiles Arbeiten" — the widget was
   * reporting an intention as if it were a fact.
   *
   * `null` from the API falls back to the preference: an open shift the server
   * gives no location for leaves nothing truer to show.
   */
  const shiftLocation =
    state.kind === 'in' || state.kind === 'break' ? state.locationType : null
  const displayedLocation = shiftLocation ?? settings?.lastLocationType ?? 'office'

  /**
   * Remembering the choice is a preference, not part of the clock-in.
   *
   * No local echo any more: the main process broadcasts the stored settings back
   * and `useSettings` picks them up, so writing one here would only be a second
   * copy racing the real one.
   */
  function chooseLocation(value: string): void {
    void window.factorial.setSettings({ lastLocationType: value }).catch(() => {})
  }

  /**
   * True once the first real answer has arrived. Drives a single fade-in of the
   * card's contents — the one moment per launch where "Lädt …" and the dash
   * placeholder are replaced wholesale, and the only place a whole-card
   * animation is affordable.
   */
  const ready = state.kind !== 'unknown'

  /**
   * The advisory line under the bar. Order matters: a lost connection explains
   * why everything else might be old, so it is read first.
   *
   * C4: a record without `minutes` counts as 0 — visibly, not silently.
   */
  const hints = [
    snapshot.stale ? describeStaleReason(snapshot.lastErrorKind) : null,
    snapshot.incompleteShifts > 0 ? 'Tagessumme unvollständig' : null,
  ].filter((hint): hint is string => hint !== null)

  /** Everything the cards need, already decided. */
  const view: WidgetView = {
    /**
     * During a break the label names the break rather than the state, because
     * the number below it is now that break's clock and the label has to say
     * what the number is. The word "Pause" stays in front of the name: the amber
     * dot already says "paused", but a break called "Arztbesuch" would leave
     * colour as the only carrier of that, and colour cannot be the only carrier.
     */
    label: state.kind === 'break' ? `Pause · ${state.breakName}` : LABEL[state.kind],
    dotClass: DOT[state.kind],
    tone: TONE[state.kind],
    /**
     * The running break, or the day's worked time.
     *
     * `segmentMs` is the break's own elapsed time in this state — the same
     * number the tray has always shown as its primary reading (`primaryMs` in
     * `tray-menu.ts`, "showing it counting up would be a lie"). The widget was
     * the one surface that disagreed, freezing a green-turned-amber day sum
     * instead, which read as a stopped app rather than as a paused shift.
     */
    time:
      state.kind === 'break'
        ? formatDuration(segmentMs)
        : workedMs === null
          ? UNKNOWN_TIME
          : formatDuration(workedMs),
    goalLine,
    progress,
    hints,
  }

  const actions = (
    /*
      Keyed by state so React remounts the row and replays the entrance. The whole
      set of buttons changes shape between states — one button becomes two — and
      swapping that in a single frame is the most abrupt thing this widget does.
      Enter only: the outgoing buttons are replaced, not dismissed.
    */
    <div
      key={state.kind}
      className="animate-in fade-in-0 slide-in-from-bottom-1 duration-[180ms] ease-(--ease-out)"
    >
      <ActionBar
        snapshot={snapshot}
        busy={busy}
        onClockIn={() =>
          void run(() =>
            window.factorial.clockIn({
              locationType: settings?.lastLocationType ?? 'office',
              workplaceId: settings?.lastWorkplaceId ?? null,
            }),
          )
        }
        onClockOut={() => void run(() => window.factorial.clockOut())}
        onStartBreak={(id) => void run(() => window.factorial.startBreak(id))}
        onEndBreak={() => void run(() => window.factorial.endBreak())}
        onSignIn={() => void run(() => window.factorial.signOut())}
      />
    </div>
  )

  /*
    `minimal` is its own component rather than a third density, because the only
    size that changes shape needs a layout built for changing shape — absolutely
    positioned, springing, with a control the others have no use for.
  */
  if (size === 'minimal') {
    return (
      <MinimalCard
        view={view}
        open={expanded}
        onToggle={() => setExpanded((current) => !current)}
        actions={actions}
      />
    )
  }

  return (
    <StatusCard
      view={view}
      density={size}
      ready={ready}
      actions={actions}
      location={
        /*
          Only `standard` has the room. In `kompakt` the work location is reached
          through the tray, where it has always belonged as a preference — the
          cost being that a running shift's actual location is no longer visible
          at a glance there.
        */
        size === 'standard' ? (
          <LocationSelect
            value={displayedLocation}
            // The location is only sent with a clock-in, so changing it mid-shift
            // would silently do nothing.
            disabled={busy || settings === null || state.kind !== 'out'}
            onChange={chooseLocation}
          />
        ) : null
      }
    />
  )
}
