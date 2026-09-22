import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { TabLifecycle } from '../resources/lifecycle'
import { recycleDebugger, setDebuggerRecycler } from '../pageDebugger'

/** `WebContents.debugger` as the governor sees it: one session, every command recorded. */
class FakeDebugger extends EventEmitter {
  attached = false
  readonly log: string[] = []
  isAttached(): boolean {
    return this.attached
  }
  attach(): void {
    if (this.attached) throw new Error('Debugger is already attached')
    this.attached = true
    this.log.push('attach')
  }
  detach(): void {
    this.attached = false
    this.log.push('detach')
    this.emit('detach', {}, 'target closed')
  }
  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.attached) throw new Error('Debugger is not attached')
    this.log.push(params ? `${method} ${JSON.stringify(params)}` : method)
    return {}
  }
}

function page(id: number): { wc: WebContents; dbg: FakeDebugger } {
  const dbg = new FakeDebugger()
  const wc = { id, debugger: dbg, isDestroyed: () => false } as unknown as WebContents
  return { wc, dbg }
}

/**
 * The resource governor's page sessions (`TabLifecycle`) are shared with the page's other
 * holders, and a holder that spent a once-per-agent command asks the lifecycle for a fresh
 * agent: the session goes and the governor's own overrides come back on the new one.
 */
describe('TabLifecycle.recycle', () => {
  afterEach(() => setDebuggerRecycler(null))

  it('drops the session and puts the governor’s overrides back on a new one', async () => {
    const lifecycle = new TabLifecycle()
    const { wc, dbg } = page(1)
    await lifecycle.setHardwareConcurrency(wc, 2)
    await lifecycle.setCpuThrottle(wc, 4)
    expect(dbg.log).toEqual([
      'attach',
      'Emulation.setHardwareConcurrencyOverride {"hardwareConcurrency":2}',
      'Emulation.setCPUThrottlingRate {"rate":4}'
    ])
    dbg.log.length = 0
    await lifecycle.recycle(wc)
    expect(dbg.log).toEqual([
      'detach',
      'attach',
      'Emulation.setCPUThrottlingRate {"rate":4}',
      'Emulation.setHardwareConcurrencyOverride {"hardwareConcurrency":2}'
    ])
    expect(dbg.attached).toBe(true)
    expect(lifecycle.cpuThrottle(wc)).toBe(4)
  })

  it('leaves a page detached when it had no overrides of the governor’s on it', async () => {
    const lifecycle = new TabLifecycle()
    const { wc, dbg } = page(2)
    // Another holder's session (the dark theme for sites, the page fonts).
    dbg.attach()
    dbg.log.length = 0
    await lifecycle.recycle(wc)
    expect(dbg.log).toEqual(['detach'])
    expect(dbg.attached).toBe(false)
  })

  it('installs itself as the page debugger’s recycler', async () => {
    const lifecycle = new TabLifecycle()
    const { wc, dbg } = page(3)
    await lifecycle.freeze(wc)
    dbg.log.length = 0
    await recycleDebugger(wc)
    expect(dbg.log).toEqual(['detach', 'attach', 'Page.setWebLifecycleState {"state":"frozen"}'])
    expect(lifecycle.isFrozen(wc)).toBe(true)
  })
})
