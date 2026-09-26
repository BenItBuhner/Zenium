import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/types'
import { AgentService } from '../service'
import { fakeBrowser, type FakeBrowser } from './fakeBrowser'

/**
 * `waitForLoad` keeps a tool from snapshotting the previous page: a navigation just asked for
 * is given a grace to start. The grace has to end at the first sign of the load – the fresh
 * view committing its page, `loading` seen on, the URL moving – and a new tab has to pay it
 * once, not in `prepare` and again in the tool. PR-D's soak measured `browser_tabs new` at a
 * fixed 3.4 s on a local page: two full graces back to back.
 */

const realWaitForLoad = AgentService.prototype.waitForLoad

/** A tab of A's whose view reports `committed` as its page, with the real `waitForLoad` in place. */
async function tabWithView(
  committed: () => string
): Promise<{ fake: FakeBrowser; id: string; tab: Tab }> {
  const fake = fakeBrowser()
  const A = await fake.connect('A')
  const id = fake.openedTab(
    await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
  )
  const view = fake.browser.tabs.view(id)!
  ;(view as { getURL: () => string }).getURL = committed
  fake.service.waitForLoad = realWaitForLoad
  return { fake, id, tab: fake.model.tabs[id] }
}

function track<T>(p: Promise<T>): { done: boolean } {
  const state = { done: false }
  void p.then(() => {
    state.done = true
  })
  return state
}

describe('waitForLoad', () => {
  afterEach(() => vi.useRealTimers())

  it('a fresh view committing its page ends the navigation grace', async () => {
    vi.useFakeTimers()
    let committed = ''
    const { fake, id } = await tabWithView(() => committed)
    const wait = track(fake.service.waitForLoad(id, 15_000, { expectNavigation: true }))
    await vi.advanceTimersByTimeAsync(400)
    expect(wait.done).toBe(false) // nothing has happened yet: still in the grace
    committed = 'https://a.example/1'
    await vi.advanceTimersByTimeAsync(300) // one 50 ms poll and the 150 ms settle
    expect(wait.done).toBe(true)
  })

  it('loading seen on ends the grace too', async () => {
    vi.useFakeTimers()
    const { fake, id, tab } = await tabWithView(() => 'https://a.example/1')
    tab.loading = true
    const wait = track(fake.service.waitForLoad(id, 15_000, { expectNavigation: true }))
    await vi.advanceTimersByTimeAsync(400)
    expect(wait.done).toBe(false) // still loading
    tab.loading = false
    await vi.advanceTimersByTimeAsync(300)
    expect(wait.done).toBe(true)
  })

  it('an idle tab with no sign of the navigation still waits the whole grace', async () => {
    vi.useFakeTimers()
    const { fake, id } = await tabWithView(() => 'https://a.example/1')
    const wait = track(fake.service.waitForLoad(id, 15_000, { expectNavigation: true }))
    await vi.advanceTimersByTimeAsync(1400)
    expect(wait.done).toBe(false) // a same-URL reload may still be about to start
    await vi.advanceTimersByTimeAsync(400)
    expect(wait.done).toBe(true)
  })

  it('without expectNavigation an idle tab counts as loaded at once', async () => {
    vi.useFakeTimers()
    const { fake, id } = await tabWithView(() => 'https://a.example/1')
    const wait = track(fake.service.waitForLoad(id, 15_000))
    await vi.advanceTimersByTimeAsync(300)
    expect(wait.done).toBe(true)
  })
})

describe('tools wait for a load once', () => {
  it('browser_tabs new: prepare loads the fresh tab, the tool does not wait again', async () => {
    const fake = fakeBrowser()
    const A = await fake.connect('A')
    const waits = vi.spyOn(fake.service, 'waitForLoad')
    await fake.call(A, 'browser_tabs', { action: 'new', url: 'https://a.example/1' })
    expect(waits.mock.calls.map((c) => c[2])).toEqual([{ expectNavigation: true }])
  })

  it('browser_navigate on an implicit tab: the blank tab is not waited for as a navigation, the URL is', async () => {
    // Background: the implicit tab opens behind without a view, prepare loads the blank one.
    const fake = fakeBrowser()
    const A = await fake.connect('A', { mode: 'background' })
    const waits = vi.spyOn(fake.service, 'waitForLoad')
    await fake.call(A, 'browser_navigate', { url: 'https://a.example/1' })
    expect(waits.mock.calls.map((c) => c[2])).toEqual([
      { expectNavigation: false },
      { expectNavigation: true }
    ])
    // Foreground: the tab opens active with its view, so only the URL's load is waited for.
    const B = await fake.connect('B')
    waits.mockClear()
    await fake.call(B, 'browser_navigate', { url: 'https://b.example/1' })
    expect(waits.mock.calls.map((c) => c[2])).toEqual([{ expectNavigation: true }])
  })
})
