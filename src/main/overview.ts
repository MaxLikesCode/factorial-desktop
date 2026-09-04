/**
 * The overview's widgets beyond the clock: what Factorial's profile page shows
 * in its "Abwesenheiten" and "Stundenzettel" cards, read on request for the
 * app window.
 *
 * Separate from `attendance.ts` on purpose. The store is about *now* and polls
 * every minute; these numbers change a few times a month and are read when the
 * overview is looked at. Putting them into the snapshot would make every poll
 * three requests heavier for a number nobody is watching.
 */

import { daysOfMonth } from '@shared/timesheet'
import { toLocalDate } from '@shared/time'
import type { MonthInsight, OverviewInsights, UpcomingLeave } from '@shared/overview'
import type { Operations } from './factorial/operations'

export type OverviewOperations = Pick<Operations, 'fetchUpcomingLeaves' | 'fetchMonthWorkedTime' | 'fetchExpectedMinutesByDay'>

export interface OverviewDeps {
  ops: OverviewOperations
  employeeId: number
  /** Injected so tests are deterministic. */
  now?: () => Date
}

export interface Overview {
  getInsights(): Promise<OverviewInsights>
}

/** The month's target so far and in total, from the per-day targets. */
export function sumExpected(
  dates: readonly string[],
  expected: ReadonlyMap<string, number | null>,
  today: string,
): { toDate: number; total: number } {
  let toDate = 0
  let total = 0
  for (const date of dates) {
    const minutes = expected.get(date) ?? 0
    total += minutes
    if (date <= today) toDate += minutes
  }
  return { toDate, total }
}

export function createOverview({ ops, employeeId, now = () => new Date() }: OverviewDeps): Overview {
  return {
    async getInsights(): Promise<OverviewInsights> {
      const current = now()
      const today = toLocalDate(current)
      const dates = daysOfMonth(current.getFullYear(), current.getMonth() + 1)
      const startOn = dates[0] ?? today
      const endOn = dates[dates.length - 1] ?? today

      const [leaves, worked, expected] = await Promise.all([
        ops.fetchUpcomingLeaves(employeeId, today),
        ops.fetchMonthWorkedTime(employeeId, startOn, endOn),
        ops.fetchExpectedMinutesByDay(employeeId, startOn, endOn),
      ])
      const { toDate, total } = sumExpected(dates, expected, today)

      const month: MonthInsight = {
        startOn,
        endOn,
        workedMinutes: worked.minutes,
        expectedToDate: toDate,
        expectedTotal: total,
        pendingInconsistencies: worked.pendingInconsistencies,
      }
      const upcoming: UpcomingLeave[] = leaves
      return { leaves: upcoming, month }
    },
  }
}
