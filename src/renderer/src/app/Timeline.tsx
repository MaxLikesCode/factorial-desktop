import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { MINUTES_PER_DAY, formatMinuteOfDay, type TimesheetBlock } from '@shared/timesheet'

/**
 * A requested change, drawn where it would land. `delete` covers the record
 * that would go; `change` is the range that was asked for, whether it moves a
 * record or adds one.
 */
export interface TimelineGhost {
  id: string
  kind: 'change' | 'delete'
  start: number
  end: number
  label: string
}

interface Props {
  blocks: TimesheetBlock[]
  /** Pending requests, drawn over the blocks and never dragged. */
  ghosts?: TimelineGhost[]
  /** Minutes of the day right now, when the day is today; the running block ends here. */
  now: number | null
  onChange: (blocks: TimesheetBlock[]) => void
  disabled?: boolean
  /** The label under the "now" line. */
  nowLabel: string
}

const SNAP = 5
const MIN_LENGTH = 5

/**
 * The day as a strip: work blocks and break blocks on one line, ends that
 * can be dragged, a body that can be moved.
 *
 * All arithmetic is in minutes of the day and the strip's pixel width; the
 * pointer is read through `setPointerCapture`, so a drag that leaves the
 * strip keeps going and ends with the button. A block is clamped between
 * its neighbours while it is dragged, not after — the strip never shows an
 * overlap the save would have to undo.
 *
 * The running block (the one without an end) ends at "now": it has no right
 * handle and its body only moves its start.
 */
