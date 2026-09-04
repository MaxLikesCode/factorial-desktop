import { useCallback, useEffect, useState } from 'react'
import { LogInIcon, PauseIcon, PlayIcon, SquareIcon } from 'lucide-react'
import { formatDuration, formatHoursMinutes } from '@shared/time'
import { breakMinutes, buildDayBar, type DaySegment } from '@shared/day-timeline'
import { parseIsoDate } from '@shared/timesheet'
import { resolveLocale } from '@shared/i18n'
import type { AppSnapshot } from '@shared/ipc-contract'
import type { MonthInsight, OverviewInsights, UpcomingLeave } from '@shared/overview'
import { useAttendance, useTicker } from '@renderer/hooks/useAttendance'
import { useSettings } from '@renderer/hooks/useSettings'
import { useTranslate } from '@renderer/hooks/useTranslate'
import { Dropdown } from './Dropdown'
import { LOCATIONS } from '@renderer/components/LocationSelect'
import { describeActionError } from '@renderer/lib/errors'
import { toast } from 'sonner'

/**
 * The overview: the clock at the top, and below it the cards Factorial's own
 * profile page has — the upcoming absences and the month's timesheet.
 *
 * The clock card is the widget at a readable size and nothing more. It reads
 * the snapshot the widget reads and presses the buttons the widget presses;
 * the day's four numbers sit in its footer rather than in a card of their own,
 * so the clock takes one card's height and the rest of the page is the rest.
 */
export function OverviewPage({ onEditToday }: { onEditToday: () => void }): React.JSX.Element {
  const t = useTranslate()
  const snapshot = useAttendance()
  const settings = useSettings()
  const locale = resolveLocale(settings?.language ?? 'system', navigator.language)
  const { state } = snapshot
  const running = state.kind === 'in' || state.kind === 'break'
  const now = useTicker(running)
  const [busy, setBusy] = useState(false)
  const insights = useOverviewInsights(snapshot)

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
    <div className="flex max-w-3xl flex-col gap-4 pt-6">
      <section className="app-card flex flex-col gap-4 px-6 pt-5 pb-4">
        <div className="flex items-center justify-between gap-6">
          <div className="flex flex-col gap-1">
            <div className="app-muted flex items-center gap-2 text-[13px] font-medium">
              <span className="size-2 rounded-full" style={{ background: tone, boxShadow: running ? `0 0 0 4px color-mix(in oklch, ${tone} 22%, transparent)` : undefined }} />
              <span>{t(`state.${state.kind}`)}</span>
            </div>
            <div className="app-num text-[40px] leading-none font-semibold" style={{ letterSpacing: '-0.03em' }}>
              {/* The same number the widget shows: the day's worked time,
                  running record included, to the second — and during a break
                  the break itself, which is what is ticking then. */}
              {state.kind === 'break'
                ? formatDuration(runningMs)
                : running
                  ? formatDuration(snapshot.todayMinutes * 60_000 + runningMs)
                  : formatHoursMinutes(worked)}
            </div>
            <div className="app-muted text-[13px]">
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

        {snapshot.stale && <div className="app-muted text-xs">{t('overview.stale')}</div>}

        <div className="flex items-end justify-between gap-4 pt-1" style={{ borderTop: '1px solid var(--app-line)' }}>
          <div className="flex gap-7 pt-3">
            <Stat label={t('overview.worked')} value={formatHours(worked)} dot="var(--app-work-2)" />
            <Stat label={t('overview.target')} value={target === null ? '–' : formatHours(target)} />
            <Stat label={t('overview.remaining')} value={remaining === null ? '–' : formatHours(remaining)} />
            <Stat label={t('overview.breaks')} value={formatHours(breaks)} dot="var(--app-break)" />
          </div>
          <button type="button" className="app-btn app-btn-ghost app-btn-sm -mr-3" onClick={onEditToday}>
            {t('overview.editToday')} →
          </button>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-4">
        <AbsencesCard leaves={insights.data?.leaves ?? null} error={insights.error} locale={locale} />
        <MonthCard
          month={insights.data?.month ?? null}
          error={insights.error}
          locale={locale}
          runningMinutes={state.kind === 'in' ? runningMinutes : 0}
        />
      </div>
    </div>
  )
}

/**
 * The two cards' data, read when the page opens and again whenever the clock
 * changes: a clock-out is a changed month, and the snapshot is the cheapest
 * signal that it changed. A failed read keeps what was shown and says so.
 */
