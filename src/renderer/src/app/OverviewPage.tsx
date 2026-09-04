import { useState } from 'react'
import { LogInIcon, PauseIcon, PlayIcon, SquareIcon } from 'lucide-react'
import { formatDuration, formatHoursMinutes } from '@shared/time'
import { breakMinutes, type DaySegment } from '@shared/day-timeline'
import { useAttendance, useTicker } from '@renderer/hooks/useAttendance'
import { useSettings } from '@renderer/hooks/useSettings'
import { useTranslate } from '@renderer/hooks/useTranslate'
import { Dropdown } from './Dropdown'
import { LOCATIONS } from '@renderer/components/LocationSelect'
import { describeActionError } from '@renderer/lib/errors'
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
  const runningMinutes = runningMs / 60_000
  const worked = snapshot.todayMinutes + (state.kind === 'in' ? runningMinutes : 0)
  const breaks = breakMinutes(snapshot.daySegments) + (state.kind === 'break' ? runningMinutes : 0)
  const target = snapshot.expectedMinutes
  const remaining = target === null ? null : Math.max(0, target - worked)

  // The running record is not in `daySegments` (it has no length yet); the
  // renderer knows the current second, so it adds it — as the widget does.
  const live: DaySegment | null =
    state.kind === 'in' ? { kind: 'work', minutes: runningMinutes } : state.kind === 'break' ? { kind: 'break', minutes: runningMinutes } : null
  const segments = live === null ? snapshot.daySegments : [...snapshot.daySegments, live]

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
  const tone = state.kind === 'in' ? 'var(--app-work-2)' : state.kind === 'break' ? 'var(--app-break)' : 'var(--app-faint)'

  return (
    <div className="flex max-w-3xl flex-col gap-6 pt-7">
      <section className="app-card grid grid-cols-4 overflow-hidden">
        <Stat label={t('overview.worked')} value={formatHours(worked)} first />
        <Stat label={t('overview.target')} value={target === null ? '–' : formatHours(target)} />
        <Stat label={t('overview.remaining')} value={remaining === null ? '–' : formatHours(remaining)} />
        <Stat label={t('overview.breaks')} value={formatHours(breaks)} />
      </section>

      <section className="app-card flex flex-col gap-5 px-[30px] pt-7 pb-6">
        <div className="flex items-start justify-between gap-6">
          <div className="flex flex-col gap-1.5">
            <div className="app-muted flex items-center gap-2 text-sm font-medium">
              <span className="size-2 rounded-full" style={{ background: tone, boxShadow: running ? `0 0 0 4px color-mix(in oklch, ${tone} 22%, transparent)` : undefined }} />
              <span>{t(`state.${state.kind}`)}</span>
            </div>
            <div className="app-num text-[64px] leading-none font-semibold" style={{ letterSpacing: '-0.03em' }}>
              {/* The same number the widget shows: the day's worked time,
                  running record included, to the second — and during a break
                  the break itself, which is what is ticking then. */}
              {state.kind === 'break'
                ? formatDuration(runningMs)
                : running
                  ? formatDuration(snapshot.todayMinutes * 60_000 + runningMs)
                  : formatHoursMinutes(worked)}
            </div>
            <div className="app-muted text-sm">
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
            askLocation={settings?.askLocationOnClockIn ?? false}
            lastLocationType={settings?.lastLocationType ?? 'office'}
            onClockIn={(locationType) =>
              run(() =>
                window.factorial.clockIn({ locationType, workplaceId: settings?.lastWorkplaceId ?? null }),
              )
            }
            onClockOut={() => run(() => window.factorial.clockOut())}
            onStartBreak={(id) => run(() => window.factorial.startBreak(id))}
            onEndBreak={() => run(() => window.factorial.endBreak())}
            onSignIn={() => run(() => window.factorial.signOut())}
          />
        </div>

        <DayBar segments={segments} target={target} />

        <div className="flex items-center justify-between text-[13px]">
          <div className="app-muted flex gap-4">
            <span className="app-chip font-medium"><span className="app-dot app-dot-work" />{t('timesheet.work')} {formatHours(worked)}</span>
            <span className="app-chip font-medium"><span className="app-dot app-dot-break" />{t('timesheet.break')} {formatHours(breaks)}</span>
            {snapshot.stale && <span>{t('overview.stale')}</span>}
          </div>
          <button type="button" className="app-btn app-btn-ghost app-btn-sm" onClick={onEditToday}>
            {t('overview.editToday')} →
          </button>
        </div>
      </section>
    </div>
  )
}

