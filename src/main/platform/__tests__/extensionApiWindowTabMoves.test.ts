import { describe, expect, it, vi } from 'vitest'
import type { Space, Tab } from '../../../shared/types'
import type { ZenWindow } from '../../../core/window'
import { TabsApi } from '../extensionApi/tabs'
import { WindowsApi } from '../extensionApi/windows'
import type { ApiContext, ApiHost } from '../extensionApi/types'

vi.mock('electron', () => ({ BrowserWindow: class {} }))

const EXT = 'abcdefghijklmnopabcdefghijklmnop'

interface FakeWindow {
  id: string
  isPrivate: boolean
  localSpace: Space | null
}

interface FakeBrowserWindow {
  bounds: { x: number; y: number; width: number; height: number }
  /** Events waited on with `once` (`show`, for an unfocused window's blur). */
  awaited: string[]
  getBounds(): { x: number; y: number; width: number; height: number }
  setBounds(b: { x: number; y: number; width: number; height: number }): void
  once(event: string): void
}

interface World {
  tabs: TabsApi
  windows: WindowsApi
  ctx: ApiContext
  own: FakeWindow
  torn: FakeWindow
  /** The window `moveTabToNewWindow` hands back, and what it was asked. */
  tearOffs: Array<{ tabId: string; at: unknown; from: FakeWindow }>
  moves: Array<{ tabId: string; target: unknown; win: FakeWindow }>
  created: Array<{ url?: string; active?: boolean; win: FakeWindow }>
  newWindows: number
  bw: Map<string, FakeBrowserWindow>
  addWindow(win: FakeWindow): number
}

function browserWindow(): FakeBrowserWindow {
  return {
    bounds: { x: 60, y: 40, width: 1280, height: 820 },
    awaited: [],
    getBounds() {
      return { ...this.bounds }
    },
    setBounds(b) {
      this.bounds = { ...b }
    },
    once(event) {
      this.awaited.push(event)
    }
  }
}

function world({ ownPrivate = false } = {}): World {
  const own: FakeWindow = { id: 'w1', isPrivate: ownPrivate, localSpace: null }
  const torn: FakeWindow = {
    id: 'w2',
    isPrivate: ownPrivate,
    localSpace: { id: 'local-w2', tabIds: [] } as unknown as Space
  }
  const tab = { id: 't1', url: 'https://example.com/', pinned: false, essential: false } as Tab
  const other = { id: 't2', url: 'https://example.org/', pinned: false, essential: false } as Tab
  const windows = new Map<number, FakeWindow>([[1, own]])
  const idOf = (win: FakeWindow): number => [...windows].find(([, w]) => w === win)?.[0] ?? -1
  const bw = new Map<string, FakeBrowserWindow>([['w1', browserWindow()]])
  const homes = new Map<string, FakeWindow>([
    ['t1', own],
    ['t2', own]
  ])
  const w: Partial<World> = {
    tearOffs: [],
    moves: [],
    created: [],
    newWindows: 0,
    bw,
    own,
    torn
  }
  const model = {
    zenWindow: (id: number) => windows.get(id),
    zenTab: (id: number) => (id === 7 ? tab : id === 8 ? other : undefined),
    chromeTabId: (t: Tab) => (t.id === 't1' ? 7 : 8),
    chromeTab: (t: Tab) => ({ id: t.id === 't1' ? 7 : 8, url: t.url }),
    windowOfTab: (t: Tab) => homes.get(t.id),
    tabsInWindow: (win: FakeWindow) => [tab, other].filter((t) => homes.get(t.id) === win),
    lastFocusedWindow: () => own,
    setOpener: () => undefined,
    browserWindowOf: (win: FakeWindow) => bw.get(win.id),
    chromeWindow: (win: FakeWindow, populate: boolean) => ({
      id: idOf(win),
      tabs: populate
        ? [tab, other]
            .filter((t) => homes.get(t.id) === win)
            .map((t) => ({ id: t.id === 't1' ? 7 : 8 }))
        : undefined
    }),
    windowIds: () => [...windows.keys()],
    windowIdOf: (win: FakeWindow) => idOf(win)
  }
  const browser = {
    extensions: { list: () => [{ id: EXT, path: '/ext/' + EXT, allowFileAccess: false }] },
    tabs: {
      createTab: (options: { url?: string; active?: boolean }, win: FakeWindow) => {
        w.created!.push({ url: options.url, active: options.active, win })
        return { ...tab, id: 't-new', url: options.url ?? '' }
      },
      // The core's tear-off files the tab in the new window's own space, as `moveTab` does.
      moveTabToNewWindow: (tabId: string, at: unknown, from: FakeWindow) => {
        w.tearOffs!.push({ tabId, at, from })
        windows.set(2, torn)
        bw.set('w2', browserWindow())
        homes.set(tabId, torn)
        const moved = tabId === 't1' ? tab : other
        moved.spaceId = torn.localSpace?.id ?? null
        return torn
      },
      moveTab: (tabId: string, target: { spaceId?: string }, win: FakeWindow) => {
        w.moves!.push({ tabId, target, win })
        homes.set(tabId, win)
        const moved = tabId === 't1' ? tab : other
        moved.spaceId = target.spaceId ?? null
      },
      activeTabFor: () => tab,
      activateTab: () => undefined
    },
    createWindow: () => {
      w.newWindows!++
      const fresh: FakeWindow = { id: 'w9', isPrivate: false, localSpace: null }
      windows.set(9, fresh)
      bw.set('w9', browserWindow())
      return fresh
    }
  }
  const host = {
    browser,
    model,
    canSeeTab: () => true,
    sessions: { get: () => ({}) }
  } as unknown as ApiHost
  const ctx = {
    extensionId: EXT,
    extension: { id: EXT, path: '/ext/' + EXT, manifest: { name: 'Probe' }, sessions: [{}] },
    sender: { kind: 'worker' },
    window: own as unknown as ZenWindow
  } as unknown as ApiContext
  return Object.assign(w, {
    tabs: new TabsApi(host),
    windows: new WindowsApi(host),
    ctx,
    addWindow: (win: FakeWindow) => {
      const id = windows.size + 10
      windows.set(id, win)
      bw.set(win.id, browserWindow())
      return id
    }
  }) as World
}

