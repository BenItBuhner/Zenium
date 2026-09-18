import { describe, expect, it } from 'vitest'
import type { Rect, Tab } from '../../../shared/types'
import type { ZenWindow } from '../../window'
import {
  ERROR_INVALID_BEHAVIOR,
  ERROR_INVALID_OPTIONS,
  ERROR_NO_PERMISSION,
  ERROR_NO_TARGET,
  SidePanelOptions,
  manifestPanelPath,
  noPanelForTab,
  noPanelForWindow,
  noTab,
  normalizeGetOptions,
  normalizeOpenOptions,
  normalizePanelBehavior,
  normalizePanelOptions
} from '../api/sidePanel'
import { SidePanelApi } from '../../../main/platform/extensionApi/sidePanel'
import type {
  PanelView,
  PanelViewHooks,
  PanelViewHost
} from '../../../main/platform/extensionApi/sidePanelBridge'
import type {
  ApiContext,
  ApiHost,
  LoadedExtension
} from '../../../main/platform/extensionApi/types'

// ---------------------------------------------------------------------------
// Pure: argument checks
// ---------------------------------------------------------------------------

describe('sidePanel argument checks', () => {
  it('normalizes options: leading slashes go, other fields pass through', () => {
    expect(normalizePanelOptions({ path: '/panel.html', enabled: false, tabId: 3 })).toEqual({
      path: 'panel.html',
      enabled: false,
      tabId: 3
    })
    expect(normalizePanelOptions({})).toEqual({})
  })

  it('rejects absolute URLs, empty paths, bad tab ids and non-boolean enabled', () => {
    expect(() => normalizePanelOptions({ path: 'https://x.test/' })).toThrow(ERROR_INVALID_OPTIONS)
    expect(() => normalizePanelOptions({ path: '' })).toThrow(ERROR_INVALID_OPTIONS)
    expect(() => normalizePanelOptions({ tabId: -1 })).toThrow(ERROR_INVALID_OPTIONS)
    expect(() => normalizePanelOptions({ tabId: 1.5 })).toThrow(ERROR_INVALID_OPTIONS)
    expect(() => normalizePanelOptions({ enabled: 'yes' })).toThrow(ERROR_INVALID_OPTIONS)
    expect(() => normalizePanelOptions('panel.html')).toThrow(ERROR_INVALID_OPTIONS)
  })

  it('reads getOptions targets', () => {
    expect(normalizeGetOptions(undefined)).toBeUndefined()
    expect(normalizeGetOptions({})).toBeUndefined()
    expect(normalizeGetOptions({ tabId: 4 })).toBe(4)
    expect(() => normalizeGetOptions({ tabId: 'x' })).toThrow(ERROR_INVALID_OPTIONS)
  })

  it('reads the panel behavior', () => {
    expect(normalizePanelBehavior({ openPanelOnActionClick: true })).toEqual({
      openPanelOnActionClick: true
    })
    expect(normalizePanelBehavior({})).toEqual({})
    expect(() => normalizePanelBehavior({ openPanelOnActionClick: 1 })).toThrow(
      ERROR_INVALID_BEHAVIOR
    )
  })

  it('open needs a window or a tab', () => {
    expect(() => normalizeOpenOptions({})).toThrow(ERROR_NO_TARGET)
    expect(() => normalizeOpenOptions(undefined)).toThrow(ERROR_NO_TARGET)
    expect(normalizeOpenOptions({ windowId: -2 })).toEqual({ windowId: -2 })
    expect(normalizeOpenOptions({ tabId: 9, windowId: 1 })).toEqual({ tabId: 9, windowId: 1 })
  })

  it('reads the manifest default path', () => {
    expect(manifestPanelPath({ side_panel: { default_path: '/panel.html' } })).toBe('panel.html')
    expect(manifestPanelPath({ side_panel: {} })).toBeNull()
    expect(manifestPanelPath({})).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Pure: the option state
// ---------------------------------------------------------------------------

describe('SidePanelOptions', () => {
  it('starts from the manifest and lets setOptions patch the defaults', () => {
    const o = new SidePanelOptions('panel.html')
    expect(o.getOptions(undefined)).toEqual({ path: 'panel.html', enabled: true })
    expect(o.effective(5)).toEqual({ path: 'panel.html', tabScoped: false })
    o.setOptions({ enabled: false })
    expect(o.getOptions(undefined)).toEqual({ path: 'panel.html', enabled: false })
    expect(o.effective(5).path).toBeNull()
    o.setOptions({ path: 'other.html', enabled: true })
    expect(o.effective(5)).toEqual({ path: 'other.html', tabScoped: false })
  })

  it('has no panel without a manifest path until setOptions gives one', () => {
    const o = new SidePanelOptions(null)
    expect(o.getOptions(undefined)).toEqual({})
    expect(o.hasDefaultPanel()).toBe(false)
    o.setOptions({ path: 'p.html' })
    expect(o.hasDefaultPanel()).toBe(true)
    expect(o.effective(1).path).toBe('p.html')
  })

  it('lays tab-specific fields over the defaults and keeps them apart', () => {
    const o = new SidePanelOptions('panel.html')
    o.setOptions({ tabId: 3, path: 'tab3.html' })
    expect(o.getOptions(3)).toEqual({ tabId: 3, path: 'tab3.html' })
    expect(o.getOptions(4)).toEqual({ path: 'panel.html', enabled: true })
    expect(o.effective(3)).toEqual({ path: 'tab3.html', tabScoped: true })
    expect(o.effective(4)).toEqual({ path: 'panel.html', tabScoped: false })
    o.setOptions({ tabId: 3, enabled: false })
    expect(o.getOptions(3)).toEqual({ tabId: 3, path: 'tab3.html', enabled: false })
    expect(o.effective(3).path).toBeNull()
    o.tabRemoved(3)
    expect(o.getOptions(3)).toEqual({ path: 'panel.html', enabled: true })
  })

  it('a disabled tab set is disabled even when the defaults are enabled, and vice versa', () => {
    const o = new SidePanelOptions('panel.html')
    o.setOptions({ enabled: false })
    o.setOptions({ tabId: 1, enabled: true })
    expect(o.effective(1).path).toBe('panel.html')
    expect(o.effective(2).path).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Host: the API and the panel per window
// ---------------------------------------------------------------------------

const EXT_A = 'a'.repeat(32)
const EXT_B = 'b'.repeat(32)
const WINDOW_ID = 7

interface FakeView {
  view: PanelView
  hooks: PanelViewHooks
  loads: string[]
  bounds: Rect | null
  visible: boolean
  focused: number
  closed: boolean
}

interface Harness {
  api: SidePanelApi
  win: ZenWindow
  views: FakeView[]
  commits: number
  activated: string[]
  opened: string[]
  behaviorStore: Record<string, boolean>
  load: (id: string, perms: string[], manifest?: Record<string, unknown>) => LoadedExtension
  unload: (id: string) => void
  ctx: (id: string) => ApiContext
  addTab: (id: string) => Tab
  activate: (id: string) => void
  call: (id: string, method: string, ...args: unknown[]) => unknown
}

function harness(): Harness {
  const tabs = new Map<string, Tab>()
  const chromeIds = new Map<string, number>()
  let nextChromeId = 100
  let activeId: string | null = null
  const win = { id: 'w1', alive: true } as unknown as ZenWindow
  const views: FakeView[] = []
  const state = { commits: 0 }
  const activated: string[] = []
  const opened: string[] = []
  const behaviorStore: Record<string, boolean> = {}
  const loaded = new Map<string, LoadedExtension>()
  const grants: Record<string, string[]> = {}
  const chromeId = (zenId: string): number => {
    let id = chromeIds.get(zenId)
    if (id === undefined) chromeIds.set(zenId, (id = nextChromeId++))
    return id
  }
  const model = {
    zenTab: (tabId: number) => {
      for (const [zenId, id] of chromeIds) if (id === tabId) return tabs.get(zenId)
      return undefined
    },
    chromeTabId: (tab: Tab) => chromeId(tab.id),
    windowOfTab: (tab: Tab) => (tabs.has(tab.id) ? win : undefined),
    windowIdOf: (w: ZenWindow) => (w === win ? WINDOW_ID : -1),
    zenWindow: (windowId: number) => (windowId === WINDOW_ID ? win : undefined),
    lastFocusedWindow: () => win
  }
  const browser = {
    tabs: {
      activeTabFor: () => (activeId ? tabs.get(activeId) : undefined),
      activateTab: (id: string) => {
        activated.push(id)
        activeId = id
      },
      createTab: (init: { url: string }) => {
        opened.push(init.url)
      }
    },
    extensions: {
      list: () =>
        [...loaded.values()].map((ext) => ({
          id: ext.id,
          name: `Name of ${ext.id.slice(0, 1)}`,
          icon: ext.id === EXT_A ? 'data:image/png;base64,AA==' : null
        }))
    }
  }
  const host = {
    browser,
    model,
    store: {
      sidePanelOnActionClick: (id: string) => behaviorStore[id] === true,
      setSidePanelOnActionClick: (id: string, enabled: boolean) => {
        if (enabled) behaviorStore[id] = true
        else delete behaviorStore[id]
      }
    },
    loaded: (id: string) => loaded.get(id),
    grants: (id: string) => ({ permissions: grants[id] ?? [], origins: [] }),
    commitUi: () => {
      state.commits += 1
    }
  }
  const viewHost: PanelViewHost = {
    create(_win, _ext, hooks) {
      const fake: FakeView = {
        hooks,
        loads: [],
        bounds: null,
        visible: false,
        focused: 0,
        closed: false,
        view: {
          loadURL: (url) => void fake.loads.push(url),
          setBounds: (rect) => {
            fake.bounds = rect
          },
          setVisible: (visible) => {
            fake.visible = visible
          },
          visible: () => fake.visible,
          focus: () => {
            fake.focused += 1
          },
          destroyed: () => fake.closed,
          close: () => {
            fake.closed = true
          },
          hostsWebContents: () => false
        }
      }
      views.push(fake)
      return fake.view
    }
  }
  const api = new SidePanelApi(host as unknown as ApiHost, viewHost)
  const load = (
    id: string,
    perms: string[],
    manifest: Record<string, unknown> = { side_panel: { default_path: 'panel.html' } }
  ): LoadedExtension => {
    grants[id] = perms
    const ext = {
      id,
      manifest,
      extension: { name: `Ext ${id.slice(0, 1)}` },
      sessions: [{}],
      path: `/ext/${id}`,
      unpacked: true
    } as unknown as LoadedExtension
    loaded.set(id, ext)
    api.load(ext)
    return ext
  }
  const ctx = (id: string): ApiContext =>
    ({
      extensionId: id,
      extension: loaded.get(id)!,
      window: win,
      tabId: null,
      sender: { kind: 'worker' }
    }) as unknown as ApiContext
  return {
    api,
    win,
    views,
    get commits() {
      return state.commits
    },
    activated,
    opened,
    behaviorStore,
    load,
    unload: (id) => {
      loaded.delete(id)
      api.unload(id)
    },
    ctx,
    addTab: (id) => {
      const tab = { id, url: `https://${id}.test/`, title: id } as unknown as Tab
      tabs.set(id, tab)
      chromeId(id)
      if (!activeId) activeId = id
      return tab
    },
    activate: (id) => {
      activeId = id
    },
    call: (id, method, ...args) => api.handlers[method](ctx(id), ...args)
  }
}

const url = (id: string, path: string): string => `chrome-extension://${id}/${path}`

describe('chrome.sidePanel: options and behavior', () => {
  it('requires the permission', () => {
    const h = harness()
    h.load(EXT_A, [])
    expect(() => h.call(EXT_A, 'getOptions', {})).toThrow(ERROR_NO_PERMISSION)
    expect(() => h.call(EXT_A, 'setOptions', { path: 'x.html' })).toThrow(ERROR_NO_PERMISSION)
    expect(() => h.call(EXT_A, 'open', { windowId: WINDOW_ID })).toThrow(ERROR_NO_PERMISSION)
    expect(() => h.call(EXT_A, 'getPanelBehavior')).toThrow(ERROR_NO_PERMISSION)
  })

  it('answers the manifest defaults and patches them', () => {
    const h = harness()
    h.load(EXT_A, ['sidePanel'])
    expect(h.call(EXT_A, 'getOptions', {})).toEqual({ path: 'panel.html', enabled: true })
    h.call(EXT_A, 'setOptions', { path: '/other.html' })
    expect(h.call(EXT_A, 'getOptions', undefined)).toEqual({ path: 'other.html', enabled: true })
  })

  it('rejects tab-specific options for unknown tabs', () => {
    const h = harness()
    h.load(EXT_A, ['sidePanel'])
    expect(() => h.call(EXT_A, 'setOptions', { tabId: 999, path: 'x.html' })).toThrow(noTab(999))
    expect(() => h.call(EXT_A, 'getOptions', { tabId: 999 })).toThrow(noTab(999))
  })

  it('keeps the panel behavior per extension and persists it', () => {
    const h = harness()
    h.load(EXT_A, ['sidePanel'])
    h.load(EXT_B, ['sidePanel'])
    expect(h.call(EXT_A, 'getPanelBehavior')).toEqual({ openPanelOnActionClick: false })
    h.call(EXT_A, 'setPanelBehavior', { openPanelOnActionClick: true })
    expect(h.call(EXT_A, 'getPanelBehavior')).toEqual({ openPanelOnActionClick: true })
    expect(h.call(EXT_B, 'getPanelBehavior')).toEqual({ openPanelOnActionClick: false })
    expect(h.behaviorStore).toEqual({ [EXT_A]: true })
    // A reload reads it back.
    h.unload(EXT_A)
    h.load(EXT_A, ['sidePanel'])
    expect(h.call(EXT_A, 'getPanelBehavior')).toEqual({ openPanelOnActionClick: true })
  })

  it('opensOnActionClick needs the behavior, the permission and a page for the tab', () => {
    const h = harness()
    h.addTab('t1')
    h.load(EXT_A, ['sidePanel'])
    expect(h.api.opensOnActionClick(EXT_A, h.win)).toBe(false)
    h.call(EXT_A, 'setPanelBehavior', { openPanelOnActionClick: true })
    expect(h.api.opensOnActionClick(EXT_A, h.win)).toBe(true)
    h.call(EXT_A, 'setOptions', { enabled: false })
    expect(h.api.opensOnActionClick(EXT_A, h.win)).toBe(false)
    h.load(EXT_B, [])
    h.api.opensOnActionClick(EXT_B, h.win)
    expect(h.api.opensOnActionClick(EXT_B, h.win)).toBe(false)
  })
})

describe('chrome.sidePanel: the panel per window', () => {
  it('open({windowId}) docks a view with the page for the active tab and tells the chrome', () => {
    const h = harness()
    h.addTab('t1')
    h.load(EXT_A, ['sidePanel'])
    expect(h.api.info(h.win)).toBeNull()
    h.call(EXT_A, 'open', { windowId: WINDOW_ID })
    expect(h.views).toHaveLength(1)
    expect(h.views[0].loads).toEqual([url(EXT_A, 'panel.html')])
    expect(h.views[0].focused).toBe(1)
    expect(h.api.info(h.win)).toEqual({
      extensionId: EXT_A,
      name: 'Name of a',
      icon: 'data:image/png;base64,AA=='
    })
    expect(h.commits).toBeGreaterThan(0)
  })

  it('open({windowId: WINDOW_ID_CURRENT}) uses the caller window', () => {
    const h = harness()
    h.addTab('t1')
    h.load(EXT_A, ['sidePanel'])
    h.call(EXT_A, 'open', { windowId: -2 })
    expect(h.api.showing(h.win)).toBe(EXT_A)
  })

  it('open({tabId}) activates the tab and opens beside it; no page for the tab is an error', () => {
    const h = harness()
    h.addTab('t1')
    const t2 = h.addTab('t2')
    h.load(EXT_A, ['sidePanel'])
    const t2Id = 101
    h.call(EXT_A, 'setOptions', { tabId: t2Id, enabled: false })
    expect(() => h.call(EXT_A, 'open', { tabId: t2Id })).toThrow(noPanelForTab(t2Id))
    h.call(EXT_A, 'setOptions', { tabId: t2Id, enabled: true, path: 'two.html' })
    h.call(EXT_A, 'open', { tabId: t2Id })
    expect(h.activated).toEqual([t2.id])
    expect(h.views[0].loads).toEqual([url(EXT_A, 'two.html')])
    expect(() => h.call(EXT_A, 'open', { tabId: 12345 })).toThrow(noTab(12345))
  })

  it('open in a window whose active tab has the panel disabled is an error', () => {
    const h = harness()
    h.addTab('t1')
    h.load(EXT_A, ['sidePanel'])
    h.call(EXT_A, 'setOptions', { enabled: false })
    expect(() => h.call(EXT_A, 'open', { windowId: WINDOW_ID })).toThrow(
      noPanelForWindow(WINDOW_ID)
    )
  })

  it('place shows the view where the chrome laid the strip out and hides it without a rect', () => {
    const h = harness()
    h.addTab('t1')
    h.load(EXT_A, ['sidePanel'])
    h.call(EXT_A, 'open', { windowId: WINDOW_ID })
    const v = h.views[0]
    expect(v.visible).toBe(false)
    h.api.place(h.win, { x: 900, y: 40, width: 360, height: 700 })
    expect(v.bounds).toEqual({ x: 900, y: 40, width: 360, height: 700 })
    expect(v.visible).toBe(true)
    h.api.place(h.win, null)
    expect(v.visible).toBe(false)
    h.api.place(h.win, { x: 0, y: 0, width: 0, height: 10 })
    expect(v.visible).toBe(false)
  })

  it('follows the active tab: a tab-specific page loads, a disabled tab collapses the strip', () => {
    const h = harness()
    h.addTab('t1')
    h.addTab('t2')
    h.addTab('t3')
    h.load(EXT_A, ['sidePanel'])
    h.call(EXT_A, 'setOptions', { tabId: 101, path: 'two.html' })
    h.call(EXT_A, 'setOptions', { tabId: 102, enabled: false })
    h.call(EXT_A, 'open', { windowId: WINDOW_ID })
    const v = h.views[0]
    expect(v.loads).toEqual([url(EXT_A, 'panel.html')])
    h.activate('t2')
    h.api.refresh()
    expect(v.loads).toEqual([url(EXT_A, 'panel.html'), url(EXT_A, 'two.html')])
    expect(h.api.info(h.win)?.extensionId).toBe(EXT_A)
    h.activate('t3')
    h.api.refresh()
    expect(h.api.info(h.win)).toBeNull()
    expect(h.api.showing(h.win)).toBe(EXT_A)
    expect(v.loads).toHaveLength(2)
    h.activate('t1')
    h.api.refresh()
    expect(v.loads).toEqual([
      url(EXT_A, 'panel.html'),
      url(EXT_A, 'two.html'),
      url(EXT_A, 'panel.html')
    ])
    expect(h.api.info(h.win)?.extensionId).toBe(EXT_A)
  })

  it('toggle opens, toggles off, and swaps to another extension in the same window', () => {
    const h = harness()
    h.addTab('t1')
    h.load(EXT_A, ['sidePanel'])
    h.load(EXT_B, ['sidePanel'])
    h.api.toggle(EXT_A, h.win)
    expect(h.api.showing(h.win)).toBe(EXT_A)
    h.api.toggle(EXT_B, h.win)
    expect(h.api.showing(h.win)).toBe(EXT_B)
    expect(h.views).toHaveLength(2)
    expect(h.views[0].closed).toBe(true)
    expect(h.views[1].loads).toEqual([url(EXT_B, 'panel.html')])
    h.api.toggle(EXT_B, h.win)
    expect(h.api.showing(h.win)).toBeNull()
    expect(h.views[1].closed).toBe(true)
  })

  it('toggle does nothing for an extension without the permission or a page', () => {
    const h = harness()
    h.addTab('t1')
    h.load(EXT_A, [])
    h.load(EXT_B, ['sidePanel'], {})
    h.api.toggle(EXT_A, h.win)
    h.api.toggle(EXT_B, h.win)
    expect(h.views).toHaveLength(0)
  })

  it('close, unload and the view going away all drop the panel', () => {
    const h = harness()
    h.addTab('t1')
    h.load(EXT_A, ['sidePanel'])
    h.call(EXT_A, 'open', { windowId: WINDOW_ID })
    h.api.close(h.win)
    expect(h.views[0].closed).toBe(true)
    expect(h.api.showing(h.win)).toBeNull()
    h.api.close(h.win)

    h.call(EXT_A, 'open', { windowId: WINDOW_ID })
    h.unload(EXT_A)
    expect(h.views[1].closed).toBe(true)
    expect(h.api.showing(h.win)).toBeNull()

    h.load(EXT_A, ['sidePanel'])
    h.call(EXT_A, 'open', { windowId: WINDOW_ID })
    h.views[2].hooks.gone()
    expect(h.api.showing(h.win)).toBeNull()
  })

  it('links the panel opens go to tabs', () => {
    const h = harness()
    h.addTab('t1')
    h.load(EXT_A, ['sidePanel'])
    h.call(EXT_A, 'open', { windowId: WINDOW_ID })
    h.views[0].hooks.openUrl('https://example.test/')
    expect(h.opened).toEqual(['https://example.test/'])
  })

  it('a closed tab loses its tab-specific options', () => {
    const h = harness()
    h.addTab('t1')
    h.load(EXT_A, ['sidePanel'])
    h.call(EXT_A, 'setOptions', { tabId: 100, path: 'one.html' })
    expect(h.call(EXT_A, 'getOptions', { tabId: 100 })).toEqual({ tabId: 100, path: 'one.html' })
    h.api.tabRemoved(100)
    expect(h.call(EXT_A, 'getOptions', { tabId: 100 })).toEqual({
      path: 'panel.html',
      enabled: true
    })
  })
})
