import { describe, it, expect } from 'vitest'
import {
  reconstructInstant, formatDuration, formatHoursMinutes,
  toLocalIsoWithOffset, toLocalOffset, toLocalDate,
} from '@shared/time'

describe('reconstructInstant', () => {
  it('rebuilds the real instant from the API’s mismatched date and time parts', () => {
    // Recorded from the live API (AttendanceShift form): clocked in at
    // 2026-08-12 00:11:12 local (+02:00), but the API reports
    // "2026-08-11T00:11:12+00:00" — UTC date glued to local time, mislabelled +00:00.
    const result = reconstructInstant('2026-08-12', '2026-08-11T00:11:12+00:00', '+02:00')
    expect(result.toISOString()).toBe('2026-08-11T22:11:12.000Z')
  })

  it('reconstructs the AttendanceOpenShift form, whose date is the 2000-01-01 sentinel', () => {
    // Verified open shift: { date: '2026-08-12', clockIn: '2000-01-01T01:18:23Z',
    //                        clockInOffset: '+02:00' }
    const result = reconstructInstant('2026-08-12', '2000-01-01T01:18:23Z', '+02:00')
    expect(result.toISOString()).toBe('2026-08-11T23:18:23.000Z')
  })

  it('matches createdAt, the only real UTC instant in the schema', () => {
    // Control record from the live API:
    //   clockInWithSeconds 2026-08-11T09:49:05+00:00, clockInOffset +02:00,
    //   date 2026-08-11, createdAt 2026-08-11T07:49:05Z
    const result = reconstructInstant('2026-08-11', '2026-08-11T09:49:05+00:00', '+02:00')
    expect(result.toISOString()).toBe('2026-08-11T07:49:05.000Z')
  })

  it('uses the offset it is given, not the machine’s zone', () => {
    // Same wall clock, winter offset: one hour further from UTC than the summer case.
    const result = reconstructInstant('2026-01-15', '2026-01-15T09:00:00+00:00', '+01:00')
    expect(result.toISOString()).toBe('2026-01-15T08:00:00.000Z')
  })

  it('handles a negative offset', () => {
    const result = reconstructInstant('2026-08-12', '2000-01-01T09:00:00Z', '-05:00')
    expect(result.toISOString()).toBe('2026-08-12T14:00:00.000Z')
  })

  it('handles the UTC offset without inverting its sign', () => {
    const result = reconstructInstant('2026-08-12', '2000-01-01T09:00:00Z', '+00:00')
    expect(result.toISOString()).toBe('2026-08-12T09:00:00.000Z')
  })

  it('never lands on a different day than the one it was handed', () => {
    // The old "if it looks like the future, subtract a day" heuristic is gone.
    // A 23:30 clock-in on the 12th stays on the 12th, whatever the clock says.
    const result = reconstructInstant('2026-08-12', '2026-08-12T23:30:00+00:00', '+02:00')
    expect(result.toISOString()).toBe('2026-08-12T21:30:00.000Z')
  })

  it('throws on an unparseable timestamp rather than returning a wrong time', () => {
    expect(() => reconstructInstant('2026-08-12', 'nonsense', '+02:00')).toThrow()
  })

  it('throws on an unparseable date', () => {
    expect(() => reconstructInstant('12.08.2026', '2000-01-01T09:00:00Z', '+02:00')).toThrow()
  })

  it('throws on an unparseable offset instead of silently assuming UTC', () => {
    expect(() => reconstructInstant('2026-08-12', '2000-01-01T09:00:00Z', 'CEST')).toThrow()
  })

  // --- Additions beyond the plan's list -------------------------------------
  // The plan's regexes accept syntactically well-formed but impossible values.
  // Date.UTC rolls those over silently, which in a time-tracking app means a
  // wrong hour written into a timesheet. Rejecting is the only safe answer.

  it('rejects an impossible month instead of rolling it into the next year', () => {
    expect(() => reconstructInstant('2026-13-01', '2000-01-01T09:00:00Z', '+02:00')).toThrow()
  })

  it('rejects a day the month does not have instead of rolling into the next month', () => {
    expect(() => reconstructInstant('2026-02-30', '2000-01-01T09:00:00Z', '+02:00')).toThrow()
  })

  it('rejects an impossible hour instead of rolling into the next day', () => {
    expect(() => reconstructInstant('2026-08-12', '2000-01-01T25:00:00Z', '+02:00')).toThrow()
  })

  it('rejects an out-of-range offset', () => {
    expect(() => reconstructInstant('2026-08-12', '2000-01-01T09:00:00Z', '+02:99')).toThrow()
  })

  it('applies the sign to the minutes of a half-hour offset too', () => {
    // Newfoundland-shaped offset: -03:30 must move the instant 3.5h forward, not 2.5h.
    const result = reconstructInstant('2026-08-12', '2000-01-01T09:00:00Z', '-03:30')
    expect(result.toISOString()).toBe('2026-08-12T12:30:00.000Z')
  })

  it('ignores fractional seconds on the API timestamp', () => {
    const result = reconstructInstant('2026-08-11', '2026-08-11T09:49:05.123+00:00', '+02:00')
    expect(result.toISOString()).toBe('2026-08-11T07:49:05.000Z')
  })

  it('accepts the compact offset spelling', () => {
    const result = reconstructInstant('2026-08-12', '2000-01-01T09:00:00Z', '+0200')
    expect(result.toISOString()).toBe('2026-08-12T07:00:00.000Z')
  })
})

