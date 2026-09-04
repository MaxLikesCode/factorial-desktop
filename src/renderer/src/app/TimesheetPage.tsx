import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { toLocalDate } from '@shared/time'
import { MINUTES_PER_DAY, formatHours, minuteOfDay, workedMinutes, type TimesheetDay, type TimesheetMonth } from '@shared/timesheet'
import { useAttendance, useTicker } from '@renderer/hooks/useAttendance'
import { useSettings } from '@renderer/hooks/useSettings'
import { useTranslate } from '@renderer/hooks/useTranslate'
import { resolveLocale } from '@shared/i18n'
import { describeActionError } from '@renderer/lib/errors'
import { DayEditor } from './DayEditor'

/**
 * Months already read this session, so coming back to the page shows the
 * last state at once while the fresh read runs behind it. Module scope on
 * purpose: the page unmounts when another section is shown, and the cache
 * is meant to outlive that. Keyed `year-month`.
 */
const loadedMonths = new Map<string, TimesheetMonth>()

/**
 * A month of days, one row each, and an editor that opens under the row
 * that was clicked.
 *
 * The month is read once per navigation and replaced day by day as saves
 * come back — the save resolves with the day as Factorial now holds it, so
 * what the row shows after a save is what the server has, not what was sent.
 * The month stepper lives in the window's title strip (`headerSlot`), so the
 * strip is the same height on every page.
 */
