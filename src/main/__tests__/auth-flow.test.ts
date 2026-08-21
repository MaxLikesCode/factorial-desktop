import { describe, it, expect } from 'vitest'
import { FactorialError } from '../factorial/client'
import type { Identity } from '../factorial/types'
import {
  authenticate,
  classifySignInFailure,
  createSessionProbe,
  LOGIN_ABORTED_MESSAGE,
  type LoginWindowHandle,
} from '../auth-flow'

const IDENTITY: Identity = {
  email: 'max@example.test',
  employeeId: 1111111,
  fullName: 'Max Muster',
  companyId: 2222222,
  companyName: 'Beispiel GmbH',
}

const LOGIN_HOST = 'https://id.factorialhr.com'
const APP_HOST = 'https://app.factorialhr.com'

/** The real predicate from `auth.ts`, restated so the flow test is standalone. */
const indicatesSignedIn = (url: string): boolean => {
  try {
    const { host } = new URL(url)
    if (!host || host === new URL(LOGIN_HOST).host) return false
    return host === 'factorialhr.com' || host.endsWith('.factorialhr.com')
  } catch {
    return false
  }
}

/** Stands in for the login BrowserWindow: records closes, fires closed/navigate. */
function fakeLoginWindow(): {
  handle: LoginWindowHandle
  fireClosed: () => void
  navigate: (url: string) => void
  closeCalls: () => number
} {
  const closedListeners: (() => void)[] = []
  const navListeners: ((url: string) => void)[] = []
  let closeCalls = 0
  return {
    handle: {
      onClosed: (listener) => closedListeners.push(listener),
      onNavigate: (listener) => navListeners.push(listener),
      close: () => {
        closeCalls += 1
      },
    },
    fireClosed: () => closedListeners.forEach((listener) => listener()),
    navigate: (url) => navListeners.forEach((listener) => listener(url)),
    closeCalls: () => closeCalls,
  }
}

/** Every probe outcome is scripted, so no test depends on wall-clock timing. */
function scriptedProbe(steps: (Identity | null | Error)[]): {
  probe: () => Promise<Identity | null>
  calls: () => number
} {
  let index = 0
  return {
    calls: () => index,
    probe: async () => {
      const step = steps[Math.min(index, steps.length - 1)]
      index += 1
      if (step instanceof Error) throw step
      return step ?? null
    },
  }
}

