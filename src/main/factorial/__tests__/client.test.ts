import { describe, it, expect } from 'vitest'
import { createClient, FactorialError, GRAPHQL_ENDPOINT, type GraphQLFetch } from '../client'

type FetchInit = Parameters<GraphQLFetch>[1]

/**
 * A fetch that answers with one canned HTTP response and records what it was
 * asked. Typed end to end, so the assertions below need no casts.
 */
function recordingFetch(
  status: number,
  body: string,
): { impl: GraphQLFetch; calls: { url: string; init: FetchInit }[] } {
  const calls: { url: string; init: FetchInit }[] = []
  const impl: GraphQLFetch = async (url, init) => {
    calls.push({ url, init })
    return { status, text: async () => body }
  }
  return { impl, calls }
}

function respondWith(status: number, body: string): GraphQLFetch {
  return recordingFetch(status, body).impl
}

const OP = { operationName: 'Probe', query: 'query Probe { __typename }', variables: {} }

describe('createClient', () => {
  it('returns the data payload on success', async () => {
    const client = createClient(respondWith(200, JSON.stringify({ data: { __typename: 'root_query' } })))
    await expect(client.execute(OP)).resolves.toEqual({ __typename: 'root_query' })
  })

  it('posts to the GraphQL endpoint with the operation name in the query string', async () => {
    const { impl, calls } = recordingFetch(200, JSON.stringify({ data: {} }))
    await createClient(impl).execute(OP)

    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (!call) throw new Error('the client did not call fetch')
    expect(call.url).toBe(`${GRAPHQL_ENDPOINT}?Probe`)
    expect(call.init.method).toBe('POST')
    // Auth is the session cookie alone: no CSRF token, no bearer, no custom header.
    expect(call.init.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(call.init.body)).toEqual(OP)
  })

  it('treats in-band GraphQL errors as failures even though HTTP says 200', async () => {
    // Factorial returns errors with HTTP 200 — status alone proves nothing.
    const body = JSON.stringify({ errors: [{ message: "Field 'x' doesn't exist" }] })
    const client = createClient(respondWith(200, body))
    await expect(client.execute(OP)).rejects.toMatchObject({
      kind: 'graphql',
      message: expect.stringContaining("Field 'x' doesn't exist"),
    })
  })

  it('joins several in-band errors into one message', async () => {
    const body = JSON.stringify({ errors: [{ message: 'first' }, { message: 'second' }] })
    const client = createClient(respondWith(200, body))
    await expect(client.execute(OP)).rejects.toMatchObject({ message: 'first; second' })
  })

  it('rejects partial data: errors outrank a data field that arrived with them', async () => {
    // A half-written attendance record is worse than a visible failure.
    const body = JSON.stringify({ data: { attendance: null }, errors: [{ message: 'boom' }] })
    const client = createClient(respondWith(200, body))
    await expect(client.execute(OP)).rejects.toMatchObject({ kind: 'graphql', message: 'boom' })
  })

  it('still reports an error that carries no message', async () => {
    const client = createClient(respondWith(200, JSON.stringify({ errors: [{ path: ['x'] }] })))
    await expect(client.execute(OP)).rejects.toMatchObject({ kind: 'graphql' })
  })

  it('accepts an empty errors array as success', async () => {
    const body = JSON.stringify({ data: { ok: true }, errors: [] })
    await expect(createClient(respondWith(200, body)).execute(OP)).resolves.toEqual({ ok: true })
  })

  it('flags an expired session as unauthenticated', async () => {
    const client = createClient(respondWith(401, 'Unauthorized'))
    await expect(client.execute(OP)).rejects.toMatchObject({ kind: 'unauthenticated' })
  })

  it('flags a 403 as unauthenticated', async () => {
    const client = createClient(respondWith(403, ''))
    await expect(client.execute(OP)).rejects.toMatchObject({ kind: 'unauthenticated' })
  })

  it('treats a 302 to the login page as unauthenticated', async () => {
    const client = createClient(respondWith(302, ''))
    await expect(client.execute(OP)).rejects.toMatchObject({ kind: 'unauthenticated' })
  })

  it('reports a transport failure as a network error and keeps the cause', async () => {
    const client = createClient(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(client.execute(OP)).rejects.toMatchObject({
      kind: 'network',
      message: expect.stringContaining('ECONNREFUSED'),
    })
  })

  it('reports a failure while reading the body as a network error', async () => {
    const client = createClient(async () => ({
      status: 200,
      text: async () => {
        throw new Error('socket hang up')
      },
    }))
    await expect(client.execute(OP)).rejects.toMatchObject({ kind: 'network' })
  })

  it('reports unparseable JSON as malformed rather than crashing', async () => {
    const client = createClient(respondWith(200, '<html>gateway timeout</html>'))
    await expect(client.execute(OP)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('names the status in the malformed message, so a 500 is diagnosable', async () => {
    const client = createClient(respondWith(500, '<html>internal server error</html>'))
    await expect(client.execute(OP)).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('500'),
    })
  })

  it('reports valid JSON that is not an object as malformed', async () => {
    // `JSON.parse('null')` succeeds; reading `.data` off it would crash.
    for (const body of ['null', '[]', '"ok"', '42']) {
      const client = createClient(respondWith(200, body))
      await expect(client.execute(OP)).rejects.toMatchObject({ kind: 'malformed' })
    }
  })

  it('reports an errors field that is not a list as malformed', async () => {
    // Never fall through to "success" while the server is signalling a failure.
    const body = JSON.stringify({ data: { ok: true }, errors: 'boom' })
    await expect(createClient(respondWith(200, body)).execute(OP)).rejects.toMatchObject({
      kind: 'malformed',
    })
  })

  it('reports a 200 without a data field as malformed', async () => {
    const client = createClient(respondWith(200, JSON.stringify({ extensions: {} })))
    await expect(client.execute(OP)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('reports a null data field as malformed', async () => {
    const client = createClient(respondWith(200, JSON.stringify({ data: null })))
    await expect(client.execute(OP)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('exposes FactorialError as a real Error', async () => {
    const client = createClient(respondWith(401, ''))
    await expect(client.execute(OP)).rejects.toBeInstanceOf(FactorialError)
    await expect(client.execute(OP)).rejects.toBeInstanceOf(Error)
    await expect(client.execute(OP)).rejects.toMatchObject({ name: 'FactorialError' })
  })
})
