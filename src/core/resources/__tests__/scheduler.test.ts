import { describe, expect, it } from 'vitest'
import { LoadScheduler, type SchedulerHost } from '../scheduler'

/*
 * The background load queue under the live-page cap: making room discards a page, and the
 * discard reports back into the queue while it is starting the next load.
 */

function host(over: Partial<SchedulerHost> = {}): SchedulerHost & { loads: string[] } {
  const loads: string[] = []
  return {
    loads,
    load: (tabId) => (loads.push(tabId), true),
    tabExists: () => true,
    liveCount: () => 0,
    maxConcurrent: () => 1,
    maxLive: () => 0,
    makeRoom: () => true,
    onDeferred: () => {},
    onChange: () => {},
    ...over
  }
}

describe('LoadScheduler', () => {
  it('starts queued loads one slot at a time', () => {
    const h = host()
    const s = new LoadScheduler(h)
    s.request('a')
    s.request('b')
    expect(h.loads).toEqual(['a'])
    s.finished('a')
    expect(h.loads).toEqual(['a', 'b'])
  })

  it('survives a discard made to free room reporting back while the queue starts a load', () => {
    let live = 2
    const ref: { s?: LoadScheduler } = {}
    const h = host({
      maxConcurrent: () => 4,
      maxLive: () => 2,
      liveCount: () => live,
      load: (tabId) => (h.loads.push(tabId), (live += 1), true),
      // The evicted page was itself still counted in flight: its going pumps the queue again.
      makeRoom: () => {
        live -= 1
        ref.s?.finished('old')
        return true
      }
    })
    const s = new LoadScheduler(h)
    ref.s = s
    s.track('old')
    s.track('x1')
    s.track('x2')
    s.track('x3')
    s.request('q1')
    s.request('q2')
    expect(() => s.finished('x1')).not.toThrow()
    expect(h.loads).toEqual(['q1', 'q2'])
    expect(s.queued).toBe(0)
  })
})
