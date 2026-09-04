import { useEffect, useState } from 'react'
import { Trash2Icon } from 'lucide-react'
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
  type TimesheetBlock,
  type TimesheetDay,
} from '@shared/timesheet'
import { useTranslate } from '@renderer/hooks/useTranslate'
import { describeActionError } from '@renderer/lib/errors'
import { MenuButton } from './MenuButton'
import { Timeline } from './Timeline'

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
      const saved = await window.factorial.saveTimesheetDay({ date: day.date, blocks })
      onSaved(saved)
      toast.success(t('timesheet.saved'))
    } catch (error) {
      toast.error(t('timesheet.saveFailed', { reason: describeActionError(t, error) }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="app-editor flex flex-col gap-[18px] px-5 py-5" data-slot="day-editor">
      <Timeline blocks={blocks} now={now} onChange={change} disabled={saving} nowLabel={t('timesheet.now')} />

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
