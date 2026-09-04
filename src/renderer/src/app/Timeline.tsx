import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { MINUTES_PER_DAY, formatMinuteOfDay, type TimesheetBlock } from '@shared/timesheet'

interface Props {
  blocks: TimesheetBlock[]
  /** Minutes of the day right now, when the day is today; the running block ends here. */
  now: number | null
  onChange: (blocks: TimesheetBlock[]) => void
  disabled?: boolean
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
export function Timeline({ blocks, now, onChange, disabled = false }: Props): React.JSX.Element {
  const track = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ index: number; part: 'start' | 'end' | 'body'; grabOffset: number } | null>(null)

  const [lo, hi] = rangeOf(blocks, now)
  const span = hi - lo

  function minuteAt(clientX: number): number {
    const box = track.current?.getBoundingClientRect()
    if (!box || box.width === 0) return lo
    const ratio = (clientX - box.left) / box.width
    const raw = lo + ratio * span
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
    const minute = minuteAt(event.clientX)

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
    <div className="flex flex-col gap-1.5 select-none">
      <div className="relative h-4 text-[11px] tabular-nums text-muted-foreground">
        {ticks.map((minute) => (
          <span
            key={minute}
            className="absolute -translate-x-1/2"
            style={{ left: `${((minute - lo) / span) * 100}%` }}
          >
            {formatMinuteOfDay(minute).replace(/^0/, '')}
          </span>
        ))}
      </div>
      <div ref={track} className="relative h-10 rounded-lg bg-muted/60" data-slot="timeline">
        {ticks.map((minute) => (
          <span
            key={minute}
            className="absolute top-0 bottom-0 w-px bg-border"
            style={{ left: `${((minute - lo) / span) * 100}%` }}
          />
        ))}
        {now !== null && now >= lo && now <= hi && (
          <span
            className="absolute top-0 bottom-0 w-0.5 bg-destructive"
            style={{ left: `${((now - lo) / span) * 100}%` }}
            data-slot="now"
          />
        )}
        {blocks.map((block, index) => {
          const end = block.end ?? now ?? block.start
          const left = ((block.start - lo) / span) * 100
          const width = Math.max(0, ((end - block.start) / span) * 100)
          const running = block.end === null
          return (
            <div
              key={block.id ?? `new-${index}`}
              className={`tl-block absolute top-1.5 bottom-1.5 rounded-md ${
                block.kind === 'work' ? 'bg-primary' : 'bg-primary/35'
              } ${running ? 'animate-pulse' : ''} ${disabled ? 'opacity-70' : ''}`}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={`${formatMinuteOfDay(block.start)} – ${block.end === null ? '…' : formatMinuteOfDay(block.end)}`}
              data-slot="block"
              data-kind={block.kind}
              onPointerDown={(event) => begin(event, index, 'body')}
              onPointerMove={move}
              onPointerUp={finish}
              onPointerCancel={finish}
            >
              <span
                className="tl-handle absolute top-0 bottom-0 -left-1.5 w-3"
                onPointerDown={(event) => begin(event, index, 'start')}
                onPointerMove={move}
                onPointerUp={finish}
                onPointerCancel={finish}
              />
              {!running && (
                <span
                  className="tl-handle absolute top-0 -right-1.5 bottom-0 w-3"
                  onPointerDown={(event) => begin(event, index, 'end')}
                  onPointerMove={move}
                  onPointerUp={finish}
                  onPointerCancel={finish}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** The hours the strip shows: 06–20 at least, widened to fit the day plus an hour either side. */
export function rangeOf(blocks: readonly TimesheetBlock[], now: number | null): [number, number] {
  let lo = 6 * 60
  let hi = 20 * 60
  for (const block of blocks) {
    lo = Math.min(lo, block.start - 60)
    hi = Math.max(hi, (block.end ?? now ?? block.start) + 60)
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
