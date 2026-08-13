/**
 * Keeping the session alive across the access token's two-hour life.
 *
 * Factorial's sign-in leaves three cookies. Read from a real jar:
 *
 *   _factorial_id           HttpOnly   expires after  2 hours
 *   _factorial_id_refresh   HttpOnly   expires after  7 months
 *   _factorial_id_data                 expires after  7 months
 *
 * So the credential this app rides on is deliberately short-lived, and staying
 * signed in means exchanging the long-lived refresh cookie for a fresh access
 * cookie. A browser tab does this in the background, which is why Chrome stays
 * logged in all day. This app did not, so it fell out roughly every two hours
 * and asked for a full sign-in — 2FA and all — as if the session had been
 * revoked.
 *
 * The exchange is one bare POST; it needs no body, no headers and no CSRF token,
 * only the cookie the partition already holds:
 *
 *   POST https://id.factorialhr.com/api/auth/refresh
 *   401 { "success": false, "error": { "code": "invalid_refresh_token", … } }
 *
 * Done reactively rather than on a timer. A 401 is the only trustworthy signal
 * that the token is spent — a clock would have to guess at expiry, drift across
 * standby, and still handle the 401 for the times it guessed wrong.
 */

import type { GraphQLFetch } from './factorial/client'
import type { SessionFetch } from './session-fetch'

export const REFRESH_URL = 'https://id.factorialhr.com/api/auth/refresh'

/** HTTP 401. The one status that means "this token is no good any more". */
const UNAUTHORISED = 401

/** Resolves true when the session was renewed and the request is worth retrying. */
export type RefreshSession = () => Promise<boolean>

/**
 * Exchanges the refresh cookie for a new access cookie.
 *
 * Deliberately built on the *plain* session fetch, never on the refreshing one:
 * a refresh that answered 401 would otherwise try to refresh itself, forever.
 *
 * The new cookie arrives as `Set-Cookie` and Chromium files it in the partition
 * on its own — this app still never reads or stores a token, exactly as before.
 */
export function createSessionRefresh(fetchImpl: SessionFetch): RefreshSession {
  return async () => {
    try {
      const response = await fetchImpl(REFRESH_URL, {
        method: 'POST',
        headers: {},
        body: '',
        credentials: 'include',
        // Unlike the API calls, a redirect here is not interesting: anything
        // other than a plain success means the refresh did not happen.
        redirect: 'manual',
        signal: new AbortController().signal,
      })
      if (response.status !== 200) return false

      // A 200 is not the whole answer. The endpoint reports failure in-band —
      // the same shape as the 401 does — and treating `{"success": false}` as a
      // renewal would retry the original request straight into another 401.
      const body = await response.text()
      if (!body) return true
      try {
        const parsed: unknown = JSON.parse(body)
        if (typeof parsed === 'object' && parsed !== null && 'success' in parsed) {
          return (parsed as { success: unknown }).success !== false
        }
      } catch {
        // Not JSON. A 200 from this endpoint is still a 200; let the retry decide.
      }
      return true
    } catch {
      // No network, a timeout, a DNS failure: not a verdict on the session, and
      // the caller's original 401 response is returned unchanged so the store
      // reports the same thing it would have without this layer.
      return false
    }
  }
}

/**
 * Wraps a fetch so a 401 is answered with one refresh and one retry.
 *
 * Retries exactly once. If the retry is unauthorised too, that answer is handed
 * back untouched and the app does what it always did: report the session as
 * expired and offer a sign-in. An expired session must never turn into a loop
 * against someone's HR system.
 *
 * Concurrent 401s share one refresh — the store fires its two queries together,
 * and two sign-in exchanges racing each other is how a rotating refresh token
 * gets invalidated. Two callers that arrive on opposite sides of a completed
 * refresh can still trigger a second one; that is bounded and harmless, where
 * blocking one behind the other would not be.
 *
 * ## Why this does not break "never retry a mutation"
 *
 * DESIGN.md forbids replaying a failed clock-in, and it is right to: a clock-in
 * repeated a minute later records a minute nobody worked. That rule is about a
 * *business* failure — the server considered the request and refused it, or the
 * answer never came back — where replaying invents time.
 *
 * A 401 is a different animal. The request never reached a resolver; the auth
 * layer turned it away, so nothing was recorded and there is nothing to
 * duplicate. And the retry is byte-identical, which matters more than it looks:
 * every mutation carries its own `now`, so the replay writes the timestamp of
 * the *original click*, not of the retry. Not retrying would be the less
 * accurate option — the user would click again some seconds later and record
 * that later moment instead.
 *
 * The identical-payload guarantee is load-bearing, so it is pinned by a test.
 */
export function createRefreshingFetch(inner: GraphQLFetch, refresh: RefreshSession): GraphQLFetch {
  let inFlight: Promise<boolean> | null = null

  const refreshOnce = (): Promise<boolean> => {
    inFlight ??= refresh().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  return async (url, init) => {
    const response = await inner(url, init)
    if (response.status !== UNAUTHORISED) return response

    const renewed = await refreshOnce()
    if (!renewed) return response

    return inner(url, init)
  }
}