describe('formatDuration', () => {
  it('formats hours, minutes and seconds', () => {
    expect(formatDuration(3 * 3600_000 + 7 * 60_000 + 5000)).toBe('3:07:05')
  })
  it('shows a zero hour rather than hiding it', () => {
    expect(formatDuration(65_000)).toBe('0:01:05')
  })
  it('clamps negatives to zero so a clock skew never renders a minus', () => {
    expect(formatDuration(-5000)).toBe('0:00:00')
  })
  it('keeps counting past 24 hours instead of wrapping', () => {
    expect(formatDuration(26 * 3600_000 + 61_000)).toBe('26:01:01')
  })
})

describe('formatHoursMinutes', () => {
  it('pads to two digits', () => {
    expect(formatHoursMinutes(485)).toBe('08:05')
  })
  it('handles zero', () => {
    expect(formatHoursMinutes(0)).toBe('00:00')
  })
  it('clamps negatives so remaining-time never renders a minus', () => {
    expect(formatHoursMinutes(-30)).toBe('00:00')
  })
})

describe('local serialisation for the API', () => {
  it('emits an ISO string carrying the local offset', () => {
    expect(toLocalIsoWithOffset(new Date(2026, 7, 12, 0, 11, 12)))
      .toBe('2026-08-12T00:11:12+02:00')
  })
  it('emits the winter offset in winter', () => {
    expect(toLocalIsoWithOffset(new Date(2026, 0, 15, 9, 0, 0)))
      .toBe('2026-01-15T09:00:00+01:00')
  })
  it('emits the local calendar date', () => {
    expect(toLocalDate(new Date(2026, 7, 12, 0, 11, 12))).toBe('2026-08-12')
  })
  it('emits the bare local offset, in the shape clockInOffset uses', () => {
    // Feeds the optimistic open shift in Task 7, which needs a clockInOffset of
    // its own before the server has answered.
    expect(toLocalOffset(new Date(2026, 7, 12, 0, 11, 12))).toBe('+02:00')
    expect(toLocalOffset(new Date(2026, 0, 15, 9, 0, 0))).toBe('+01:00')
  })
})

describe('round trip', () => {
  it('reconstructs exactly what toLocalIsoWithOffset/toLocalDate/toLocalOffset emitted', () => {
    // What Task 7 does optimistically: serialise `now` for the mutation, then feed
    // the same three parts back in as if they had come from the API.
    const now = new Date(2026, 7, 12, 0, 11, 12)
    const sent = toLocalIsoWithOffset(now)
    const back = reconstructInstant(toLocalDate(now), sent, toLocalOffset(now))
    expect(back.getTime()).toBe(now.getTime())
  })
})