/** Lets the promise chain inside a navigation handler run to completion. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('createSessionProbe', () => {
  it('reports the identity when the stored session still works', async () => {
    const probe = createSessionProbe({ fetchMe: async () => IDENTITY })
    await expect(probe()).resolves.toEqual(IDENTITY)
  })

  it('reports a rejected session as "not logged in"', async () => {
    const probe = createSessionProbe({
      fetchMe: async () => {
        throw new FactorialError('unauthenticated', 'session rejected (HTTP 401)')
      },
    })
    await expect(probe()).resolves.toBeNull()
  })

  it('does not mistake a network failure for a logged-out session', async () => {
    // Opening a login window because the Wi-Fi blipped would be a lie about why
    // the app is stuck, and the user cannot fix it by signing in again.
    const probe = createSessionProbe({
      fetchMe: async () => {
        throw new FactorialError('network', 'ECONNREFUSED')
      },
    })
    await expect(probe()).rejects.toMatchObject({ kind: 'network' })
  })

  it('rethrows an error that is not a FactorialError', async () => {
    const probe = createSessionProbe({
      fetchMe: async () => {
        throw new TypeError('boom')
      },
    })
    await expect(probe()).rejects.toBeInstanceOf(TypeError)
  })
})

describe('authenticate', () => {
  it('returns the identity without opening a window when the session is valid', async () => {
    let opened = 0
    const identity = await authenticate({
      probe: async () => IDENTITY,
      openLoginWindow: () => {
        opened += 1
        return fakeLoginWindow().handle
      },
      indicatesSignedIn,
    })

    expect(identity).toEqual(IDENTITY)
    expect(opened).toBe(0)
  })

  it('does not open a login window when the first probe fails for another reason', async () => {
    let opened = 0
    await expect(
      authenticate({
        probe: async () => {
          throw new FactorialError('network', 'ECONNREFUSED')
        },
        openLoginWindow: () => {
          opened += 1
          return fakeLoginWindow().handle
        },
        indicatesSignedIn,
      }),
    ).rejects.toMatchObject({ kind: 'network' })
    expect(opened).toBe(0)
  })

  /**
   * The regression this whole redesign exists for. Polling `Me` through the
   * sign-in made Factorial reject every OTP and every TOTP as invalid.
   */
  it('makes no request at all while the user is still on the login host', async () => {
    const window = fakeLoginWindow()
    const { probe, calls } = scriptedProbe([null])

    const pending = authenticate({ probe, openLoginWindow: () => window.handle, indicatesSignedIn })
    // The first probe runs before the window is opened, so the listeners do not
    // exist until that promise has resolved.
    await settle()

    // The whole sign-in: e-mail, password, the MFA challenge, a failed attempt.
    window.navigate(`${LOGIN_HOST}/login`)
    window.navigate(`${LOGIN_HOST}/login/password`)
    window.navigate(`${LOGIN_HOST}/login/mfa`)
    window.navigate(`${LOGIN_HOST}/login/mfa?error=1`)
    await settle()

    // Exactly the one probe from before the window opened. Nothing since.
    expect(calls()).toBe(1)

    window.fireClosed()
    await expect(pending).rejects.toMatchObject({ kind: 'unauthenticated' })
  })

  it('probes once the window leaves the login host, then closes it', async () => {
    const window = fakeLoginWindow()
    const { probe, calls } = scriptedProbe([null, IDENTITY])

    const pending = authenticate({ probe, openLoginWindow: () => window.handle, indicatesSignedIn })
    // The first probe runs before the window is opened, so the listeners do not
    // exist until that promise has resolved.
    await settle()

    window.navigate(`${LOGIN_HOST}/login/mfa`)
    window.navigate(`${APP_HOST}/dashboard`)

    await expect(pending).resolves.toEqual(IDENTITY)
    // One before the window opened, one for the navigation that left the host.
    expect(calls()).toBe(2)
    expect(window.closeCalls()).toBe(1)
  })

  it('keeps waiting when a navigation away does not yet carry a session', async () => {
    const window = fakeLoginWindow()
    const { probe, calls } = scriptedProbe([null, null, IDENTITY])

    const pending = authenticate({ probe, openLoginWindow: () => window.handle, indicatesSignedIn })
    // The first probe runs before the window is opened, so the listeners do not
    // exist until that promise has resolved.
    await settle()

    window.navigate(`${APP_HOST}/`)
    await settle()
    expect(calls()).toBe(2)

    window.navigate(`${APP_HOST}/dashboard`)
    await expect(pending).resolves.toEqual(IDENTITY)
    expect(window.closeCalls()).toBe(1)
  })

  it('survives a transient failure on one navigation and succeeds on the next', async () => {
    const window = fakeLoginWindow()
    const { probe } = scriptedProbe([null, new FactorialError('network', 'ECONNRESET'), IDENTITY])

    const pending = authenticate({ probe, openLoginWindow: () => window.handle, indicatesSignedIn })
    // The first probe runs before the window is opened, so the listeners do not
    // exist until that promise has resolved.
    await settle()

    window.navigate(`${APP_HOST}/`)
    await settle()
    window.navigate(`${APP_HOST}/dashboard`)

    await expect(pending).resolves.toEqual(IDENTITY)
  })

  it('gives up when the user closes the login window', async () => {
    const window = fakeLoginWindow()
    const { probe } = scriptedProbe([null])

    const pending = authenticate({ probe, openLoginWindow: () => window.handle, indicatesSignedIn })
    // The first probe runs before the window is opened, so the listeners do not
    // exist until that promise has resolved.
    await settle()
    window.fireClosed()

    const failure = await pending.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(FactorialError)
    expect(failure).toMatchObject({ kind: 'unauthenticated', message: LOGIN_ABORTED_MESSAGE })
    // Closing an already-closed window is at best a no-op and at worst a throw.
    expect(window.closeCalls()).toBe(0)
  })

  it('does not sign the user in when the window closes while a probe is in flight', async () => {
    const window = fakeLoginWindow()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const probe = async (): Promise<Identity | null> => {
      calls += 1
      if (calls === 1) return null
      await gate
      return IDENTITY
    }

    const pending = authenticate({ probe, openLoginWindow: () => window.handle, indicatesSignedIn })
    // The first probe runs before the window is opened, so the listeners do not
    // exist until that promise has resolved.
    await settle()
    window.navigate(`${APP_HOST}/dashboard`)
    await settle()

    // The user gives up before the answer arrives.
    window.fireClosed()
    release()

    await expect(pending).rejects.toMatchObject({ kind: 'unauthenticated' })
    // Logging someone in after they walked away is worse than one more click.
    expect(window.closeCalls()).toBe(0)
  })

  it('stays quiet on detours that are not Factorial — SSO hops, about:blank, junk', async () => {
    const window = fakeLoginWindow()
    const { probe, calls } = scriptedProbe([null, IDENTITY])
    const pending = authenticate({ probe, openLoginWindow: () => window.handle, indicatesSignedIn })
    await settle()

    // Each of these would have fired a request under a negative predicate.
    window.navigate('about:blank')
    window.navigate('https://accounts.google.com/o/oauth2/auth')
    window.navigate('not a url at all')
    await settle()
    expect(calls()).toBe(1)

    window.navigate(`${APP_HOST}/dashboard`)
    await expect(pending).resolves.toEqual(IDENTITY)
  })
})

/**
 * The two ways a sign-in can fail after this module has done its job, and why
 * telling them apart matters: one is a decision, the other is weather.
 *
 * Getting it wrong is not theoretical. Startup used to end the app on either,
 * with "Anmeldung nicht möglich" — so a fifteen-second timeout on a network
 * that was fine a minute later produced an app that would not start and a
 * message blaming the session for it.
 */
describe('classifySignInFailure', () => {
  it('treats a closed login window as the user’s decision', () => {
    expect(classifySignInFailure(LOGIN_ABORTED_MESSAGE)).toBe('aborted')
  })

  it('treats a timeout as the server not answering, not as a logout', () => {
    expect(classifySignInFailure('request timed out after 15000 ms')).toBe('unreachable')
  })

  it('says nothing about the session for any other failure either', () => {
    for (const reason of ['fetch failed', 'getaddrinfo ENOTFOUND', 'socket hang up', '']) {
      expect(classifySignInFailure(reason)).toBe('unreachable')
    }
  })
})
