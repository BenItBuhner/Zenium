import { describe, expect, it } from 'vitest'
import {
  PRIVATE_CONTAINER_ID,
  type HostCapabilities,
  type Platform as PlatformOs,
  type Tab
} from '../../shared/types'
import { Browser } from '../browser'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import type { ZenWindow } from '../window'

/**
 * Duplicate Window (session-19): a second window like this one – its kind, its space, its tabs
 * (a blank or private window's as copies: the addresses in their order, pinned as they are, not
 * the pages' state), the same tab selected – cascaded from the original, which stays as it was.
 */

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

function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

interface FakeView {
  readonly tabId: string
  view: TabView
  loads: string[]
}

function fakeView(tab: Tab): FakeView {
  let url = ''
  const fake: FakeView = { tabId: tab.id, loads: [], view: undefined as unknown as TabView }
  const overrides: Partial<TabView> = {
    isDestroyed: () => false,
    isVisible: () => false,
    loadURL: (u) => {
      fake.loads.push(u)
      url = u
    },
    getURL: () => url,
    getTitle: () => '',
    hasDocument: () => url !== '',
    getZoom: () => 1,
    isCurrentlyAudible: () => false
  }
  fake.view = new Proxy(overrides as TabView, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
  return fake
}

/** What the host was asked for when each window was made. */
interface Created {
  id: string
  cascadeFrom: string | null
  title: string
}

interface Harness {
  browser: Browser
  win: ZenWindow
  created: Created[]
  viewOf: (tabId: string) => FakeView
  /** The URLs of `win`'s space, in strip order, each marked `*` when pinned. */
  strip: (win: ZenWindow) => string[]
}

function harness(capabilities: Partial<HostCapabilities> = {}): Harness {
  const views: FakeView[] = []
  const created: Created[] = []
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '1.2.3' },
    capabilities: stub<HostCapabilities>({ windows: true, nativeMenus: true, ...capabilities }),
    io: memoryIo(),
    windows: {
      create: (win, opts) => {
        created.push({ id: win.id, cascadeFrom: opts.cascadeFrom?.id ?? null, title: opts.title })
        return stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true
        })
      }
    },
    views: stub<TabViewHost>({
      createView: (tab) => {
        const fake = fakeView(tab)
        views.push(fake)
        return fake.view
      }
    }),
    menus: { popup: () => undefined },
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
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  return {
    browser,
    win,
    created,
    viewOf: (tabId) => {
      const v = [...views].reverse().find((x) => x.tabId === tabId)
      if (!v) throw new Error(`no view for ${tabId}`)
      return v
    },
    strip: (w) =>
      w.activeSpace().tabIds.map((id) => {
        const tab = browser.tabs.tab(id)
        if (!tab) throw new Error(`no tab ${id}`)
        return tab.pinned ? `*${tab.url}` : tab.url
      })
  }
}

