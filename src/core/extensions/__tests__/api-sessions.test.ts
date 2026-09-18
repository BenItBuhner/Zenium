import { describe, expect, it } from 'vitest'
import type { ClosedEntry, ClosedTabEntry, ClosedWindowEntry, Tab } from '../../../shared/types'
import { createTabRecord } from '../../model'
import type { ZenWindow } from '../../window'
import {
  ERROR_NO_PERMISSION,
  ERROR_NO_RECENTLY_CLOSED,
  MAX_SESSION_RESULTS,
  invalidSessionId,
  normalizeSessionFilter,
  normalizeSessionId,
  toChromeSession,
  type ChromeSession,
  type SessionTab,
  type SessionWindow
} from '../api/sessions'
import type { ChromeTab } from '../api/tabs'
import type { ChromeWindow } from '../api/windows'
import { SessionsApi } from '../../../main/platform/extensionApi/sessions'
import type {
  ApiContext,
  ApiHost,
  LoadedExtension
} from '../../../main/platform/extensionApi/types'

const CLOSED_AT = Date.UTC(2026, 8, 17, 12, 0, 0)

function tab(over: Partial<Tab> = {}): Tab {
  return createTabRecord({
    spaceId: 'space-1',
    containerId: 'default',
    url: 'https://example.com/page',
    title: 'Example page',
    favicon: 'https://example.com/favicon.ico',
    ...over
  })
}

function closedTab(over: Partial<ClosedTabEntry> = {}, tabOver: Partial<Tab> = {}): ClosedTabEntry {
  return {
    kind: 'tab',
    id: over.id ?? 'closed-1',
    closedAt: CLOSED_AT,
    tab: tab(tabOver),
    spaceId: 'space-1',
    folderId: null,
    index: 3,
    windowId: null,
    navigation: null,
    ...over
  }
}

function closedWindow(tabs: ClosedTabEntry[], activeTabId: string | null): ClosedWindowEntry {
  return {
    kind: 'window',
    id: 'closed-w',
    closedAt: CLOSED_AT + 5000,
    windowKind: 'synced',
    bounds: null,
    activeTabId,
    tabs
  }
}

const seeAll = (): boolean => true
const seeNone = (): boolean => false