function useOverviewInsights(snapshot: AppSnapshot): { data: OverviewInsights | null; error: string | null } {
  const t = useTranslate()
  const [data, setData] = useState<OverviewInsights | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await window.factorial.getOverviewInsights())
      setError(null)
    } catch (e) {
      setError(t('overview.loadFailed', { reason: describeActionError(t, e) }))
    }
  }, [t])

  useEffect(() => {
    if (snapshot.state.kind === 'unknown' || snapshot.state.kind === 'unauthenticated') return
    void load()
  }, [load, snapshot.state.kind, snapshot.todayMinutes])

  return { data, error }
}

function formatHours(minutes: number): string {
  const total = Math.max(0, Math.round(minutes))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')} h`
}

/** A signed `+1:04 h` / `−1:04 h`, for balances. */
function formatSigned(minutes: number): string {
  return `${minutes < 0 ? '−' : '+'}${formatHours(Math.abs(minutes))}`
}

/** One of the clock card's four numbers, small: the label under the value. */
function Stat({ label, value, dot }: { label: string; value: string; dot?: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="app-num flex items-center gap-1.5 text-[15px] font-semibold">
        {dot !== undefined && <span className="app-dot" style={{ background: dot }} />}
        {value}
      </div>
      <div className="app-faint text-xs">{label}</div>
    </div>
  )
}

/** Today as a strip against its target — the widget's own bar arithmetic (`buildDayBar`). */
function DayBar({ segments, target }: { segments: DaySegment[]; target: number | null }): React.JSX.Element {
  const label = useTranslate()('overview.target')
  const parts = buildDayBar(segments, target)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-2 overflow-hidden rounded-full" style={{ background: 'var(--app-fill-strong)' }}>
        {parts.map((part, index) => (
          <span
            key={index}
            style={{
              width: `${part.percent}%`,
              background: part.kind === 'work' ? 'var(--app-work-2)' : part.kind === 'break' ? 'var(--app-break)' : 'transparent',
            }}
          />
        ))}
      </div>
      <div className="app-faint flex justify-end text-[11px]" style={{ fontVariantNumeric: 'tabular-nums' }}>
        <span>{target === null ? '' : `${label} ${formatHours(target)}`}</span>
      </div>
    </div>
  )
}

/** A card's title line: what it is, and beside it what it covers. */
function CardHeader({ title, subtitle }: { title: string; subtitle: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[13px] font-semibold">{title}</span>
      <span className="app-faint truncate text-xs">{subtitle}</span>
    </div>
  )
}

function CardError({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="text-xs" style={{ color: 'var(--app-neg)' }}>
      {message}
    </div>
  )
}

function toDate(iso: string): Date | null {
  const parts = parseIsoDate(iso)
  return parts === null ? null : new Date(parts.year, parts.month - 1, parts.day)
}

/** A day as the profile page draws it: the month above the day number. */
function DateChip({ iso, locale }: { iso: string; locale: string }): React.JSX.Element {
  const date = toDate(iso)
  return (
    <span className="flex w-8 flex-col items-center leading-none">
      <span className="app-faint text-[9px] font-bold tracking-wide uppercase">
        {date === null ? '' : date.toLocaleDateString(locale, { month: 'short' }).replace('.', '')}
      </span>
      <span className="app-num text-[15px] font-semibold">{date === null ? iso : date.getDate()}</span>
    </span>
  )
}

