import { describe, it, expect } from 'vitest'
import { FactorialError } from '../factorial/client'
import type { Identity } from '../factorial/types'
import { authenticate, createSessionProbe, LOGIN_ABORTED_MESSAGE, type LoginWindowHandle } from '../auth-flow'

const IDENTITY: Identity = {
  email: 'max@example.test',
  employeeId: 1111111,
  fullName: 'Max Muster',
  companyId: 2222222,
  companyName: 'Beispiel GmbH',
}

/** Stands in for the login BrowserWindow: records closes, can fire `closed`. */
function fakeLoginWindow(): {
  handle: LoginWindowHandle
  fireClosed: () => void
  closeCalls: () => number
} {
  const listeners: (() => void)[] = []
  let closeCalls = 0
  return {
    handle: {
      onClosed: (listener) => listeners.push(listener),
      close: () => {
        closeCalls += 1
      },
    },
    fireClosed: () => listeners.forEach((listener) => listener()),
    closeCalls: () => closeCalls,
  }
}

/** Every probe outcome is scripted, so no test depends on wall-clock timing. */
function scriptedProbe(steps: (Identity | null | Error)[]): { probe: () => Promise<Identity | null>; calls: () => number } {
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
      sleep: async () => {},
      pollIntervalMs: 1500,
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
        sleep: async () => {},
        pollIntervalMs: 1500,
      }),
    ).rejects.toMatchObject({ kind: 'network' })
    expect(opened).toBe(0)
  })

  it('opens the login window, polls until the session works, and closes it again', async () => {
    const window = fakeLoginWindow()
    const { probe, calls } = scriptedProbe([null, null, null, IDENTITY])
    const sleeps: number[] = []

    const identity = await authenticate({
      probe,
      openLoginWindow: () => window.handle,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      pollIntervalMs: 1500,
    })

    expect(identity).toEqual(IDENTITY)
    // One probe before the window opened, three while it was open.
    expect(calls()).toBe(4)
    // No sleep before the first probe and none after the successful one.
    expect(sleeps).toEqual([1500, 1500])
    expect(window.closeCalls()).toBe(1)
  })

  it('keeps polling through a transient failure instead of giving up', async () => {
    const window = fakeLoginWindow()
    const { probe } = scriptedProbe([null, new FactorialError('network', 'ECONNRESET'), IDENTITY])

    await expect(
      authenticate({ probe, openLoginWindow: () => window.handle, sleep: async () => {}, pollIntervalMs: 1 }),
    ).resolves.toEqual(IDENTITY)
  })

  it('gives up when the user closes the login window', async () => {
    const window = fakeLoginWindow()
    const { probe, calls } = scriptedProbe([null])
    let sleeps = 0

    const failure = await authenticate({
      probe,
      openLoginWindow: () => window.handle,
      sleep: async () => {
        sleeps += 1
        if (sleeps === 2) window.fireClosed()
      },
      pollIntervalMs: 1,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(FactorialError)
    expect(failure).toMatchObject({ kind: 'unauthenticated', message: LOGIN_ABORTED_MESSAGE })
    // One probe before the window opened plus two while it was open; the loop
    // must not keep hammering the API once the window is gone.
    expect(calls()).toBe(3)
    // Closing an already-closed window is at best a no-op and at worst a throw.
    expect(window.closeCalls()).toBe(0)
  })

  it('stops polling when the window closes during a probe', async () => {
    const window = fakeLoginWindow()
    let calls = 0
    const probe = async (): Promise<Identity | null> => {
      calls += 1
      window.fireClosed()
      return null
    }

    await expect(
      authenticate({ probe, openLoginWindow: () => window.handle, sleep: async () => {}, pollIntervalMs: 1 }),
    ).rejects.toMatchObject({ kind: 'unauthenticated' })
    // The probe before the window opened, then one inside the loop that closed
    // it — and no sleep and no further probe after that.
    expect(calls).toBe(2)
  })
})
