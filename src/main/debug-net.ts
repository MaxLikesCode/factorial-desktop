/**
 * Opt-in request logging for the session partition, for debugging the login.
 *
 * Enabled with `FACTORIAL_DEBUG_NET=1`. Off by default and never registered
 * otherwise, so it costs nothing in normal use.
 *
 * It logs method, URL and status code only. No request bodies, no response
 * bodies, no header values — the traffic it watches carries the user's
 * credentials and their session cookie, and none of that belongs in a log file
 * a user is about to paste into a chat window. Which requests happen, in which
 * order, and how the server answered is enough to locate a broken auth flow.
 */

import type { Session } from 'electron'

const FLAG = 'FACTORIAL_DEBUG_NET'

/** Only the hosts this app talks to; anything else is noise from third parties. */
const INTERESTING = /(^|\.)factorialhr\.com$/

export function isNetDebugEnabled(): boolean {
  return process.env[FLAG] === '1'
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

/**
 * Strips the query string. Factorial puts the GraphQL operation name there, which
 * is useful, but login URLs can carry tokens — so the operation name is kept
 * only for the API host and dropped everywhere else.
 */
function describeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const isApi = parsed.host === 'api.factorialhr.com'
    const suffix = isApi && parsed.search ? `?${parsed.search.slice(1).split('&')[0]}` : ''
    return `${parsed.origin}${parsed.pathname}${suffix}`
  } catch {
    return '<unparseable url>'
  }
}

export function installNetDebug(session: Session, log: (line: string) => void = console.log): void {
  if (!isNetDebugEnabled()) return

  log(`[net] logging enabled (${FLAG}=1). User-Agent: ${session.getUserAgent()}`)

  const started = new Map<number, string>()

  session.webRequest.onBeforeRequest((details, callback) => {
    const host = hostOf(details.url)
    if (host && INTERESTING.test(host)) {
      started.set(details.id, `${details.method} ${describeUrl(details.url)}`)
    }
    callback({})
  })

  session.webRequest.onCompleted((details) => {
    const label = started.get(details.id)
    if (!label) return
    started.delete(details.id)
    log(`[net] ${details.statusCode} ${label}`)
  })

  session.webRequest.onErrorOccurred((details) => {
    const label = started.get(details.id)
    if (!label) return
    started.delete(details.id)
    log(`[net] ERR ${details.error} ${label}`)
  })
}
