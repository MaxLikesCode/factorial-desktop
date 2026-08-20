/**
 * The day as a row of segments, and what that row draws as.
 *
 * A break is a shift record of its own, so a day arrives as an ordered sequence
 * of work and break records rather than one span with holes in it. Drawing that
 * sequence is what makes a break visible at all: on the progress bar's own axis —
 * worked time against the day's goal — a break has no width, because it is
 * exactly the time that axis does not count.
 *
 * Only lengths and order matter here, never clock times. Two records that follow
 * each other with a gap between them (clocked out and back in without taking a
 * break) draw as touching, which is deliberate: the widget is answering "how
 * much have I worked and how much have I paused", not reconstructing a
 * timesheet.
 */

export type SegmentKind = 'work' | 'break'

export interface DaySegment {
  kind: SegmentKind
  /** The record's own length. Fractional while a segment is still running. */
  minutes: number
}

export interface BarPart {
  /** `rest` is the part of the day still ahead — the goal not yet reached. */
  kind: SegmentKind | 'rest'
  /** Share of the whole bar, 0..100. */
  percent: number
}

export function breakMinutes(segments: readonly DaySegment[]): number {
  return segments.reduce((total, s) => (s.kind === 'break' ? total + s.minutes : total), 0)
}

export function workedMinutes(segments: readonly DaySegment[]): number {
  return segments.reduce((total, s) => (s.kind === 'work' ? total + s.minutes : total), 0)
}

/**
 * What the bar spans, in minutes.
 *
 * The earliest possible end of the day: the goal, plus every break taken, since
 * a break pushes the finish back by its own length. Once the day runs past that
 * — overtime, or a goal already met — the span is simply everything that has
 * happened, so the bar fills and stops rather than overflowing.
 *
 * A consequence worth knowing before reading the bar: taking a longer break
 * stretches the whole thing, because it genuinely does move the finish line.
 */
function spanMinutes(segments: readonly DaySegment[], targetMinutes: number): number {
  const elapsed = segments.reduce((total, s) => total + s.minutes, 0)
  return Math.max(targetMinutes + breakMinutes(segments), elapsed)
}

/**
 * The day as bar parts, in order, ending with whatever is still ahead.
 *
 * Returns an empty list when there is nothing to draw — no goal, or a day with
 * no records yet. An empty bar is not neutral: it would claim "0 % of
 * something", and on a day without a goal there is no something. Same rule the
 * timer follows when it shows a dash instead of a fabricated 0:00:00.
 *
 * Zero-length segments are dropped. They are real — a break started and ended
 * within the same minute — but a part with no width still costs a seam in the
 * bar, and a seam that marks nothing is worse than a break too short to see.
 */
export function buildDayBar(
  segments: readonly DaySegment[],
  targetMinutes: number | null,
): BarPart[] {
  if (targetMinutes === null || targetMinutes <= 0) return []

  const drawable = segments.filter((s) => s.minutes > 0)
  if (drawable.length === 0) return []

  const span = spanMinutes(drawable, targetMinutes)
  if (span <= 0) return []

  const parts: BarPart[] = drawable.map((s) => ({
    kind: s.kind,
    percent: (s.minutes / span) * 100,
  }))

  // Whatever is left of the span. Guarded against the rounding that a sum of
  // divisions can leave behind, which would otherwise draw a hairline of "rest"
  // on a day that is fully accounted for.
  const used = parts.reduce((total, p) => total + p.percent, 0)
  const rest = 100 - used
  if (rest > 0.01) parts.push({ kind: 'rest', percent: rest })

  return parts
}
