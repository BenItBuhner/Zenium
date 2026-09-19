import { describe, expect, it } from 'vitest'
import {
  ERR_ABORTED,
  firstRetryableFailLoad,
  isRetryableFailLoad,
  retryDetail,
  waitForTabWithRetry
} from './navigation.mjs'

const URL = 'https://example.com/'
const reset = {
  type: 'did-fail-load',
  wc: 9,
  code: -101,
  desc: 'ERR_CONNECTION_RESET',
  url: URL,
  isMain: true
}

describe('isRetryableFailLoad', () => {
  it('takes a main-frame network failure of the target URL', () => {
    expect(isRetryableFailLoad(reset, URL)).toBe(true)
  })
  it('ignores sub-frames, aborted navigations, other URLs and other events', () => {
    expect(isRetryableFailLoad({ ...reset, isMain: false }, URL)).toBe(false)
    expect(isRetryableFailLoad({ ...reset, code: ERR_ABORTED }, URL)).toBe(false)
    expect(isRetryableFailLoad({ ...reset, url: 'https://other.test/' }, URL)).toBe(false)
    expect(isRetryableFailLoad({ type: 'console', message: 'x' }, URL)).toBe(false)
    expect(isRetryableFailLoad(null, URL)).toBe(false)
  })
  it('finds the first retryable failure in an event log', () => {
    const events = [{ type: 'console' }, { ...reset, isMain: false }, reset]
    expect(firstRetryableFailLoad(events, URL)).toBe(reset)
    expect(firstRetryableFailLoad([{ type: 'console' }], URL)).toBeNull()
  })
  it('names the error in the retry detail', () => {
    expect(retryDetail(reset)).toBe('retried once after did-fail-load -101 ERR_CONNECTION_RESET')
  })
})

describe('waitForTabWithRetry', () => {
  function clock() {
    let t = 0
    return { now: () => t, sleep: async (ms) => void (t += ms) }
  }

  it('resolves without a retry when the tab loads', async () => {
    const c = clock()
    let polls = 0
    const out = await waitForTabWithRetry({
      url: URL,
      loaded: async () => (++polls >= 2 ? { url: URL } : null),
      events: async () => [],
      retry: async () => {
        throw new Error('must not retry')
      },
      timeoutMs: 5000,
      ...c
    })
    expect(out).toEqual({ tab: { url: URL }, retried: null })
  })

  it('retries once on a network failure and then reports the loaded tab with the retry', async () => {
    const c = clock()
    const log = [reset]
    let retries = 0
    let loadedAfterRetry = false
    const out = await waitForTabWithRetry({
      url: URL,
      loaded: async () => (loadedAfterRetry ? { url: URL } : null),
      events: async () => log,
      retry: async (failure) => {
        retries += 1
        expect(failure).toBe(reset)
        loadedAfterRetry = true
      },
      timeoutMs: 5000,
      ...c
    })
    expect(retries).toBe(1)
    expect(out.retried).toBe(reset)
    expect(out.tab).toEqual({ url: URL })
  })

  it('fails on a second network failure instead of retrying again', async () => {
    const c = clock()
    const second = { ...reset, code: -105, desc: 'ERR_NAME_NOT_RESOLVED' }
    const log = [reset]
    await expect(
      waitForTabWithRetry({
        url: URL,
        loaded: async () => null,
        events: async () => log,
        retry: async () => {
          log.push(second)
        },
        timeoutMs: 5000,
        ...c
      })
    ).rejects.toThrow(
      /failed to load twice: retried once after did-fail-load -101 ERR_CONNECTION_RESET, then did-fail-load -105 ERR_NAME_NOT_RESOLVED/
    )
  })

  it('times out naming the retry it made', async () => {
    const c = clock()
    await expect(
      waitForTabWithRetry({
        url: URL,
        loaded: async () => null,
        events: async () => [reset],
        retry: async () => undefined,
        timeoutMs: 1000,
        ...c
      })
    ).rejects.toThrow(/not within 1000 ms; retried once after did-fail-load -101/)
  })
})
