import { describe, it, expect } from 'vitest'

describe('test environment', () => {
  it('runs in Europe/Berlin so local-time maths is reproducible', () => {
    // 12 Aug 2026 is CEST (UTC+2). getTimezoneOffset returns minutes *behind* UTC.
    expect(new Date(2026, 7, 12, 12, 0, 0).getTimezoneOffset()).toBe(-120)
  })

  it('is in CET (UTC+1) in winter', () => {
    expect(new Date(2026, 0, 15, 12, 0, 0).getTimezoneOffset()).toBe(-60)
  })
})