describe('chrome.sessions shapes', () => {
  it('lists a closed tab with Chrome fields and no live id', () => {
    const session = toChromeSession(closedTab(), seeAll)
    expect(session.lastModified).toBe(Math.floor(CLOSED_AT / 1000))
    expect(session.window).toBeUndefined()
    const t = session.tab as SessionTab
    expect(t).toEqual({
      sessionId: 'closed-1',
      index: 3,
      windowId: 0,
      active: false,
      highlighted: false,
      selected: false,
      pinned: false,
      incognito: false,
      discarded: false,
      autoDiscardable: false,
      frozen: false,
      groupId: -1,
      url: 'https://example.com/page',
      title: 'Example page',
      favIconUrl: 'https://example.com/favicon.ico'
    })
    expect('id' in t).toBe(false)
  })

  it('scrubs url, title and favicon for an extension without tab access', () => {
    const t = toChromeSession(closedTab(), seeNone).tab as SessionTab
    expect(t.url).toBeUndefined()
    expect(t.title).toBeUndefined()
    expect(t.favIconUrl).toBeUndefined()
    expect(t.sessionId).toBe('closed-1')
  })

  it('falls back to the display URL as title, prefers the custom title, skips a missing favicon', () => {
    const untitled = toChromeSession(closedTab({}, { title: '', favicon: null }), seeAll)
      .tab as SessionTab
    expect(untitled.title).toBe('example.com/page')
    expect('favIconUrl' in untitled).toBe(false)
    const renamed = toChromeSession(closedTab({}, { customTitle: 'Mine' }), seeAll)
      .tab as SessionTab
    expect(renamed.title).toBe('Mine')
    const pinned = toChromeSession(closedTab({}, { essential: true }), seeAll).tab as SessionTab
    expect(pinned.pinned).toBe(true)
  })

  it('lists a closed window with its tabs and the active one marked', () => {
    const a = closedTab({ id: 'c-a', index: 0 }, { id: 'tab-a' })
    const b = closedTab({ id: 'c-b', index: 1 }, { id: 'tab-b' })
    const session = toChromeSession(closedWindow([a, b], 'tab-b'), seeAll)
    expect(session.lastModified).toBe(Math.floor((CLOSED_AT + 5000) / 1000))
    const w = session.window as SessionWindow
    expect(w.sessionId).toBe('closed-w')
    expect(w.type).toBe('normal')
    expect(w.state).toBe('normal')
    expect(w.focused).toBe(false)
    expect(w.incognito).toBe(false)
    expect(w.alwaysOnTop).toBe(false)
    expect('id' in w).toBe(false)
    expect(w.tabs.map((t) => [t.sessionId, t.active])).toEqual([
      ['c-a', false],
      ['c-b', true]
    ])
  })

  it('marks the first tab active when the window remembers none', () => {
    const a = closedTab({ id: 'c-a' }, { id: 'tab-a' })
    const w = toChromeSession(closedWindow([a], null), seeAll).window as SessionWindow
    expect(w.tabs[0].active).toBe(true)
  })

  it('checks the getRecentlyClosed filter', () => {
    expect(normalizeSessionFilter(undefined)).toEqual({ maxResults: MAX_SESSION_RESULTS })
    expect(normalizeSessionFilter({})).toEqual({ maxResults: 25 })
    expect(normalizeSessionFilter({ maxResults: 3 })).toEqual({ maxResults: 3 })
    expect(normalizeSessionFilter({ maxResults: 0 })).toEqual({ maxResults: 0 })
    expect(() => normalizeSessionFilter({ maxResults: 26 })).toThrow(/between 0 and 25/)
    expect(() => normalizeSessionFilter({ maxResults: -1 })).toThrow(/between 0 and 25/)
    expect(() => normalizeSessionFilter({ maxResults: 1.5 })).toThrow(/between 0 and 25/)
    expect(() => normalizeSessionFilter([])).toThrow('Invalid filter')
  })

  it('checks the restore session id', () => {
    expect(normalizeSessionId(undefined)).toBeNull()
    expect(normalizeSessionId('closed-1')).toBe('closed-1')
    expect(() => normalizeSessionId(12)).toThrow(invalidSessionId('12'))
  })
})

// ---------------------------------------------------------------------------
// Host module over a fake session service
// ---------------------------------------------------------------------------

interface Dispatched {
  extensionId: string
  event: string
  args: unknown[]
}

const EXT_A = 'a'.repeat(32)
const EXT_B = 'b'.repeat(32)

