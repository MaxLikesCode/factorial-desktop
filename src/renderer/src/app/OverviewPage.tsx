import { useState } from 'react'
import { LogOutIcon, PauseIcon, PlayIcon, SquareIcon } from 'lucide-react'
import { formatDuration, formatHoursMinutes } from '@shared/time'
import { breakMinutes, buildDayBar } from '@shared/day-timeline'
import { useAttendance, useTicker } from '@renderer/hooks/useAttendance'
import { useSettings } from '@renderer/hooks/useSettings'
import { useTranslate } from '@renderer/hooks/useTranslate'
import { Button } from '@renderer/components/ui/button'
import { BreakMenu } from '@renderer/components/BreakMenu'
import { ProgressBar } from '@renderer/components/ProgressBar'
import { LOCATIONS } from '@renderer/components/LocationSelect'
import { describeActionError } from '@renderer/lib/errors'
import { clockInFromButton } from '@renderer/lib/clock-in'
import { toast } from 'sonner'

/**
 * The widget, at full size: today's numbers, the running timer and the same
 * three actions. Nothing here is a second source of anything — it reads the
 * snapshot the widget reads and presses the buttons the widget presses.
 */
export function OverviewPage({ onEditToday }: { onEditToday: () => void }): React.JSX.Element {
  const t = useTranslate()
  const snapshot = useAttendance()
  const settings = useSettings()
  const { state } = snapshot
  const running = state.kind === 'in' || state.kind === 'break'
  const now = useTicker(running)
  const [busy, setBusy] = useState(false)

  const runningMs = running ? Math.max(0, now - state.since.getTime()) : 0
  const runningMinutes = state.kind === 'in' ? runningMs / 60_000 : 0
  const worked = snapshot.todayMinutes + runningMinutes
  const breaks = breakMinutes(snapshot.daySegments) + (state.kind === 'break' ? runningMs / 60_000 : 0)
  const target = snapshot.expectedMinutes
  const remaining = target === null ? null : Math.max(0, target - worked)
  // The running record is not in `daySegments` (it has no length yet); the
  // renderer is the one that knows the current second, so it adds it here —
  // the same thing the widget does.
  const live = runningSegment(state.kind, runningMs)
  const parts =
    state.kind === 'unknown' || state.kind === 'unauthenticated'
      ? []
      : buildDayBar(live === null ? snapshot.daySegments : [...snapshot.daySegments, live], target)

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      toast.error(describeActionError(t, error))
    } finally {
      setBusy(false)
    }
  }

  const location = LOCATIONS.find(
    (l) => l.value === ((state.kind === 'in' || state.kind === 'break' ? state.locationType : null) ?? settings?.lastLocationType),
  )

  return (
    <div className="flex max-w-3xl flex-col gap-8 pt-2">
      <section className="grid grid-cols-4 gap-px overflow-hidden rounded-2xl border bg-border">
        <Stat label={t('overview.worked')} value={formatHoursMinutes(worked)} />
        <Stat label={t('overview.target')} value={target === null ? '–' : formatHoursMinutes(target)} />
        <Stat label={t('overview.remaining')} value={remaining === null ? '–' : formatHoursMinutes(remaining)} />
        <Stat label={t('overview.breaks')} value={formatHoursMinutes(breaks)} />
      </section>

      <section className="flex flex-col gap-5 rounded-2xl border bg-card p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <div className="text-sm font-medium text-muted-foreground">{t(`state.${state.kind}`)}</div>
            <div className="text-5xl font-semibold tabular-nums tracking-tight">
              {running ? formatDuration(runningMs) : formatHoursMinutes(worked)}
            </div>
            <div className="text-sm text-muted-foreground">
              {running
                ? t('overview.since', { time: state.since.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) })
                : t('overview.today')}
              {state.kind === 'break' ? ` · ${state.breakName}` : ''}
              {location ? ` · ${t(location.key)}` : ''}
            </div>
          </div>
          <Actions
            busy={busy || state.kind === 'unknown'}
            state={state.kind}
            breakOptions={snapshot.breakOptions}
            onClockIn={(anchor) =>
              run(() =>
                clockInFromButton({
                  ask: settings?.askLocationOnClockIn ?? false,
                  lastLocationType: settings?.lastLocationType ?? 'office',
                  workplaceId: settings?.lastWorkplaceId ?? null,
                  anchor,
                  t,
                }),
              )
            }
            onClockOut={() => run(() => window.factorial.clockOut())}
            onStartBreak={(id) => run(() => window.factorial.startBreak(id))}
            onEndBreak={() => run(() => window.factorial.endBreak())}
            onSignIn={() => run(() => window.factorial.signOut())}
          />
        </div>
        <ProgressBar parts={parts} tone={state.kind === 'in' ? 'active' : state.kind === 'break' ? 'paused' : 'idle'} className="h-2" />
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{snapshot.stale ? t('overview.stale') : ''}</span>
          <Button variant="ghost" size="sm" onClick={onEditToday}>
            {t('overview.editToday')}
          </Button>
        </div>
      </section>
    </div>
  )
}

function runningSegment(kind: string, ms: number): { kind: 'work' | 'break'; minutes: number } | null {
  if (kind === 'in') return { kind: 'work', minutes: ms / 60_000 }
  if (kind === 'break') return { kind: 'break', minutes: ms / 60_000 }
  return null
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 bg-card px-5 py-4">
      <div className="text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      <div className="text-sm text-muted-foreground">{label}</div>
    </div>
  )
}

function Actions({
  busy,
  state,
  breakOptions,
  onClockIn,
  onClockOut,
  onStartBreak,
  onEndBreak,
  onSignIn,
}: {
  busy: boolean
  state: string
  breakOptions: { id: string; name: string }[]
  onClockIn: (anchor: DOMRect) => void
  onClockOut: () => void
  onStartBreak: (id: string) => void
  onEndBreak: () => void
  onSignIn: () => void
}): React.JSX.Element {
  const t = useTranslate()
  if (state === 'unauthenticated') {
    return (
      <Button size="lg" disabled={busy} onClick={onSignIn}>
        <LogOutIcon /> {t('tray.signIn')}
      </Button>
    )
  }
  if (state === 'out' || state === 'unknown') {
    return (
      <Button size="lg" disabled={busy} onClick={(event) => onClockIn(event.currentTarget.getBoundingClientRect())}>
        <PlayIcon /> {t('tray.clockIn')}
      </Button>
    )
  }
  return (
    <div className="flex items-center gap-2">
      {state === 'in' ? (
        <BreakMenu options={breakOptions} disabled={busy} onSelect={onStartBreak} />
      ) : (
        <Button size="lg" disabled={busy} onClick={onEndBreak}>
          <PauseIcon /> {t('tray.resume')}
        </Button>
      )}
      <Button size="lg" variant="outline" disabled={busy} onClick={onClockOut}>
        <SquareIcon /> {t('tray.clockOut')}
      </Button>
    </div>
  )
}
