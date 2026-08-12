/**
 * Where the sign-in lives, and how to tell that it is over.
 *
 * Split out of `auth.ts` so it can be tested: `auth.ts` imports `BrowserWindow`
 * and is therefore only exercisable by running the app, and this predicate is
 * the single decision that controls whether the app touches the API during a
 * sign-in. Getting it wrong is what made Factorial reject every OTP and TOTP —
 * see the note at the top of `auth-flow.ts`.
 */

/**
 * DESIGN.md names `id.factorialhr.com` as the login host (PLAN.md's Task 6
 * snippet says `app.factorialhr.com`; the design document wins). Both lead to
 * the same form — `app` bounces to `id` when there is no session — but pointing
 * straight at the login host avoids one redirect on the cold path.
 */
export const LOGIN_URL = 'https://id.factorialhr.com/'

const LOGIN_HOST = new URL(LOGIN_URL).host

const FACTORIAL_DOMAIN = 'factorialhr.com'

/**
 * True only once the window has landed on a Factorial host that is *not* the
 * sign-in host — which is what a completed sign-in does.
 *
 * Stated positively on purpose. A negative "is this still the login?" answers
 * "no" for every unknown detour — an SSO hop, `about:blank`, a malformed URL —
 * and each of those would fire a request in the middle of the challenge.
 */
export function indicatesSignedIn(url: string): boolean {
  let host: string
  try {
    host = new URL(url).host
  } catch {
    return false
  }
  if (!host || host === LOGIN_HOST) return false
  return host === FACTORIAL_DOMAIN || host.endsWith(`.${FACTORIAL_DOMAIN}`)
}