function formatHours(minutes: number): string {
  const total = Math.max(0, Math.round(minutes))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')} h`
}

function Stat({ label, value, first = false }: { label: string; value: string; first?: boolean }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 px-[26px] py-[22px]" style={first ? undefined : { borderLeft: '1px solid var(--app-line)' }}>
      <div className="app-num text-[26px] font-semibold">{value}</div>
      <div className="app-muted text-sm">{label}</div>
    </div>
  )
}

/** Today as a strip against its target; the bar is the target's length. */
function DayBar({ segments, target }: { segments: DaySegment[]; target: number | null }): React.JSX.Element {
  const label = useTranslate()('overview.target')
  const total = Math.max(target ?? 0, segments.reduce((s, x) => s + x.minutes, 0))
  let offset = 0
  return (
    <div className="flex flex-col gap-2.5">
      <div className="relative h-2.5 overflow-hidden rounded-full" style={{ background: 'var(--app-fill-strong)' }}>
        {total > 0 &&
          segments.map((segment, index) => {
            const left = (offset / total) * 100
            offset += segment.minutes
            return (
              <span
                key={index}
                className="absolute inset-y-0"
                style={{
                  left: `${left}%`,
                  width: `${(segment.minutes / total) * 100}%`,
                  background: segment.kind === 'work' ? 'var(--app-work-2)' : 'var(--app-break)',
                }}
              />
            )
          })}
      </div>
      <div className="app-faint flex justify-between text-xs" style={{ fontVariantNumeric: 'tabular-nums' }}>
        <span />
        <span>{target === null ? '' : `${label} ${formatHours(target)}`}</span>
      </div>
    </div>
  )
}

function Actions({
  busy,
  state,
  breakOptions,
  askLocation,
  lastLocationType,
  onClockIn,
  onClockOut,
  onStartBreak,
  onEndBreak,
  onSignIn,
}: {
  busy: boolean
  state: string
  breakOptions: { id: string; name: string }[]
  askLocation: boolean
  lastLocationType: string
  /** With the location to clock in at — asked for first when the setting says so. */
  onClockIn: (locationType: string) => void
  onClockOut: () => void
  onStartBreak: (id: string) => void
  onEndBreak: () => void
  onSignIn: () => void
}): React.JSX.Element {
  const t = useTranslate()
  if (state === 'unauthenticated') {
    return (
      <button type="button" className="app-btn app-btn-primary app-btn-lg" disabled={busy} onClick={onSignIn}>
        <LogInIcon /> {t('tray.signIn')}
      </button>
    )
  }
  if (state === 'out' || state === 'unknown') {
    if (askLocation) {
      // The question as the window's own list: pick the place, and the pick
      // is the clock-in. The choice is remembered as the new default too.
      return (
        <Dropdown
          items={LOCATIONS.map((l) => ({ value: l.value, label: t(l.key) }))}
          value={lastLocationType}
          disabled={busy}
          className="app-btn app-btn-primary app-btn-lg"
          align="end"
          onSelect={(locationType) => {
            void window.factorial.setSettings({ lastLocationType: locationType }).catch(() => {})
            onClockIn(locationType)
          }}
        >
          <PlayIcon /> {t('tray.clockIn')}
        </Dropdown>
      )
    }
    return (
      <button type="button" className="app-btn app-btn-primary app-btn-lg" disabled={busy} onClick={() => onClockIn(lastLocationType)}>
        <PlayIcon /> {t('tray.clockIn')}
      </button>
    )
  }
  return (
    <div className="flex items-center gap-2.5 pt-1">
      {state === 'in' ? (
        <Dropdown
          items={breakOptions.map((o) => ({ value: o.id, label: o.name }))}
          disabled={busy || breakOptions.length === 0}
          className="app-btn app-btn-secondary app-btn-lg"
          onSelect={onStartBreak}
        >
          <PauseIcon /> {t('tray.break')}
        </Dropdown>
      ) : (
        <button type="button" className="app-btn app-btn-secondary app-btn-lg" disabled={busy} onClick={onEndBreak}>
          <PauseIcon /> {t('tray.resume')}
        </button>
      )}
      <button type="button" className="app-btn app-btn-primary app-btn-lg" disabled={busy} onClick={onClockOut}>
        <SquareIcon /> {t('tray.clockOut')}
      </button>
    </div>
  )
}
