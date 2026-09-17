import { describe, expect, it } from 'vitest'
import { BackgroundLifecycle, backgroundKindOf, type BackgroundHost } from '../background'
import { parseRuntimeManifest, type RuntimeManifest } from '../manifest'

/** Manual timers: `advance(ms)` fires what is due, in order. */
class FakeHost implements BackgroundHost {
  started: string[] = []
  stopped: string[] = []
  private now = 0
  private seq = 0
  private timers = new Map<number, { at: number; callback: () => void }>()

  start(id: string): void {
    this.started.push(id)
  }

  stop(id: string): void {
    this.stopped.push(id)
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const handle = ++this.seq
    this.timers.set(handle, { at: this.now + ms, callback })
    return handle
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  advance(ms: number): void {
    const until = this.now + ms
    for (;;) {
      const next = [...this.timers]
        .filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.timers.delete(next[0])
      this.now = next[1].at
      next[1].callback()
    }
    this.now = until
  }

  pendingTimers(): number {
    return this.timers.size
  }
}

const ID = 'abcdefghijklmnopabcdefghijklmnop'

describe('backgroundKindOf', () => {
  const mv3 = (background: unknown): RuntimeManifest =>
    parseRuntimeManifest({ manifest_version: 3, name: 'x', version: '1', background }, null)
  const mv2 = (background: unknown): RuntimeManifest =>
    parseRuntimeManifest({ manifest_version: 2, name: 'x', version: '1', background }, null)

  it('classifies workers, event pages and persistent pages', () => {
    expect(backgroundKindOf(mv3(undefined))).toBe('none')
    expect(backgroundKindOf(mv3({ service_worker: 'sw.js' }))).toBe('worker')
    expect(backgroundKindOf(mv2({ scripts: ['bg.js'] }))).toBe('persistent')
    expect(backgroundKindOf(mv2({ scripts: ['bg.js'], persistent: false }))).toBe('event')
    expect(backgroundKindOf(mv2({ page: 'bg.html', persistent: false }))).toBe('event')
    // MV3 never has persistent pages, whatever the manifest says.
    expect(backgroundKindOf(mv3({ scripts: ['bg.js'], persistent: true }))).toBe('event')
  })
})

describe('BackgroundLifecycle', () => {
  it('starts once, idles out after the quiet time and restarts for a message', () => {
    const host = new FakeHost()
    const life = new BackgroundLifecycle(host, { idleMs: 30_000 })
    life.configure(ID, 'worker')
    life.ensureStarted(ID)
    life.ensureStarted(ID)
    expect(host.started).toEqual([ID])
    expect(life.state(ID)).toBe('starting')
    life.onReady(ID)
    expect(life.state(ID)).toBe('running')
    host.advance(29_000)
    life.activity(ID)
    host.advance(29_000)
    expect(host.stopped).toEqual([])
    host.advance(1_000)
    expect(host.stopped).toEqual([ID])
    expect(life.state(ID)).toBe('stopped')
    life.onGone(ID)
    expect(host.started).toEqual([ID])
    const sent: string[] = []
    expect(life.deliver(ID, null, () => sent.push('m'))).toBe('queued')
    expect(host.started).toEqual([ID, ID])
    expect(sent).toEqual([])
    life.onReady(ID)
    expect(sent).toEqual(['m'])
    expect(life.stats(ID)).toEqual({ starts: 2, idleStops: 1, queued: 1, dropped: 0 })
  })

  it('wakes a stopped worker only for events it registered listeners for', () => {
    const host = new FakeHost()
    const life = new BackgroundLifecycle(host)
    life.configure(ID, 'worker', ['alarms.onAlarm'])
    const sent: string[] = []
    expect(life.deliver(ID, 'tabs.onUpdated', () => sent.push('tabs'))).toBe('dropped')
    expect(host.started).toEqual([])
    expect(life.wouldDeliver(ID, 'tabs.onUpdated')).toBe(false)
    expect(life.wouldDeliver(ID, 'alarms.onAlarm')).toBe(true)
    expect(life.deliver(ID, 'alarms.onAlarm', () => sent.push('alarm'))).toBe('queued')
    expect(host.started).toEqual([ID])
    life.onReady(ID)
    expect(sent).toEqual(['alarm'])
    // Listeners registered while running persist across the next idle stop.
    life.listen(ID, 'tabs.onUpdated', true)
    life.listen(ID, 'runtime.onMessage', true)
    life.listen(ID, 'runtime.onMessage', false)
    expect(life.persistedListeners(ID)).toEqual(['alarms.onAlarm', 'tabs.onUpdated'])
    host.advance(30_000)
    life.onGone(ID)
    expect(life.deliver(ID, 'tabs.onUpdated', () => sent.push('tabs'))).toBe('queued')
    expect(life.deliver(ID, 'tabs.onUpdated', () => sent.push('tabs2'))).toBe('queued')
    life.onReady(ID)
    expect(sent).toEqual(['alarm', 'tabs', 'tabs2'])
    expect(life.wouldDeliver(ID, 'anything.else')).toBe(true)
  })

  it('never idles a persistent MV2 page and restarts it after a crash', () => {
    const host = new FakeHost()
    const life = new BackgroundLifecycle(host, { idleMs: 1_000 })
    life.configure(ID, 'persistent')
    life.ensureStarted(ID)
    life.onReady(ID)
    host.advance(60_000)
    expect(host.stopped).toEqual([])
    expect(host.pendingTimers()).toBe(0)
    life.onGone(ID)
    expect(host.started).toEqual([ID, ID])
    expect(life.state(ID)).toBe('starting')
  })

  it('does not restart a worker after an expected stop, but does when work waits', () => {
    const host = new FakeHost()
    const life = new BackgroundLifecycle(host, { idleMs: 1_000 })
    life.configure(ID, 'worker')
    life.ensureStarted(ID)
    life.onReady(ID)
    host.advance(1_000)
    expect(host.stopped).toEqual([ID])
    life.onGone(ID)
    expect(host.started).toEqual([ID])
    // A crash while starting with a queued message: start again.
    life.deliver(ID, null, () => undefined)
    expect(life.state(ID)).toBe('starting')
    life.onGone(ID)
    expect(host.started).toEqual([ID, ID, ID])
  })

  it('flushes the queue when a start never reports ready', () => {
    const host = new FakeHost()
    const life = new BackgroundLifecycle(host, { startTimeoutMs: 5_000 })
    life.configure(ID, 'event')
    const sent: string[] = []
    life.deliver(ID, null, () => sent.push('m'))
    host.advance(5_000)
    expect(sent).toEqual(['m'])
    expect(life.state(ID)).toBe('running')
  })

  it('remove stops a running page and forgets the queue', () => {
    const host = new FakeHost()
    const life = new BackgroundLifecycle(host)
    life.configure(ID, 'worker')
    life.deliver(ID, null, () => undefined)
    life.remove(ID)
    expect(host.stopped).toEqual([ID])
    expect(life.has(ID)).toBe(false)
    expect(life.deliver(ID, null, () => undefined)).toBe('dropped')
    expect(host.pendingTimers()).toBe(0)
  })

  it('reconfiguring to a persistent kind cancels the idle clock', () => {
    const host = new FakeHost()
    const life = new BackgroundLifecycle(host, { idleMs: 1_000 })
    life.configure(ID, 'worker')
    life.ensureStarted(ID)
    life.onReady(ID)
    life.configure(ID, 'persistent')
    host.advance(5_000)
    expect(host.stopped).toEqual([])
    life.configure(ID, 'none')
    expect(host.stopped).toEqual([ID])
    expect(life.has(ID)).toBe(false)
  })
})
