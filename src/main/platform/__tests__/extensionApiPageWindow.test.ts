import { describe, expect, it, vi } from 'vitest'
import type { Space, Tab } from '../../../shared/types'
import type { Browser } from '../../../core/browser'
import type { ZenWindow } from '../../../core/window'
import { ApiModel, type ModelSnapshot, visibleToExtensions } from '../extensionApi/model'
import { TabsApi } from '../extensionApi/tabs'
import { WindowsApi } from '../extensionApi/windows'
import { WINDOW_ID_NONE, type ApiContext, type ApiHost } from '../extensionApi/types'
import type { ElectronTabViewHost } from '../views'

/**
 * A stand-in for Electron's `BrowserWindow` with the focus and bounds the differ reads, and the
 * task manager page's WebContents – a guessable numeric id – that `tabs.get` may be asked for.
 */
const { FakeBrowserWindow, TASKS_WC_ID, tasksWebContents } = vi.hoisted(() => {
  class FakeBrowserWindow {
    focused = false
    destroyed = false
    bounds = { x: 40, y: 40, width: 1280, height: 820 }
    constructor(readonly id: number) {}
    static fromWebContents(): null {
      return null
    }
    getBounds(): { x: number; y: number; width: number; height: number } {
      return { ...this.bounds }
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    isFocused(): boolean {
      return this.focused && !this.destroyed
    }
    isMinimized(): boolean {
      return false
    }
    isFullScreen(): boolean {
      return false
    }
    isMaximized(): boolean {
      return false
    }
    isAlwaysOnTop(): boolean {
      return false
    }
    on(): this {
      return this
    }
    once(): this {
      return this
    }
  }
  const TASKS_WC_ID = 777
  const tasksWebContents = { id: TASKS_WC_ID, isDestroyed: () => false }
  return { FakeBrowserWindow, TASKS_WC_ID, tasksWebContents }
})

vi.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  webContents: { fromId: (id: number) => (id === TASKS_WC_ID ? tasksWebContents : undefined) }
}))

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const HOME_URL = 'https://example.com/'
const TASKS_URL = 'zen://tasks'

interface Broadcast {
  namespace: string
  event: string
  args: unknown[] | null
}

interface World {
  model: ApiModel
  windows: WindowsApi
  tabs: TabsApi
  ctx: ApiContext
  full: ZenWindow
  page: ZenWindow
  bwFull: InstanceType<typeof FakeBrowserWindow>
  bwPage: InstanceType<typeof FakeBrowserWindow>
  fullId: number
  pageId: number
  tasksTab: Tab
  broadcasts: Broadcast[]
  closed: string[]
  /** `Browser.openTaskManager`: an unsynced `page` window holding the one `zen://tasks` tab. */
  openPage(): void
  /** The page window is closed: its tab and local space go with it, as the core's teardown does. */
  closePage(): void
  closeFull(): void
  focus(bw: InstanceType<typeof FakeBrowserWindow> | null): void
  /** The window ids the broadcasts of one event name, in order. */
  named(event: string): number[]
}

function tab(id: string, url: string, spaceId: string, windowId: string | null): Tab {
  return {
    id,
    url,
    title: id,
    spaceId,
    windowId,
    containerId: 'default',
    pinned: false,
    essential: false,
    discarded: false,
    loading: false,
    audible: false,
    muted: false,
    frozen: false,
    zoom: 1,
    lastActiveAt: 1
  } as unknown as Tab
}

