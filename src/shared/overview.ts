/**
 * What the overview's widgets show beyond the clock: the cards Factorial's own
 * profile page has (`app.factorialhr.com/profile`), read the same way the
 * web app reads them (docs/api-discovery.md, "The profile widgets").
 *
 * Plain data only — this crosses IPC. Dates are `YYYY-MM-DD` strings, never
 * `Date`s, for the same reason `AppSnapshot` serialises its one instant.
 */

/** One absence from today on: a holiday, a sick leave, anything `timeoff` books. */
export interface UpcomingLeave {
  id: string
  /** Both ends inclusive. */
  startOn: string
  finishOn: string
  /** null is still waiting for a manager, true is approved; false never comes back from the query. */
  approved: boolean | null
  /** Factorial's translated name of the leave type — "Urlaub", "Krankheit". */
  name: string
  /** A hex colour without the `#`, as Factorial stores it, or null. */
  color: string | null
  /** Working days it covers, when Factorial says; null when it did not. */
  days: number | null
}

/** The month so far, as the profile's "Stundenzettel" card counts it. */
export interface MonthInsight {
  /** The month's first and last day. */
  startOn: string
  endOn: string
  /**
   * Minutes worked this month — `attendanceAggregatedWorkedTime.minutes`,
   * which is Factorial's own sum and includes today's closed records.
   */
  workedMinutes: number
  /** The sum of the days' targets up to and including today. */
  expectedToDate: number
  /** The sum of the days' targets over the whole month. */
  expectedTotal: number
  /**
   * Days Factorial flags as needing attention — a missing clock-out, a shift
   * on a day off. null when the count could not be read.
   */
  pendingInconsistencies: number | null
}

export interface OverviewInsights {
  leaves: UpcomingLeave[]
  month: MonthInsight
}
