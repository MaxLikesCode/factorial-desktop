import { useEffect, useState } from 'react'
import type { BarPart } from '@shared/day-timeline'

interface Props {
  /** The day in order, from `buildDayBar`. An empty list draws nothing. */
  parts: BarPart[]
  /** Whether the day is running; only decides the colour of the work parts. */
  tone: 'idle' | 'active' | 'paused'
  /** Height utility; the card's density decides how thick the bar is. */
  className?: string
}

const WORK = { idle: 'bg-muted-foreground/40', active: 'bg-emerald-500', paused: 'bg-emerald-500' }

/**
 * The day as a bar: worked stretches, breaks, and whatever is still ahead.
 *
 * It used to be a plain fraction of the day's goal, and on that axis a break has
 * no width at all — it is exactly the time the axis does not count. So a day with
 * a break looked identical to a day without one, which is a problem when the law
 * says you have to take one and the app is the thing you check.
 *
 * The break parts stay amber even while work is running: amber is the app's
 * colour for a break everywhere else, and a break that changed colour once it
 * was over would be a second vocabulary. The work parts follow the day — grey
 * once clocked out, green while it is running.
 */
export function ProgressBar({ parts, tone, className = 'h-1.5' }: Props): React.JSX.Element | null {
  /**
   * The bar fills itself in, once per launch.
   *
   * A CSS transition does not run on the first render — the element is born at
   * its final value — so the fill would otherwise appear already grown. It starts
   * empty and is handed its real widths on the next frame.
   *
   * Deliberately tied to mount and nothing else: the fill must **not** animate on
   * every tick. At an eight-hour target it grows 0.003 % per second, invisible,
   * and this window sits in the corner of someone's eye all day.
   */
  const [drawn, setDrawn] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setDrawn(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  // Absent rather than empty: an empty track claims "0 % of something", and
  // `buildDayBar` returns nothing exactly when there is no something.
  if (parts.length === 0) return null

  return (
    <div className={`${className} flex w-full overflow-hidden rounded-full bg-muted`}>
      {parts.map((part, index) => (
        <div
          // Position is the identity here — the parts have no ids of their own,
          // and a day only ever grows at its end.
          key={index}
          data-slot={`bar-${part.kind}`}
          className={`h-full transition-[width,background-color] duration-500 ease-(--ease-out) ${
            part.kind === 'break'
              ? 'bg-amber-500'
              : part.kind === 'rest'
                ? 'bg-transparent'
                : WORK[tone]
          }`}
          style={{ width: drawn ? `${part.percent}%` : '0%' }}
        />
      ))}
    </div>
  )
}
