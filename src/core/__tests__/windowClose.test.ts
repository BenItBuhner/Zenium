import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { Browser } from '../browser'
import type {
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'
import type { ZenWindow } from '../window'

function memoryIo(): StoreIO {
  const files: Record<string, string> = {}
  return {
    readSync: (name) => files[name] ?? null,
    write: async (name, text) => {
      files[name] = text
    },
    writeSync: (name, text) => {
      files[name] = text
    }
  }
}

/** Anything the browser touches on the host answers with a harmless no-op. */
function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

/**
 * A page as the host sees it. Once destroyed, only the placement calls and `isDestroyed()` stay
 * legal (Electron's `WebContentsView` outlives its `WebContents`); everything else Electron would
 * answer with "Object has been destroyed", so it is recorded for the assertions.
 */
interface FakeView {
  readonly tabId: string
  view: TabView
  readonly events: TabViewEvents
  destroyed: boolean
  destroyCalls: number
  attachedTo: WindowHost | null
  readonly usedAfterDestroy: string[]
}

const SAFE_AFTER_DESTROY = new Set<string | symbol>([
  'isDestroyed',
  'destroy',
  'attachTo',
  'detach',
  'setBounds',
  'setBorderRadius',
  'setVisible',
  'isVisible',
  'bringToFront',
  'setBackgroundColor',
  'then'
])

function fakeView(tab: Tab, events: TabViewEvents, host: WindowHost): FakeView {
  let url = ''
  let visible = false
  const fake: FakeView = {
    tabId: tab.id,
    events,
    destroyed: false,
    destroyCalls: 0,
    attachedTo: host,
    usedAfterDestroy: [],
    view: undefined as unknown as TabView
  }
  const overrides: Partial<TabView> = {
    isDestroyed: () => fake.destroyed,
    destroy: () => {
      fake.destroyCalls += 1
      fake.destroyed = true
      fake.attachedTo = null
    },
    attachTo: (h) => {
      fake.attachedTo = h
    },
    detach: () => {
      fake.attachedTo = null
    },
    setVisible: (v) => {
      visible = v
    },
    isVisible: () => visible,
    loadURL: (u) => {
      url = u
    },
    getURL: () => url,
    getTitle: () => '',
    hasDocument: () => url !== '',
    canGoBack: () => false,
    canGoForward: () => false,
    getZoom: () => 1,
    isCurrentlyAudible: () => false
  }
  fake.view = new Proxy(overrides as TabView, {
    get: (target, key) => {
      if (fake.destroyed && !SAFE_AFTER_DESTROY.has(key)) fake.usedAfterDestroy.push(String(key))
      return key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
    }
  })
  return fake
}

interface Fixture {
  browser: Browser
  views: FakeView[]
  /** The host side of closing a window: `close` fires before destruction, `closed` after it. */
  closeWindow(win: ZenWindow): void
}

function fixture(): Fixture {
  const views: FakeView[] = []
  const alive = new Map<ZenWindow, boolean>()
  const capabilities = stub<HostCapabilities>({ windows: true, updates: false, agents: false })
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities,
    io: memoryIo(),
    windows: {
      create: (win) => {
        alive.set(win, true)
        return stub<WindowHost>({
          get alive() {
            return alive.get(win) ?? false
          },
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => false,
          isVisible: () => true
        })
      }
    },
    views: stub<TabViewHost>({
      createView: (tab, events, host) => {
        const fake = fakeView(tab, events, host)
        views.push(fake)
        return fake.view
      }
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub(),
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  return {
    browser,
    views,
    closeWindow: (win) => {
      win.onClosing()
      alive.set(win, false)
      win.onClosed()
    }
  }
}

/** Electron emits `destroyed` asynchronously, after the core has already dropped its records. */
function fireLateDestroyed(views: FakeView[]): void {
  for (const v of views) v.events.onDestroyed()
}

describe('closing windows and quitting', () => {
  it('destroys every page of the last window exactly once and tolerates the late destroyed events', () => {
    const f = fixture()
    const win = f.browser.allWindows()[0]
    const a = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    const b = f.browser.tabs.createTab({ url: 'https://example.org/', active: true }, win)
    expect(f.views.map((v) => v.tabId)).toEqual([a.id, b.id])
    expect(f.browser.tabs.loadedCount()).toBe(2)

    f.closeWindow(win)

    expect(f.browser.allWindows()).toHaveLength(0)
    expect(f.browser.tabs.loadedCount()).toBe(0)
    for (const v of f.views) {
      expect(v.destroyCalls).toBe(1)
      expect(v.attachedTo).toBeNull()
      expect(f.browser.tabs.view(v.tabId)).toBeUndefined()
    }
    expect(() => fireLateDestroyed(f.views)).not.toThrow()
    expect(() => f.browser.tabs.destroyAll()).not.toThrow()
    for (const v of f.views) {
      expect(v.destroyCalls).toBe(1)
      expect(v.usedAfterDestroy).toEqual([])
    }
    // The tabs survive for session restore, unloaded.
    expect(f.browser.tabs.tab(a.id)?.discarded).toBe(true)
    expect(f.browser.tabs.tab(b.id)?.discarded).toBe(true)
  })

  it('hands the pages of a closing window to a surviving synced window instead of destroying them', () => {
    const f = fixture()
    const first = f.browser.allWindows()[0]
    const tab = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, first)
    const second = f.browser.openWindow('synced', first)
    expect(second).not.toBeNull()
    if (!second) return
    const view = f.views[0]
    expect(view.attachedTo).toBe(first.host)

    f.closeWindow(first)

    expect(f.browser.allWindows()).toEqual([second])
    expect(view.destroyCalls).toBe(0)
    expect(view.attachedTo).toBe(second.host)
    expect(f.browser.tabs.ownerOf(tab.id)).toBe(second)
    expect(f.browser.tabs.view(tab.id)).toBe(view.view)
    expect(view.usedAfterDestroy).toEqual([])
  })

  it('closing the window that merely previews a page leaves the owner untouched', () => {
    const f = fixture()
    const first = f.browser.allWindows()[0]
    const tab = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, first)
    const second = f.browser.openWindow('synced', first)
    if (!second) throw new Error('no second window')
    // Focusing the new window moves the live page there (the first window shows a preview).
    f.browser.onWindowFocused(second)
    const view = f.views[0]
    expect(view.attachedTo).toBe(second.host)

    f.closeWindow(first)

    expect(view.destroyCalls).toBe(0)
    expect(f.browser.tabs.ownerOf(tab.id)).toBe(second)
    expect(view.usedAfterDestroy).toEqual([])
  })

  it('quitting with three tabs across two windows destroys each page once and only once', () => {
    const f = fixture()
    const first = f.browser.allWindows()[0]
    f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, first)
    f.browser.tabs.createTab({ url: 'https://example.org/', active: true }, first)
    const second = f.browser.openWindow('synced', first)
    if (!second) throw new Error('no second window')
    f.browser.tabs.createTab({ url: 'https://example.net/', active: true }, second)
    expect(f.views).toHaveLength(3)

    f.browser.shutdown()
    expect(f.browser.quitting).toBe(true)
    // Electron closes the windows one after another while quitting.
    f.closeWindow(first)
    expect(f.views.filter((v) => v.destroyed)).toHaveLength(0)
    f.closeWindow(second)

    expect(f.browser.allWindows()).toHaveLength(0)
    expect(f.browser.tabs.loadedCount()).toBe(0)
    for (const v of f.views) expect(v.destroyCalls).toBe(1)
    expect(() => fireLateDestroyed(f.views)).not.toThrow()
    for (const v of f.views) expect(v.usedAfterDestroy).toEqual([])
    // Nothing is persisted after the final flush, and the tabs stay in the model for restore.
    expect(Object.keys(f.browser.state.model.tabs)).toHaveLength(3)
  })
})
