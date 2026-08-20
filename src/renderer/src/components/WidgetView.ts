import type { BarPart } from '@shared/day-timeline'

/**
 * What the three card layouts are handed.
 *
 * Everything here is already decided: the German label, the pre-formatted times,
 * the clamped progress. The cards are presentational on purpose — the rules
 * about what counts as worked time, when a goal comparison exists and how a
 * rejected action is phrased belong in one place, and that place is
 * `StatusWidget`.
 */
export interface WidgetView {
  /** "Eingestempelt", "In einer Pause", … */
  label: string
  /** Tailwind class for the state dot; the cards never map state to colour. */
  dotClass: string
  tone: 'idle' | 'active' | 'paused'
  /**
   * Pre-formatted; a card never derives a time of its own.
   *
   * While a break runs this is the BREAK's duration, not the day's worked time.
   * The day sum stands still during a break, and a big number that has stopped
   * moving reads as a frozen app rather than as a paused shift — which is
   * exactly how it read. The tray has always shown it this way.
   */
  time: string
  /** "Verbleibende Zeit 01:47", "Soll erfüllt · +2:23", or null when there is no goal. */
  goalLine: string | null
  /**
   * The day in order — worked stretches, breaks, and what is still ahead.
   *
   * Empty when there is nothing to draw: no goal for the day, or no records yet.
   * The bar is then absent rather than empty, for the same reason the timer shows
   * a dash instead of a fabricated 0:00:00.
   */
  bar: BarPart[]
  /** Total break time today, pre-formatted, or null when none has been taken. */
  breakLine: string | null
  /** Advisory lines, already joined by the caller's rules. */
  hints: string[]
}