describe('windows.create({ tabId }) and tabs.move across windows', () => {
  it('carries the tab into a window of its own at the asked bounds, as Chrome moves it into the created window (Tab Resize, Dualless)', () => {
    const w = world()
    const record = w.windows.handlers.create(w.ctx, {
      tabId: 7,
      left: 700,
      top: 0,
      width: 700,
      height: 900
    }) as { id: number; tabs?: Array<{ id: number }> }
    expect(w.tearOffs).toEqual([{ tabId: 't1', at: null, from: w.own }])
    expect(w.newWindows).toBe(0)
    expect(w.created).toEqual([])
    expect(w.bw.get('w2')?.bounds).toEqual({ x: 700, y: 0, width: 700, height: 900 })
    expect(w.bw.get('w1')?.bounds).toEqual({ x: 60, y: 40, width: 1280, height: 820 })
    expect(w.bw.get('w2')?.awaited).toEqual([])
    expect(record.id).toBe(2)
    expect(record.tabs).toEqual([{ id: 7 }])
    const quiet = world()
    quiet.windows.handlers.create(quiet.ctx, { tabId: 7, focused: false })
    expect(quiet.bw.get('w2')?.awaited).toEqual(['show'])
  })

  it('opens the URLs beside the moved tab, and a popup asked to carry a tab gets the tab a window too', () => {
    const w = world()
    w.windows.handlers.create(w.ctx, { tabId: 7, url: 'https://example.net/' })
    expect(w.tearOffs).toHaveLength(1)
    expect(w.created).toEqual([{ url: 'https://example.net/', active: false, win: w.torn }])
    const again = world()
    again.windows.handlers.create(again.ctx, { tabId: 7, type: 'popup', width: 400, height: 300 })
    expect(again.tearOffs).toHaveLength(1)
    expect(again.bw.get('w2')?.bounds).toEqual({ x: 60, y: 40, width: 400, height: 300 })
  })

  it("refuses an unknown tab and a tab of another profile with Chrome's texts, before any window is made", () => {
    const w = world()
    expect(() => w.windows.handlers.create(w.ctx, { tabId: 99 })).toThrow('No tab with id: 99.')
    expect(() => w.windows.handlers.create(w.ctx, { tabId: 7, incognito: true })).toThrow(
      'Tabs can only be moved between windows in the same profile.'
    )
    expect(() => w.windows.handlers.create(w.ctx, { tabId: 'x' })).toThrow('Invalid tab id')
    expect(w.tearOffs).toEqual([])
    expect(w.newWindows).toBe(0)
  })

  it('tabs.move takes a tab into a window that owns its tabs, at the index asked, and keeps refusing synced and other-profile windows', () => {
    const w = world()
    w.windows.handlers.create(w.ctx, { tabId: 7 })
    // Tab Resize's follow-up: the remaining tabs into the window it just made, at index 1.
    const moved = w.tabs.handlers.move(w.ctx, 8, { windowId: 2, index: 1 }) as { id: number }
    expect(moved.id).toBe(8)
    expect(w.moves).toEqual([
      { tabId: 't2', target: { spaceId: 'local-w2', section: 'regular', index: 1 }, win: w.torn }
    ])
    const synced = w.addWindow({ id: 'w3', isPrivate: false, localSpace: null })
    expect(() => w.tabs.handlers.move(w.ctx, 8, { windowId: synced, index: 0 })).toThrow(
      'Tabs can only be moved within their own window in Zenium.'
    )
    const priv = w.addWindow({
      id: 'w4',
      isPrivate: true,
      localSpace: { id: 'local-w4', tabIds: [] } as unknown as Space
    })
    expect(() => w.tabs.handlers.move(w.ctx, 8, { windowId: priv, index: 0 })).toThrow(
      'Tabs can only be moved between windows in the same profile.'
    )
    expect(w.moves).toHaveLength(1)
  })
})
