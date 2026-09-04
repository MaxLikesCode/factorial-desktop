/**
 * Factorial's own web app, opened in *our* session, with its GraphQL traffic
 * written to the terminal.
 *
 * This exists for one question: when the API refuses something the web
 * interface is allowed to do, what does the web interface send that we do not?
 * `debug-introspect.ts` can ask the schema what exists, but not what the real
 * client puts in the request. This can, because the web app and this app share
 * the `persist:factorial` partition — the same cookie, the same session, so the
 * window comes up already signed in.
 *
 *   $env:FACTORIAL_DEBUG_WEB = '1'; npm run dev
 *
 * Then do the thing in the window that fails in the app, and read the payload
 * off the terminal.
 *
 * ## What it records, and what it refuses to
 *
 * Request bodies to the GraphQL endpoint only — operation, query, variables —
 * plus the request's header *names* so a missing one is visible. Header values
 * are printed only for headers that cannot carry a credential;
 * `cookie`/`authorization` and friends are reduced to their length. Variables
 * whose name suggests a secret are replaced before anything is printed, because
 * a terminal log is something a user pastes into a chat window.
 *
 * Dev only, off unless the flag is set, like `debug-net.ts` next door.
 *
 * ## One conflict worth knowing
 *
 * Electron keeps a single `onBeforeRequest` listener per session, so this and
 * `FACTORIAL_DEBUG_NET` cannot both own it. Installed second, this one wins and
 * says so; the net log's status lines stay intact either way.
 */

import { app, BrowserWindow, type Session } from 'electron'

const FLAG = 'FACTORIAL_DEBUG_WEB'

/** Where the web app lives. `app` bounces to the login host without a session. */
const WEB_URL = 'https://app.factorialhr.com/'

const GRAPHQL_PREFIX = 'https://api.factorialhr.com/graphql'

/** Header values that are never printed, only measured. */
const SECRET_HEADERS = /^(cookie|set-cookie|authorization|proxy-authorization|x-csrf-token)$/i

/** Variable names that are never printed, whatever they hold. */
const SECRET_VARIABLES = /pass|secret|token|otp|^code$|credential/i

const REDACTED = '<redacted>'

export function isWebDebugEnabled(): boolean {
  return process.env[FLAG] === '1'
}

/**
 * Replaces anything that looks like a credential, at any depth. Recursive
 * because Factorial nests its mutation arguments one level down often enough,
 * and a redaction that only looks at the top level is not one.
 */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_VARIABLES.test(key) ? REDACTED : redact(nested)
  }
  return out
}

/** The upload buffers of one request, concatenated into the body it will send. */
function bodyOf(details: { uploadData?: Array<{ bytes?: Uint8Array }> }): string | null {
  const parts = details.uploadData
  if (!parts || parts.length === 0) return null
  const chunks = parts.map((part) => (part.bytes ? Buffer.from(part.bytes).toString('utf8') : ''))
  const body = chunks.join('')
  return body === '' ? null : body
}

/**
 * One GraphQL request, as a block a person can read and compare with
 * `operations.ts`. A body that will not parse is printed raw and truncated —
 * being unable to read it is itself worth seeing.
 */
function describeGraphql(body: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return `  <unparseable body> ${body.slice(0, 500)}`
  }
  if (typeof parsed !== 'object' || parsed === null) return `  <body was not an object> ${body.slice(0, 500)}`

  const { operationName, query, variables } = parsed as Record<string, unknown>
  const lines = [`  operation: ${typeof operationName === 'string' ? operationName : '<none>'}`]
  lines.push(`  variables: ${JSON.stringify(redact(variables))}`)
  if (typeof query === 'string') lines.push(`  query: ${query.replace(/\s+/g, ' ').trim()}`)
  return lines.join('\n')
}

function describeHeaders(headers: Record<string, unknown>): string {
  return Object.entries(headers)
    .map(([name, value]) => {
      if (SECRET_HEADERS.test(name)) return `${name}=<${String(value).length} chars>`
      return `${name}=${String(value)}`
    })
    .sort()
    .join(' ')
}

/**
 * Body capture. Returns without touching the session unless the flag is set, so
 * `debug-net.ts` keeps `onBeforeRequest` in the normal case.
 */
export function installWebDebug(session: Session, log: (line: string) => void = console.log): void {
  if (app.isPackaged || !isWebDebugEnabled()) return

  log(`[web] GraphQL body logging enabled (${FLAG}=1)`)
  if (process.env.FACTORIAL_DEBUG_NET === '1') {
    log('[web] note: this replaces FACTORIAL_DEBUG_NET\'s request listener; its status lines still work')
  }

  session.webRequest.onBeforeRequest((details, callback) => {
    if (details.method === 'POST' && details.url.startsWith(GRAPHQL_PREFIX)) {
      const body = bodyOf(details)
      if (body !== null) log(`[web] POST ${details.url}\n${describeGraphql(body)}`)
    }
    callback({})
  })

  session.webRequest.onBeforeSendHeaders((details, callback) => {
    if (details.method === 'POST' && details.url.startsWith(GRAPHQL_PREFIX)) {
      log(`[web] headers ${describeHeaders(details.requestHeaders)}`)
    }
    callback({ requestHeaders: details.requestHeaders })
  })
}

/**
 * The web app in a plain window on our partition. Not a login window and not
 * wired into anything: it is a place to reproduce a failing action by hand while
 * the listeners above write down what it sent.
 */
export function openFactorialWeb(session: Session, log: (line: string) => void = console.log): void {
  if (app.isPackaged || !isWebDebugEnabled()) return

  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    // Nothing of ours runs in it — it is somebody else's web app.
    webPreferences: { session, nodeIntegration: false, contextIsolation: true },
  })
  void window.loadURL(WEB_URL)
  log(`[web] opened ${WEB_URL} in the app's session`)
}