describe('Duplicate Window (session-19)', () => {
  it('a synced window: a second synced window on the same space with the same tab selected, cascaded from the first – the tabs are shared, not copied', () => {
    const h = harness()
    const a = h.browser.tabs.createTab({ url: 'https://a.test/' }, h.win)
    const b = h.browser.tabs.createTab({ url: 'https://b.test/' }, h.win)
    h.browser.tabs.activateTab(a.id, h.win)
    h.win.compactEnabled = true
    const tabsBefore = Object.keys(h.browser.state.model.tabs).length
    const stripBefore = h.strip(h.win)

    const dup = h.browser.duplicateWindow(h.win)
    expect(dup).not.toBeNull()
    if (!dup) return
    expect(h.browser.allWindows()).toHaveLength(2)
    expect(dup.kind).toBe('synced')
    expect(dup.chrome).toBe('full')
    expect(dup.activeSpace().id).toBe(h.win.activeSpace().id)
    expect(dup.selectedTabIn(dup.activeSpace())).toBe(a.id)
    expect(dup.compactEnabled).toBe(true)
    // Placed offset from the original: the host cascades it from the window it came from.
    expect(dup.cascadeFrom).toBe(h.win)
    expect(h.created.at(-1)).toEqual({ id: dup.id, cascadeFrom: h.win.id, title: 'Zenium' })
    // Nothing was copied – synced windows show the model's tabs – and the original is as it was.
    expect(Object.keys(h.browser.state.model.tabs)).toHaveLength(tabsBefore)
    expect(h.strip(h.win)).toEqual(stripBefore)
    expect(h.strip(dup)).toEqual(stripBefore)
    expect(h.win.selectedTabIn(h.win.activeSpace())).toBe(a.id)
    expect(h.browser.tabs.tab(b.id)?.url).toBe('https://b.test/')
  })

  it('a blank window: copies of its tabs – the addresses in their order, pinned as they were, the same one selected – as fresh loads, the original untouched', () => {
    const h = harness()
    const blank = h.browser.openWindow('unsynced', h.win)
    expect(blank).not.toBeNull()
    if (!blank) return
    h.browser.tabs.createTab({ url: 'https://pinned.test/', pinned: true }, blank)
    const one = h.browser.tabs.createTab({ url: 'https://one.test/' }, blank)
    h.browser.tabs.createTab({ url: 'https://two.test/' }, blank)
    h.browser.tabs.activateTab(one.id, blank)
    const sourceIds = [...blank.activeSpace().tabIds]
    const stripBefore = h.strip(blank)
    expect(stripBefore).toContain('*https://pinned.test/')

    const dup = h.browser.duplicateWindow(blank)
    expect(dup).not.toBeNull()
    if (!dup) return
    expect(h.browser.allWindows()).toHaveLength(3)
    expect(dup.kind).toBe('unsynced')
    expect(dup.localSpace).not.toBeNull()
    expect(dup.localSpace).not.toBe(blank.localSpace)
    expect(dup.activeSpace().containerId).toBe(blank.activeSpace().containerId)
    expect(dup.cascadeFrom).toBe(blank)
    // The same strip, tab for tab, made of new tabs.
    expect(h.strip(dup)).toEqual(stripBefore)
    const copyIds = dup.activeSpace().tabIds
    expect(copyIds.some((id) => sourceIds.includes(id))).toBe(false)
    for (const id of copyIds) expect(h.browser.tabs.tab(id)?.windowId).toBe(dup.id)
    // The selected tab's copy is the one shown, loaded afresh; the others wait to be picked.
    const shown = dup.selectedTabIn(dup.activeSpace())
    expect(h.browser.tabs.tab(shown ?? '')?.url).toBe('https://one.test/')
    expect(h.viewOf(shown!).loads).toEqual(['https://one.test/'])
    for (const id of copyIds) if (id !== shown) expect(() => h.viewOf(id)).toThrow()
    // The original: the same tabs, the same selection.
    expect(blank.activeSpace().tabIds).toEqual(sourceIds)
    expect(blank.selectedTabIn(blank.activeSpace())).toBe(one.id)
  })

  it('a private window duplicates into a private window: its copies are private tabs', () => {
    const h = harness()
    const priv = h.browser.openWindow('private', h.win)
    expect(priv).not.toBeNull()
    if (!priv) return
    h.browser.tabs.createTab({ url: 'https://secret.test/' }, priv)

    const dup = h.browser.duplicateWindow(priv)
    expect(dup).not.toBeNull()
    if (!dup) return
    expect(dup.isPrivate).toBe(true)
    expect(dup.activeSpace().containerId).toBe(PRIVATE_CONTAINER_ID)
    expect(h.strip(dup)).toEqual(h.strip(priv))
    for (const id of dup.activeSpace().tabIds)
      expect(h.browser.tabs.tab(id)?.containerId).toBe(PRIVATE_CONTAINER_ID)
    expect(h.created.at(-1)?.title).toBe('Zenium (Private Browsing)')
  })

  it('a popup has no tab strip to duplicate, and a host with one window nothing to duplicate into', () => {
    const h = harness()
    const popup = h.browser.createWindow({
      kind: 'synced',
      from: h.win,
      chrome: 'popup',
      bounds: { x: 20, y: 20, width: 400, height: 300 }
    })
    const before = h.browser.allWindows().length
    expect(h.browser.duplicateWindow(popup)).toBeNull()
    expect(h.browser.allWindows()).toHaveLength(before)

    const one = harness({ windows: false })
    expect(one.browser.duplicateWindow(one.win)).toBeNull()
    expect(one.browser.allWindows()).toHaveLength(1)
  })

  it('the window.duplicate action (the menus’ rows, a bound key) runs it on the window it came from', () => {
    const h = harness()
    h.browser.actions.run('window.duplicate', { sourceTabId: null, win: h.win })
    const windows = h.browser.allWindows()
    expect(windows).toHaveLength(2)
    const dup = windows.find((w) => w !== h.win)
    expect(dup?.cascadeFrom).toBe(h.win)
    expect(dup?.activeSpace().id).toBe(h.win.activeSpace().id)
  })
})
