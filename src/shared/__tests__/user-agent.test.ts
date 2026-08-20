import { describe, it, expect } from 'vitest'
import { toBrowserUserAgent } from '@shared/user-agent'

/** What a standalone Electron session reports (no app name set). */
const BARE =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.224 Electron/43.4.0 Safari/537.36'

/**
 * What the real app reported, read from the debug log. Note the product token:
 * this is the one a first, subtractive fix left behind.
 */
const REAL_APP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) factorial-desktop/0.1.0 Chrome/150.0.7871.224 Safari/537.36'

const EXPECTED =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.224 Safari/537.36'

describe('toBrowserUserAgent', () => {
  it('removes the Electron build token', () => {
    expect(toBrowserUserAgent(BARE)).toBe(EXPECTED)
  })

  it('removes the application name, which only appears in a packaged/real app', () => {
    expect(toBrowserUserAgent(REAL_APP)).toBe(EXPECTED)
    expect(toBrowserUserAgent(REAL_APP)).not.toContain('factorial')
  })

  it('removes both at once', () => {
    const both =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) factorial-desktop/0.1.0 Chrome/150.0.7871.224 Electron/43.4.0 Safari/537.36'
    expect(toBrowserUserAgent(both)).toBe(EXPECTED)
  })

  it('leaves no token that names this project, whatever the app is called', () => {
    const renamed =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Some Other Name/9.9.9 Chrome/150.0.0.0 Electron/43.4.0 Safari/537.36'
    expect(toBrowserUserAgent(renamed)).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    )
  })

  it('keeps the real Chrome version and the real platform', () => {
    const result = toBrowserUserAgent(REAL_APP)
    expect(result).toContain('Chrome/150.0.7871.224')
    expect(result).toContain('Macintosh; Intel Mac OS X 10_15_7')
  })

  it('produces a well-formed single line with no doubled spaces', () => {
    const result = toBrowserUserAgent(REAL_APP)
    expect(result).not.toMatch(/\s{2,}/)
    expect(result.trim()).toBe(result)
  })

  it('is a no-op on a genuine Chrome string', () => {
    const chrome =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
    expect(toBrowserUserAgent(chrome)).toBe(chrome)
  })

  it('is idempotent, so re-applying it to a cleaned session changes nothing', () => {
    const once = toBrowserUserAgent(REAL_APP)
    expect(toBrowserUserAgent(once)).toBe(once)
  })

  it('still strips the Electron token from a string of an unexpected shape', () => {
    // No Mozilla prefix: the rebuild cannot apply, but the fallback must.
    expect(toBrowserUserAgent('Weird/1.0 Electron/43.4.0 Safari/537.36')).toBe(
      'Weird/1.0 Safari/537.36',
    )
  })
})
