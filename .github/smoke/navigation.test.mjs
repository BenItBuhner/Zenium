import { describe, expect, it } from 'vitest'
import {
  ERR_ABORTED,
  URLBAR_FIELD_OWNER,
  caretVerdict,
  firstRetryableFailLoad,
  isNewTabUrl,
  isRetryableFailLoad,
  newTabPlan,
  retryDetail,
  rowsExpected,
  waitForTabWithRetry
} from './navigation.mjs'

const URL = 'https://example.com/'

describe('isNewTabUrl', () => {
  it('takes the new tab page bare, with a path and with a query', () => {
    expect(isNewTabUrl('zen://newtab')).toBe(true)
    expect(isNewTabUrl('zen://newtab/')).toBe(true)
    expect(isNewTabUrl('zen://newtab?private=1')).toBe(true)
  })
  it('refuses pages, other internal pages, an empty string and non-strings', () => {
    expect(isNewTabUrl(URL)).toBe(false)
    expect(isNewTabUrl('zen://newtabs')).toBe(false)
    expect(isNewTabUrl('zen://settings')).toBe(false)
    expect(isNewTabUrl('')).toBe(false)
    expect(isNewTabUrl(null)).toBe(false)
    expect(isNewTabUrl(undefined)).toBe(false)
  })
})

describe('newTabPlan', () => {
  it('uses the bar over the blank new tab: that tab takes the URL, the row count stays', () => {
    const plan = newTabPlan({ barVisible: true, submitTabUrl: 'zen://newtab/' })
    expect(plan).toEqual({ way: 'use', rowsAfter: 'same' })
    expect(rowsExpected(1, plan)).toBe(1)
  })
  it('uses a bar whose submit opens a new tab: one more row', () => {
    const plan = newTabPlan({ barVisible: true, submitTabUrl: null })
    expect(plan).toEqual({ way: 'use', rowsAfter: 'one-more' })
    expect(rowsExpected(1, plan)).toBe(2)
  })
  it("closes a bar over a page's own address before Accel+T", () => {
    expect(newTabPlan({ barVisible: true, submitTabUrl: URL })).toEqual({
      way: 'close-then-new',
      rowsAfter: 'one-more'
    })
    // A tab the app state does not list is not a blank tab.
    expect(newTabPlan({ barVisible: true, submitTabUrl: '' })).toEqual({
      way: 'close-then-new',
      rowsAfter: 'one-more'
    })
  })
  it('opens a tab with Accel+T when the bar is down, whatever the tab argument says', () => {
    const plan = newTabPlan({ barVisible: false, submitTabUrl: 'zen://newtab/' })
    expect(plan).toEqual({ way: 'new', rowsAfter: 'one-more' })
    expect(rowsExpected(0, plan)).toBe(1)
    expect(newTabPlan({ barVisible: false, submitTabUrl: null })).toEqual(plan)
  })
})

describe('caretVerdict', () => {
  const caret = (owner, bar = 'found-up', ms = 12) => ({
    focused: owner === URLBAR_FIELD_OWNER,
    owner,
    ms,
    bar
  })
  const withCaret = (owner) => ({ url: URL, way: 'use', caret: caret(owner) })

  it("hands the detail back as it is when the bar's field held the keyboard", () => {
    const detail = withCaret(URLBAR_FIELD_OWNER)
    expect(caretVerdict(detail)).toBe(detail)
    // A detail without a reading (a step that did not go through the bar) is not judged.
    const bare = { url: URL }
    expect(caretVerdict(bare)).toBe(bare)
    expect(caretVerdict(bare, [undefined, null])).toBe(bare)
  })

  it('fails the step, its detail kept on the error, when the bar had no caret', () => {
    // The state main's boot smoke was in: the field let go, the page's view holding the keyboard.
    const detail = withCaret('tab:7')
    let thrown = null
    try {
      caretVerdict(detail)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown.message).toBe(
      'the URL bar found up had no caret: the keyboard was tab:7 for the 12 ms before the harness focused the field'
    )
    expect(thrown.detail).toBe(detail)
    // The chrome page with the keyboard but the field not the active element: no caret either.
    expect(() => caretVerdict(withCaret('chrome'))).toThrow(/the keyboard was chrome for/)
  })

  it('judges every reading it is given – the second Accel+T of the walkthrough too', () => {
    const first = caret(URLBAR_FIELD_OWNER, 'accel-t')
    const second = caret('tab:9', 'accel-t', 3000)
    const detail = { first: { caret: first }, second: { caret: second } }
    expect(caretVerdict(detail, [first, first])).toBe(detail)
    expect(() => caretVerdict(detail, [first, second])).toThrow(
      'the URL bar brought up with Accel+T had no caret: the keyboard was tab:9 for the 3000 ms before the harness focused the field'
    )
  })
})

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
