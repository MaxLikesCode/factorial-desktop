import { describe, expect, it, vi } from 'vitest'
import { createOverview, sumExpected, type OverviewOperations } from '../overview'

/** 5 September 2026, a Saturday, mid-month. */
const now = () => new Date(2026, 8, 5, 10, 0, 0)

function fakeOps(over: Partial<OverviewOperations> = {}): OverviewOperations {
  return {
    fetchUpcomingLeaves: vi.fn(async () => []),
    fetchMonthWorkedTime: vi.fn(async () => ({ minutes: 1856, pendingInconsistencies: 0 })),
    fetchExpectedMinutesByDay: vi.fn(async () => new Map<string, number | null>()),
    ...over,
  }
}

describe('sumExpected', () => {
  it('splits the month’s targets at today, today included', () => {
    const expected = new Map<string, number | null>([
      ['2026-09-04', 480],
      ['2026-09-05', 480],
      ['2026-09-06', null],
      ['2026-09-07', 480],
    ])
    expect(sumExpected(['2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07'], expected, '2026-09-05')).toEqual({
      toDate: 960,
      total: 1440,
    })
  })

  it('treats a day the API omitted as no target', () => {
    expect(sumExpected(['2026-09-04', '2026-09-05'], new Map(), '2026-09-05')).toEqual({ toDate: 0, total: 0 })
  })
})

describe('createOverview', () => {
  it('reads the leaves from today and the month from its first day to its last', async () => {
    const ops = fakeOps()
    await createOverview({ ops, employeeId: 1111111, now }).getInsights()

    expect(ops.fetchUpcomingLeaves).toHaveBeenCalledWith(1111111, '2026-09-05')
    expect(ops.fetchMonthWorkedTime).toHaveBeenCalledWith(1111111, '2026-09-01', '2026-09-30')
    expect(ops.fetchExpectedMinutesByDay).toHaveBeenCalledWith(1111111, '2026-09-01', '2026-09-30')
  })

  it('hands the month on with its targets summed to date and in total', async () => {
    const expected = new Map<string, number | null>()
    for (const day of ['01', '02', '03', '04', '07', '08']) expected.set(`2026-09-${day}`, 480)
    const ops = fakeOps({
      fetchExpectedMinutesByDay: vi.fn(async () => expected),
      fetchMonthWorkedTime: vi.fn(async () => ({ minutes: 1856, pendingInconsistencies: 2 })),
    })

    const { month } = await createOverview({ ops, employeeId: 1111111, now }).getInsights()
    expect(month).toEqual({
      startOn: '2026-09-01',
      endOn: '2026-09-30',
      workedMinutes: 1856,
      expectedToDate: 4 * 480,
      expectedTotal: 6 * 480,
      pendingInconsistencies: 2,
    })
  })

  it('passes the leaves through untouched', async () => {
    const leave = { id: '1', startOn: '2026-11-19', finishOn: '2026-11-20', approved: true, name: 'Urlaub', color: '07A2AD', days: 2 }
    const ops = fakeOps({ fetchUpcomingLeaves: vi.fn(async () => [leave]) })
    const { leaves } = await createOverview({ ops, employeeId: 1111111, now }).getInsights()
    expect(leaves).toEqual([leave])
  })

  it('fails as a whole when one read fails — a half-loaded card is not shown as loaded', async () => {
    const ops = fakeOps({ fetchUpcomingLeaves: vi.fn(async () => Promise.reject(new Error('nope'))) })
    await expect(createOverview({ ops, employeeId: 1111111, now }).getInsights()).rejects.toThrow('nope')
  })
})
