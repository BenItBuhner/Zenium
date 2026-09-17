import { describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/types'
import type { TabViewEvents, WindowHost } from '../../../core/platform'
import type { SessionManager } from '../sessions'
import { ElectronTabViewHost } from '../views'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeWebContents extends EventEmitter {
    private static nextId = 1
    readonly id = FakeWebContents.nextId++
    private closed = false
    isDestroyed(): boolean {
      return this.closed
    }
    getTitle(): string {
      return ''
    }
    setWindowOpenHandler(): undefined {
      return undefined
    }
    close(): void {
      this.closed = true
      this.emit('destroyed')
    }
  }
  /**
   * Electron 44 resolves `WebContentsView.webContents` through a weak pointer to the API wrapper,
   * which is already gone when the wrapper emits `destroyed`; the accessor yields undefined there.
   */
  class FakeWebContentsView {
    private contents: FakeWebContents | undefined = new FakeWebContents()
    constructor() {
      this.contents?.on('destroyed', () => {
        this.contents = undefined
      })
    }
    get webContents(): FakeWebContents | undefined {
      return this.contents
    }
    setVisible(): undefined {
      return undefined
    }
  }
  return { WebContentsView: FakeWebContentsView }
})

const sessions = { get: () => ({}) } as unknown as SessionManager
const detachedWindow = { win: { isDestroyed: () => true } } as unknown as WindowHost
const noEvents = new Proxy({} as TabViewEvents, { get: () => () => undefined })

describe('ElectronTabViewHost', () => {
  it('forgets a closed tab by its captured webContents id without touching the dead accessor', () => {
    const host = new ElectronTabViewHost(sessions)
    const tab = { id: 'tab_1', containerId: 'default' } as Tab
    const view = host.createView(tab, noEvents, detachedWindow)
    const wc = (view as unknown as { webContents: Electron.WebContents }).webContents
    expect(host.tabIdForWebContents(wc)).toBe('tab_1')
    expect(host.viewForWebContents(wc)).toBe(view)

    expect(() => view.destroy()).not.toThrow()

    expect(host.tabIdForWebContents(wc)).toBeUndefined()
    expect(host.viewForWebContents(wc)).toBeUndefined()
  })
})
