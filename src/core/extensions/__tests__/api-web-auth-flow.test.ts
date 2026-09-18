import { describe, expect, it } from 'vitest'
import {
  ERROR_INTERACTION_REQUIRED,
  ERROR_PAGE_LOAD_FAILED,
  ERROR_TIMEOUT,
  ERROR_USER_CANCELLED,
  IdentityError,
  normalizeWebAuthFlowDetails
} from '../api/identity'
import {
  runWebAuthFlow,
  type AuthFlowTimers,
  type AuthViewEvents,
  type WebAuthFlow
} from '../api/webAuthFlow'

const EXT = 'a'.repeat(32)
const REDIRECT = `https://${EXT}.chromiumapp.org/`

interface FakeView {
  url: string
  events: AuthViewEvents
  shown: number
  closed: boolean
}

interface Harness {
  views: FakeView[]
  timers: AuthFlowTimers & { pending: Array<{ fn: () => void; ms: number }>; cleared: number }
  start(details: Record<string, unknown>): WebAuthFlow
}

function harness(): Harness {
  const views: FakeView[] = []
  const timers: Harness['timers'] = {
    pending: [],
    cleared: 0,
    setTimeout(fn, ms) {
      const entry = { fn, ms }
      timers.pending.push(entry)
      return entry
    },
    clearTimeout(handle) {
      timers.cleared += 1
      timers.pending = timers.pending.filter((entry) => entry !== handle)
    }
  }
  return {
    views,
    timers,
    start: (details) =>
      runWebAuthFlow(
        EXT,
        normalizeWebAuthFlowDetails(details),
        (url, events) => {
          const view: FakeView = { url, events, shown: 0, closed: false }
          views.push(view)
          return {
            show: () => {
              view.shown += 1
            },
            close: () => {
              if (view.closed) return
              view.closed = true
              // A real view reports its closing when told to close, too.
              events.closed()
            }
          }
        },
        timers
      )
  }
}

describe('runWebAuthFlow', () => {
  it('resolves with the first URL back on the redirect origin, fragment included, and closes the view', async () => {
    const h = harness()
    const flow = h.start({ url: 'https://auth.test/authorize?client=1', interactive: true })
    expect(h.views).toHaveLength(1)
    expect(h.views[0].url).toBe('https://auth.test/authorize?client=1')
    h.views[0].events.navigating('https://auth.test/login')
    h.views[0].events.loaded()
    expect(h.views[0].shown).toBe(1)
    h.views[0].events.navigating(`${REDIRECT}#access_token=abc&state=s`)
    await expect(flow.result).resolves.toBe(`${REDIRECT}#access_token=abc&state=s`)
    expect(h.views[0].closed).toBe(true)
    // Interactive flows have no timeout to clear.
    expect(h.timers.pending).toEqual([])
    expect(h.timers.cleared).toBe(0)
  })

  it('the way back is matched by origin only, over https', async () => {
    const h = harness()
    const flow = h.start({ url: 'https://auth.test/', interactive: true })
    h.views[0].events.navigating(`http://${EXT}.chromiumapp.org/`)
    h.views[0].events.navigating(`https://${'b'.repeat(32)}.chromiumapp.org/`)
    expect(h.views[0].closed).toBe(false)
    h.views[0].events.navigating(`${REDIRECT}any/path?code=1`)
    await expect(flow.result).resolves.toBe(`${REDIRECT}any/path?code=1`)
  })

  it('the user closing the view cancels the flow', async () => {
    const h = harness()
    const flow = h.start({ url: 'https://auth.test/', interactive: true })
    h.views[0].closed = true
    h.views[0].events.closed()
    await expect(flow.result).rejects.toThrow(ERROR_USER_CANCELLED)
    await expect(flow.result).rejects.toBeInstanceOf(IdentityError)
  })

  it('a failed page load fails the flow', async () => {
    const h = harness()
    const flow = h.start({ url: 'https://auth.test/', interactive: true })
    h.views[0].events.failed()
    await expect(flow.result).rejects.toThrow(ERROR_PAGE_LOAD_FAILED)
    expect(h.views[0].closed).toBe(true)
  })

  it('a silent flow never shows the view and fails once a page needs the user', async () => {
    const h = harness()
    const flow = h.start({ url: 'https://auth.test/' })
    expect(h.timers.pending.map((t) => t.ms)).toEqual([60_000])
    h.views[0].events.loaded()
    expect(h.views[0].shown).toBe(0)
    await expect(flow.result).rejects.toThrow(ERROR_INTERACTION_REQUIRED)
    expect(h.views[0].closed).toBe(true)
    expect(h.timers.pending).toEqual([])
  })

  it('a silent flow that may load pages waits for the redirect or the timeout', async () => {
    const h = harness()
    const flow = h.start({
      url: 'https://auth.test/',
      abortOnLoadForNonInteractive: false,
      timeoutMsForNonInteractive: 10_000
    })
    h.views[0].events.loaded()
    expect(h.views[0].closed).toBe(false)
    h.views[0].events.navigating(`${REDIRECT}?code=silent`)
    await expect(flow.result).resolves.toBe(`${REDIRECT}?code=silent`)

    const late = h.start({
      url: 'https://auth.test/',
      abortOnLoadForNonInteractive: false,
      timeoutMsForNonInteractive: 10_000
    })
    expect(h.timers.pending.map((t) => t.ms)).toEqual([10_000])
    h.timers.pending[0].fn()
    await expect(late.result).rejects.toThrow(ERROR_TIMEOUT)
    expect(h.views[1].closed).toBe(true)
  })

  it('cancel ends an open flow the way a closed view does, once', async () => {
    const h = harness()
    const flow = h.start({ url: 'https://auth.test/', interactive: true })
    flow.cancel()
    flow.cancel()
    await expect(flow.result).rejects.toThrow(ERROR_USER_CANCELLED)
    expect(h.views[0].closed).toBe(true)
    // Later reports from the view change nothing.
    h.views[0].events.navigating(`${REDIRECT}?code=late`)
    await expect(flow.result).rejects.toThrow(ERROR_USER_CANCELLED)
  })

  it('a view that ends the flow while opening is closed all the same', async () => {
    let closed = 0
    const flow = runWebAuthFlow(
      EXT,
      normalizeWebAuthFlowDetails({ url: 'https://auth.test/', interactive: true }),
      (_url, events) => {
        events.failed()
        return {
          show: () => undefined,
          close: () => {
            closed += 1
          }
        }
      }
    )
    await expect(flow.result).rejects.toThrow(ERROR_PAGE_LOAD_FAILED)
    expect(closed).toBe(1)
  })
})