export function Timeline({ blocks, ghosts = [], now, onChange, disabled = false, nowLabel }: Props): React.JSX.Element {
  const track = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ index: number; part: 'start' | 'end' | 'body'; grabOffset: number } | null>(null)

  // The hours shown. Frozen while a drag runs — recomputing per move made the
  // scale jump under the pointer whenever a block crossed an hour — and only
  // ever widened afterwards, so the strip never shifts while the day is edited.
  const [range, setRange] = useState<[number, number]>(() => rangeOf(blocks, now, ghosts))
  useEffect(() => {
    if (drag !== null) return
    const [nextLo, nextHi] = rangeOf(blocks, now, ghosts)
    setRange(([lo, hi]) => (nextLo < lo || nextHi > hi ? [Math.min(lo, nextLo), Math.max(hi, nextHi)] : [lo, hi]))
  }, [blocks, ghosts, now, drag])
  const [lo, hi] = range
  const span = hi - lo
  const pct = (minute: number): string => `${((minute - lo) / span) * 100}%`

  function minuteAt(clientX: number): number {
    const box = track.current?.getBoundingClientRect()
    if (!box || box.width === 0) return lo
    const raw = lo + ((clientX - box.left) / box.width) * span
    return Math.round(raw / SNAP) * SNAP
  }

  function begin(event: ReactPointerEvent<HTMLElement>, index: number, part: 'start' | 'end' | 'body'): void {
    if (disabled || event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const block = blocks[index]
    if (block === undefined) return
    setDrag({ index, part, grabOffset: minuteAt(event.clientX) - block.start })
  }

  function move(event: ReactPointerEvent<HTMLElement>): void {
    if (drag === null) return
    const block = blocks[drag.index]
    if (block === undefined) return
    const previous = blocks[drag.index - 1]
    const next = blocks[drag.index + 1]
    const floor = previous === undefined ? 0 : (previous.end ?? previous.start)
    const ceiling = next === undefined ? MINUTES_PER_DAY : next.start
    const endNow = block.end ?? now ?? block.start
    const minute = clamp(minuteAt(event.clientX), lo, hi)

    let start = block.start
    let end = block.end
    if (drag.part === 'start') {
      start = clamp(minute, floor, endNow - MIN_LENGTH)
    } else if (drag.part === 'end') {
      if (end === null) return
      end = clamp(minute, block.start + MIN_LENGTH, ceiling)
    } else {
      const length = endNow - block.start
      if (end === null) {
        start = clamp(minute - drag.grabOffset, floor, endNow - MIN_LENGTH)
      } else {
        start = clamp(minute - drag.grabOffset, floor, ceiling - length)
        end = start + length
      }
    }
    if (start === block.start && end === block.end) return
    onChange(blocks.map((b, i) => (i === drag.index ? { ...b, start, end } : b)))
  }

  function finish(event: ReactPointerEvent<HTMLElement>): void {
    if (drag === null) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    setDrag(null)
  }

  const ticks = tickMinutes(lo, hi)

  return (
    <div className="flex flex-col gap-1.5 pb-4 select-none">
      <div className="app-faint relative h-4 text-[11px]" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {ticks.map((minute) => (
          <span key={minute} className="absolute -translate-x-1/2" style={{ left: pct(minute) }}>
            {formatMinuteOfDay(minute).replace(/^0/, '')}
          </span>
        ))}
      </div>
      <div ref={track} className="tl-track" data-slot="timeline">
        {ticks
          // The first and last tick sit on the strip's own edge; a line there
          // doubles the border.
          .filter((minute) => minute > lo && minute < hi)
          .map((minute) => (
            <span key={minute} className="absolute inset-y-0 w-px" style={{ left: pct(minute), background: 'var(--app-line)' }} />
          ))}
        {blocks.map((block, index) => {
          const end = block.end ?? now ?? block.start
          const running = block.end === null
          const length = end - block.start
          return (
            <div
              key={block.id ?? `new-${index}`}
              className="tl-block"
              data-slot="block"
              data-kind={block.kind}
              data-running={running || undefined}
              style={{ left: pct(block.start), width: `${Math.max(0, (length / span) * 100)}%`, opacity: disabled ? 0.7 : 1 }}
              title={`${formatMinuteOfDay(block.start)} – ${block.end === null ? '…' : formatMinuteOfDay(block.end)}`}
              onPointerDown={(event) => begin(event, index, 'body')}
              onPointerMove={move}
              onPointerUp={finish}
              onPointerCancel={finish}
            >
              <span className="tl-handle tl-handle-start" onPointerDown={(event) => begin(event, index, 'start')} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} />
              {length >= 45 && (
                <span className="pointer-events-none px-3 truncate">
                  {block.kind === 'break' && block.breakName && length >= 120 ? `${block.breakName} · ` : ''}
                  {formatMinuteOfDay(length).replace(/^0/, '')}
                </span>
              )}
              {!running && (
                <span className="tl-handle tl-handle-end" onPointerDown={(event) => begin(event, index, 'end')} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} />
              )}
            </div>
          )
        })}
        {ghosts.map((ghost) => {
          const length = ghost.end - ghost.start
          return (
            <span
              key={ghost.id}
              className="tl-ghost"
              data-slot="ghost"
              data-ghost={ghost.kind}
              style={{ left: pct(ghost.start), width: `${Math.max(0, (length / span) * 100)}%` }}
              title={`${formatMinuteOfDay(ghost.start)} – ${formatMinuteOfDay(ghost.end)}`}
            >
              {length >= 60 && <span className="truncate px-2">{ghost.label}</span>}
            </span>
          )
        })}
        {now !== null && now >= lo && now <= hi && (
          <>
            <span className="tl-now" style={{ left: pct(now) }} data-slot="now" />
            <span className="tl-now-label" style={{ left: pct(now) }}>
              {nowLabel}
            </span>
          </>
        )}
      </div>
    </div>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** The hours the strip shows: 06–20 at least, widened to fit the day — and what was asked for — plus an hour either side. */
export function rangeOf(blocks: readonly TimesheetBlock[], now: number | null, ghosts: readonly TimelineGhost[] = []): [number, number] {
  let lo = 6 * 60
  let hi = 20 * 60
  for (const block of blocks) {
    lo = Math.min(lo, block.start - 60)
    hi = Math.max(hi, (block.end ?? now ?? block.start) + 60)
  }
  for (const ghost of ghosts) {
    lo = Math.min(lo, ghost.start - 60)
    hi = Math.max(hi, ghost.end + 60)
  }
  lo = Math.max(0, Math.floor(lo / 60) * 60)
  hi = Math.min(MINUTES_PER_DAY, Math.ceil(hi / 60) * 60)
  return [lo, hi]
}

function tickMinutes(lo: number, hi: number): number[] {
  const step = hi - lo > 12 * 60 ? 120 : 60
  const out: number[] = []
  for (let m = Math.ceil(lo / step) * step; m <= hi; m += step) out.push(m)
  return out
}
