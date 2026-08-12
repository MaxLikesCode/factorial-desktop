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

  /** Remembering the choice is a preference, not part of the clock-in. */
  function chooseLocation(value: string): void {
    setSettings((current) => (current === null ? current : { ...current, lastLocationType: value }))
    void window.factorial.setSettings({ lastLocationType: value }).catch(() => {})
  }

  return (
    <div className="flex h-full flex-col justify-between rounded-xl border bg-background/95 p-3 backdrop-blur">
      <div className="drag-region flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`size-2 shrink-0 rounded-full ${DOT[state.kind]}`} />
            <span className="truncate text-sm font-semibold">{LABEL[state.kind]}</span>
          </div>
          {/*
            Keyed off `stale`, never off `lastError !== null`: a successful
            refresh clears `stale` but keeps `lastError` forever (see the
            contract's note on `AppSnapshot.lastError`), so the other test would
            glue this hint to the widget for the rest of the session.
          */}
          {snapshot.stale && (
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              · {describeStaleReason(snapshot.lastErrorKind)}
            </p>
          )}
          {remainingMinutes !== null && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Verbleibende Zeit {formatHoursMinutes(remainingMinutes)}
            </p>
          )}
          {/* C4: a record without `minutes` counts as 0 — visibly, not silently. */}
          {snapshot.incompleteShifts > 0 && (
            <p className="mt-0.5 text-[10px] text-muted-foreground">Tagessumme unvollständig</p>
          )}
        </div>
        <ProgressRing
          // Without a target there is nothing to be a fraction of: the arc stays
          // empty and the ring is just a frame around the timer.
          progress={workedMs === null || target === null ? 0 : workedMs / 60_000 / target}
          label={workedMs === null ? UNKNOWN_TIME : formatDuration(workedMs)}
          tone={TONE[state.kind]}
        />
      </div>

      <div className="no-drag">
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
        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <LocationSelect
            value={settings?.lastLocationType ?? 'office'}
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
