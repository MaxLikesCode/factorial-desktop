import { useEffect, useState } from 'react'

interface Props {
  /** 0..1. Out of range or non-finite values are clamped — see `arcOffset`. */
  progress: number
  /** Pre-formatted; this component never derives a time of its own. */
  label: string
  tone: 'idle' | 'active' | 'paused'
}

const TONE: Record<Props['tone'], string> = {
  idle: 'stroke-muted-foreground/40',
  active: 'stroke-emerald-500',
  paused: 'stroke-amber-500',
}

const RADIUS = 46
export const RING_CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * 88 px, not the 96 it started at.
 *
 * The card is 224 px tall and its worst case — clocked out, connection lost and
 * an incomplete day total, so status plus an advisory line plus both action rows
 * — needs every pixel. Eight of them came from here. The ring reads as the
 * subject because it is centred and topmost, not because of its diameter; a
 * work-location select pushed off the bottom edge would have been a real loss,
 * this is not.
 */

/**
 * How much of the circle stays *undrawn*.
 *
 * `Math.min/max` alone would let a NaN through — every comparison with NaN is
 * false, so it would be returned unchanged and `stroke-dashoffset="NaN"` erases
 * the ring silently. A day target of 0 makes `worked / target` exactly that
 * (`0/0`), and Task 13 wires a real, sometimes-zero target in. An infinity needs
 * no special case: `Math.min/max` clamp it like any other out-of-range value.
 */
function arcOffset(progress: number): number {
  if (Number.isNaN(progress)) return RING_CIRCUMFERENCE
  const clamped = Math.min(1, Math.max(0, progress))
  return RING_CIRCUMFERENCE * (1 - clamped)
}

export function ProgressRing({ progress, label, tone }: Props): React.JSX.Element {
  /**
   * The arc draws itself in, once per launch.
   *
   * A CSS transition does not run on the first render — the element is simply
   * born at its final value — so the arc used to appear already complete. It
   * starts empty instead and is handed its real value on the next frame, which
   * gives the transition something to animate from.
   *
   * Deliberately tied to mount and nothing else: the arc must **not** animate on
   * every tick. At an eight-hour target it grows 0.003 % per second, invisible,
   * and this window sits in the corner of someone's eye all day.
   */
  const [drawn, setDrawn] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setDrawn(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <div className="relative grid size-22 shrink-0 place-items-center">
      <svg className="size-22 -rotate-90" viewBox="0 0 112 112" aria-hidden>
        <circle cx="56" cy="56" r={RADIUS} fill="none" strokeWidth="6" className="stroke-muted" />
        <circle
          data-slot="progress-ring-arc"
          cx="56"
          cy="56"
          r={RADIUS}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          // `stroke` joins the transition: the tone carries the whole state
          // change (green → amber), and a colour that teleports is the one part
          // of a state change the eye is guaranteed to miss.
          className={`${TONE[tone]} transition-[stroke-dashoffset,stroke] duration-500 ease-(--ease-out)`}
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={drawn ? arcOffset(progress) : RING_CIRCUMFERENCE}
        />
      </svg>
      <span className="absolute text-lg font-semibold tabular-nums">
        {/*
          Deliberately not larger: at `text-xl` the widest reading — "3:50:57" —
          runs into the stroke on both sides. The ring is the subject here, and a
          number crowding its own frame reads as a mistake, not as emphasis.
        */}
        {label}
      </span>
    </div>
  )
}
