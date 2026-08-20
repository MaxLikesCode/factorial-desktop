import { useEffect, useState } from 'react'

interface Props {
  /** 0..1. Out of range or non-finite values are clamped — see `fillWidth`. */
  progress: number
  tone: 'idle' | 'active' | 'paused'
}

const TONE: Record<Props['tone'], string> = {
  idle: 'bg-muted-foreground/40',
  active: 'bg-emerald-500',
  paused: 'bg-amber-500',
}

/**
 * How much of the track is filled.
 *
 * The NaN guard is the same one the ring carried, and for a worse reason: a day
 * target of 0 makes `worked / target` exactly `NaN` (`0/0`), React writes
 * `width: NaN%`, the browser drops the invalid declaration — and a block-level
 * child with no width falls back to `auto`, which is the *full* track. The ring
 * failed that case by disappearing; the bar would fail it by claiming the day
 * was complete. Silent, and the more expensive of the two lies.
 */
function fillWidth(progress: number): string {
  if (Number.isNaN(progress)) return '0%'
  const clamped = Math.min(1, Math.max(0, progress))
  return `${clamped * 100}%`
}

/**
 * The day's progress as a bar across the full width of the card.
 *
 * A bar rather than the ring it replaced: at 320 px it resolves the day about
 * four times finer than an 88 px ring's circumference could, and it leaves the
 * middle of the card free for the timer — which is what the ring never managed
 * (`10:23:45` at a readable size simply does not fit inside a ring this card
 * has room for).
 */
export function ProgressBar({ progress, tone }: Props): React.JSX.Element {
  /**
   * The bar fills itself in, once per launch.
   *
   * A CSS transition does not run on the first render — the element is born at
   * its final value — so the fill would otherwise appear already grown. It
   * starts empty and is handed its real width on the next frame.
   *
   * Deliberately tied to mount and nothing else: the fill must **not** animate
   * on every tick. At an eight-hour target it grows 0.003 % per second,
   * invisible, and this window sits in the corner of someone's eye all day.
   */
  const [drawn, setDrawn] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setDrawn(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        data-slot="progress-bar-fill"
        // `background-color` joins the transition: the tone carries the whole
        // state change (green → amber), and a colour that teleports is the one
        // part of a state change the eye is guaranteed to miss.
        className={`h-full rounded-full transition-[width,background-color] duration-500 ease-(--ease-out) ${TONE[tone]}`}
        style={{ width: drawn ? fillWidth(progress) : '0%' }}
      />
    </div>
  )
}
