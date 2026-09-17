import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/defaults'
import type { StoreIO } from '../platform'
import { BrowserState, PERSISTED_VERSION, sanitizeNewTabShortcuts, type Persisted } from '../state'
import { createSpace, createTabRecord } from '../model'
import { closedTabEntry } from '../session'

function fakeIo(initial: string | null = null): StoreIO & { writes: string[] } {
  const io = {
    writes: [] as string[],
    readSync: () => initial,
    write: async (_name: string, text: string) => {
      io.writes.push(text)
    },
    writeSync: (_name: string, text: string) => {
      io.writes.push(text)
    }
  }
  return io
}

function state(io: StoreIO): BrowserState {
  const s = new BrowserState(io, {} as Platform, {} as HostCapabilities, '0.0')
  s.load()
  return s
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('BrowserState commits', () => {
  it('persists a commit even when a volatile commit was scheduled first in the same tick', async () => {
    const io = fakeIo()
    const s = state(io)
    s.commitVolatile()
    s.commit()
    await tick()
    await s.flush()
    expect(io.writes.length).toBeGreaterThan(0)
  })

  it('does not persist for volatile commits alone', async () => {
    const io = fakeIo()
    const s = state(io)
    s.commitVolatile()
    await tick()
    // flush() writes unconditionally, so look at the store directly: nothing was scheduled.
    expect(io.writes).toEqual([])
  })

  it('notifies listeners once per tick for any mix of commits', async () => {
    const io = fakeIo()
    const s = state(io)
    let calls = 0
    s.subscribe(() => calls++)
    s.commitVolatile()
    s.commit()
    s.commitVolatile()
    await tick()
    expect(calls).toBe(1)
  })

  it('runs afterBroadcast callbacks once the pending broadcast has gone out', async () => {
    const io = fakeIo()
    const s = state(io)
    const order: string[] = []
    s.subscribe(() => order.push('broadcast'))
    s.commit()
    s.afterBroadcast(() => order.push('after'))
    expect(order).toEqual([])
    await tick()
    expect(order).toEqual(['broadcast', 'after'])
  })

  it('runs afterBroadcast callbacks right away when nothing is pending', async () => {
    const io = fakeIo()
    const s = state(io)
    let calls = 0
    s.subscribe(() => calls++)
    let ran = false
    s.afterBroadcast(() => (ran = true))
    expect(ran).toBe(true)
    await tick()
    expect(calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Recently closed persistence (state.json v3) and "restore previous session" off
// ---------------------------------------------------------------------------

function profile(): { doc: Record<string, unknown>; spaceId: string; ids: string[] } {
  const space = createSpace('Work', '')
  const pinned = createTabRecord({
    spaceId: space.id,
    containerId: 'default',
    url: 'https://p.test/',
    pinned: true
  })
  const a = createTabRecord({ spaceId: space.id, containerId: 'default', url: 'https://a.test/' })
  const b = createTabRecord({ spaceId: space.id, containerId: 'default', url: 'https://b.test/' })
  const essential = createTabRecord({
    spaceId: null,
    containerId: 'default',
    url: 'https://e.test/',
    essential: true
  })
  space.tabIds = [pinned.id, a.id, b.id]
  space.activeTabId = b.id
  const doc = {
    version: 2,
    spaces: [space],
    tabs: [pinned, a, b, essential],
    essentialTabIds: [essential.id],
    activeSpaceId: space.id,
    settings: {},
    windows: [
      {
        id: 'w1',
        bounds: null,
        maximized: false,
        activeSpaceId: space.id,
        selection: { [space.id]: b.id },
        compact: false
      },
      {
        id: 'w2',
        bounds: null,
        maximized: false,
        activeSpaceId: space.id,
        selection: {},
        compact: false
      }
    ]
  }
  return { doc, spaceId: space.id, ids: [pinned.id, a.id, b.id, essential.id] }
}

function stateFrom(doc: unknown): { s: BrowserState; io: ReturnType<typeof fakeIo> } {
  const io = fakeIo()
  io.readSync = () => JSON.stringify(doc)
  const s = new BrowserState(io, {} as Platform, {} as HostCapabilities, '0.0')
  s.load()
  return { s, io }
}

describe('recently closed persistence', () => {
  it('starts empty for profiles written before v3 and round-trips v3 entries', async () => {
    const { doc } = profile()
    const { s, io } = stateFrom(doc)
    expect(s.recentlyClosed).toEqual([])
    const tab = createTabRecord({ spaceId: null, containerId: 'default', url: 'https://c.test/' })
    s.recentlyClosed = [
      closedTabEntry(tab, { spaceId: null, folderId: null, index: 0, windowId: null }, null, 5)
    ]
    s.commit()
    await tick()
    await s.flush()
    const written = JSON.parse(io.writes[io.writes.length - 1]) as {
      version: number
      recentlyClosed: unknown[]
    }
    expect(written.version).toBe(PERSISTED_VERSION)
    expect(written.recentlyClosed).toHaveLength(1)
    const reloaded = stateFrom(written).s
    expect(reloaded.recentlyClosed).toHaveLength(1)
    expect(reloaded.recentlyClosed[0]).toMatchObject({ kind: 'tab', closedAt: 5 })
  })

  it('ignores a corrupt recentlyClosed list', () => {
    const { doc } = profile()
    const { s } = stateFrom({ ...doc, version: 3, recentlyClosed: 'oops' })
    expect(s.recentlyClosed).toEqual([])
  })
})

describe('forgetSession', () => {
  it('drops regular tabs, keeps pinned tabs and essentials, and leaves one window without a selection', () => {
    const { doc, ids } = profile()
    const [pinned, a, b, essential] = ids
    const { s } = stateFrom(doc)
    expect(Object.keys(s.model.tabs)).toHaveLength(4)
    expect(s.restoredWindows).toHaveLength(2)
    s.forgetSession()
    expect(Object.keys(s.model.tabs).sort()).toEqual([pinned, essential].sort())
    expect(s.model.tabs[a]).toBeUndefined()
    expect(s.model.tabs[b]).toBeUndefined()
    expect(s.model.spaces[0].tabIds).toEqual([pinned])
    expect(s.model.essentialTabIds).toEqual([essential])
    expect(s.restoredWindows).toHaveLength(1)
    expect(s.restoredWindows[0].selection).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// New tab page persistence (state.json v4)
// ---------------------------------------------------------------------------

/** A minimal profile as an older build wrote it (`version` picks the schema). */
function legacyProfile(version: 1 | 2 | 3 | 4, extra: Partial<Persisted> = {}): string {
  const base: Persisted = {
    version,
    spaces: [],
    tabs: [],
    essentialTabIds: [],
    activeSpaceId: 'space_1',
    containers: [],
    folders: [],
    splitGroups: [],
    settings: structuredClone(DEFAULT_SETTINGS),
    shortcutOverrides: {},
    bookmarks: [],
    ...extra
  }
  return JSON.stringify(base)
}

describe('state.json v4 (new tab page)', () => {
  it('writes the current schema version with the shortcuts list and the block list', async () => {
    const io = fakeIo()
    const s = state(io)
    s.newTabShortcuts = [{ id: 'sc_1', title: 'Zen', url: 'https://zen-browser.app/' }]
    s.newTabHiddenHosts = ['news.example']
    await s.flush()
    const written = JSON.parse(io.writes.at(-1) ?? '{}') as Persisted
    expect(written.version).toBe(PERSISTED_VERSION)
    expect(written.version).toBe(4)
    expect(written.newTabShortcuts).toEqual([
      { id: 'sc_1', title: 'Zen', url: 'https://zen-browser.app/' }
    ])
    expect(written.newTabHiddenHosts).toEqual(['news.example'])
    expect(written.settings.newTab).toEqual(DEFAULT_SETTINGS.newTab)
  })

  it('migrates a v2 profile: no shortcuts, default new tab settings', () => {
    const settings = structuredClone(DEFAULT_SETTINGS) as Partial<typeof DEFAULT_SETTINGS>
    delete settings.newTab
    const s = state(
      fakeIo(legacyProfile(2, { settings: settings as typeof DEFAULT_SETTINGS }))
    )
    expect(s.newTabShortcuts).toEqual([])
    expect(s.settings.newTab).toEqual(DEFAULT_SETTINGS.newTab)
  })

  it('migrates a v1 profile the same way', () => {
    const s = state(fakeIo(legacyProfile(1, { windowBounds: null, maximized: false })))
    expect(s.newTabShortcuts).toEqual([])
    expect(s.settings.newTab.enabled).toBe(true)
  })

  it('migrates a v3 profile (bookmark tree, recently closed) keeping its closed list', () => {
    const s = state(fakeIo(legacyProfile(3, { bookmarks: undefined, recentlyClosed: [] })))
    expect(s.newTabShortcuts).toEqual([])
    expect(s.newTabHiddenHosts).toEqual([])
    expect(s.recentlyClosed).toEqual([])
    expect(s.settings.newTab).toEqual(DEFAULT_SETTINGS.newTab)
  })

  it('ignores stray new tab data in profiles older than v4', () => {
    const s = state(
      fakeIo(
        legacyProfile(3, {
          newTabShortcuts: [{ id: 'x', title: 'x', url: 'https://x.example/' }],
          newTabHiddenHosts: ['x.example']
        })
      )
    )
    expect(s.newTabShortcuts).toEqual([])
    expect(s.newTabHiddenHosts).toEqual([])
  })

  it('reads v4 shortcuts and the block list and sanitises the new tab settings', () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    ;(settings.newTab as unknown as Record<string, unknown>).shortcuts = 'bogus'
    ;(settings.newTab as unknown as Record<string, unknown>).background = 'solid'
    const s = state(
      fakeIo(
        legacyProfile(4, {
          settings,
          newTabHiddenHosts: ['WWW.News.Example', 'news.example', '', 7 as unknown as string],
          newTabShortcuts: [
            { id: 'a', title: 'A', url: 'https://a.example/' },
            { id: 'a', title: 'dup', url: 'https://dup.example/' },
            { id: 'b', title: '  ', url: 'https://b.example/' },
            { id: '', title: 'no id', url: 'https://c.example/' }
          ]
        })
      )
    )
    expect(s.newTabShortcuts).toEqual([
      { id: 'a', title: 'A', url: 'https://a.example/' },
      { id: 'b', title: 'https://b.example/', url: 'https://b.example/' }
    ])
    expect(s.newTabHiddenHosts).toEqual(['news.example'])
    expect(s.settings.newTab).toEqual({ ...DEFAULT_SETTINGS.newTab, background: 'solid' })
  })

  it('sanitizeNewTabShortcuts rejects anything that is not a list of records', () => {
    expect(sanitizeNewTabShortcuts(undefined)).toEqual([])
    expect(sanitizeNewTabShortcuts('nope')).toEqual([])
    expect(sanitizeNewTabShortcuts([null, 4, { id: 'a' }])).toEqual([])
  })
})
