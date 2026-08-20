import { describe, expect, it } from 'vitest'
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  capabilityFor,
  installKind,
  mayRestart,
  shouldOffer,
} from '../update-policy'

/**
 * The awkward cases of updating, checked here because they are unreachable from
 * the machine the code is written on: a portable build only exists on Windows,
 * and a running shift only exists against a real account. Every input is an
 * argument for exactly that reason — see the note at the top of the module.
 */

describe('installKind', () => {
  it('is development for anything not packaged', () => {
    expect(installKind({ packaged: false })).toBe('development')
    // Even with the variable set: an unpacked build is a dev build first.
    expect(installKind({ packaged: false, portableExecutable: 'D:\\x.exe' })).toBe('development')
  })

  it('is installed when nothing says portable', () => {
    expect(installKind({ packaged: true })).toBe('installed')
    expect(installKind({ packaged: true, portableExecutable: undefined })).toBe('installed')
    // An empty string is what an unset environment variable can arrive as, and
    // it must not read as "portable" — that would disable updates for every
    // installed copy.
    expect(installKind({ packaged: true, portableExecutable: '' })).toBe('installed')
  })

  it('is portable when the launcher named the real file', () => {
    expect(installKind({ packaged: true, portableExecutable: 'D:\\Tools\\App.exe' })).toBe(
      'portable',
    )
  })
})

describe('capabilityFor', () => {
  it('lets an installed build check and install', () => {
    expect(capabilityFor('installed')).toEqual({ check: true, install: true })
  })

  /**
   * The portable build unpacks to %TEMP% and runs from there, so there is
   * nothing it could replace: the file the user keeps is elsewhere, and
   * overwriting the unpacked copy updates nothing. Checking still earns its
   * keep — it can say a version exists and open the download page.
   */
  it('lets a portable build check but not install', () => {
    expect(capabilityFor('portable')).toEqual({ check: true, install: false })
  })

  it('does neither in development', () => {
    expect(capabilityFor('development')).toEqual({ check: false, install: false })
  })
})

describe('mayRestart', () => {
  /**
   * The rule the whole feature is built around: never restart out from under a
   * running shift. A stopped timer nobody is watching is the expensive failure
   * this app exists to avoid.
   */
  it('refuses while a shift or a break is running', () => {
    expect(mayRestart('in')).toBe(false)
    expect(mayRestart('break')).toBe(false)
  })

  it('allows it when nothing is running', () => {
    expect(mayRestart('out')).toBe(true)
    expect(mayRestart('unauthenticated')).toBe(true)
  })

  /**
   * `unknown` is "the app has not read the state yet", which is not the same as
   * "nobody is clocked in" — and the difference is exactly the case where
   * guessing wrong costs somebody their afternoon.
   */
  it('treats an unknown state as if a shift were running', () => {
    expect(mayRestart('unknown')).toBe(false)
    expect(mayRestart('')).toBe(false)
    expect(mayRestart('something-new')).toBe(false)
  })
})

describe('shouldOffer', () => {
  it('offers a version nobody has declined', () => {
    expect(shouldOffer('1.2.0', null)).toBe(true)
  })

  it('does not ask twice about the same version', () => {
    expect(shouldOffer('1.2.0', '1.2.0')).toBe(false)
  })

  it('asks again once a different version appears', () => {
    expect(shouldOffer('1.3.0', '1.2.0')).toBe(true)
  })
})

describe('timing', () => {
  it('waits before the first check and then spaces them out', () => {
    // Not asserted as exact numbers — the point is the relationship. A first
    // check that fires immediately competes with the first attendance read; an
    // interval shorter than the delay would be a busy loop by accident.
    expect(FIRST_CHECK_DELAY_MS).toBeGreaterThan(5_000)
    expect(CHECK_INTERVAL_MS).toBeGreaterThan(FIRST_CHECK_DELAY_MS)
    expect(CHECK_INTERVAL_MS).toBeGreaterThanOrEqual(60 * 60 * 1000)
  })
})
