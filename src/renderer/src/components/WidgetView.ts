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
  /** Pre-formatted; a card never derives a time of its own. */
  time: string
  /** "Verbleibende Zeit 01:47", "Soll erfüllt · +2:23", or null when there is no goal. */
  goalLine: string | null
  /** 0..1, or null when there is nothing to be a fraction of — then no bar is drawn. */
  progress: number | null
  /** Advisory lines, already joined by the caller's rules. */
  hints: string[]
  /** "Mittagspause · 0:12:31" while a break runs. */
  breakLine: string | null
}