function world(): World {
  const bwFull = new FakeBrowserWindow(11)
  const bwPage = new FakeBrowserWindow(12)
  const home = tab('home', HOME_URL, 's1', null)
  const space = {
    id: 's1',
    tabIds: ['home'],
    windowId: null,
    containerId: 'default'
  } as unknown as Space
  const pageSpace = {
    id: 'local-w-page',
    tabIds: ['tasks'],
    windowId: 'w-page',
    containerId: 'default'
  } as unknown as Space
  const tasksTab = tab('tasks', TASKS_URL, pageSpace.id, 'w-page')
  const state = {
    model: {
      tabs: { home } as Record<string, Tab>,
      spaces: [space],
      localSpaces: {} as Record<string, Space>,
      folders: {},
      essentialTabIds: [] as string[]
    }
  }
  const zenWindow = (
    id: string,
    chrome: 'full' | 'page',
    bw: InstanceType<typeof FakeBrowserWindow>,
    localSpace: Space | null,
    lastFocusedAt: number
  ): ZenWindow =>
    ({
      id,
      kind: localSpace ? 'unsynced' : 'synced',
      chrome,
      isPrivate: false,
      lastFocusedAt,
      localSpace,
      glance: null,
      get alive() {
        return !bw.destroyed
      },
      host: {
        get alive() {
          return !bw.destroyed
        },
        win: bw,
        isFocused: () => bw.isFocused(),
        close: () => undefined
      },
      activeSpace: () => localSpace ?? space,
      selectedTabIn: (s: Space) => s.tabIds[0] ?? null
    }) as unknown as ZenWindow
  const full = zenWindow('w-full', 'full', bwFull, null, 10)
  // Opened after – and so focused after – the browser window.
  const page = zenWindow('w-page', 'page', bwPage, pageSpace, 20)
  const alive: ZenWindow[] = [full]
  const owners = new Map<string, ZenWindow>([['home', full]])
  const closed: string[] = []
  const tasksView = {
    webContents: tasksWebContents,
    isDestroyed: () => false,
    view: { getBounds: () => ({ x: 0, y: 0, width: 960, height: 640 }) }
  }
  const browser = {
    allWindows: () => [...alive],
    state,
    tabs: {
      view: (id: string) => (id === 'tasks' && alive.includes(page) ? tasksView : undefined),
      ownerOf: (id: string) => owners.get(id),
      visibleTabIds: (win: ZenWindow) => win.activeSpace().tabIds,
      activeTabFor: (win: ZenWindow) => state.model.tabs[win.activeSpace().tabIds[0] ?? ''],
      closeTab: (id: string) => closed.push(id),
      navigate: () => undefined,
      toggleMute: () => undefined,
      activateTab: () => undefined,
      togglePin: () => undefined
    },
    extensions: { list: () => [{ id: EXT, path: '/ext/' + EXT, allowFileAccess: false }] }
  } as unknown as Browser
  const views = {
    viewForTab: () => undefined,
    tabIdForWebContents: (wc: { id: number }) => (wc.id === TASKS_WC_ID ? 'tasks' : undefined)
  } as unknown as ElectronTabViewHost
  const model = new ApiModel(browser, views)
  const broadcasts: Broadcast[] = []
  const extension = {
    id: EXT,
    path: '/ext/' + EXT,
    manifest: { name: 'Probe', permissions: ['tabs'] },
    sessions: [{}]
  }
  const host = {
    browser,
    model,
    canSeeTab: () => true,
    scheduleTick: () => undefined,
    sessions: { get: () => ({}) },
    broadcast: (namespace: string, event: string, argsFor: (ext: unknown) => unknown[] | null) =>
      broadcasts.push({ namespace, event, args: argsFor(extension) })
  } as unknown as ApiHost
  // A service worker: no window of its own, so "current" is the last focused one.
  const ctx = {
    extensionId: EXT,
    extension,
    sender: { kind: 'worker' },
    window: undefined
  } as unknown as ApiContext
  return {
    model,
    windows: new WindowsApi(host),
    tabs: new TabsApi(host),
    ctx,
    full,
    page,
    bwFull,
    bwPage,
    fullId: bwFull.id,
    pageId: bwPage.id,
    tasksTab,
    broadcasts,
    closed,
    openPage() {
      alive.push(page)
      state.model.tabs.tasks = tasksTab
      state.model.localSpaces[pageSpace.id] = pageSpace
      owners.set('tasks', page)
    },
    closePage() {
      alive.splice(alive.indexOf(page), 1)
      bwPage.destroyed = true
      bwPage.focused = false
      delete state.model.tabs.tasks
      delete state.model.localSpaces[pageSpace.id]
      owners.delete('tasks')
    },
    closeFull() {
      alive.splice(alive.indexOf(full), 1)
      bwFull.destroyed = true
      bwFull.focused = false
    },
    focus(bw) {
      bwFull.focused = bw === bwFull
      bwPage.focused = bw === bwPage
    },
    named(event) {
      return broadcasts
        .filter((b) => b.namespace === 'windows' && b.event === event && b.args)
        .map((b) => {
          const first = b.args?.[0]
          return typeof first === 'number' ? first : (first as { id: number }).id
        })
    }
  }
}

const EMPTY: ModelSnapshot = { tabs: new Map(), windows: new Map(), focused: WINDOW_ID_NONE }

