/**
 * The adapter between `client.ts`'s minimal `GraphQLFetch` and Electron's
 * session-bound `fetch`, plus the one thing the client deliberately does not do:
 * enforce a deadline.
 *
 * This module holds no Electron import so it can be unit tested. `session.ts`
 * supplies the real `ses.fetch`.
 *
 * Why a deadline lives here (carry-forward C2): `client.ts` awaits its fetch
 * without any timeout. A socket that opens and then goes quiet — captive
 * portal, VPN dropping mid-request, a sleeping laptop's stale connection —
 * would leave `execute()` pending forever, and with it the 60 s poll loop and
 * every button that waits on it. An aborted request is a visible failure; a
 * pending one is a frozen app.
 */

import type { GraphQLFetch } from './factorial/client'

/** What Electron's `Response` gives us, narrowed to what is actually used. */
export interface SessionFetchResponse {
  readonly status: number
  text(): Promise<string>
}

/** Structurally a `RequestInit`, but with every field this app relies on required. */
export interface SessionFetchInit {
  method: string
  headers: Record<string, string>
  body: string
  credentials: 'include'
  redirect: 'manual'
  signal: AbortSignal
}

export interface SessionFetch {
  (url: string, init: SessionFetchInit): Promise<SessionFetchResponse>
}

/**
 * The status a `redirect: 'manual'` response carries in the fetch standard: the
 * body and the real status are hidden behind an opaque response. Electron's
 * `net.fetch` is built on Chromium's stack, so this is what it may hand back —
 * unverified either way, which is exactly why it is normalised below.
 */
export const OPAQUE_REDIRECT_STATUS = 0

/** What an opaque redirect is reported as, so the client's 3xx rule fires. */
const NORMALISED_REDIRECT_STATUS = 302

const OPAQUE_REDIRECT_BODY = 'redirected (opaque response, likely an expired session)'

export function createTimeoutFetch(fetchImpl: SessionFetch, timeoutMs: number): GraphQLFetch {
  return async (url, init) => {
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetchImpl(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        // The session cookie is the entire authentication (DESIGN.md, Transport).
        credentials: 'include',
        // The API answers an expired session with a bounce to the login page.
        // Following it would replace a legible 3xx with an HTML page the client
        // can only call "malformed", and the login window would never open.
        redirect: 'manual',
        signal: controller.signal,
      })

      // The body is read *inside* the deadline. A response whose headers arrive
      // and whose body then stalls is the same hang, one layer down.
      const body = await response.text()

      if (response.status === OPAQUE_REDIRECT_STATUS) {
        return { status: NORMALISED_REDIRECT_STATUS, text: async () => OPAQUE_REDIRECT_BODY }
      }
      return { status: response.status, text: async () => body }
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new Error(`request timed out after ${timeoutMs} ms`)
      }
      throw cause
    } finally {
      // A surviving timer would abort a signal nobody awaits any more.
      clearTimeout(deadline)
    }
  }
}
