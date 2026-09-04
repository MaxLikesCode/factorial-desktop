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
import { Button } from '@renderer/components/ui/button'
import { describeActionError } from '@renderer/lib/errors'
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
    <div className="flex flex-col gap-5 border-t bg-muted/20 px-5 py-5" data-slot="day-editor">
      <Timeline blocks={blocks} now={now} onChange={change} disabled={saving} />

      <div className="flex flex-col gap-2">
        {blocks.map((block, index) => (
          <div key={block.id ?? `new-${index}`} className="flex items-center gap-3 text-sm" data-slot="block-row">
            <span
              className={`w-20 shrink-0 rounded-md px-2 py-0.5 text-center text-xs font-medium ${
                block.kind === 'work' ? 'bg-primary text-primary-foreground' : 'bg-primary/15 text-foreground'
              }`}
            >
              {block.kind === 'work'
                ? t('timesheet.work')
                : breakOptions.length > 1
                  ? t('timesheet.break')
                  : (block.breakName ?? t('timesheet.break'))}
            </span>
            {block.kind === 'break' && breakOptions.length > 1 && (
              <select
                value={block.breakConfigurationId ?? ''}
                onChange={(event) => {
                  const option = breakOptions.find((o) => o.id === event.target.value)
                  change(
                    blocks.map((b, i) =>
                      i === index ? { ...b, breakConfigurationId: option?.id ?? null, breakName: option?.name ?? null } : b,
                    ),
                  )
                }}
                className="h-7 rounded-md border bg-background px-1.5 text-xs"
              >
                {breakOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            )}
            <TimeField label={t('timesheet.from')} value={block.start} disabled={saving} onCommit={(v) => setTime(index, 'start', v)} />
            <TimeField
              label={t('timesheet.to')}
              value={block.end}
              disabled={saving || block.end === null}
              placeholder={block.end === null ? t('timesheet.running') : undefined}
              onCommit={(v) => setTime(index, 'end', v)}
            />
            <span className="w-16 text-right tabular-nums text-muted-foreground">
              {formatHours((block.end ?? now ?? block.start) - block.start)}
            </span>
            <span className="flex-1" />
            {block.end !== null && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('timesheet.remove')}
                disabled={saving}
                onClick={() => change(blocks.filter((_, i) => i !== index))}
              >
                <Trash2Icon />
              </Button>
            )}
          </div>
        ))}
        {blocks.some((b) => b.end === null) && (
          <div className="text-xs text-muted-foreground">{t('timesheet.runningHint')}</div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled={saving} onClick={() => add('work')}>
          {t('timesheet.addWork')}
        </Button>
        <Button variant="secondary" size="sm" disabled={saving || breakOptions.length === 0} onClick={() => add('break')}>
          {t('timesheet.addBreak')}
        </Button>
        <span className="flex-1" />
        <span className="text-sm tabular-nums text-muted-foreground" data-slot="sums">
          {t('overview.worked')} <strong className="text-foreground">{formatHours(worked)}</strong>
          {day.expectedMinutes !== null && day.expectedMinutes > 0 ? ` / ${formatHours(day.expectedMinutes)}` : ''}
          {breaks > 0 ? ` · ${t('overview.breaks')} ${formatHours(breaks)}` : ''}
        </span>
        <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => setBlocks(day.blocks)}>
          {t('timesheet.discard')}
        </Button>
        <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
          {t('timesheet.save')}
        </Button>
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
      <span className="text-xs text-muted-foreground">{label}</span>
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
        className="h-7 w-16 rounded-md border bg-background px-2 text-center text-sm tabular-nums outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
      />
    </label>
  )
}
