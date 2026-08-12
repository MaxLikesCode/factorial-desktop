import { describe, it, expect } from 'vitest'
import { createClient, FactorialError } from '../factorial/client'
import {
  createTimeoutFetch,
  OPAQUE_REDIRECT_STATUS,
  type SessionFetch,
  type SessionFetchInit,
} from '../session-fetch'

const INIT = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }

function recording(
  respond: (init: SessionFetchInit) => Promise<{ status: number; text: () => Promise<string> }>,
): { impl: SessionFetch; calls: SessionFetchInit[] } {
  const calls: SessionFetchInit[] = []
  const impl: SessionFetch = async (_url, init) => {
    calls.push(init)
    return await respond(init)
  }
  return { impl, calls }
}

function ok(body: string, status = 200): SessionFetch {
  return async () => ({ status, text: async () => body })
}

/** A request that only ever settles by being aborted — a hung socket. */
const hangs: SessionFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted.')))
  })

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('createTimeoutFetch', () => {
  it('passes method, headers and body through untouched', async () => {
    const { impl, calls } = recording(async () => ({ status: 200, text: async () => '{}' }))
    await createTimeoutFetch(impl, 1000)('https://example.test/graphql?Me', INIT)

    const call = calls[0]
    if (!call) throw new Error('the adapter did not call fetch')
    expect(call.method).toBe('POST')
    expect(call.headers).toEqual({ 'content-type': 'application/json' })
    expect(call.body).toBe('{}')
  })

  it('sends the partition cookies and never follows a redirect on its own', async () => {
    const { impl, calls } = recording(async () => ({ status: 200, text: async () => '{}' }))
    await createTimeoutFetch(impl, 1000)('https://example.test/graphql', INIT)

    const call = calls[0]
    if (!call) throw new Error('the adapter did not call fetch')
    // Without `include` the session cookie stays behind and every call is a 401.
    expect(call.credentials).toBe('include')
    // A redirect is the API's way of saying "log in again"; following it would
    // turn that verdict into an unparseable HTML page.
    expect(call.redirect).toBe('manual')
  })

  it('hands back status and body', async () => {
    const result = await createTimeoutFetch(ok('{"data":{"ok":true}}'), 1000)('https://example.test', INIT)
    expect(result.status).toBe(200)
    await expect(result.text()).resolves.toBe('{"data":{"ok":true}}')
  })

  it('reads the body inside the deadline, so text() is replayable afterwards', async () => {
    let reads = 0
    const impl: SessionFetch = async () => ({
      status: 200,
      text: async () => {
        reads += 1
        return 'body'
      },
    })
    const result = await createTimeoutFetch(impl, 1000)('https://example.test', INIT)
    await expect(result.text()).resolves.toBe('body')
    await expect(result.text()).resolves.toBe('body')
    expect(reads).toBe(1)
  })

  it('aborts a request that hangs past the deadline', async () => {
    await expect(createTimeoutFetch(hangs, 5)('https://example.test', INIT)).rejects.toThrow(/timed out/)
  })

  it('aborts a body read that hangs past the deadline', async () => {
    const impl: SessionFetch = async (_url, init) => ({
      status: 200,
      text: () =>
        new Promise<string>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    })
    await expect(createTimeoutFetch(impl, 5)('https://example.test', INIT)).rejects.toThrow(/timed out/)
  })

  it('clears the deadline once the request is done', async () => {
    const { impl, calls } = recording(async () => ({ status: 200, text: async () => '{}' }))
    await createTimeoutFetch(impl, 5)('https://example.test', INIT)

    const call = calls[0]
    if (!call) throw new Error('the adapter did not call fetch')
    await wait(25)
    // A leaked timer would abort a signal nobody is waiting on any more, and on
    // a shared signal it would poison the next request.
    expect(call.signal.aborted).toBe(false)
  })

  it('reports a rejected fetch unchanged when it was not a timeout', async () => {
    const impl: SessionFetch = async () => {
      throw new Error('ECONNREFUSED')
    }
    await expect(createTimeoutFetch(impl, 1000)('https://example.test', INIT)).rejects.toThrow(/ECONNREFUSED/)
  })

  it('turns an opaque redirect into a redirect status', async () => {
    // With `redirect: 'manual'` the fetch spec hides the real status behind an
    // opaque response with status 0. Passing that on would read as "not a
    // session problem"; it is exactly one.
    const result = await createTimeoutFetch(ok('', OPAQUE_REDIRECT_STATUS), 1000)('https://example.test', INIT)
    expect(result.status).toBeGreaterThanOrEqual(300)
    expect(result.status).toBeLessThan(400)
  })
})

describe('createTimeoutFetch behind the GraphQL client', () => {
  it('surfaces a timeout as a network error rather than freezing the caller', async () => {
    const client = createClient(createTimeoutFetch(hangs, 5))
    await expect(client.execute({ operationName: 'Me', query: 'query Me { __typename }', variables: {} })).rejects
      .toMatchObject({ kind: 'network' })
  })

  it('surfaces an opaque redirect as an expired session', async () => {
    const client = createClient(createTimeoutFetch(ok('', OPAQUE_REDIRECT_STATUS), 1000))
    const failure = await client
      .execute({ operationName: 'Me', query: 'query Me { __typename }', variables: {} })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(FactorialError)
    expect(failure).toMatchObject({ kind: 'unauthenticated' })
  })
})