export function TimesheetPage({ headerSlot }: { headerSlot: HTMLElement | null }): React.JSX.Element {
  const t = useTranslate()
  const settings = useSettings()
  const snapshot = useAttendance()
  const locale = resolveLocale(settings?.language ?? 'system', navigator.language)
  const today = toLocalDate(new Date())
  const tick = useTicker(true)
  const nowMinute = minuteOfDay(new Date(tick))

  const [cursor, setCursor] = useState(() => {
    const d = new Date()
    return { year: d.getFullYear(), month: d.getMonth() + 1 }
  })
  const [month, setMonth] = useState<TimesheetMonth | null>(() => loadedMonths.get(monthKey(cursor)) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    // What was seen last, immediately; the read below replaces it.
    const remembered = loadedMonths.get(monthKey(cursor))
    if (remembered !== undefined) setMonth(remembered)
    try {
      const loaded = await window.factorial.getTimesheetMonth(cursor.year, cursor.month)
      loadedMonths.set(monthKey(cursor), loaded)
      setMonth(loaded)
      // Today is open on arrival: it is the day most edits are about, and
      // the one the tray's "Timesheet …" and the overview's "Edit today" mean.
      setOpen((current) => current ?? (loaded.days.some((d) => d.date === today) ? today : null))
    } catch (e) {
      // A failed refresh keeps what was shown; the message says it is old.
      if (remembered === undefined) setMonth(null)
      setError(t('timesheet.loadFailed', { reason: describeActionError(t, e) }))
    }
  }, [cursor, t, today])

  useEffect(() => {
    void load()
  }, [load])

  // Today's row follows the widget: a clock-in or clock-out elsewhere is a
  // changed day here, and the snapshot is the cheapest signal that it changed.
  useEffect(() => {
    if (month !== null && isCurrentMonth(cursor)) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.state.kind, snapshot.todayMinutes])

  function step(delta: number): void {
    setOpen(null)
    setCursor(({ year, month: m }) => {
      const d = new Date(year, m - 1 + delta, 1)
      return { year: d.getFullYear(), month: d.getMonth() + 1 }
    })
  }

  const title = new Date(cursor.year, cursor.month - 1, 1).toLocaleDateString(locale, { month: 'long', year: 'numeric' })
  const days = month?.days ?? []
  const nowFor = (day: TimesheetDay): number | null => (day.date === today ? nowMinute : null)
  const pastOrToday = days.filter((d) => d.date <= today)
  const workedTotal = pastOrToday.reduce((sum, d) => sum + workedMinutes(d.blocks, nowFor(d)), 0)
  const targetTotal = pastOrToday.reduce((sum, d) => sum + (d.expectedMinutes ?? 0), 0)
  const balance = workedTotal - targetTotal

  const header = (
    <div className="flex w-full items-center justify-between">
      <div className="flex items-center gap-1.5">
        <button type="button" className="app-btn app-btn-ghost app-btn-icon no-drag" aria-label={t('timesheet.previousMonth')} onClick={() => step(-1)}>
          <ChevronLeftIcon />
        </button>
        <span className="min-w-[150px] text-center text-[15px] font-semibold capitalize" style={{ color: 'var(--app-text)' }}>
          {title}
        </span>
        <button type="button" className="app-btn app-btn-ghost app-btn-icon no-drag" aria-label={t('timesheet.nextMonth')} onClick={() => step(1)}>
          <ChevronRightIcon />
        </button>
        {!isCurrentMonth(cursor) && (
          <button
            type="button"
            className="app-btn app-btn-ghost app-btn-sm no-drag"
            onClick={() => {
              const d = new Date()
              setOpen(null)
              setCursor({ year: d.getFullYear(), month: d.getMonth() + 1 })
            }}
          >
            {t('timesheet.thisMonth')}
          </button>
        )}
      </div>
    </div>
  )

  return (
    <div className="flex max-w-3xl flex-col gap-6 pt-7">
      {headerSlot !== null && createPortal(header, headerSlot)}

      <section className="app-card grid grid-cols-3 overflow-hidden">
        <Stat label={t('overview.worked')} value={formatHours(workedTotal)} first />
        <Stat label={t('overview.target')} value={formatHours(targetTotal)} />
        <Stat
          label={t('timesheet.balance')}
          value={`${balance < 0 ? '−' : '+'}${formatHours(Math.abs(balance))}`}
          color={balance < 0 ? 'var(--app-neg)' : 'var(--app-work-2)'}
        />
      </section>

      {error !== null && (
        <div className="rounded-xl px-4 py-3 text-sm" style={{ background: 'color-mix(in oklch, var(--app-neg) 12%, transparent)', border: '1px solid color-mix(in oklch, var(--app-neg) 40%, transparent)' }}>
          {error}
        </div>
      )}

      <section className="app-card app-divide flex flex-col overflow-hidden">
        <div className="app-faint flex items-center gap-4 px-5 py-2.5 text-[11px]" style={{ fontVariantNumeric: 'tabular-nums' }}>
          <span className="w-14 shrink-0" />
          <div className="flex flex-1 justify-between">
            {[6, 8, 10, 12, 14, 16, 18, 20].map((h) => (
              <span key={h}>{h}</span>
            ))}
          </div>
          <span className="w-[120px] shrink-0 text-right">{t('overview.worked')} / {t('overview.target')}</span>
          <span className="w-14 shrink-0 text-right">{t('timesheet.balance')}</span>
        </div>

        {days.map((day) => {
          const isToday = day.date === today
          const future = day.date > today
          const now = nowFor(day)
          const worked = workedMinutes(day.blocks, now)
          const target = day.expectedMinutes
          const delta = target === null || future || (target === 0 && worked === 0) ? null : worked - target
          const date = new Date(`${day.date}T00:00:00`)
          const opened = open === day.date
          return (
            <div key={day.date} data-slot="day" data-today={isToday || undefined}>
              <button
                type="button"
                disabled={future}
                onClick={() => setOpen(opened ? null : day.date)}
                className="app-row-hover flex w-full items-center gap-4 px-5 py-3 text-left transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                style={opened ? { background: 'var(--app-fill)' } : undefined}
              >
                <span className="flex w-14 shrink-0 flex-col leading-[1.1]">
                  <span className="text-[11px] uppercase" style={{ letterSpacing: '0.06em', color: isToday ? 'var(--app-accent-2)' : 'var(--app-faint)' }}>
                    {date.toLocaleDateString(locale, { weekday: 'short' })}
                  </span>
                  <span className="app-num text-lg font-semibold">{date.getDate()}</span>
                </span>
                <MiniStrip day={day} now={now} />
                {day.requests.length > 0 && (
                  <span className="app-pending-badge shrink-0" data-slot="pending-badge">
                    {t('timesheet.pendingCount', { count: day.requests.length })}
                  </span>
                )}
                <span className="w-[120px] shrink-0 text-right text-sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {day.blocks.length === 0 ? (
                    <span className="app-faint">{target === 0 || target === null ? t('timesheet.dayOff') : t('timesheet.noRecords')}</span>
                  ) : (
                    <>
                      <span className="font-semibold">{formatHours(worked).replace(' h', '')}</span>
                      {target !== null && target > 0 && <span className="app-faint"> / {formatHours(target).replace(' h', '')}</span>}
                    </>
                  )}
                </span>
                <span
                  className="w-14 shrink-0 text-right text-[13px]"
                  style={{ fontVariantNumeric: 'tabular-nums', color: delta === null ? 'transparent' : delta < 0 ? 'var(--app-neg)' : 'var(--app-work-2)' }}
                >
                  {delta === null ? '' : `${delta < 0 ? '−' : '+'}${formatHours(Math.abs(delta)).replace(' h', '')}`}
                </span>
              </button>
              {opened && (
                <DayEditor
                  day={day}
                  breakOptions={snapshot.breakOptions}
                  now={now}
                  onSaved={(saved) =>
                    setMonth((current) => {
                      if (current === null) return current
                      const next = { ...current, days: current.days.map((d) => (d.date === saved.date ? saved : d)) }
                      loadedMonths.set(monthKey(cursor), next)
                      return next
                    })
                  }
                />
              )}
            </div>
          )
        })}
      </section>
    </div>
  )
}

