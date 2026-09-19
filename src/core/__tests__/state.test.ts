import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/defaults'
import { DEFAULT_NEW_TAB_SETTINGS } from '../../shared/newTab'
import type { StoreIO } from '../platform'
import { BrowserState, PERSISTED_VERSION, type Persisted } from '../state'
import { createFolder, createSpace, createTabRecord, nextFolderColor } from '../model'
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

describe('folder (tab group) persistence', () => {
  it('round-trips a folder’s name, colour, collapsed state and membership (session-22)', async () => {
    const { doc, spaceId, ids } = profile()
    const [, a, b] = ids
    const { s, io } = stateFrom(doc)
    const folder = createFolder(s.model, spaceId, 'Research', '📁', 'purple')
    folder.collapsed = true
    s.model.tabs[a].folderId = folder.id
    s.model.tabs[b].folderId = folder.id
    s.commit()
    await tick()
    await s.flush()
    const written = JSON.parse(io.writes[io.writes.length - 1]) as Persisted
    expect(written.folders).toEqual([
      { id: folder.id, spaceId, name: 'Research', icon: '📁', color: 'purple', collapsed: true }
    ])
    const reloaded = stateFrom(written).s
    expect(reloaded.model.folders[folder.id]).toEqual(folder)
    expect(reloaded.model.tabs[a].folderId).toBe(folder.id)
    expect(reloaded.model.tabs[b].folderId).toBe(folder.id)
    expect(nextFolderColor(reloaded.model, spaceId)).toBe('grey')
  })

  it('drops a folder whose space is gone and the membership that pointed at it', () => {
    const { doc, spaceId, ids } = profile()
    const [, a] = ids
    const tabs = (doc.tabs as Array<Record<string, unknown>>).map((t) =>
      t.id === a ? { ...t, folderId: 'folder_orphan' } : t
    )
    const { s } = stateFrom({
      ...doc,
      tabs,
      folders: [
        { id: 'folder_orphan', spaceId: 'space_gone', name: 'Old', icon: '📁', collapsed: false },
        { id: 'folder_kept', spaceId, name: 'Kept', icon: '📁', color: 'red', collapsed: false }
      ]
    })
    expect(Object.keys(s.model.folders)).toEqual(['folder_kept'])
    expect(s.model.tabs[a].folderId).toBeNull()
  })
})

