/**
 * The authentication flow without Electron: probe the stored session, and if it
 * does not authenticate, wait for a login window to make it work.
 *
 * `auth.ts` next door owns the real `BrowserWindow`; everything decided here —
 * when to open a window, when to keep waiting, when to give up — is testable
 * because the window, the clock and the probe are injected.
 *
 * The one distinction that matters: **"the server says no" is not the same as
 * "the server did not answer"**. Only the first means the user has to log in.
 * Treating a network hiccup as a logout would throw a login window at a user
 * whose problem is their Wi-Fi.
 */

import { FactorialError } from './factorial/client'
import type { Operations } from './factorial/operations'
import type { Identity } from './factorial/types'

/** German on purpose: this message reaches the user. */
export const LOGIN_ABORTED_MESSAGE = 'Anmeldung abgebrochen'

/** `null` means "not logged in". Anything else failed and is thrown. */
export type SessionProbe = () => Promise<Identity | null>

/** The slice of the login window this flow needs — see `auth.ts` for the real one. */
export interface LoginWindowHandle {
  onClosed(listener: () => void): void
  close(): void
}

export interface AuthFlowDeps {
  probe: SessionProbe
  openLoginWindow: () => LoginWindowHandle
  sleep: (ms: number) => Promise<void>
  pollIntervalMs: number
}

/**
 * `Me` doubles as the session check: it needs nothing but the cookie, so if it
 * comes back the session is good. The cookie itself is never read — it is
 * HttpOnly and lives in Chromium's partition.
 */
export function createSessionProbe(ops: Pick<Operations, 'fetchMe'>): SessionProbe {
  return async () => {
    try {
      return await ops.fetchMe()
    } catch (error) {
      if (error instanceof FactorialError && error.kind === 'unauthenticated') return null
      throw error
    }
  }
}

/**
 * Resolves once the stored session authenticates, opening Factorial's own login
 * page in a window sharing our partition if it does not.
 *
 * Rejects when the first probe fails for a reason other than authentication
 * (nothing a login would fix), and when the user closes the login window.
 */
export async function authenticate(deps: AuthFlowDeps): Promise<Identity> {
  const existing = await deps.probe()
  if (existing) return existing

  const window = deps.openLoginWindow()

  let abandoned = false
  let markClosed = (): void => {}
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve
  })
  window.onClosed(() => {
    abandoned = true
    markClosed()
  })

  while (!abandoned) {
    let identity: Identity | null = null
    try {
      identity = await deps.probe()
    } catch {
      // A failed probe during login is not a verdict: the login page itself is
      // proof the network was reachable a moment ago. Keep waiting.
    }

    // The window may have closed while the probe was in flight. Logging someone
    // in after they gave up is worse than making them click again.
    if (abandoned) break

    if (identity) {
      window.close()
      return identity
    }

    // Racing the sleep against the close event keeps the abort responsive
    // instead of waiting out a full poll interval.
    await Promise.race([deps.sleep(deps.pollIntervalMs), closed])
  }

  // The window is already gone; closing it again is at best a no-op.
  throw new FactorialError('unauthenticated', LOGIN_ABORTED_MESSAGE)
}
