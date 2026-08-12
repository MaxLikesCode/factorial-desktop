/**
 * The persistent Chromium session the whole app shares, and the network entry
 * point built on top of it.
 *
 * The session cookie is never read, stored or copied by this app. It is
 * HttpOnly — invisible to JavaScript by design — and lives in Chromium's
 * `persist:factorial` partition on disk. The login window writes it, `ses.fetch`
 * sends it, logout deletes it. There is no token anywhere in this codebase.
 */

import { session as electronSession, type Session } from 'electron'
import { stripElectronToken } from '@shared/user-agent'
import type { GraphQLFetch } from './factorial/client'
import { createTimeoutFetch, type SessionFetch } from './session-fetch'

/** Persistent by prefix: `persist:` is what makes Chromium write it to disk. */
export const PARTITION = 'persist:factorial'

/**
 * Long enough for a slow mobile connection, short enough that a hung socket
 * does not outlive the 60 s poll interval and stack requests up behind it.
 */
export const REQUEST_TIMEOUT_MS = 15_000

export function getFactorialSession(): Session {
  return electronSession.fromPartition(PARTITION)
}

/**
 * Drops the `Electron/<version>` token from the partition's User-Agent.
 *
 * Applied to the whole partition rather than just the login window on purpose:
 * the login window and every later API call share this session, and handing the
 * server two different User-Agents for one session is exactly the kind of
 * mismatch that gets a session invalidated.
 *
 * See `@shared/user-agent` for what is removed and why. Returns the string it
 * set, so the caller can log it.
 */
export function applyBrowserUserAgent(session: Session): string {
  const userAgent = stripElectronToken(session.getUserAgent())
  session.setUserAgent(userAgent)
  return userAgent
}

/**
 * The renderer cannot call the Factorial API at all: it has no origin the server
 * allows, so CORS blocks it before the request leaves. `ses.fetch` runs in the
 * main process, is not subject to CORS, and attaches the partition's cookies
 * itself.
 */
export function createNetFetch(session: Session, timeoutMs: number = REQUEST_TIMEOUT_MS): GraphQLFetch {
  // `ses.fetch` is `net.fetch` already bound to this session, which is the typed
  // way to get the partition's cookies onto the request.
  const fetchImpl: SessionFetch = (url, init) => session.fetch(url, init)
  return createTimeoutFetch(fetchImpl, timeoutMs)
}

/**
 * Logout. Dropping the partition's cookies is the whole of it — there is no
 * token to forget. The next `Me` gets a 401 and the login window opens.
 */
export async function clearSession(): Promise<void> {
  await getFactorialSession().clearStorageData({ storages: ['cookies'] })
}