function monthKey(cursor: { year: number; month: number }): string {
  return `${cursor.year}-${cursor.month}`
}

function isCurrentMonth(cursor: { year: number; month: number }): boolean {
  const d = new Date()
  return cursor.year === d.getFullYear() && cursor.month === d.getMonth() + 1
}

function Stat({ label, value, color, first = false }: { label: string; value: string; color?: string; first?: boolean }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 px-[26px] py-[22px]" style={first ? undefined : { borderLeft: '1px solid var(--app-line)' }}>
      <div className="app-num text-[26px] font-semibold" style={color ? { color } : undefined}>{value}</div>
      <div className="app-muted text-sm">{label}</div>
    </div>
  )
}

/** The day at a glance: its blocks on a 06–20 strip, the running one to now. */
function MiniStrip({ day, now }: { day: TimesheetDay; now: number | null }): React.JSX.Element {
  const lo = 6 * 60
  const hi = Math.max(20 * 60, ...day.blocks.map((b) => b.end ?? now ?? 0))
  const span = Math.min(MINUTES_PER_DAY, hi) - lo
  return (
    <span className="relative h-3 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--app-fill)' }}>
      {day.blocks.map((block, index) => {
        const end = block.end ?? now ?? block.start
        const running = block.end === null
        return (
          <span
            key={block.id ?? `new-${index}`}
            className="absolute inset-y-0 rounded-full"
            style={{
              left: `${Math.max(0, ((block.start - lo) / span) * 100)}%`,
              width: `${Math.max(0, ((end - block.start) / span) * 100)}%`,
              background: block.kind === 'work' ? 'var(--app-work-2)' : 'var(--app-break)',
              boxShadow: running ? '0 0 0 3px color-mix(in oklch, var(--app-work-2) 25%, transparent)' : undefined,
            }}
          />
        )
      })}
      {/* What was asked for, as an outline over what is there — so a day
          with a pending change looks unsettled before the row is opened. */}
      {day.requests.map((request) => {
        const target = day.blocks.find((b) => b.id === request.shiftId)
        const start = request.requestType === 'delete_shift' ? target?.start : request.start
        const end = request.requestType === 'delete_shift' ? target?.end : request.end
        if (start === undefined || start === null || end === undefined || end === null) return null
        return (
          <span
            key={request.id}
            className="absolute inset-y-0 rounded-full"
            data-slot="pending-strip"
            style={{
              left: `${Math.max(0, ((start - lo) / span) * 100)}%`,
              width: `${Math.max(0, ((end - start) / span) * 100)}%`,
              border: '2px dashed var(--app-pending)',
              boxSizing: 'border-box',
            }}
          />
        )
      })}
    </span>
  )
}
