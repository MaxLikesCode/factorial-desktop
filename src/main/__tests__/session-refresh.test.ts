import { describe, it, expect, vi } from 'vitest'
import {
  createRefreshingFetch,
  createSessionRefresh,
  REFRESH_URL,
  type RefreshSession,
} from '../session-refresh'
import type { GraphQLFetch } from '../factorial/client'
import type { SessionFetch, SessionFetchResponse } from '../session-fetch'

const reply = (status: number, body = ''): SessionFetchResponse => ({
  status,
  text: async () => body,
})

/** A `GraphQLFetch` that answers with the scripted statuses, in order. */
function scriptedFetch(statuses: number[]): { fetch: GraphQLFetch; calls: () => number } {
  let index = 0
  return {
    calls: () => index,
    fetch: async () => {
      const status = statuses[Math.min(index, statuses.length - 1)] ?? 200
      index += 1
      return { status, text: async () => '{}' }
    },
  }
}

describe('createSessionRefresh', () => {
  const init = {
    method: 'POST',
    headers: {},
    body: '',
    credentials: 'include',
    redirect: 'manual',
  }

  it('posts to the ID service’s refresh endpoint and nothing else', async () => {
    const fetchImpl = vi.fn(async () => reply(200, '{"success":true}')) as unknown as SessionFetch
    await createSessionRefresh(fetchImpl)()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, sent] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      typeof init,
    ]
    expect(url).toBe(REFRESH_URL)
    expect(sent.method).toBe('POST')
    // Verified against the live endpoint: a bare POST is accepted. No CSRF token,
    // no content type, no body.
    expect(sent.body).toBe('')
    expect(sent.headers).toEqual({})
  })

  it('reports success on a plain 200', async () => {
    const fetchImpl = (async () => reply(200, '{"success":true}')) as unknown as SessionFetch
    await expect(createSessionRefresh(fetchImpl)()).resolves.toBe(true)
  })

  it('reports failure on the 401 the endpoint answers with a spent token', async () => {
    const body = JSON.stringify({
      success: false,
      error: { code: 'invalid_refresh_token', message: 'Ihre Sitzung ist abgelaufen.' },
    })
    const fetchImpl = (async () => reply(401, body)) as unknown as SessionFetch
    await expect(createSessionRefresh(fetchImpl)()).resolves.toBe(false)
  })

  /** The endpoint reports failure in-band; a 200 alone is not an answer. */
  it('reports failure on a 200 that carries success:false', async () => {
    const fetchImpl = (async () => reply(200, '{"success":false}')) as unknown as SessionFetch
    await expect(createSessionRefresh(fetchImpl)()).resolves.toBe(false)
  })

  it('accepts a 200 with an empty or non-JSON body rather than guessing failure', async () => {
    await expect(
      createSessionRefresh((async () => reply(200, '')) as unknown as SessionFetch)(),
    ).resolves.toBe(true)
    await expect(
      createSessionRefresh((async () => reply(200, 'OK')) as unknown as SessionFetch)(),
    ).resolves.toBe(true)
  })

  it('treats a network failure as "not refreshed" instead of throwing', async () => {
    // A thrown refresh would escape into the poll loop and turn a hiccup into a
    // crash; the caller's own 401 is the more honest thing to report.
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as SessionFetch
    await expect(createSessionRefresh(fetchImpl)()).resolves.toBe(false)
  })
})

describe('createRefreshingFetch', () => {
  const url = 'https://api.factorialhr.com/graphql?Me'
  const init = { method: 'POST', headers: {}, body: '{}' }

  it('passes a successful response straight through without refreshing', async () => {
    const refresh = vi.fn<RefreshSession>(async () => true)
    const { fetch, calls } = scriptedFetch([200])
    const wrapped = createRefreshingFetch(fetch, refresh)

    await expect(wrapped(url, init)).resolves.toMatchObject({ status: 200 })
    expect(refresh).not.toHaveBeenCalled()
    expect(calls()).toBe(1)
  })

  it('refreshes and retries once on a 401', async () => {
    const refresh = vi.fn<RefreshSession>(async () => true)
    const { fetch, calls } = scriptedFetch([401, 200])
    const wrapped = createRefreshingFetch(fetch, refresh)

    await expect(wrapped(url, init)).resolves.toMatchObject({ status: 200 })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(calls()).toBe(2)
  })

  it('gives up after one retry rather than looping against the server', async () => {
    const refresh = vi.fn<RefreshSession>(async () => true)
    const { fetch, calls } = scriptedFetch([401, 401, 401])
    const wrapped = createRefreshingFetch(fetch, refresh)

    // The second 401 is handed back untouched: the store then reports the
    // session as expired, which is exactly what it did before this layer.
    await expect(wrapped(url, init)).resolves.toMatchObject({ status: 401 })
    expect(calls()).toBe(2)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('does not retry when the refresh itself failed', async () => {
    const refresh = vi.fn<RefreshSession>(async () => false)
    const { fetch, calls } = scriptedFetch([401])
    const wrapped = createRefreshingFetch(fetch, refresh)

    await expect(wrapped(url, init)).resolves.toMatchObject({ status: 401 })
    expect(calls()).toBe(1)
  })

  it('does not refresh on any status other than 401', async () => {
    const refresh = vi.fn<RefreshSession>(async () => true)
    for (const status of [200, 302, 403, 500]) {
      const { fetch } = scriptedFetch([status])
      await createRefreshingFetch(fetch, refresh)(url, init)
    }
    expect(refresh).not.toHaveBeenCalled()
  })

  /**
   * The store fires `fetchOpenShift` and `fetchTodayShifts` together, so both
   * meet the same expired token. Two exchanges racing each other is how a
   * rotating refresh token gets itself invalidated.
   */
  it('shares one refresh between requests that fail together', async () => {
    let resolveRefresh: (value: boolean) => void = () => {}
    const gate = new Promise<boolean>((resolve) => {
      resolveRefresh = resolve
    })
    const refresh = vi.fn<RefreshSession>(() => gate)
    const { fetch } = scriptedFetch([401, 401, 200, 200])
    const wrapped = createRefreshingFetch(fetch, refresh)

    const both = Promise.all([wrapped(url, init), wrapped(url, init)])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(refresh).toHaveBeenCalledTimes(1)

    resolveRefresh(true)
    const [first, second] = await both
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('retries with the very same request, so no mutation is reshaped on the way', async () => {
    const seen: { url: string; body: string }[] = []
    const inner: GraphQLFetch = async (requestUrl, requestInit) => {
      seen.push({ url: requestUrl, body: requestInit.body })
      return { status: seen.length === 1 ? 401 : 200, text: async () => '{}' }
    }
    const clockOut = { method: 'POST', headers: {}, body: '{"operationName":"ClockOut"}' }

    await createRefreshingFetch(inner, async () => true)(url, clockOut)
    expect(seen).toHaveLength(2)
    expect(seen[0]).toEqual(seen[1])
  })
})
