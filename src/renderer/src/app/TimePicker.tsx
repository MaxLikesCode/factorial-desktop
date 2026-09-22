import { useEffect, useRef, useState } from 'react'
import { Popover } from '@base-ui/react/popover'
import { Clock3Icon, ChevronDownIcon } from 'lucide-react'
import { useTranslate } from '@renderer/hooks/useTranslate'

const pad = (n: number) => String(n).padStart(2, '0')

/** A single control for a precise local time or an inactive reminder. */
export function TimePicker({ value, onChange, label }: {
  value: string | null
  onChange: (value: string | null) => void
  label: string
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value ?? '12:30')
  const [hours, minutes] = draft.split(':')
  function commit(next: string | null): void {
    if (next !== value) onChange(next)
    setOpen(false)
  }
  return (
    <Popover.Root open={open} onOpenChange={(next) => {
      if (next) setDraft(value ?? '12:30')
      setOpen(next)
    }}>
      <Popover.Trigger className="app-btn app-btn-secondary no-drag min-w-[122px]" aria-label={`${label}: ${value ?? t('settingsPage.off')}`}>
        <Clock3Icon />
        <span className="tabular-nums">{value ?? t('settingsPage.off')}</span>
        <ChevronDownIcon className="app-faint ml-auto" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end" collisionPadding={38} className="z-[1000] no-drag">
          <Popover.Popup className="app-menu app-time-picker" aria-label={label}>
            <Popover.Title className="px-2 pb-3 text-sm font-semibold">{t('timePicker.title')}</Popover.Title>
            <div className="flex gap-2">
              <TimeColumn label={t('timePicker.hour')} count={24} value={Number(hours)} onChange={(h) => setDraft(`${pad(h)}:${minutes}`)} />
              <span className="app-muted self-center text-xl">:</span>
              <TimeColumn label={t('timePicker.minute')} count={60} value={Number(minutes)} onChange={(m) => setDraft(`${hours}:${pad(m)}`)} />
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <button type="button" className="app-btn app-btn-ghost" onClick={() => commit(null)}>{t('settingsPage.off')}</button>
              <button type="button" className="app-btn app-btn-primary" onClick={() => commit(draft)}>{t('timePicker.apply')}</button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function TimeColumn({ label, count, value, onChange }: {
  label: string; count: number; value: number; onChange: (value: number) => void
}): React.JSX.Element {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const selected = list.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (selected && list.current) list.current.scrollTop = selected.offsetTop - (list.current.clientHeight - selected.offsetHeight) / 2
  }, [value])
  return (
    <div className="min-w-0 flex-1">
      <div className="app-muted mb-2 text-center text-xs">{label}</div>
      <div ref={list} role="listbox" aria-label={label} className="app-time-column">
        {Array.from({ length: count }, (_, n) => (
          <button key={n} type="button" role="option" aria-selected={value === n} tabIndex={value === n ? 0 : -1}
            className="app-menu-item justify-center tabular-nums" onClick={() => onChange(n)}
            onKeyDown={(event) => {
              const next = event.key === 'ArrowDown' ? (n + 1) % count : event.key === 'ArrowUp' ? (n + count - 1) % count : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : null
              if (next === null) return
              event.preventDefault()
              onChange(next)
              list.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
            }}>
            {pad(n)}
          </button>
        ))}
      </div>
    </div>
  )
}
