import { describe, it, expect } from 'vitest'
import { stripElectronToken } from '@shared/user-agent'

/** The real string, read from `session.getUserAgent()` on Electron 43.4.0. */
const REAL =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.224 Electron/43.4.0 Safari/537.36'

describe('stripElectronToken', () => {
  it('removes the Electron build token and nothing else', () => {
    expect(stripElectronToken(REAL)).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.224 Safari/537.36',
    )
  })

  it('leaves the Chrome version intact — it is a real version and must stay', () => {
    expect(stripElectronToken(REAL)).toContain('Chrome/150.0.7871.224')
  })

  it('collapses no other whitespace, so the result stays a single well-formed line', () => {
    const result = stripElectronToken(REAL)
    expect(result).not.toMatch(/\s{2,}/)
    expect(result.trim()).toBe(result)
  })

  it('is a no-op on a string that never carried the token', () => {
    const chrome =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
    expect(stripElectronToken(chrome)).toBe(chrome)
  })

  it('is idempotent, so applying it to an already-cleaned session changes nothing', () => {
    const once = stripElectronToken(REAL)
    expect(stripElectronToken(once)).toBe(once)
  })

  it('survives a future Electron whose version format differs', () => {
    const future = 'Chrome/999.0.0.0 Electron/44.0.0-beta.3 Safari/537.36'
    expect(stripElectronToken(future)).toBe('Chrome/999.0.0.0 Safari/537.36')
  })
})
