import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { formatDuration, formatHoursMinutes } from '@shared/time'
import type { AppSettings } from '@shared/ipc-contract'
import { describeActionError, describeStaleReason } from '@renderer/lib/errors'
import { useAttendance, useTicker } from '@renderer/hooks/useAttendance'
import { ProgressRing } from './ProgressRing'
import { ActionBar } from './ActionBar'
import { LocationSelect } from './LocationSelect'

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
  const [settings, setSettings] = useState<AppSettings | null>(null)

  // Only `in` and `break` carry a start; `since` is what the timer is recomputed
  // from on every tick, and the ticker only runs while there is one.
  const since = state.kind === 'in' || state.kind === 'break' ? state.since : null
  const tick = useTicker(since !== null)
  // `Math.max(0, …)` guards a clock that jumped backwards (NTP correction, a
  // resume from standby): a negative segment would render as a shrinking timer.
  const segmentMs = since === null ? 0 : Math.max(0, tick - since.getTime())

  useEffect(() => {
    // A failure here is not worth a toast — the widget stays usable, the
    // location select just stays disabled until the next mount.
    void window.factorial.getSettings().then(setSettings, () => {})
  }, [])

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
   * goal. DESIGN.md, "Soll-Zeit und Fortschrittsring": on a day off the
   * comparison is dropped and the ring shows plain elapsed time.
   */
  const target =
    snapshot.expectedMinutes !== null && snapshot.expectedMinutes > 0
      ? snapshot.expectedMinutes
      : null

  const remainingMinutes =
    workedMs === null || target === null ? null : Math.max(0, target - workedMs / 60_000)

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

  /** Remembering the choice is a preference, not part of the clock-in. */
  function chooseLocation(value: string): void {
    setSettings((current) => (current === null ? current : { ...current, lastLocationType: value }))
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
   * The advisory line under the status. Order matters: a lost connection
   * explains why everything else might be old, so it is read first.
   *
   * C4: a record without `minutes` counts as 0 — visibly, not silently.
   */
  const hints = [
    snapshot.stale ? describeStaleReason(snapshot.lastErrorKind) : null,
    snapshot.incompleteShifts > 0 ? 'Tagessumme unvollständig' : null,
  ].filter((hint): hint is string => hint !== null)

  return (
    <div className="flex h-full flex-col rounded-xl border bg-background/95 p-2.5 backdrop-blur">
      {/*
        The ring is the subject, centred in the space the actions leave over.
        `flex-1` plus `justify-center` is what removed the dead band the old
        `justify-between` opened up between the header and the buttons: the room
        now belongs to the composition instead of falling out of it.
      */}
      <div
        className={`drag-region flex flex-1 flex-col items-center justify-center gap-1 transition-[opacity,transform] duration-[220ms] ease-(--ease-out) ${
          ready ? 'scale-100 opacity-100' : 'scale-[0.98] opacity-0'
        }`}
      >
        <ProgressRing
          // Without a target there is nothing to be a fraction of: the arc stays
          // empty and the ring is just a frame around the timer.
          progress={workedMs === null || target === null ? 0 : workedMs / 60_000 / target}
          label={workedMs === null ? UNKNOWN_TIME : formatDuration(workedMs)}
          tone={TONE[state.kind]}
        />

        <div className="flex min-w-0 flex-col items-center gap-0.5 text-center">
          <div className="flex items-center gap-1.5">
            <span
              // The dot and the ring are the only carriers of the state change.
              // Both transition their colour rather than cutting to it.
              className={`size-2 shrink-0 rounded-full transition-colors duration-300 ease-(--ease-out) ${DOT[state.kind]}`}
            />
            <span className="truncate text-sm font-semibold">{LABEL[state.kind]}</span>
          </div>
          {remainingMinutes !== null && (
            <p className="text-xs text-muted-foreground">
              Verbleibende Zeit {formatHoursMinutes(remainingMinutes)}
            </p>
          )}
          {/*
            One line, not two stacked ones.

            Both hints are advisory and both are rare, but together they used to
            add 28 px to a card with 7 px to spare — which pushed the work-location
            select clean off the bottom edge. Losing a control the user can still
            click at is far worse than reading two short warnings side by side.

            `stale` is keyed off the flag, never off `lastError !== null`: a
            successful refresh clears `stale` but keeps `lastError` forever (see
            the contract's note on `AppSnapshot.lastError`), so the other test
            would glue this hint to the widget for the rest of the session.

            Fades rather than appearing: these arrive on their own, with no click
            behind them to explain the change. No slide — a warning should be
            noticed, not performed.
          */}
          {hints.length > 0 && (
            <p className="animate-in fade-in-0 max-w-full truncate text-[10px] text-muted-foreground duration-[140ms] ease-(--ease-out)">
              {hints.join(' · ')}
            </p>
          )}
        </div>
      </div>

      <div className="no-drag flex flex-col items-center gap-2">
        {/*
          Keyed by state so React remounts the row and replays the entrance. The
          whole set of buttons changes shape between states (one button becomes
          two), and swapping that in a single frame is the most abrupt thing this
          widget does — at a handful of times a day it can well afford 180 ms.
          Enter only: the outgoing buttons are replaced, not dismissed, and
          holding them around to fade would delay the state the user just asked
          for.
        */}
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

        <div className="flex w-full items-center justify-between gap-2 text-xs text-muted-foreground">
          <LocationSelect
            value={displayedLocation}
            // The location is only sent with a clock-in, so changing it mid-shift
            // would silently do nothing.
            disabled={busy || settings === null || state.kind !== 'out'}
            onChange={chooseLocation}
          />
          {state.kind === 'break' && (
            <span className="truncate tabular-nums">{`${state.breakName} · ${formatDuration(segmentMs)}`}</span>
          )}
        </div>
      </div>
    </div>
  )
}