describe('the task manager’s page window is invisible to chrome.windows and chrome.tabs', () => {
  it('a page window is not one extensions see; every other chrome is', () => {
    const w = world()
    expect(visibleToExtensions(w.full)).toBe(true)
    expect(visibleToExtensions({ chrome: 'popup' } as ZenWindow)).toBe(true)
    expect(visibleToExtensions({ chrome: 'app' } as ZenWindow)).toBe(true)
    expect(visibleToExtensions(w.page)).toBe(false)
  })

  it('windows.getAll lists the browser window alone, get refuses the page window’s id, and getLastFocused is the browser window while the page window has focus', () => {
    const w = world()
    w.openPage()
    w.focus(w.bwPage)
    const all = w.windows.handlers.getAll(w.ctx, { populate: true }) as Array<{
      id: number
      type: string
      tabs?: Array<{ url?: string }>
    }>
    expect(all.map((win) => win.id)).toEqual([w.fullId])
    expect(all.flatMap((win) => (win.tabs ?? []).map((t) => t.url))).toEqual([HOME_URL])
    // Nor does the page window turn up as a popup, the type its chrome would have mapped to.
    expect(w.windows.handlers.getAll(w.ctx, { windowTypes: ['popup'] })).toEqual([])
    expect(() => w.windows.handlers.get(w.ctx, w.pageId, {})).toThrow(
      `No window with id: ${w.pageId}.`
    )
    expect(w.model.windowIds()).toEqual([w.fullId])
    expect(w.model.zenWindow(w.pageId)).toBeUndefined()
    const last = w.windows.handlers.getLastFocused(w.ctx, {}) as { id: number; focused: boolean }
    expect(last.id).toBe(w.fullId)
    expect(last.focused).toBe(false)
    expect(w.model.lastFocusedWindow()).toBe(w.full)
  })

  it('tabs.query never lists the page window’s tab, and tabs.get / update / remove refuse its WebContents id', () => {
    const w = world()
    w.openPage()
    const listed = w.tabs.handlers.query(w.ctx, {}) as Array<{ url?: string; windowId: number }>
    expect(listed.map((t) => t.url)).toEqual([HOME_URL])
    expect(listed.map((t) => t.windowId)).toEqual([w.fullId])
    expect(w.tabs.handlers.query(w.ctx, { url: 'zen://*/*' })).toEqual([])
    expect(() => w.tabs.handlers.get(w.ctx, TASKS_WC_ID)).toThrow(`No tab with id: ${TASKS_WC_ID}.`)
    expect(() => w.tabs.handlers.update(w.ctx, TASKS_WC_ID, { muted: true })).toThrow(
      `No tab with id: ${TASKS_WC_ID}.`
    )
    expect(() => w.tabs.handlers.remove(w.ctx, TASKS_WC_ID)).toThrow(
      `No tab with id: ${TASKS_WC_ID}.`
    )
    expect(w.closed).toEqual([])
    expect(w.model.allTabs().map((t) => t.id)).toEqual(['home'])
    expect(w.model.tab('tasks')).toBeUndefined()
    expect(w.model.zenTab(TASKS_WC_ID)).toBeUndefined()
    expect(w.model.windowOfTab(w.tasksTab)).toBeUndefined()
    // The browser window's own tab is untouched by the filter.
    expect(w.model.tab('home')?.id).toBe('home')
  })

  it('the differ broadcasts no onCreated / onBoundsChanged / onRemoved for the page window’s open, move and close, while the browser window’s own fire', () => {
    const w = world()
    const s0 = w.model.snapshot()
    w.windows.diff(EMPTY, s0)
    expect(w.named('onCreated')).toEqual([w.fullId])
    w.openPage()
    const s1 = w.model.snapshot()
    expect([...s1.windows.keys()]).toEqual([w.fullId])
    expect([...s1.tabs.keys()]).toEqual(['home'])
    w.windows.diff(s0, s1)
    // Both windows move; only the browser window's move is an event.
    w.bwPage.bounds = { ...w.bwPage.bounds, x: 300, y: 200 }
    w.bwFull.bounds = { ...w.bwFull.bounds, x: 100 }
    const s2 = w.model.snapshot()
    w.windows.diff(s1, s2)
    w.closePage()
    const s3 = w.model.snapshot()
    w.windows.diff(s2, s3)
    w.closeFull()
    const s4 = w.model.snapshot()
    w.windows.diff(s3, s4)
    expect(w.named('onCreated')).toEqual([w.fullId])
    expect(w.named('onBoundsChanged')).toEqual([w.fullId])
    expect(w.named('onRemoved')).toEqual([w.fullId])
    const namingPage = w.broadcasts.filter((b) => {
      const first = b.args?.[0]
      const id = typeof first === 'number' ? first : (first as { id?: number } | undefined)?.id
      return id === w.pageId
    })
    expect(namingPage).toEqual([])
  })

  it('snapshot().focused is WINDOW_ID_NONE while the page window holds focus, and onFocusChanged carries -1 there and the browser window’s id when focus returns', () => {
    const w = world()
    w.openPage()
    w.focus(w.bwFull)
    const s1 = w.model.snapshot()
    expect(s1.focused).toBe(w.fullId)
    w.focus(w.bwPage)
    const s2 = w.model.snapshot()
    expect(s2.focused).toBe(WINDOW_ID_NONE)
    expect(w.model.focusedWindowId()).toBe(WINDOW_ID_NONE)
    w.windows.diff(s1, s2)
    expect(w.named('onFocusChanged')).toEqual([WINDOW_ID_NONE])
    w.focus(w.bwFull)
    const s3 = w.model.snapshot()
    w.windows.diff(s2, s3)
    expect(w.named('onFocusChanged')).toEqual([WINDOW_ID_NONE, w.fullId])
    // The page window is a sibling to nothing: the browser window stays the current window.
    expect(w.model.currentWindowId(w.ctx.sender, undefined)).toBe(w.fullId)
    w.focus(w.bwPage)
    expect(w.model.currentWindowId(w.ctx.sender, undefined)).toBe(w.fullId)
  })
})
