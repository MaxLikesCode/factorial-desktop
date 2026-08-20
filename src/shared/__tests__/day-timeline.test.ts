import { describe, expect, it } from 'vitest'
import {
  breakMinutes,
  buildDayBar,
  workedMinutes,
  type DaySegment,
} from '@shared/day-timeline'

const work = (minutes: number): DaySegment => ({ kind: 'work', minutes })
const pause = (minutes: number): DaySegment => ({ kind: 'break', minutes })

/** The reported day: in at 08:00, 33 minutes of break, 7:23 worked of an 8:00 goal. */
const REAL_DAY: DaySegment[] = [work(270), pause(33), work(173)]

describe('summing a day', () => {
  it('counts work and break separately', () => {
    expect(workedMinutes(REAL_DAY)).toBe(443)
    expect(breakMinutes(REAL_DAY)).toBe(33)
  })

  it('has nothing to report for a day with no records', () => {
    expect(workedMinutes([])).toBe(0)
    expect(breakMinutes([])).toBe(0)
  })
})

describe('buildDayBar', () => {
  const percent = (parts: ReturnType<typeof buildDayBar>, index: number): number => {
    const part = parts[index]
    if (part === undefined) throw new Error(`no part at ${index}`)
    return Number(part.percent.toFixed(2))
  }

  it('draws the day in order, breaks included, and fills to 100 %', () => {
    const parts = buildDayBar(REAL_DAY, 480)

    expect(parts.map((p) => p.kind)).toEqual(['work', 'break', 'work', 'rest'])
    // The span is the goal plus the break, because a break moves the finish
    // line: 480 + 33 = 513 minutes.
    expect(percent(parts, 0)).toBe(52.63)
    expect(percent(parts, 1)).toBe(6.43)
    expect(percent(parts, 2)).toBe(33.72)
    expect(percent(parts, 3)).toBe(7.21)
    expect(parts.reduce((t, p) => t + p.percent, 0)).toBeCloseTo(100, 6)
  })

  /**
   * The bar's whole purpose. On the old worked-against-goal axis a break had no
   * width at all, because it is exactly the time that axis does not count.
   */
  it('gives a break real width, unlike the axis it replaced', () => {
    const parts = buildDayBar(REAL_DAY, 480)
    const breakPart = parts.find((p) => p.kind === 'break')
    expect(breakPart?.percent).toBeGreaterThan(5)
  })

  it('fills completely once the day runs past its goal', () => {
    // 9 hours of work against an 8 hour goal, no break.
    const parts = buildDayBar([work(540)], 480)
    expect(parts.map((p) => p.kind)).toEqual(['work'])
    expect(percent(parts, 0)).toBe(100)
  })

  it('never lets the parts add up past the whole bar', () => {
    for (const day of [REAL_DAY, [work(540)], [work(200), pause(60)], [pause(45), work(500)]]) {
      const total = buildDayBar(day, 480).reduce((t, p) => t + p.percent, 0)
      expect(total).toBeLessThanOrEqual(100.001)
    }
  })

  /**
   * Same rule as the timer's dash instead of a fabricated 0:00:00: with no goal
   * there is nothing for the bar to be a fraction of, so it is absent rather
   * than empty. An empty track still claims "0 % of something".
   */
  it('draws nothing when there is no goal, and nothing when there is no day', () => {
    expect(buildDayBar(REAL_DAY, null)).toEqual([])
    expect(buildDayBar(REAL_DAY, 0)).toEqual([])
    expect(buildDayBar([], 480)).toEqual([])
  })

  /**
   * A break that started and ended inside the same minute is real, but a part
   * with no width still costs a seam, and a seam marking nothing is worse than
   * a break too short to see.
   */
  it('drops zero-length records rather than drawing seams for them', () => {
    const parts = buildDayBar([work(270), pause(0), work(173)], 480)
    expect(parts.map((p) => p.kind)).toEqual(['work', 'work', 'rest'])
  })

  it('carries a running break as its own part', () => {
    // Mid-break: 4:30 worked, 12 minutes into lunch.
    const parts = buildDayBar([work(270), pause(12)], 480)
    expect(parts.map((p) => p.kind)).toEqual(['work', 'break', 'rest'])
    expect(breakMinutes([work(270), pause(12)])).toBe(12)
  })
})
