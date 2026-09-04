import { useEffect, useMemo, useState } from 'react'
import { ArrowRightIcon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'
import type { BreakOption } from '@shared/ipc-contract'
import {
  breakMinutes,
  diffDay,
  formatHours,
  formatMinuteOfDay,
  hasChanges,
  normaliseBlocks,
  parseTimeOfDay,
  workedMinutes,
  type PendingRequest,
  type TimesheetBlock,
  type TimesheetDay,
} from '@shared/timesheet'
import { useTranslate } from '@renderer/hooks/useTranslate'
import { describeActionError } from '@renderer/lib/errors'
import { MenuButton } from './MenuButton'
import { Timeline, type TimelineGhost } from './Timeline'

interface Props {
  day: TimesheetDay
  breakOptions: BreakOption[]
  /** Minutes of the day right now, when `day` is today. */
  now: number | null
  onSaved: (day: TimesheetDay) => void
}

/**
 * One day, edited: the strip to drag, the same blocks as fields to type
 * into, the sums that follow every change, and Save.
 *
 * The blocks are copied out of the day and edited locally; nothing is sent
 * until Save, and Discard puts the copy back. The sum the user is steering
 * towards — worked against target — is recomputed from the copy on every
 * change, which is the whole reason the editor exists.
 */
export function DayEditor({ day, breakOptions, now, onSaved }: Props): React.JSX.Element {
  const t = useTranslate()
  const [blocks, setBlocks] = useState<TimesheetBlock[]>(day.blocks)
  const [saving, setSaving] = useState(false)
  useEffect(() => setBlocks(day.blocks), [day])

  const dirty = hasChanges(diffDay(day.blocks, blocks))
  const worked = workedMinutes(blocks, now)
  const breaks = breakMinutes(blocks, now)

  // What has been asked for, drawn over the strip. Memoised because the strip
  // widens its scale to fit these and must not see a fresh list every render.
  const ghosts = useMemo(() => ghostsOf(day, t('timesheet.pendingNew')), [day, t])

  async function withdraw(request: PendingRequest): Promise<void> {
    setSaving(true)
    try {
      onSaved(await window.factorial.withdrawTimesheetRequest(request.id, day.date))
      toast.success(t('timesheet.withdrawn'))
    } catch (error) {
      toast.error(t('timesheet.withdrawFailed', { reason: describeActionError(t, error) }))
    } finally {
      setSaving(false)
    }
  }

  function change(next: TimesheetBlock[]): void {
    setBlocks(normaliseBlocks(next))
  }

  function setTime(index: number, part: 'start' | 'end', text: string): void {
    const minute = parseTimeOfDay(text)
    if (minute === null) return
    change(blocks.map((b, i) => (i === index ? { ...b, [part]: minute } : b)))
  }

  function add(kind: 'work' | 'break'): void {
    const last = blocks[blocks.length - 1]
    const start = last === undefined ? 9 * 60 : (last.end ?? now ?? last.start)
    const length = kind === 'work' ? 60 : 30
    const option = breakOptions[0]
    change([
      ...blocks,
      {
        id: null,
        kind,
        start,
        end: Math.min(24 * 60, start + length),
        breakConfigurationId: kind === 'break' ? (option?.id ?? null) : null,
        breakName: kind === 'break' ? (option?.name ?? null) : null,
        locationType: null,
      },
    ])
  }

  async function save(): Promise<void> {
    setSaving(true)
    try {
      const result = await window.factorial.saveTimesheetDay({ date: day.date, blocks })
      // The day, not the edit: nothing was changed, only asked for. Drawing the
      // requested times would show something the timesheet does not hold.
      onSaved(result.day)
      if (result.requested === 0) toast.info(t('timesheet.noChanges'))
      else toast.success(t('timesheet.saved'))
    } catch (error) {
      toast.error(t('timesheet.saveFailed', { reason: describeActionError(t, error) }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="app-editor flex flex-col gap-[18px] px-5 py-5" data-slot="day-editor">
      <Timeline blocks={blocks} ghosts={ghosts} now={now} onChange={change} disabled={saving} nowLabel={t('timesheet.now')} />

      <div className="flex flex-col gap-2">
        {blocks.map((block, index) => (
          <div key={block.id ?? `new-${index}`} className="flex items-center gap-3 rounded-[10px] px-2.5 py-2 text-sm" style={{ background: 'var(--app-fill)' }} data-slot="block-row">
            {block.kind === 'break' && breakOptions.length > 1 ? (
              // The chip is the picker: the type opens the platform's menu,
              // and the row keeps its columns whatever the type is called.
              <MenuButton
                className="app-btn-sm w-[160px] shrink-0 justify-start"
                leading={<span className="app-dot app-dot-break" />}
                disabled={saving}
                value={block.breakConfigurationId ?? ''}
                options={breakOptions.map((o) => ({ value: o.id, label: o.name }))}
                onChange={(id) => {
                  const option = breakOptions.find((o) => o.id === id)
                  change(
                    blocks.map((b, i) =>
                      i === index ? { ...b, breakConfigurationId: option?.id ?? null, breakName: option?.name ?? null } : b,
                    ),
                  )
                }}
              />
            ) : (
              <span className="app-chip w-[160px] shrink-0">
                <span className={`app-dot ${block.kind === 'work' ? 'app-dot-work' : 'app-dot-break'}`} />
                <span className="truncate">{block.kind === 'work' ? t('timesheet.work') : (block.breakName ?? t('timesheet.break'))}</span>
              </span>
            )}
            <TimeField label={t('timesheet.from')} value={block.start} disabled={saving} onCommit={(v) => setTime(index, 'start', v)} />
            <TimeField
              label={t('timesheet.to')}
              value={block.end}
              disabled={saving || block.end === null}
              placeholder={block.end === null ? t('timesheet.running') : undefined}
              onCommit={(v) => setTime(index, 'end', v)}
            />
            <span className="app-muted w-16 text-right text-[13px]" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {formatHours((block.end ?? now ?? block.start) - block.start)}
            </span>
            <span className="flex-1" />
            {block.end !== null && (
              <button type="button" className="app-btn app-btn-ghost app-btn-icon" aria-label={t('timesheet.remove')} disabled={saving} onClick={() => change(blocks.filter((_, i) => i !== index))}>
                <Trash2Icon />
              </button>
            )}
          </div>
        ))}
        {blocks.some((b) => b.end === null) && <div className="app-faint text-xs">{t('timesheet.runningHint')}</div>}
      </div>

      {day.requests.length > 0 && (
        <div className="flex flex-col gap-2" data-slot="pending">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase" style={{ letterSpacing: '0.06em', color: 'var(--app-pending)' }}>
            <span className="app-dot app-dot-pending" style={{ borderRadius: 999 }} />
            {t('timesheet.pendingTitle')}
          </div>
          {day.requests.map((request) => {
            const target = day.blocks.find((b) => b.id === request.shiftId) ?? null
            const isBreak = request.workable === false || request.breakConfigurationId !== null || target?.kind === 'break'
            const breakName = breakOptions.find((o) => o.id === (request.breakConfigurationId ?? target?.breakConfigurationId))?.name ?? target?.breakName ?? null
            const before = target === null ? t('timesheet.pendingNew') : span(target.start, target.end)
            const after = request.requestType === 'delete_shift' ? t('timesheet.pendingDelete') : span(request.start, request.end)
            return (
              <div
                key={request.id}
                className="flex items-center gap-3 rounded-[10px] px-2.5 py-2 text-sm"
                style={{ background: 'var(--app-pending-soft)', border: '1px dashed color-mix(in oklch, var(--app-pending) 45%, transparent)' }}
                data-slot="pending-row"
              >
                <span className="app-chip w-[160px] shrink-0">
                  <span className={`app-dot ${isBreak ? 'app-dot-break' : 'app-dot-work'}`} />
                  <span className="truncate">{isBreak ? (breakName ?? t('timesheet.break')) : t('timesheet.work')}</span>
                </span>
                <span className="app-muted" style={{ fontVariantNumeric: 'tabular-nums', textDecoration: target === null ? undefined : 'line-through' }}>
                  {before}
                </span>
                <ArrowRightIcon className="size-3.5 shrink-0" style={{ color: 'var(--app-pending)' }} />
                <span className="font-semibold" style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--app-pending)' }}>
                  {after}
                </span>
                <span className="flex-1" />
                <button type="button" className="app-btn app-btn-ghost app-btn-sm" disabled={saving} onClick={() => void withdraw(request)}>
                  {t('timesheet.withdraw')}
                </button>
              </div>
            )
          })}
        </div>
      )}

      <div className="flex items-center gap-2.5">
        <button type="button" className="app-btn app-btn-secondary" disabled={saving} onClick={() => add('work')}>
          + {t('timesheet.work')}
        </button>
        <button type="button" className="app-btn app-btn-secondary" disabled={saving || breakOptions.length === 0} onClick={() => add('break')}>
          + {t('timesheet.break')}
        </button>
        <span className="flex-1" />
        <span className="app-muted text-[13px]" style={{ fontVariantNumeric: 'tabular-nums' }} data-slot="sums">
          {t('overview.worked')} <strong className="font-semibold" style={{ color: 'var(--app-text)' }}>{formatHours(worked)}</strong>
          {day.expectedMinutes !== null && day.expectedMinutes > 0 ? ` / ${formatHours(day.expectedMinutes)}` : ''}
          {breaks > 0 ? ` · ${t('overview.breaks')} ${formatHours(breaks)}` : ''}
        </span>
        <button type="button" className="app-btn app-btn-ghost" disabled={!dirty || saving} onClick={() => setBlocks(day.blocks)}>
          {t('timesheet.discard')}
        </button>
        <button type="button" className="app-btn app-btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
          {t('timesheet.save')}
        </button>
      </div>

      {/* Shown while there is something to send, which is when it matters: the
          times snap back after the request, and unexplained that looks broken. */}
      {dirty && <div className="app-faint text-xs">{t('timesheet.pendingHint')}</div>}
    </div>
  )
}

/**
 * A time as text, committed on blur or Enter rather than per keystroke: a
 * half-typed "1" must not move a block to 01:00 on the way to 13:00.
 */
function TimeField({
  label,
  value,
  disabled,
  placeholder,
  onCommit,
}: {
  label: string
  value: number | null
  disabled: boolean
  placeholder?: string | undefined
  onCommit: (text: string) => void
}): React.JSX.Element {
  const shown = value === null ? '' : formatMinuteOfDay(value)
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  return (
    <label className="flex items-center gap-1.5">
      <span className="app-faint text-xs">{label}</span>
      <input
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        inputMode="numeric"
        onChange={(event) => setText(event.target.value)}
        onBlur={() => onCommit(text)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onCommit(text)
        }}
        className="app-input w-16 text-center"
      />
    </label>
  )
}

/** `13:12 – 18:07`, or an open end as `…`. */
function span(start: number | null, end: number | null): string {
  if (start === null) return '…'
  return `${formatMinuteOfDay(start)} – ${end === null ? '…' : formatMinuteOfDay(end)}`
}

/**
 * The strip's overlay for a day's pending requests. A move or an addition is
 * drawn where it was asked to be; a deletion is drawn over the record it
 * would remove, since the request itself carries no times.
 */
export function ghostsOf(day: TimesheetDay, newLabel: string): TimelineGhost[] {
  const out: TimelineGhost[] = []
  for (const request of day.requests) {
    if (request.requestType === 'delete_shift') {
      const target = day.blocks.find((b) => b.id === request.shiftId)
      if (target === undefined || target.end === null) continue
      out.push({ id: request.id, kind: 'delete', start: target.start, end: target.end, label: span(target.start, target.end) })
      continue
    }
    if (request.start === null || request.end === null) continue
    const label = request.requestType === 'create_shift' ? `${newLabel} ${span(request.start, request.end)}` : span(request.start, request.end)
    out.push({ id: request.id, kind: 'change', start: request.start, end: request.end, label })
  }
  return out
}