/** The profile page's "Abwesenheiten": what is booked from today on. */
function AbsencesCard({ leaves, error, locale }: { leaves: UpcomingLeave[] | null; error: string | null; locale: string }): React.JSX.Element {
  const t = useTranslate()
  return (
    <section className="app-card flex flex-col gap-3 px-5 pt-4 pb-4" data-slot="absences">
      <CardHeader title={t('overview.absences')} subtitle={t('overview.absencesUpcoming')} />
      {error !== null && leaves === null && <CardError message={error} />}
      {leaves !== null && leaves.length === 0 && <div className="app-faint py-2 text-[13px]">{t('overview.noAbsences')}</div>}
      {leaves !== null && leaves.length > 0 && (
        <ul className="app-divide flex flex-col">
          {leaves.map((leave) => (
            <li key={leave.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
              <span
                className="h-8 w-1 shrink-0 rounded-full"
                style={{ background: leave.color === null ? 'var(--app-work-2)' : `#${leave.color}` }}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-2 text-[13px] font-medium">
                  <span className="truncate">{leave.name}</span>
                  {leave.approved === null && <span className="app-pending-badge">{t('overview.requested')}</span>}
                </span>
                {leave.days !== null && (
                  <span className="app-faint text-xs">
                    {leave.days === 1 ? t('overview.oneDay') : t('overview.dayCount', { count: formatDays(leave.days) })}
                  </span>
                )}
              </span>
              <span className="flex items-center gap-1">
                <DateChip iso={leave.startOn} locale={locale} />
                {leave.finishOn !== leave.startOn && (
                  <>
                    <span className="app-faint text-xs">→</span>
                    <DateChip iso={leave.finishOn} locale={locale} />
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** `2`, `2.5` — never `2.0`, and never more than one decimal. */
function formatDays(days: number): string {
  return String(Math.round(days * 10) / 10)
}

/**
 * The profile page's "Stundenzettel": the month's worked time against its
 * target. The running shift is added live, exactly as the clock card adds it
 * to today — Factorial's sum only counts closed records.
 */
function MonthCard({
  month,
  error,
  locale,
  runningMinutes,
}: {
  month: MonthInsight | null
  error: string | null
  locale: string
  runningMinutes: number
}): React.JSX.Element {
  const t = useTranslate()
  // Some locales spell the month in lower case; as a title it gets a capital.
  const monthName = new Date().toLocaleDateString(locale, { month: 'long', year: 'numeric' })
  const title = monthName.charAt(0).toLocaleUpperCase(locale) + monthName.slice(1)
  const worked = month === null ? null : month.workedMinutes + runningMinutes
  const balance = month === null || worked === null ? null : worked - month.expectedToDate
  const total = month?.expectedTotal ?? 0
  const percent = (minutes: number): number => (total <= 0 ? 0 : Math.min(100, (minutes / total) * 100))

  return (
    <section className="app-card flex flex-col gap-3 px-5 pt-4 pb-4" data-slot="month">
      <CardHeader title={t('overview.monthSheet')} subtitle={title} />
      {error !== null && month === null && <CardError message={error} />}
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="app-num text-[26px] leading-none font-semibold" style={{ letterSpacing: '-0.02em' }}>
            {worked === null ? '–' : formatHours(worked)}
          </span>
          <span className="app-faint text-xs">{t('overview.monthWorked')}</span>
        </div>
        {balance !== null && (
          <div className="flex flex-col items-end gap-0.5">
            <span
              className="app-num text-[17px] leading-none font-semibold"
              style={{ color: balance < 0 ? 'var(--app-neg)' : 'var(--app-work-2)' }}
              data-slot="balance"
            >
              {formatSigned(balance)}
            </span>
            <span className="app-faint text-xs">{t('timesheet.balance')}</span>
          </div>
        )}
      </div>
      <div className="relative flex h-2 overflow-hidden rounded-full" style={{ background: 'var(--app-fill-strong)' }}>
        <span className="rounded-full" style={{ width: `${percent(worked ?? 0)}%`, background: 'var(--app-work-2)' }} />
        {month !== null && total > 0 && (
          // Where the month should stand today.
          <span className="absolute top-0 h-full w-0.5" style={{ left: `${percent(month.expectedToDate)}%`, background: 'var(--app-text)', opacity: 0.5 }} />
        )}
      </div>
      <div className="app-faint flex items-center justify-between gap-3 text-xs" style={{ fontVariantNumeric: 'tabular-nums' }}>
        <span>
          {t('overview.targetToDate')} {month === null ? '–' : formatHours(month.expectedToDate)}
        </span>
        <span>
          {t('overview.targetMonth')} {month === null ? '–' : formatHours(month.expectedTotal)}
        </span>
      </div>
      {month !== null && month.pendingInconsistencies !== null && month.pendingInconsistencies > 0 && (
        <span className="app-pending-badge self-start">{t('overview.toComplete', { count: String(month.pendingInconsistencies) })}</span>
      )}
    </section>
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
      <button type="button" className="app-btn app-btn-primary" disabled={busy} onClick={onSignIn}>
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
          className="app-btn app-btn-primary"
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
      <button type="button" className="app-btn app-btn-primary" disabled={busy} onClick={() => onClockIn(lastLocationType)}>
        <PlayIcon /> {t('tray.clockIn')}
      </button>
    )
  }
  return (
    <div className="flex items-center gap-2.5">
      {state === 'in' ? (
        <Dropdown
          items={breakOptions.map((o) => ({ value: o.id, label: o.name }))}
          disabled={busy || breakOptions.length === 0}
          className="app-btn app-btn-secondary"
          onSelect={onStartBreak}
        >
          <PauseIcon /> {t('tray.break')}
        </Dropdown>
      ) : (
        <button type="button" className="app-btn app-btn-secondary" disabled={busy} onClick={onEndBreak}>
          <PauseIcon /> {t('tray.resume')}
        </button>
      )}
      <button type="button" className="app-btn app-btn-primary" disabled={busy} onClick={onClockOut}>
        <SquareIcon /> {t('tray.clockOut')}
      </button>
    </div>
  )
}
