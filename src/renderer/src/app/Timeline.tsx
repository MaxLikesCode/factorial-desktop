import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { MINUTES_PER_DAY, MIN_BLOCK_MINUTES, formatMinuteOfDay, type TimesheetBlock } from '@shared/timesheet'

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

/**
 * The grid a drag lands on, and the finer one it lands on while a modifier is
 * held. Five minutes is what a timesheet is read in; the modifier is there for
 * the rare record that has to match a real minute.
 */
const SNAP = 5
const FINE_SNAP = 1
const MIN_LENGTH = MIN_BLOCK_MINUTES

/** Ctrl (Cmd on macOS) held: drag by the minute instead of by the grid. */
function stepOf(event: { ctrlKey: boolean; metaKey: boolean }): number {
  return event.ctrlKey || event.metaKey ? FINE_SNAP : SNAP
}

/** How much of each end of a block resizes it, and how wide a block has to be drawn to have two of them. */
const GRIP = 12
const MIN_GRAB_WIDTH = 3 * GRIP

/**
 * Which end of a block a press at `offset` pixels into it takes hold of.
 *
 * A third of the width at most, so the two ends can never reach across each
 * other however short the block is: the grips used to be fixed-width boxes
 * that both overflowed a five-minute block, which is why grabbing its right
 * edge took hold of its left one and dragged the other way.
 */
export function grabPart(offset: number, width: number): 'start' | 'end' | 'body' {
  const grip = Math.min(GRIP, width / 3)
  if (offset <= grip) return 'start'
  if (offset >= width - grip) return 'end'
  return 'body'
}

