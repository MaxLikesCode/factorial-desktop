import { useCallback, useEffect, useState } from 'react'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { toLocalDate } from '@shared/time'
import {
  MINUTES_PER_DAY,
  formatHours,
  minuteOfDay,
  workedMinutes,
  type TimesheetDay,
  type TimesheetMonth,
} from '@shared/timesheet'
import { useAttendance, useTicker } from '@renderer/hooks/useAttendance'
import { useSettings } from '@renderer/hooks/useSettings'
import { useTranslate } from '@renderer/hooks/useTranslate'
import { resolveLocale } from '@shared/i18n'
import { Button } from '@renderer/components/ui/button'
import { describeActionError } from '@renderer/lib/errors'
import { DayEditor } from './DayEditor'

/**
 * A month of days, one row each, and an editor that opens under the row
 * that was clicked.
 *
 * The month is read once per navigation and replaced day by day as saves
 * come back — the save resolves with the day as Factorial now holds it, so
 * what the row shows after a save is what the server has, not what was sent.
 */
export function TimesheetPage(): React.JSX.Element {
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
  const [month, setMonth] = useState<TimesheetMonth | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const loaded = await window.factorial.getTimesheetMonth(cursor.year, cursor.month)
      setMonth(loaded)
      // Today is open on arrival: it is the day most edits are about, and
      // the one the tray's "Timesheet …" and the overview's "Edit today" mean.
      setOpen((current) => current ?? (loaded.days.some((d) => d.date === today) ? today : null))
    } catch (e) {
      setMonth(null)
      setError(t('timesheet.loadFailed', { reason: describeActionError(t, e) }))
    }
  }, [cursor, t])

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

  return (
    <div className="flex max-w-3xl flex-col gap-6 pt-2">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" aria-label={t('timesheet.previousMonth')} onClick={() => step(-1)}>
          <ChevronLeftIcon />
        </Button>
        <h2 className="min-w-44 text-center text-lg font-semibold capitalize">{title}</h2>
        <Button variant="ghost" size="icon-sm" aria-label={t('timesheet.nextMonth')} onClick={() => step(1)}>
          <ChevronRightIcon />
        </Button>
        {!isCurrentMonth(cursor) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const d = new Date()
              setOpen(null)
              setCursor({ year: d.getFullYear(), month: d.getMonth() + 1 })
            }}
          >
            {t('timesheet.thisMonth')}
          </Button>
        )}
      </div>

      <section className="grid grid-cols-3 gap-px overflow-hidden rounded-2xl border bg-border">
        <Stat label={t('overview.worked')} value={formatHours(workedTotal)} />
        <Stat label={t('overview.target')} value={formatHours(targetTotal)} />
        <Stat label={t('timesheet.balance')} value={`${balance < 0 ? '−' : '+'}${formatHours(Math.abs(balance))}`} tone={balance < 0 ? 'neg' : 'pos'} />
      </section>

      {error !== null && <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">{error}</div>}

      <section className="divide-y overflow-hidden rounded-2xl border bg-card">
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
                className={`flex w-full items-center gap-4 px-5 py-3 text-left transition-colors hover:bg-muted/40 disabled:opacity-40 disabled:hover:bg-transparent ${
                  opened ? 'bg-muted/40' : ''
                }`}
              >
                <span className="flex w-14 shrink-0 flex-col leading-tight">
                  <span className="text-xs uppercase text-muted-foreground">
                    {date.toLocaleDateString(locale, { weekday: 'short' })}
                  </span>
                  <span className={`text-lg font-semibold tabular-nums ${isToday ? 'text-primary' : ''}`}>{date.getDate()}</span>
                </span>
                <MiniStrip day={day} now={now} />
                <span className="w-32 shrink-0 text-right text-sm tabular-nums">
                  {day.blocks.length === 0 ? (
                    <span className="text-muted-foreground">{target === 0 || target === null ? t('timesheet.dayOff') : t('timesheet.noRecords')}</span>
                  ) : (
                    <>
                      <span className="font-medium">{formatHours(worked)}</span>
                      {target !== null && target > 0 && <span className="text-muted-foreground"> / {formatHours(target)}</span>}
                    </>
                  )}
                </span>
                <span
                  className={`w-16 shrink-0 text-right text-xs tabular-nums ${
                    delta === null ? 'text-transparent' : delta < 0 ? 'text-destructive' : 'text-muted-foreground'
                  }`}
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
                    setMonth((current) =>
                      current === null ? current : { ...current, days: current.days.map((d) => (d.date === saved.date ? saved : d)) },
                    )
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

function isCurrentMonth(cursor: { year: number; month: number }): boolean {
  const d = new Date()
  return cursor.year === d.getFullYear() && cursor.month === d.getMonth() + 1
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'pos' | 'neg' }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 bg-card px-5 py-4">
      <div className={`text-2xl font-semibold tabular-nums tracking-tight ${tone === 'neg' ? 'text-destructive' : ''}`}>{value}</div>
      <div className="text-sm text-muted-foreground">{label}</div>
    </div>
  )
}

/** The day at a glance: its blocks on a 06–20 strip, the running one to now. */
function MiniStrip({ day, now }: { day: TimesheetDay; now: number | null }): React.JSX.Element {
  const lo = 6 * 60
  const hi = Math.max(20 * 60, ...day.blocks.map((b) => b.end ?? now ?? 0))
  const span = Math.min(MINUTES_PER_DAY, hi) - lo
  return (
    <span className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-muted/60">
      {day.blocks.map((block, index) => {
        const end = block.end ?? now ?? block.start
        return (
          <span
            key={block.id ?? `new-${index}`}
            className={`absolute top-0 bottom-0 rounded-full ${block.kind === 'work' ? 'bg-primary' : 'bg-primary/35'}`}
            style={{
              left: `${Math.max(0, ((block.start - lo) / span) * 100)}%`,
              width: `${Math.max(0, ((end - block.start) / span) * 100)}%`,
            }}
          />
        )
      })}
    </span>
  )
}
