/**
 * GraphQL transport, and nothing beyond it. This module knows how to POST a
 * document and how to tell success from the four ways a request can fail. It
 * knows nothing about attendance, shifts or breaks — that semantic lives next
 * door in operations.ts.
 *
 * The fetch implementation is injected. In production it is `net.fetch` bound to
 * the `persist:factorial` session (the renderer cannot reach the API at all —
 * CORS), in tests a plain function. So the client is testable without Electron
 * running.
 */

export const GRAPHQL_ENDPOINT = 'https://api.factorialhr.com/graphql'

export interface GraphQLFetch {
  (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ): Promise<{ status: number; text: () => Promise<string> }>
}

export interface Operation {
  operationName: string
  query: string
  variables: Record<string, unknown>
}

export type FactorialErrorKind = 'unauthenticated' | 'graphql' | 'network' | 'malformed'

/**
 * One error type for the whole integration, carrying *why* it failed. Only
 * `unauthenticated` is branched on (it opens the login window); the rest end up
 * in a toast. A failed call is never presented as a success.
 */
export class FactorialError extends Error {
  constructor(
    readonly kind: FactorialErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'FactorialError'
  }
}

export interface GraphQLClient {
  execute<T>(op: Operation): Promise<T>
}

/** Only the two envelope fields matter here; both arrive untrusted. */
interface GraphQLEnvelope {
  data?: unknown
  errors?: unknown
}

/** Longer bodies are usually an HTML error page; the first line identifies it. */
const BODY_EXCERPT_LENGTH = 120

function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error as { message?: unknown }
    if (typeof message === 'string' && message.length > 0) return message
  }
  return 'unknown error'
}

export function createClient(fetchImpl: GraphQLFetch): GraphQLClient {
  async function execute<T>(op: Operation): Promise<T> {
    let status: number
    let raw: string
    try {
      const res = await fetchImpl(`${GRAPHQL_ENDPOINT}?${op.operationName}`, {
        method: 'POST',
        // The session cookie is the entire authentication. No CSRF token, no
        // bearer, no custom headers — verified against the live API.
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(op),
      })
      status = res.status
      raw = await res.text()
    } catch (cause) {
      throw new FactorialError('network', describeError(cause))
    }

    // A redirect means the session cookie no longer authenticates us: the API
    // answers a valid request with a bounce to the login page.
    if (status === 401 || status === 403 || (status >= 300 && status < 400)) {
      throw new FactorialError('unauthenticated', `session rejected (HTTP ${status})`)
    }

    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      throw new FactorialError(
        'malformed',
        `HTTP ${status}: expected JSON, got: ${raw.slice(0, BODY_EXCERPT_LENGTH)}`,
      )
    }

    // `JSON.parse` happily returns null, an array or a bare number. Reading
    // fields off those either throws or silently yields undefined.
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new FactorialError('malformed', `HTTP ${status}: response was not a GraphQL envelope`)
    }
    const envelope: GraphQLEnvelope = body

    // Factorial reports errors in-band with HTTP 200. The status code alone
    // never establishes success.
    const { errors } = envelope
    if (errors !== undefined && errors !== null && !Array.isArray(errors)) {
      // Do not fall through to "success" while the server signals a failure.
      throw new FactorialError('malformed', `HTTP ${status}: errors was not a list`)
    }
    if (Array.isArray(errors) && errors.length > 0) {
      // Errors outrank any data that came with them: GraphQL may deliver a
      // partial payload, and half an attendance record is not a result.
      throw new FactorialError('graphql', errors.map(describeError).join('; '))
    }

    if (envelope.data === undefined || envelope.data === null) {
      throw new FactorialError('malformed', `HTTP ${status}: response carried neither data nor errors`)
    }

    // The single unchecked cast of the integration. Shape validation belongs to
    // the caller, which knows what it asked for; operations.ts does it there.
    return envelope.data as T
  }

  return { execute }
}
