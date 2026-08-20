import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { formatDuration, formatHoursMinutes, formatOvertime } from '@shared/time'
import type { AppSettings } from '@shared/ipc-contract'
import { describeActionError, describeStaleReason } from '@renderer/lib/errors'
import { useAttendance, useTicker } from '@renderer/hooks/useAttendance'
import { ProgressBar } from './ProgressBar'
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

/**
 * The day's worked time, at the size this card is now built around.
 *
 * The seconds are one step down in *contrast*, not in size. At 42 px they tick
 * once a second in the corner of someone's eye for eight hours, and that
 * movement is the one thing about this widget that could become tiring; muting
 * them settles it while every digit stays fully readable. Shrinking them would
 * have bought the same calm by giving up legibility instead.
 *
 * The split is on the last colon, so it works on `UNKNOWN_TIME` too — the dash
 * placeholder gets the same treatment rather than a second code path.
 */
function Timer({ value }: { value: string }): React.JSX.Element {
  const cut = value.lastIndexOf(':')
  return (
    <span
      data-slot="worked-timer"
      className="text-[42px] leading-[1.04] font-semibold tracking-[-0.038em] tabular-nums"
    >
      {value.slice(0, cut)}
      <span className="text-muted-foreground">{value.slice(cut)}</span>
    </span>
  )
}

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
    overtimeMinutes === null
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
   * The advisory line under the bar. Order matters: a lost connection explains
   * why everything else might be old, so it is read first.
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
        Left-aligned and full-width, where the old composition stacked everything
        in a narrow centred column and left roughly 200 px of the card's 340 dark.
        The timer is the subject because it is the largest thing on the card, not
        because it sits in the middle of a ring — which is what freed it to be
        legible at every reading length. „10:23:45" needs 178 px of the 312 here;
        inside the old ring it had 67.6 px and ran over the stroke on both sides.
      */}
      <div
        className={`drag-region flex flex-1 flex-col justify-center gap-1.5 px-1 transition-[opacity,transform] duration-[220ms] ease-(--ease-out) ${
          ready ? 'scale-100 opacity-100' : 'scale-[0.98] opacity-0'
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              // The dot and the bar are the only carriers of the state change.
              // Both transition their colour rather than cutting to it.
              className={`size-2 shrink-0 rounded-full transition-colors duration-300 ease-(--ease-out) ${DOT[state.kind]}`}
            />
            <span className="truncate text-sm font-semibold">{LABEL[state.kind]}</span>
          </div>
          {goalLine !== null && (
            <span className="shrink-0 text-[11.5px] text-muted-foreground tabular-nums">
              {goalLine}
            </span>
          )}
        </div>

        <Timer value={workedMs === null ? UNKNOWN_TIME : formatDuration(workedMs)} />

        {progress !== null && (
          <div className="mt-1.5">
            <ProgressBar progress={progress} tone={TONE[state.kind]} />
          </div>
        )}

        {/*
          One line, not two stacked ones.

          Both hints are advisory and both are rare. On the old ring layout the
          two of them together added 28 px to a card with 7 px to spare, which
          pushed the work-location select clean off the bottom edge; this layout
          has around 40 px of slack and no longer depends on that, but two short
          warnings side by side still read faster than a stack.

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

      <div className="no-drag flex flex-col items-start gap-2 px-1">
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
