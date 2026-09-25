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
function legacyProfile(version: 1 | 2 | 3 | 4 | 5 | 6, extra: Partial<Persisted> = {}): string {
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
    expect(written.version).toBe(6)
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

  it('reads the split view drag and drop switch as on unless the profile turned it off (split-12)', () => {
    const without = structuredClone(DEFAULT_SETTINGS) as Partial<typeof DEFAULT_SETTINGS>
    delete without.splitEdgeZones
    const older = state(fakeIo(legacyProfile(5, { settings: without as typeof DEFAULT_SETTINGS })))
    expect(older.settings.splitEdgeZones).toBe(true)

    const garbage = structuredClone(DEFAULT_SETTINGS)
    ;(garbage as unknown as Record<string, unknown>).splitEdgeZones = 'off'
    expect(state(fakeIo(legacyProfile(5, { settings: garbage }))).settings.splitEdgeZones).toBe(
      true
    )

    const off = structuredClone(DEFAULT_SETTINGS)
    off.splitEdgeZones = false
    expect(state(fakeIo(legacyProfile(5, { settings: off }))).settings.splitEdgeZones).toBe(false)
  })

  it('keeps a split’s link rule with the split (split-13, §9.35): a restored session reads it on only where the record says true; a record from before it, or garbage, reads off and is stored as absent', () => {
    const session = (linksToRight: unknown): string => {
      const space = createSpace('Work', '')
      const a = createTabRecord({
        spaceId: space.id,
        containerId: 'default',
        url: 'https://a.test/'
      })
      const b = createTabRecord({
        spaceId: space.id,
        containerId: 'default',
        url: 'https://b.test/'
      })
      space.tabIds = [a.id, b.id]
      const group: Record<string, unknown> = {
        id: 'split_1',
        spaceId: space.id,
        tabIds: [a.id, b.id],
        layout: 'vertical',
        sizes: [0.5, 0.5]
      }
      if (linksToRight !== undefined) group.linksToRight = linksToRight
      return legacyProfile(5, {
        spaces: [space],
        tabs: [a, b],
        activeSpaceId: space.id,
        splitGroups: [group as unknown as Persisted['splitGroups'][number]]
      })
    }
    const kept = state(fakeIo(session(true)))
    expect(kept.model.splitGroups.split_1).toMatchObject({ layout: 'vertical', linksToRight: true })
    expect('linksToRight' in state(fakeIo(session(undefined))).model.splitGroups.split_1).toBe(
      false
    )
    expect('linksToRight' in state(fakeIo(session('on'))).model.splitGroups.split_1).toBe(false)
    expect('linksToRight' in state(fakeIo(session(false))).model.splitGroups.split_1).toBe(false)
    // The browser has no such setting any more (one home for the switch: the pane's ⋯ menu).
    expect('splitLinksToRight' in DEFAULT_SETTINGS).toBe(false)
  })

  it('reads the developer tools dock, the bottom for profiles from before it and for garbage (§9.29)', () => {
    const without = structuredClone(DEFAULT_SETTINGS) as Partial<typeof DEFAULT_SETTINGS>
    delete without.devtoolsDock
    const older = state(fakeIo(legacyProfile(5, { settings: without as typeof DEFAULT_SETTINGS })))
    expect(older.settings.devtoolsDock).toBe('bottom')

    const garbage = structuredClone(DEFAULT_SETTINGS)
    ;(garbage as unknown as Record<string, unknown>).devtoolsDock = 'detach'
    expect(state(fakeIo(legacyProfile(5, { settings: garbage }))).settings.devtoolsDock).toBe(
      'bottom'
    )

    for (const dock of ['right', 'left', 'undocked'] as const) {
      const chosen = structuredClone(DEFAULT_SETTINGS)
      chosen.devtoolsDock = dock
      expect(state(fakeIo(legacyProfile(5, { settings: chosen }))).settings.devtoolsDock).toBe(dock)
    }
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
    expect(keys.version).toBe(6)
    expect(keys.newTabPhone).toBeUndefined()
    expect(keys.newTabShortcuts).toBeUndefined()
    expect(keys.newTabHiddenHosts).toBeUndefined()
    expect(keys.newTabDevice).toEqual(s.newTabDevice)

    // A second launch reads the v6 file as it was written: nothing to migrate, nothing changes.
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

// ---------------------------------------------------------------------------
// The rail's Expand on hover, on by default (state.json v5 → v6; tabs-03, W5-17)
// ---------------------------------------------------------------------------

describe('state.json v6 (Expand on hover on by default)', () => {
  const stored = (version: 1 | 2 | 3 | 4 | 5 | 6, value: unknown): BrowserState => {
    const settings = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>
    if (value === undefined) delete settings.sidebarExpandOnHover
    else settings.sidebarExpandOnHover = value
    return state(
      fakeIo(legacyProfile(version, { settings: settings as unknown as Persisted['settings'] }))
    )
  }

  it('ships on: a fresh profile and a profile from before the row (no key) take the default', () => {
    expect(DEFAULT_SETTINGS.sidebarExpandOnHover).toBe(true)
    expect(state(fakeIo()).settings.sidebarExpandOnHover).toBe(true)
    for (const version of [1, 2, 3, 4, 5] as const) {
      expect(stored(version, undefined).settings.sidebarExpandOnHover, `v${version}`).toBe(true)
    }
  })

  it('reads a pre-v6 profile’s false as the old default written back, not a choice: on; its true was a choice and stays on', () => {
    // The settings are written whole, so every profile a build with the off default wrote
    // carries `false` whether or not the row was ever seen; only `true` could have been chosen.
    for (const version of [4, 5] as const) {
      expect(stored(version, false).settings.sidebarExpandOnHover, `v${version} false`).toBe(true)
      expect(stored(version, true).settings.sidebarExpandOnHover, `v${version} true`).toBe(true)
    }
  })

  it('keeps a v6 profile’s stored value, off only where it says so; garbage reads the default', () => {
    expect(stored(6, false).settings.sidebarExpandOnHover).toBe(false)
    expect(stored(6, true).settings.sidebarExpandOnHover).toBe(true)
    expect(stored(6, undefined).settings.sidebarExpandOnHover).toBe(true)
    expect(stored(6, 'off').settings.sidebarExpandOnHover).toBe(true)
  })

  it('writes v6, so a profile turned off after the flip stays off across a relaunch', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.sidebarExpandOnHover = false
    const io = fakeIo(legacyProfile(5, { settings }))
    const s = state(io)
    expect(s.settings.sidebarExpandOnHover).toBe(true)
    s.settings.sidebarExpandOnHover = false
    s.commit()
    await s.flush()
    const written = JSON.parse(io.writes.at(-1) ?? '{}') as Persisted
    expect(written.version).toBe(6)
    expect(written.settings.sidebarExpandOnHover).toBe(false)
    const again = state(fakeIo(io.writes.at(-1) ?? '{}'))
    expect(again.settings.sidebarExpandOnHover).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The phone app menu's order (TB-22): a list loads as a list, the empty one included
// ---------------------------------------------------------------------------

describe('settings.menuOrder on load', () => {
  const stored = (value: unknown): BrowserState => {
    const settings = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>
    if (value !== undefined) settings.menuOrder = value
    return state(
      fakeIo(legacyProfile(6, { settings: settings as unknown as Persisted['settings'] }))
    )
  }

  it('has no key on a fresh profile or one that never held it, keeps a saved list sanitised, and keeps the empty list of a Reset as a value', () => {
    expect('menuOrder' in DEFAULT_SETTINGS).toBe(false)
    expect('menuOrder' in state(fakeIo()).settings).toBe(false)
    expect('menuOrder' in stored(undefined).settings).toBe(false)
    expect(stored(['row.settings', 3, 'row.newTab', 'row.settings']).settings.menuOrder).toEqual([
      'row.settings',
      'row.newTab'
    ])
    // The Reset's write: kept, so it persists across a relaunch and travels in the sync record.
    expect(stored([]).settings.menuOrder).toEqual([])
    expect(stored([3, null]).settings.menuOrder).toEqual([])
  })

  it('reads anything that is no list as no setting', () => {
    for (const bad of [null, 'row.settings', 42, { 0: 'row.settings' }]) {
      expect('menuOrder' in stored(bad).settings, JSON.stringify(bad)).toBe(false)
    }
  })

  it('writes the empty list back, so a Reset survives a relaunch', async () => {
    const io = fakeIo(legacyProfile(6))
    const s = state(io)
    s.settings.menuOrder = []
    s.commit()
    await s.flush()
    const written = JSON.parse(io.writes.at(-1) ?? '{}') as Persisted
    expect(written.settings.menuOrder).toEqual([])
    expect(state(fakeIo(io.writes.at(-1) ?? '{}')).settings.menuOrder).toEqual([])
  })
})