/**
 * The day as a strip: work blocks and break blocks on one line, ends that
 * can be dragged, a body that can be moved.
 *
 * All arithmetic is in minutes of the day and the strip's pixel width; the
 * pointer is read through `setPointerCapture`, so a drag that leaves the
 * strip keeps going and ends with the button. The capture is taken by the
 * strip itself, never by the block or the reach beside it: those are rendered
 * from the very lengths a drag is changing and come and go under the pointer,
 * and an element that unmounts mid-drag takes the capture with it — the drag
 * would stop dead and then, with no pointerup to end it, follow the pointer
 * again with the button already up. A block is clamped between its neighbours
 * while it is dragged, not after — the strip never shows an overlap the save
 * would have to undo.
 *
 * Times snap to absolute five-minute marks, not to five-minute steps from
 * wherever the block happened to start: a break that begins at 11:52 ends at
 * 12:55, not at 12:57. Moving a block snaps its start and carries its length,
 * so a record keeps its duration. Holding Ctrl drags by the minute for the
 * cases where the grid is in the way.
 *
 * A block is grabbed by its ends to resize and anywhere else to move, decided
 * from where the press landed rather than from overlapping handle boxes.
 *
 * A block is always drawn exactly as long as it is, five minutes included — it
 * collapses to a sliver, and the strip stays an honest picture of the day.
 * What a sliver has no room for is an end to take hold of, so the ends move
 * outside it: the empty strip on either side of a short block resizes it, up
 * to a grip's width and never further than the gap, so the reach can neither
 * cover a neighbour nor pull in a direction the block could not go anyway.
 * Left of a block is still its start and right of it is still its end.
 *
 * The running block (the one without an end) is not dragged at all. Factorial
 * does not take a change to a record that has no clock-out yet — `diffDay`
 * drops it — so a handle on it would move something that could never be saved.
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
    // The same array back when nothing widened, not an equal one: React bails
    // out on identity, and a fresh `[lo, hi]` here re-runs this effect for as
    // long as the caller hands in a new `ghosts` list per render.
    setRange((current) =>
      nextLo < current[0] || nextHi > current[1] ? [Math.min(current[0], nextLo), Math.max(current[1], nextHi)] : current,
    )
  }, [blocks, ghosts, now, drag])
  const [lo, hi] = range
  const span = hi - lo
  const pct = (minute: number): string => `${((minute - lo) / span) * 100}%`

  // The strip's own width, because "wide enough to grab" is a number of pixels
  // and everything else here is minutes. Zero until it has been measured, which
  // simply means no block is widened on the first frame.
  const [trackWidth, setTrackWidth] = useState(0)
  useEffect(() => {
    const node = track.current
    if (node === null) return
    setTrackWidth(node.getBoundingClientRect().width)
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver((entries) => setTrackWidth(entries[0]?.contentRect.width ?? 0))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const perMinute = span === 0 ? 0 : trackWidth / span

  /** The minute under the pointer, unrounded. */
  function minuteAt(clientX: number): number {
    const box = track.current?.getBoundingClientRect()
    if (!box || box.width === 0) return lo
    return lo + ((clientX - box.left) / box.width) * span
  }

  /** `part` comes from the reach beside a short block; from the press itself otherwise. */
  function begin(event: ReactPointerEvent<HTMLElement>, index: number, part?: 'start' | 'end'): void {
    if (disabled || event.button !== 0) return
    const block = blocks[index]
    if (block === undefined || block.end === null) return
    const box = event.currentTarget.getBoundingClientRect()
    track.current?.setPointerCapture(event.pointerId)
    setDrag({
      index,
      part: part ?? grabPart(event.clientX - box.left, box.width),
      grabOffset: minuteAt(event.clientX) - block.start,
    })
  }

  /** The cursor says what a press would do, which the grips cannot say themselves: they are only marks. */
  function hover(event: ReactPointerEvent<HTMLElement>, index: number): void {
    if (drag !== null || disabled) return
    const block = blocks[index]
    if (block === undefined || block.end === null) return
    const box = event.currentTarget.getBoundingClientRect()
    event.currentTarget.style.cursor = grabPart(event.clientX - box.left, box.width) === 'body' ? 'grab' : 'ew-resize'
  }

  function move(event: ReactPointerEvent<HTMLElement>): void {
    if (drag === null) return
    const block = blocks[drag.index]
    if (block === undefined) return
    const previous = blocks[drag.index - 1]
    const next = blocks[drag.index + 1]
    const bounds = {
      floor: previous === undefined ? 0 : (previous.end ?? previous.start),
      ceiling: next === undefined ? MINUTES_PER_DAY : next.start,
    }
    // The pointer first, then the grab offset, then the grid: a block moved by
    // its body lands on the grid rather than carrying its old offset along.
    const pointer = clamp(minuteAt(event.clientX), lo, hi)
    const moved = dragTo(block, drag.part, drag.part === 'body' ? pointer - drag.grabOffset : pointer, stepOf(event), bounds)
    if (moved === null || (moved.start === block.start && moved.end === block.end)) return
    onChange(blocks.map((b, i) => (i === drag.index ? { ...b, ...moved } : b)))
  }

  /**
   * Also the answer to a lost capture, not only to the button: whatever ends
   * the gesture, the drag ends with it rather than staying live under a
   * pointer that is no longer pressed.
   */
  function finish(event: ReactPointerEvent<HTMLElement>): void {
    if (drag === null) return
    if (track.current?.hasPointerCapture(event.pointerId) === true) track.current.releasePointerCapture(event.pointerId)
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
      <div
        ref={track}
        className="tl-track"
        data-slot="timeline"
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
      >
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
          // Wide enough to be taken by its own ends, or the ends move out into
          // the empty strip beside it.
          const roomy = !running && length * perMinute >= MIN_GRAB_WIDTH
          const previous = blocks[index - 1]
          const reach =
            roomy || running || perMinute === 0
              ? null
              : {
                  start: reachOf(block.start - (previous === undefined ? lo : (previous.end ?? previous.start)), perMinute),
                  end: reachOf((blocks[index + 1]?.start ?? hi) - end, perMinute),
                }
          return (
            <div key={block.id ?? `new-${index}`} className="contents">
              {reach !== null && reach.start > 0 && (
                <span
                  className="tl-reach"
                  data-slot="reach"
                  data-reach="start"
                  style={{ left: `calc(${pct(block.start)} - ${reach.start}px)`, width: `${reach.start}px` }}
                  onPointerDown={(event) => begin(event, index, 'start')}
                />
              )}
              <div
                className="tl-block"
                data-slot="block"
                data-kind={block.kind}
                data-running={running || undefined}
                style={{ left: pct(block.start), width: `${Math.max(0, (length / span) * 100)}%`, opacity: disabled ? 0.7 : 1 }}
                title={`${formatMinuteOfDay(block.start)} – ${block.end === null ? '…' : formatMinuteOfDay(block.end)}`}
                onPointerDown={(event) => begin(event, index)}
                onPointerMove={(event) => hover(event, index)}
              >
                {/* Marks, not targets: what the press does is decided by where it
                    landed, so two boxes cannot fight over a short block. */}
                {roomy && <span className="tl-handle tl-handle-start" />}
                {length >= 45 && (
                  <span className="pointer-events-none px-3 truncate">
                    {block.kind === 'break' && block.breakName && length >= 120 ? `${block.breakName} · ` : ''}
                    {formatMinuteOfDay(length).replace(/^0/, '')}
                  </span>
                )}
                {roomy && <span className="tl-handle tl-handle-end" />}
              </div>
              {reach !== null && reach.end > 0 && (
                <span
                  className="tl-reach"
                  data-slot="reach"
                  data-reach="end"
                  style={{ left: pct(end), width: `${reach.end}px` }}
                  onPointerDown={(event) => begin(event, index, 'end')}
                />
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

/**
 * Where a drag leaves a block: the minute under the pointer snapped to `step`,
 * then held between the neighbours and kept at least `MIN_LENGTH` long.
 *
 * The snapping is absolute — `Math.round(minute / step)` is the minute of the
 * day, not an offset from wherever the block began — so a break that starts at
 * 11:52 ends at 12:55 and not at 12:57. A block moved by its body keeps its
 * length and snaps where it lands; `minute` is already grab-corrected for
 * that. A running block returns null: it has no end, and Factorial takes no
 * change to a record that is still open.
 */
export function dragTo(
  block: TimesheetBlock,
  part: 'start' | 'end' | 'body',
  minute: number,
  step: number,
  bounds: { floor: number; ceiling: number },
): { start: number; end: number } | null {
  if (block.end === null) return null
  const snapped = Math.round(minute / step) * step
  if (part === 'start') return { start: clamp(snapped, bounds.floor, block.end - MIN_LENGTH), end: block.end }
  if (part === 'end') return { start: block.start, end: clamp(snapped, block.start + MIN_LENGTH, bounds.ceiling) }
  const length = block.end - block.start
  const start = clamp(snapped, bounds.floor, bounds.ceiling - length)
  return { start, end: start + length }
}

/**
 * How far beside a short block its end may be taken hold of, in pixels.
 *
 * A grip's width, but never more than the empty `room` minutes next to it: the
 * reach may not lie over the neighbour, whose own end is there to be dragged,
 * and where there is no gap there is nothing to reach for — a block cannot be
 * pulled into the block beside it in any case. Under a few pixels it is not
 * worth aiming at, and none is offered.
 */
export function reachOf(room: number, perMinute: number): number {
  const pixels = Math.min(GRIP, Math.max(0, room) * perMinute)
  return pixels < 4 ? 0 : Math.round(pixels)
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