function harness(): {
  api: SessionsApi
  state: { recentlyClosed: ClosedEntry[] }
  tabs: Map<string, Tab>
  out: Dispatched[]
  grants: Record<string, string[]>
  load: (id: string, perms: string[]) => void
  ctx: (id: string) => ApiContext
  restored: string[]
} {
  const state = { recentlyClosed: [] as ClosedEntry[] }
  const tabs = new Map<string, Tab>()
  const restored: string[] = []
  const win = { id: 'w1', kind: 'synced' } as unknown as ZenWindow
  const service = {
    recentlyClosed: () => state.recentlyClosed,
    restoreClosed(id: string, w: ZenWindow): void {
      expect(w).toBe(win)
      const entry = state.recentlyClosed.find((e) => e.id === id)
      if (!entry) return
      state.recentlyClosed = state.recentlyClosed.filter((e) => e.id !== id)
      restored.push(id)
      const entries = entry.kind === 'tab' ? [entry] : entry.tabs
      for (const closed of entries) {
        const live = createTabRecord({
          ...closed.tab,
          id: `live-${closed.tab.id}`,
          discarded: true
        })
        tabs.set(live.id, live)
      }
    }
  }
  let nextChromeId = 100
  const chromeIds = new Map<string, number>()
  const chromeTab = (tab: Tab, urls: boolean): ChromeTab => {
    let id = chromeIds.get(tab.id)
    if (id === undefined) chromeIds.set(tab.id, (id = nextChromeId++))
    const record: ChromeTab = {
      id,
      index: 0,
      windowId: 7,
      active: true,
      highlighted: true,
      selected: true,
      pinned: tab.pinned,
      status: 'unloaded',
      audible: false,
      mutedInfo: { muted: false },
      discarded: true,
      frozen: false,
      autoDiscardable: true,
      incognito: false,
      groupId: -1
    }
    if (urls) {
      record.url = tab.url
      record.title = tab.title
    }
    return record
  }
  const model = {
    lastFocusedWindow: () => win,
    allTabs: () => [...tabs.values()],
    chromeTab,
    windowOfTab: () => win,
    chromeWindow: (w: ZenWindow, populate: boolean, urls: (tab: Tab) => boolean): ChromeWindow => {
      expect(w).toBe(win)
      const record: ChromeWindow = {
        id: 7,
        focused: true,
        incognito: false,
        type: 'normal',
        state: 'normal',
        alwaysOnTop: false
      }
      if (populate) record.tabs = [...tabs.values()].map((t) => chromeTab(t, urls(t)))
      return record
    }
  }
  const loaded = new Map<string, LoadedExtension>()
  const grants: Record<string, string[]> = {}
  const out: Dispatched[] = []
  const host = {
    browser: { session: service, state },
    model,
    allLoaded: () => [...loaded.values()],
    grants: (id: string) => ({ permissions: grants[id] ?? [], origins: [] }),
    canSeeTab: (ext: LoadedExtension) => (grants[ext.id] ?? []).includes('tabs'),
    broadcast(
      namespace: string,
      event: string,
      argsFor: (ext: LoadedExtension) => unknown[] | null
    ): void {
      for (const ext of loaded.values()) {
        const args = argsFor(ext)
        if (args) out.push({ extensionId: ext.id, event: `${namespace}.${event}`, args })
      }
    }
  }
  const api = new SessionsApi(host as unknown as ApiHost, () => CLOSED_AT + 60_000)
  const load = (id: string, perms: string[]): void => {
    loaded.set(id, { id } as LoadedExtension)
    grants[id] = perms
  }
  const ctx = (id: string): ApiContext =>
    ({ extensionId: id, extension: loaded.get(id), window: undefined }) as unknown as ApiContext
  return { api, state, tabs, out, grants, load, ctx, restored }
}

const call = async (
  api: SessionsApi,
  method: string,
  ctx: ApiContext,
  ...args: unknown[]
): Promise<unknown> => await api.handlers[method]!(ctx, ...args)

