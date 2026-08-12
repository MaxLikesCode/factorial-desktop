/**
 * The authentication flow without Electron: probe the stored session, and if it
 * does not authenticate, wait for a login window to make it work.
 *
 * `auth.ts` next door owns the real `BrowserWindow`; everything decided here —
 * when to open a window, when to keep waiting, when to give up — is testable
 * because the window and the probe are injected.
 *
 * The one distinction that matters: **"the server says no" is not the same as
 * "the server did not answer"**. Only the first means the user has to log in.
 * Treating a network hiccup as a logout would throw a login window at a user
 * whose problem is their Wi-Fi.
 *
 * ## Why this waits for navigation instead of polling
 *
 * It used to ask `Me` every 1.5 seconds for as long as the login window was
 * open. That is not how a browser behaves, and Factorial's sign-in rejected
 * every code — the emailed OTP and the authenticator's TOTP alike — with
 * "invalid code". A TOTP is checked server-side from the code, the shared
 * secret and the clock; nothing about the client can make a correct one wrong.
 * So the codes were never the problem: the request verifying them could not
 * find its pending sign-in any more.
 *
 * A stream of unauthenticated `Me` calls carrying a half-built auth cookie, one
 * every 1.5 s, into an API that sits behind Cloudflare, is the obvious thing to
 * remove. So this flow now makes **no API request at all** while the user is on
 * the login host. It waits for the window to navigate somewhere else — which is
 * what a completed sign-in does — and only then asks once.
 *
 * If Factorial ever changes where it lands after sign-in, the symptom is a login
 * window that stays open after a successful login: visible, and easy to trace.
 * That is a much better failure than a sign-in that cannot succeed at all.
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
  /** Main-frame navigations, as absolute URLs. */
  onNavigate(listener: (url: string) => void): void
  close(): void
}

export interface AuthFlowDeps {
  probe: SessionProbe
  openLoginWindow: () => LoginWindowHandle
  /**
   * True only for a URL that means the sign-in is over. Stated positively on
   * purpose: a negative "is this still the login?" lets every unknown detour
   * through — an SSO hop, `about:blank` — and each of those would fire a request
   * mid-challenge, which is the bug this flow exists to avoid.
   */
  indicatesSignedIn: (url: string) => boolean
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

  return new Promise<Identity>((resolve, reject) => {
    let settled = false

    window.onClosed(() => {
      if (settled) return
      settled = true
      // The window is already gone; closing it again is at best a no-op.
      reject(new FactorialError('unauthenticated', LOGIN_ABORTED_MESSAGE))
    })

    window.onNavigate((url) => {
      // Anything short of a clear "we are through" is left alone. Touching the
      // API mid-sign-in is what broke it.
      if (settled || !deps.indicatesSignedIn(url)) return

      void deps
        .probe()
        .then((identity) => {
          // `settled` is re-read after the await: the user may have closed the
          // window while this was in flight, and logging someone in after they
          // gave up is worse than making them click again.
          if (settled || !identity) return
          settled = true
          window.close()
          resolve(identity)
        })
        .catch(() => {
          // A failed probe here is not a verdict — the page that just loaded is
          // proof the network was reachable. Wait for the next navigation.
        })
    })
  })
}