describe('tab navigation persistence', () => {
  const stack = {
    entries: [
      { url: 'https://a.test/', title: 'A', pageState: 'c2Nyb2xs' },
      { url: 'https://a.test/two', title: 'A two' }
    ],
    index: 1
  }

  it('writes the stacks of the open tabs with the page state and reads them back', async () => {
    const { doc, ids } = profile()
    const [, a] = ids
    const { s, io } = stateFrom(doc)
    expect(s.tabNavigation.size).toBe(0)
    s.tabNavigation.set(a, stack)
    s.commit()
    await tick()
    await s.flush()
    const written = JSON.parse(io.writes[io.writes.length - 1]) as {
      navigation: Record<string, unknown>
    }
    expect(written.navigation).toEqual({ [a]: stack })
    const reloaded = stateFrom(written).s
    expect(reloaded.tabNavigation.get(a)).toEqual(stack)
  })

  it('leaves out stacks whose tab is gone or private, and drops garbage on load', async () => {
    const { doc, ids } = profile()
    const [, a, b] = ids
    const { s, io } = stateFrom({
      ...doc,
      version: 3,
      navigation: {
        [a]: stack,
        [b]: { entries: [{ url: '' }, { title: 'no url' }, 7], index: 0 },
        ghost: stack,
        nonsense: 'oops'
      }
    })
    expect([...s.tabNavigation.keys()]).toEqual([a, 'ghost'])
    s.model.tabs[b].containerId = 'private'
    s.tabNavigation.set(b, stack)
    s.commit()
    await tick()
    await s.flush()
    const written = JSON.parse(io.writes[io.writes.length - 1]) as {
      navigation: Record<string, unknown>
    }
    expect(Object.keys(written.navigation)).toEqual([a])
    expect(s.tabNavigation.has('ghost')).toBe(false)
    expect(s.tabNavigation.has(b)).toBe(false)
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
// New tab page persistence (state.json v4 → v5)
// ---------------------------------------------------------------------------

/** A minimal profile as an older build wrote it (`version` picks the schema). */
function legacyProfile(version: 1 | 2 | 3 | 4 | 5, extra: Partial<Persisted> = {}): string {
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

/** `settings` of a 0.3.x profile: the desktop's first `newTab` next to the phone's `newTabPhone`. */
function settingsOfBothKeys(): Persisted['settings'] {
  const settings = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>
  settings.newTab = { enabled: true, shortcuts: 'custom', background: 'space', greeting: true }
  settings.newTabPhone = {
    preset: 'inspirational',
    modules: { searchBox: true, shortcuts: true, wallpaper: false, feed: false },
    shortcutStyle: 'most-visited',
    wallpaper: 'image',
    pinned: [
      { url: 'https://pinned.example/', title: 'Pinned' },
      { url: 'https://a.example/', title: 'Also a desktop shortcut' }
    ],
    hiddenHosts: ['www.news.example', 'Gone.example']
  }
  return settings as unknown as Persisted['settings']
}

const newTabKeys = (
  text: string
): Pick<Persisted, 'version' | 'newTabDevice' | 'newTabShortcuts' | 'newTabHiddenHosts'> & {
  newTab: unknown
  newTabPhone: unknown
} => {
  const written = JSON.parse(text) as Persisted & { settings: Record<string, unknown> }
  return {
    version: written.version,
    newTabDevice: written.newTabDevice,
    newTabShortcuts: written.newTabShortcuts,
    newTabHiddenHosts: written.newTabHiddenHosts,
    newTab: written.settings.newTab,
    newTabPhone: written.settings.newTabPhone
  }
}

describe('state.json v5 (new tab page)', () => {
  it('writes the current schema version with the device-local document', async () => {
    const io = fakeIo()
    const s = state(io)
    s.newTabDevice = {
      shortcuts: [{ id: 'sc_1', title: 'Zen', url: 'https://zen-browser.app/' }],
      hiddenHosts: ['news.example']
    }
    await s.flush()
    const written = JSON.parse(io.writes.at(-1) ?? '{}') as Persisted
    expect(written.version).toBe(PERSISTED_VERSION)
    expect(written.version).toBe(5)
    expect(written.newTabDevice).toEqual({
      shortcuts: [{ id: 'sc_1', title: 'Zen', url: 'https://zen-browser.app/' }],
      hiddenHosts: ['news.example']
    })
    expect(written.newTabShortcuts).toBeUndefined()
    expect(written.newTabHiddenHosts).toBeUndefined()
    expect(written.settings.newTab).toEqual(DEFAULT_NEW_TAB_SETTINGS)
    expect('newTabPhone' in written.settings).toBe(false)
  })

  it('migrates a v2 profile: no shortcuts, default new tab settings', () => {
    const settings = structuredClone(DEFAULT_SETTINGS) as Partial<typeof DEFAULT_SETTINGS>
    delete settings.newTab
    const s = state(fakeIo(legacyProfile(2, { settings: settings as typeof DEFAULT_SETTINGS })))
    expect(s.newTabDevice).toEqual({ shortcuts: [], hiddenHosts: [] })
    expect(s.settings.newTab).toEqual(DEFAULT_NEW_TAB_SETTINGS)
  })

  it('migrates a v1 profile the same way', () => {
    const s = state(fakeIo(legacyProfile(1, { windowBounds: null, maximized: false })))
    expect(s.newTabDevice).toEqual({ shortcuts: [], hiddenHosts: [] })
    expect(s.settings.newTab.enabled).toBe(true)
  })

  it('migrates a v3 profile (bookmark tree, recently closed) keeping its closed list', () => {
    const s = state(fakeIo(legacyProfile(3, { bookmarks: undefined, recentlyClosed: [] })))
    expect(s.newTabDevice).toEqual({ shortcuts: [], hiddenHosts: [] })
    expect(s.recentlyClosed).toEqual([])
    expect(s.settings.newTab).toEqual(DEFAULT_NEW_TAB_SETTINGS)
  })

  it('reads v4 shortcuts and the block list and sanitises the new tab settings', () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    ;(settings.newTab as unknown as Record<string, unknown>).mode = 'bogus'
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
    expect(s.newTabDevice).toEqual({
      shortcuts: [
        { id: 'a', title: 'A', url: 'https://a.example/' },
        { id: 'b', title: 'https://b.example/', url: 'https://b.example/' }
      ],
      hiddenHosts: ['news.example']
    })
    expect(s.settings.newTab).toEqual({ ...DEFAULT_NEW_TAB_SETTINGS, background: 'solid' })
  })

  it('folds a v4 profile carrying both keys into the one model, once', async () => {
    const io = fakeIo(
      legacyProfile(4, {
        settings: settingsOfBothKeys(),
        newTabShortcuts: [{ id: 'a', title: 'A', url: 'https://a.example/' }],
        newTabHiddenHosts: ['news.example', 'old.example']
      })
    )
    const s = state(io)
    // The desktop's `custom` grid reads as `my-shortcuts`; the phone's non-default preset and
    // image source win; the desktop's greeting lives on in the modules of the phone's preset.
    expect(s.settings.newTab).toEqual({
      enabled: true,
      mode: 'my-shortcuts',
      preset: 'inspirational',
      modules: { searchBox: true, shortcuts: true, wallpaper: false, feed: false, greeting: true },
      background: 'image'
    })
    expect('newTabPhone' in s.settings).toBe(false)
    // Pins follow the desktop's shortcuts, once per address; the block lists are one normalised
    // list; pinning a hidden host (as the desktop copy of a.example was not) is not in play here.
    expect(s.newTabDevice.shortcuts.map((x) => [x.url, x.title])).toEqual([
      ['https://a.example/', 'A'],
      ['https://pinned.example/', 'Pinned']
    ])
    expect(s.newTabDevice.hiddenHosts).toEqual(['news.example', 'old.example', 'gone.example'])

    await s.flush()
    const first = io.writes.at(-1) ?? '{}'
    const keys = newTabKeys(first)
    expect(keys.version).toBe(5)
    expect(keys.newTabPhone).toBeUndefined()
    expect(keys.newTabShortcuts).toBeUndefined()
    expect(keys.newTabHiddenHosts).toBeUndefined()
    expect(keys.newTabDevice).toEqual(s.newTabDevice)

    // A second launch reads the v5 file as it was written: nothing to migrate, nothing changes.
    const again = fakeIo(first)
    const s2 = state(again)
    expect(s2.settings.newTab).toEqual(s.settings.newTab)
    expect(s2.newTabDevice).toEqual(s.newTabDevice)
    await s2.flush()
    expect(newTabKeys(again.writes.at(-1) ?? '{}')).toEqual(keys)
  })

  it('folds the phone key wherever it turns up, a v5 file included', () => {
    const settings = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>
    settings.newTabPhone = {
      preset: 'custom',
      modules: { searchBox: true, shortcuts: false, wallpaper: false, feed: false },
      shortcutStyle: 'my-shortcuts',
      wallpaper: 'space',
      pinned: [],
      hiddenHosts: []
    }
    const s = state(
      fakeIo(
        legacyProfile(5, {
          settings: settings as unknown as Persisted['settings'],
          newTabDevice: { shortcuts: [], hiddenHosts: ['kept.example'] }
        })
      )
    )
    expect(s.settings.newTab.preset).toBe('custom')
    expect(s.settings.newTab.modules.shortcuts).toBe(false)
    expect(s.settings.newTab.mode).toBe('my-shortcuts')
    expect('newTabPhone' in s.settings).toBe(false)
    expect(s.newTabDevice.hiddenHosts).toEqual(['kept.example'])
  })
})