describe('chrome.sessions host', () => {
  it('requires the sessions permission', async () => {
    const h = harness()
    h.load(EXT_A, ['tabs'])
    await expect(call(h.api, 'getRecentlyClosed', h.ctx(EXT_A))).rejects.toThrow(
      ERROR_NO_PERMISSION
    )
    await expect(call(h.api, 'restore', h.ctx(EXT_A))).rejects.toThrow(ERROR_NO_PERMISSION)
    await expect(call(h.api, 'getDevices', h.ctx(EXT_A))).rejects.toThrow(ERROR_NO_PERMISSION)
  })

  it('lists the entries newest first, capped by maxResults, scrubbed without tabs access', async () => {
    const h = harness()
    h.load(EXT_A, ['sessions'])
    h.load(EXT_B, ['sessions', 'tabs'])
    h.state.recentlyClosed = [
      closedTab({ id: 'c-3' }, { id: 't3', url: 'https://c.example/' }),
      closedWindow([closedTab({ id: 'c-2' }, { id: 't2' })], 't2'),
      closedTab({ id: 'c-1' }, { id: 't1' })
    ]
    const all = (await call(h.api, 'getRecentlyClosed', h.ctx(EXT_B))) as ChromeSession[]
    expect(
      all.map((s) => (s.tab as SessionTab)?.sessionId ?? (s.window as SessionWindow).sessionId)
    ).toEqual(['c-3', 'closed-w', 'c-1'])
    expect((all[0].tab as SessionTab).url).toBe('https://c.example/')
    const two = (await call(h.api, 'getRecentlyClosed', h.ctx(EXT_A), {
      maxResults: 2
    })) as ChromeSession[]
    expect(two).toHaveLength(2)
    expect((two[0].tab as SessionTab).url).toBeUndefined()
    expect((two[1].window as SessionWindow).tabs[0].url).toBeUndefined()
    await expect(
      call(h.api, 'getRecentlyClosed', h.ctx(EXT_A), { maxResults: 99 })
    ).rejects.toThrow(/between 0 and 25/)
    expect(await call(h.api, 'getDevices', h.ctx(EXT_A))).toEqual([])
  })

  it('restores the newest entry without an id and names what came back', async () => {
    const h = harness()
    h.load(EXT_A, ['sessions', 'tabs'])
    await expect(call(h.api, 'restore', h.ctx(EXT_A))).rejects.toThrow(ERROR_NO_RECENTLY_CLOSED)
    h.state.recentlyClosed = [
      closedTab({ id: 'c-2' }, { id: 't2', url: 'https://two.example/' }),
      closedTab({ id: 'c-1' }, { id: 't1' })
    ]
    const session = (await call(h.api, 'restore', h.ctx(EXT_A))) as ChromeSession
    expect(h.restored).toEqual(['c-2'])
    expect(session.lastModified).toBe(Math.floor((CLOSED_AT + 60_000) / 1000))
    const live = session.tab as ChromeTab
    expect(live.id).toBe(100)
    expect(live.url).toBe('https://two.example/')
    expect(h.state.recentlyClosed.map((e) => e.id)).toEqual(['c-1'])
  })

  it('restores a named window entry as a live window with its tabs', async () => {
    const h = harness()
    h.load(EXT_A, ['sessions'])
    h.state.recentlyClosed = [
      closedTab({ id: 'c-3' }, { id: 't3' }),
      closedWindow(
        [closedTab({ id: 'c-a' }, { id: 'ta' }), closedTab({ id: 'c-b' }, { id: 'tb' })],
        'tb'
      )
    ]
    const session = (await call(h.api, 'restore', h.ctx(EXT_A), 'closed-w')) as ChromeSession
    expect(h.restored).toEqual(['closed-w'])
    const win = session.window as ChromeWindow
    expect(win.id).toBe(7)
    expect(win.tabs).toHaveLength(2)
    // No `tabs` permission: the live tabs come without URLs.
    expect(win.tabs![0].url).toBeUndefined()
    expect(session.tab).toBeUndefined()
  })

  it('rejects unknown and malformed session ids', async () => {
    const h = harness()
    h.load(EXT_A, ['sessions'])
    h.state.recentlyClosed = [closedTab({ id: 'c-1' })]
    await expect(call(h.api, 'restore', h.ctx(EXT_A), 'nope')).rejects.toThrow(
      invalidSessionId('nope')
    )
    await expect(call(h.api, 'restore', h.ctx(EXT_A), 5)).rejects.toThrow(invalidSessionId('5'))
    expect(h.restored).toEqual([])
  })

  it('fires onChanged for holders when the list is replaced, not on the baseline', () => {
    const h = harness()
    h.load(EXT_A, ['sessions'])
    h.load(EXT_B, ['tabs'])
    h.api.tick()
    expect(h.out).toEqual([])
    h.api.tick()
    expect(h.out).toEqual([])
    h.state.recentlyClosed = [closedTab()]
    h.api.tick()
    expect(h.out).toEqual([{ extensionId: EXT_A, event: 'sessions.onChanged', args: [] }])
    h.api.tick()
    expect(h.out).toHaveLength(1)
    h.state.recentlyClosed = []
    h.api.tick()
    expect(h.out).toHaveLength(2)
    // After a reset the next list is a baseline again.
    h.api.reset()
    h.state.recentlyClosed = [closedTab()]
    h.api.tick()
    expect(h.out).toHaveLength(2)
  })
})
