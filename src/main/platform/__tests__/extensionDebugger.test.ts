import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { Tab } from '../../../shared/types'
import { DebuggerApi, type PageDebugger } from '../extensionApi/debugger'
import type { ApiContext, ApiHost } from '../extensionApi/types'
import { hasForeignDebuggerOwner } from '../pageDebugger'

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'
const NO_PERMISSION = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

/** Stands in for `WebContents.debugger`: one session, commands answered by the test. */
class FakePageDebugger extends EventEmitter implements PageDebugger {
  attached = false
  attachedVersions: string[] = []
  detaches = 0
  commands: Array<{ method: string; params: unknown; sessionId?: string }> = []
  answer: (method: string) => unknown = () => ({ ok: true })

  attach(version?: string): void {
    if (this.attached) throw new Error('Debugger is already attached to the target')
    this.attached = true
    this.attachedVersions.push(version ?? '')
  }

  detach(): void {
    if (!this.attached) throw new Error('Debugger is not attached to the target')
    this.attached = false
    this.detaches++
  }

  isAttached(): boolean {
    return this.attached
  }

  sendCommand(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    this.commands.push({ method, params, sessionId })
    try {
      return Promise.resolve(this.answer(method))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /** The engine dropped the session (the tab closed, another client took over). */
  kick(): void {
    this.attached = false
    this.emit('detach', {}, 'target closed')
  }

  notify(method: string, params: unknown, sessionId?: string): void {
    this.emit('message', {}, method, params, sessionId)
  }
}

interface Page {
  tab: Tab
  wc: WebContents & EventEmitter
  dbg: FakePageDebugger
  /** What the page's main frame answers the first-paint probe, one per probe (the last repeats). */
  paintAnswers: string[]
  /** Every paint probe run in the page's main frame. */
  paintProbes: string[]
}

interface Dispatched {
  extensionId: string
  namespace: string
  event: string
  args: unknown[]
}

interface World {
  api: DebuggerApi
  pages: Map<number, Page>
  dispatched: Dispatched[]
  loaded: Set<string>
  ctx(extensionId: string): ApiContext
  page(tabId: number, url: string, title?: string): Page
}

function world(): World {
  const pages = new Map<number, Page>()
  const dispatched: Dispatched[] = []
  const loaded = new Set([EXT, OTHER, NO_PERMISSION])
  const host = {
    grants: (extensionId: string) => ({
      permissions: extensionId === NO_PERMISSION ? ['tabs'] : ['debugger', 'tabs'],
      origins: []
    }),
    loaded: (extensionId: string) => (loaded.has(extensionId) ? { id: extensionId } : undefined),
    dispatch: (extensionId: string, namespace: string, event: string, args: unknown[]) => {
      dispatched.push({ extensionId, namespace, event, args })
    },
    model: {
      zenTab: (tabId: number) => pages.get(tabId)?.tab,
      webContentsOf: (tab: Tab) => [...pages.values()].find((p) => p.tab === tab)?.wc,
      allTabs: () => [...pages.values()].map((p) => p.tab),
      chromeTabId: (tab: Tab) => Number(tab.id.slice(4))
    }
  } as unknown as ApiHost
  return {
    api: new DebuggerApi(host),
    pages,
    dispatched,
    loaded,
    ctx: (extensionId) =>
      ({ extensionId, extension: { id: extensionId }, tabId: null }) as unknown as ApiContext,
    page(tabId, url, title = 'Page') {
      const dbg = new FakePageDebugger()
      const wc = new EventEmitter() as WebContents & EventEmitter
      let destroyed = false
      const paintAnswers = ['painted']
      const paintProbes: string[] = []
      Object.assign(wc, {
        id: 100 + tabId,
        debugger: dbg,
        isDestroyed: () => destroyed,
        getURL: () => url,
        destroy: () => {
          destroyed = true
          wc.emit('destroyed')
        },
        mainFrame: {
          executeJavaScript: (code: string): Promise<unknown> => {
            paintProbes.push(code)
            return Promise.resolve(
              paintAnswers.length > 1 ? paintAnswers.shift()! : paintAnswers[0]!
            )
          }
        }
      })
      const page: Page = {
        tab: { id: `tab-${tabId}`, url, title, favicon: null } as unknown as Tab,
        wc,
        dbg,
        paintAnswers,
        paintProbes
      }
      pages.set(tabId, page)
      return page
    }
  }
}

describe('chrome.debugger', () => {
  it('attaches with a supported version, relays events and commands, and detaches quietly', async () => {
    const w = world()
    const page = w.page(7, 'https://a.example/')
    w.api.handlers.attach(w.ctx(EXT), { tabId: 7 }, '1.3')
    expect(page.dbg.attachedVersions).toEqual(['1.3'])
    expect(w.api.attachedTabs(EXT)).toEqual([7])
    page.dbg.answer = (method) =>
      method === 'Runtime.evaluate' ? { result: { value: 2 } } : undefined
    await expect(
      w.api.handlers.sendCommand(w.ctx(EXT), { tabId: 7 }, 'Runtime.evaluate', {
        expression: '1+1'
      })
    ).resolves.toEqual({ result: { value: 2 } })
    // A command without a result answers an empty object, as Chrome does; params default to {}.
    await expect(
      w.api.handlers.sendCommand(w.ctx(EXT), { tabId: 7 }, 'Page.enable')
    ).resolves.toEqual({})
    expect(page.dbg.commands).toEqual([
      { method: 'Runtime.evaluate', params: { expression: '1+1' }, sessionId: undefined },
      { method: 'Page.enable', params: {}, sessionId: undefined }
    ])
    page.dbg.notify('Page.loadEventFired', { timestamp: 1 })
    page.dbg.notify('Target.attachedToTarget', { sessionId: 'S1' }, 'S1')
    expect(w.dispatched).toEqual([
      {
        extensionId: EXT,
        namespace: 'debugger',
        event: 'onEvent',
        args: [{ tabId: 7 }, 'Page.loadEventFired', { timestamp: 1 }]
      },
      {
        extensionId: EXT,
        namespace: 'debugger',
        event: 'onEvent',
        args: [{ tabId: 7, sessionId: 'S1' }, 'Target.attachedToTarget', { sessionId: 'S1' }]
      }
    ])
    // A command addressed to the child session carries its id to the engine.
    await w.api.handlers.sendCommand(w.ctx(EXT), { tabId: 7, sessionId: 'S1' }, 'Runtime.enable')
    expect(page.dbg.commands[2]).toEqual({ method: 'Runtime.enable', params: {}, sessionId: 'S1' })
    // Own detach: the session ends, nothing is announced, later events go nowhere.
    w.api.handlers.detach(w.ctx(EXT), { tabId: 7 })
    expect(page.dbg.detaches).toBe(1)
    expect(w.api.attachedTabs()).toEqual([])
    page.dbg.notify('Page.loadEventFired', {})
    expect(w.dispatched).toHaveLength(2)
    expect(() => w.api.handlers.detach(w.ctx(EXT), { tabId: 7 })).toThrow(
      'Debugger is not attached to the tab with id: 7.'
    )
  })

  it('holds the page’s session against Zenium’s own holders for as long as it is attached', () => {
    const w = world()
    const page = w.page(7, 'https://a.example/')
    const id = (page.wc as unknown as { id: number }).id
    expect(hasForeignDebuggerOwner(id)).toBe(false)
    w.api.handlers.attach(w.ctx(EXT), { tabId: 7 }, '1.3')
    expect(hasForeignDebuggerOwner(id)).toBe(true)
    w.api.handlers.detach(w.ctx(EXT), { tabId: 7 })
    expect(hasForeignDebuggerOwner(id)).toBe(false)
    // Ended from outside (the engine dropped the session): released as well.
    w.api.handlers.attach(w.ctx(EXT), { tabId: 7 }, '1.3')
    expect(hasForeignDebuggerOwner(id)).toBe(true)
    page.dbg.kick()
    expect(hasForeignDebuggerOwner(id)).toBe(false)
    // Unloading the extension releases every page it held.
    const other = w.page(8, 'https://b.example/')
    w.api.handlers.attach(w.ctx(EXT), { tabId: 8 }, '1.3')
    w.api.unload(EXT)
    expect(hasForeignDebuggerOwner((other.wc as unknown as { id: number }).id)).toBe(false)
  })

  it("refuses what Chrome refuses: no permission, unknown tabs, the browser's pages, another extension's tab", async () => {
    const w = world()
    w.page(1, 'https://a.example/')
    w.page(2, 'zen://newtab/')
    w.page(3, `chrome-extension://${OTHER}/options.html`)
    expect(() => w.api.handlers.attach(w.ctx(NO_PERMISSION), { tabId: 1 }, '1.3')).toThrow(
      "The 'debugger' permission is required."
    )
    expect(() => w.api.handlers.attach(w.ctx(EXT), { tabId: 9 }, '1.3')).toThrow(
      'No tab with given id 9.'
    )
    expect(() => w.api.handlers.attach(w.ctx(EXT), { tabId: 1 }, '0.1')).toThrow(
      'Requested protocol version is not supported: 0.1.'
    )
    expect(() => w.api.handlers.attach(w.ctx(EXT), { tabId: 2 }, '1.3')).toThrow(
      'Cannot access a chrome:// URL'
    )
    expect(() => w.api.handlers.attach(w.ctx(EXT), { tabId: 3 }, '1.3')).toThrow(
      'Cannot access a chrome-extension:// URL of different extension'
    )
    expect(() => w.api.handlers.attach(w.ctx(EXT), { extensionId: OTHER }, '1.3')).toThrow(
      'Cannot attach to this target.'
    )
    expect(() => w.api.handlers.attach(w.ctx(EXT), 'tab', '1.3')).toThrow(/parameter 'target'/)
    w.api.handlers.attach(w.ctx(EXT), { tabId: 1 }, '1.2')
    expect(() => w.api.handlers.attach(w.ctx(OTHER), { tabId: 1 }, '1.3')).toThrow(
      'Another debugger is already attached to the tab with id: 1.'
    )
    expect(() => w.api.handlers.attach(w.ctx(EXT), { tabId: 1 }, '1.3')).toThrow(
      'Another debugger is already attached to the tab with id: 1.'
    )
    await expect(
      w.api.handlers.sendCommand(w.ctx(OTHER), { tabId: 1 }, 'Page.enable')
    ).rejects.toThrow('Debugger is not attached to the tab with id: 1.')
    expect(w.api.attachedTabs()).toEqual([1])
  })

  it("reports a failed command as the protocol's error object in lastError", async () => {
    const w = world()
    const page = w.page(4, 'https://a.example/')
    w.api.handlers.attach(w.ctx(EXT), { targetId: 'tab-4' }, '1.3')
    page.dbg.answer = () => {
      throw new Error("'Foo.bar' wasn't found")
    }
    await expect(w.api.handlers.sendCommand(w.ctx(EXT), { tabId: 4 }, 'Foo.bar')).rejects.toThrow(
      JSON.stringify({ code: -32000, message: "'Foo.bar' wasn't found" })
    )
    await expect(w.api.handlers.sendCommand(w.ctx(EXT), { tabId: 4 }, '')).rejects.toThrow(
      /parameter 'method'/
    )
    await expect(
      w.api.handlers.sendCommand(w.ctx(EXT), { tabId: 4 }, 'Page.enable', 'x')
    ).rejects.toThrow(/parameter 'commandParams'/)
  })

  it('announces onDetach with target_closed when the tab goes or the engine drops the session', () => {
    const w = world()
    const closing = w.page(5, 'https://a.example/')
    const kicked = w.page(6, 'https://b.example/')
    w.api.handlers.attach(w.ctx(EXT), { tabId: 5 }, '1.3')
    w.api.handlers.attach(w.ctx(EXT), { tabId: 6 }, '1.3')
    ;(closing.wc as unknown as { destroy(): void }).destroy()
    kicked.dbg.kick()
    expect(w.dispatched).toEqual([
      {
        extensionId: EXT,
        namespace: 'debugger',
        event: 'onDetach',
        args: [{ tabId: 5 }, 'target_closed']
      },
      {
        extensionId: EXT,
        namespace: 'debugger',
        event: 'onDetach',
        args: [{ tabId: 6 }, 'target_closed']
      }
    ])
    expect(w.api.attachedTabs()).toEqual([])
    // Once: a later notification from the fake finds no listener.
    kicked.dbg.kick()
    expect(w.dispatched).toHaveLength(2)
  })

  it("shares a session Zenium's own holders already opened and leaves it to them on detach", () => {
    const w = world()
    const page = w.page(8, 'https://a.example/')
    page.dbg.attach('1.3')
    w.api.handlers.attach(w.ctx(EXT), { tabId: 8 }, '1.3')
    expect(page.dbg.attachedVersions).toEqual(['1.3'])
    page.dbg.notify('Network.requestWillBeSent', { requestId: '1' })
    expect(w.dispatched.map((d) => d.event)).toEqual(['onEvent'])
    w.api.handlers.detach(w.ctx(EXT), { tabId: 8 })
    expect(page.dbg.isAttached()).toBe(true)
    expect(page.dbg.detaches).toBe(0)
  })

  it('lists the tabs as page targets and ends the sessions of an unloaded extension quietly', () => {
    const w = world()
    w.page(1, 'https://a.example/', 'A')
    const b = w.page(2, 'https://b.example/', 'B')
    ;(b.tab as { favicon: string | null }).favicon = 'https://b.example/favicon.ico'
    w.api.handlers.attach(w.ctx(EXT), { tabId: 2 }, '1.3')
    expect(w.api.handlers.getTargets(w.ctx(EXT))).toEqual([
      {
        type: 'page',
        id: 'tab-1',
        tabId: 1,
        attached: false,
        title: 'A',
        url: 'https://a.example/'
      },
      {
        type: 'page',
        id: 'tab-2',
        tabId: 2,
        attached: true,
        title: 'B',
        url: 'https://b.example/',
        faviconUrl: 'https://b.example/favicon.ico'
      }
    ])
    expect(() => w.api.handlers.getTargets(w.ctx(NO_PERMISSION))).toThrow(/'debugger' permission/)
    w.loaded.delete(EXT)
    w.api.unload(EXT)
    expect(w.api.attachedTabs()).toEqual([])
    expect(w.dispatched).toEqual([])
    // The extension's own session ended with it, not left dangling on the page.
    expect(b.dbg.isAttached()).toBe(false)
    expect(b.dbg.detaches).toBe(1)
  })

  /**
   * Paint holding (in-house fix, row 3): before a new http(s) document's first paint the
   * renderer drops presses, keys, wheels, touches and inserted text with a success ack, so an
   * extension's `Input.*` waits for the paint, bounded; bare moves and every other command go
   * through as they came.
   */
  describe('input before the first paint', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('holds Input.dispatchMouseEvent / KeyEvent / TouchEvent / insertText until the page has painted', async () => {
      const w = world()
      const page = w.page(7, 'https://a.example/')
      page.paintAnswers.splice(0, 1, 'holding', 'holding', 'painted')
      w.api.handlers.attach(w.ctx(EXT), { tabId: 7 }, '1.3')
      const press = w.api.handlers.sendCommand(
        w.ctx(EXT),
        { tabId: 7 },
        'Input.dispatchMouseEvent',
        {
          type: 'mousePressed',
          x: 10,
          y: 20,
          button: 'left'
        }
      )
      await new Promise((r) => setTimeout(r, 5))
      // Asked, holding: the engine has not seen the press.
      expect(page.paintProbes.length).toBeGreaterThanOrEqual(1)
      expect(page.dbg.commands).toEqual([])
      await expect(press).resolves.toEqual({ ok: true })
      expect(page.paintProbes).toHaveLength(3)
      expect(page.dbg.commands.map((c) => c.method)).toEqual(['Input.dispatchMouseEvent'])
      // The document is known to have painted: the rest of the gesture costs no probe.
      await w.api.handlers.sendCommand(w.ctx(EXT), { tabId: 7 }, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: 10,
        y: 20,
        button: 'left'
      })
      await w.api.handlers.sendCommand(w.ctx(EXT), { tabId: 7 }, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a'
      })
      await w.api.handlers.sendCommand(w.ctx(EXT), { tabId: 7 }, 'Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: []
      })
      await w.api.handlers.sendCommand(w.ctx(EXT), { tabId: 7 }, 'Input.insertText', { text: 'hi' })
      expect(page.paintProbes).toHaveLength(3)
      expect(page.dbg.commands.map((c) => c.method)).toEqual([
        'Input.dispatchMouseEvent',
        'Input.dispatchMouseEvent',
        'Input.dispatchKeyEvent',
        'Input.dispatchTouchEvent',
        'Input.insertText'
      ])
    })

    it('lets a bare mouse move and every other command through without asking', async () => {
      const w = world()
      const page = w.page(8, 'https://a.example/')
      page.paintAnswers.splice(0, 1, 'holding')
      w.api.handlers.attach(w.ctx(EXT), { tabId: 8 }, '1.3')
      await w.api.handlers.sendCommand(w.ctx(EXT), { tabId: 8 }, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: 1,
        y: 1
      })
      await w.api.handlers.sendCommand(w.ctx(EXT), { tabId: 8 }, 'Page.navigate', {
        url: 'https://b.example/'
      })
      await w.api.handlers.sendCommand(w.ctx(EXT), { tabId: 8 }, 'Runtime.evaluate', {
        expression: '1'
      })
      expect(page.paintProbes).toEqual([])
      expect(page.dbg.commands.map((c) => c.method)).toEqual([
        'Input.dispatchMouseEvent',
        'Page.navigate',
        'Runtime.evaluate'
      ])
    })

    it('forwards the input anyway after the deadline, with a warning, when the page never paints', async () => {
      vi.useFakeTimers()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const w = world()
        const page = w.page(9, 'https://a.example/')
        page.paintAnswers.splice(0, 1, 'holding')
        w.api.handlers.attach(w.ctx(EXT), { tabId: 9 }, '1.3')
        let result: unknown = null
        void w.api.handlers
          .sendCommand(w.ctx(EXT), { tabId: 9 }, 'Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'Enter'
          })
          .then((r) => {
            result = r
          })
        await vi.advanceTimersByTimeAsync(9_900)
        expect(page.dbg.commands).toEqual([])
        expect(result).toBeNull()
        await vi.advanceTimersByTimeAsync(200)
        expect(page.dbg.commands.map((c) => c.method)).toEqual(['Input.dispatchKeyEvent'])
        expect(result).toEqual({ ok: true })
        expect(warn).toHaveBeenCalledTimes(1)
        expect(warn.mock.calls[0]?.[0]).toContain('https://a.example/')
      } finally {
        warn.mockRestore()
      }
    })
  })
})
