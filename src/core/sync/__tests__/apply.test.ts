import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs } from '../../../shared/types'
import { DEFAULT_SETTINGS } from '../../../shared/defaults'
import { DEFAULT_NEW_TAB_SETTINGS } from '../../../shared/newTab'
import { matchKeywordWord } from '../../../shared/search'
import { Browser } from '../../../core/browser'
import { createFolder, createSpace } from '../../../core/model'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../../../core/platform'
import { applyRemote } from '../apply'
import {
  SETTINGS_RECORD_ID,
  SITE_DATA_RECORD_ID,
  collectLocal,
  defaultScope,
  withoutDeviceLocalSettings,
  type SyncRecord
} from '../records'

function memoryIo(files: Record<string, string> = {}): StoreIO {
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

/** A browser over an empty profile, or over the files given (`state.json` among them). */
function browser(files: Record<string, string> = {}): Browser {
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities: stub<HostCapabilities>({ windows: false, updates: false, agents: false }),
    io: memoryIo(files),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true
        })
    },
    views: stub<TabViewHost>({
      createView: () => stub<TabView>({ isDestroyed: () => false, isVisible: () => false })
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
  const b = new Browser(platform)
  b.state.settings.onboardingDone = true
  b.start()
  return b
}

function settingsRecord(data: Record<string, unknown>): SyncRecord {
  return { id: SETTINGS_RECORD_ID, type: 'settings', data, modified: 1000, deleted: false }
}

/** `settings.newTabPhone` as a 0.3.x phone wrote it: the user picked the inspirational layout. */
const PEER_PHONE = {
  preset: 'inspirational',
  modules: { searchBox: true, shortcuts: true, wallpaper: false, feed: false },
  shortcutStyle: 'most-visited',
  wallpaper: 'image',
  pinned: [{ url: 'https://peer.example/', title: 'Peer' }],
  hiddenHosts: ['www.gone.example']
}

describe('applyRemote: the settings record and the new tab page', () => {
  it("folds a 0.3.x peer's newTabPhone into newTab and never lets the key land on the settings", () => {
    const b = browser()
    b.newTab.addShortcut('Mine', 'https://mine.example/')
    applyRemote(b, [
      settingsRecord({
        ...b.state.settings,
        // The desktop's first shape next to the phone's key, as such a peer's record carries them.
        newTab: { enabled: true, shortcuts: 'most-visited', background: 'space', greeting: false },
        newTabPhone: PEER_PHONE
      })
    ])
    expect(b.state.settings.newTab).toEqual({
      ...DEFAULT_NEW_TAB_SETTINGS,
      preset: 'inspirational',
      background: 'image'
    })
    expect('newTabPhone' in b.state.settings).toBe(false)
    // Pins and removed hosts are the peer device's own: this device's sets do not change.
    expect(b.state.newTabDevice).toEqual({
      shortcuts: [{ id: expect.any(String), title: 'Mine', url: 'https://mine.example/' }],
      hiddenHosts: []
    })
  })

  it("translates a 0.3.x desktop peer's first newTab shape", () => {
    const b = browser()
    applyRemote(b, [
      settingsRecord({
        ...b.state.settings,
        newTab: { enabled: false, shortcuts: 'custom', background: 'solid', greeting: true }
      })
    ])
    expect(b.state.settings.newTab).toEqual({
      enabled: false,
      mode: 'my-shortcuts',
      preset: 'custom',
      modules: { searchBox: true, shortcuts: true, wallpaper: true, feed: false, greeting: true },
      background: 'solid'
    })
  })

  it('applies the one model from a peer on this build, sanitised, and drops unknown values', () => {
    const b = browser()
    applyRemote(b, [
      settingsRecord({
        ...b.state.settings,
        newTab: {
          enabled: true,
          mode: 'custom',
          preset: 'nope',
          modules: { greeting: true, feed: 'yes' },
          background: 'solid'
        }
      })
    ])
    expect(b.state.settings.newTab).toEqual({
      enabled: true,
      mode: 'my-shortcuts',
      preset: 'focused',
      modules: { searchBox: true, shortcuts: true, wallpaper: false, feed: false, greeting: true },
      background: 'solid'
    })
  })

  it('the settings record this device sends carries newTab alone: no phone key, no device sets', () => {
    const b = browser()
    b.newTab.addShortcut('Mine', 'https://mine.example/')
    b.newTab.hideSite('https://gone.example/')
    const record = collectLocal(
      {
        model: b.state.model,
        settings: b.state.settings,
        shortcutOverrides: {},
        bookmarks: [],
        boosts: []
      },
      defaultScope()
    ).get(SETTINGS_RECORD_ID)
    const data = record?.data as Record<string, unknown>
    expect(data.newTab).toEqual(DEFAULT_NEW_TAB_SETTINGS)
    expect(data).not.toHaveProperty('newTabPhone')
    expect(data).not.toHaveProperty('newTabDevice')
    expect(JSON.stringify(data)).not.toContain('mine.example')
    expect(JSON.stringify(data)).not.toContain('gone.example')
  })

  it("a peer's record making a deactivated engine the default lands with the default active, the other flags kept (A7)", () => {
    const b = browser()
    applyRemote(b, [
      settingsRecord({
        ...b.state.settings,
        searchEngineId: 'custom:mine',
        searchEngines: [
          {
            id: 'custom:mine',
            name: 'Mine',
            searchUrl: 'https://mine.example/?q=%s',
            keyword: '@mine',
            active: false
          },
          {
            id: 'custom:other',
            name: 'Other',
            searchUrl: 'https://other.example/?q=%s',
            keyword: '@other',
            active: false
          }
        ]
      })
    ])
    expect(b.state.settings.searchEngineId).toBe('custom:mine')
    const [mine, other] = b.state.settings.searchEngines ?? []
    expect(mine).toMatchObject({ id: 'custom:mine', keyword: '@mine' })
    expect('active' in mine).toBe(false)
    expect(other).toMatchObject({ id: 'custom:other', active: false })
    expect(matchKeywordWord('@mine', b.state.searchEngines)).toMatchObject({ kind: 'engine' })
    expect(matchKeywordWord('@other', b.state.searchEngines)).toBeNull()
  })

  it("a peer's device-local keys never land: this device's Expand on hover and onboarding flag stand while the rest applies (W5-F3)", () => {
    const b = browser()
    // The device as shipped since v6 (on) and before its onboarding; a v5 peer's record
    // carries that build's default `false` and, as every older peer's, its `onboardingDone`.
    b.state.settings.sidebarExpandOnHover = true
    b.state.settings.onboardingDone = false
    applyRemote(b, [
      settingsRecord({
        ...b.state.settings,
        colorScheme: 'dark',
        sidebarWidth: 321,
        sidebarExpandOnHover: false,
        onboardingDone: true
      })
    ])
    expect(b.state.settings.sidebarExpandOnHover).toBe(true)
    expect(b.state.settings.onboardingDone).toBe(false)
    expect(b.state.settings.colorScheme).toBe('dark')
    expect(b.state.settings.sidebarWidth).toBe(321)
  })

  it("a v6 device that turned Expand on hover off stays off when a peer's record applies (W5-F3)", () => {
    // The profile as a v6 build wrote it after the user turned the row off: a choice.
    const profile = {
      version: 6,
      spaces: [],
      tabs: [],
      essentialTabIds: [],
      activeSpaceId: 'space_1',
      containers: [],
      folders: [],
      splitGroups: [],
      settings: { ...structuredClone(DEFAULT_SETTINGS), sidebarExpandOnHover: false },
      shortcutOverrides: {},
      bookmarks: []
    }
    const b = browser({ 'state.json': JSON.stringify(profile) })
    expect(b.state.settings.sidebarExpandOnHover).toBe(false)
    // A peer that upgraded later publishes its v6 default (on); one on this build sends no key.
    applyRemote(b, [
      settingsRecord({ ...b.state.settings, sidebarExpandOnHover: true, colorScheme: 'dark' })
    ])
    expect(b.state.settings.sidebarExpandOnHover).toBe(false)
    expect(b.state.settings.colorScheme).toBe('dark')
    const data = withoutDeviceLocalSettings(b.state.settings) as Record<string, unknown>
    applyRemote(b, [settingsRecord({ ...data, colorScheme: 'light' })])
    expect(b.state.settings.sidebarExpandOnHover).toBe(false)
    expect(b.state.settings.colorScheme).toBe('light')
    // What this device publishes carries the choice nowhere: the next peer's rail is its own.
    const published = collectLocal(
      {
        model: b.state.model,
        settings: b.state.settings,
        shortcutOverrides: {},
        bookmarks: [],
        boosts: []
      },
      defaultScope()
    ).get(SETTINGS_RECORD_ID)?.data as Record<string, unknown>
    expect(published).not.toHaveProperty('sidebarExpandOnHover')
    expect(published).not.toHaveProperty('onboardingDone')
    expect(published.colorScheme).toBe('light')
  })

  it('takes a synced site-data record whole through the service, ignoring a stray id or a tombstone', () => {
    const b = browser()
    b.siteData.add('allow', 'mine.example')
    const remote = {
      blockAll: true,
      allow: [],
      clearOnExit: ['[*.]shop.example'],
      block: ['never.example', 'bad/']
    }
    applyRemote(b, [
      { id: SITE_DATA_RECORD_ID, type: 'site-data', data: remote, modified: 2000, deleted: false }
    ])
    expect(b.siteData.policy()).toEqual({
      blockAll: true,
      allow: [],
      clearOnExit: ['[*.]shop.example'],
      block: ['never.example']
    })
    applyRemote(b, [
      { id: 'other', type: 'site-data', data: { blockAll: false }, modified: 3000, deleted: false },
      { id: SITE_DATA_RECORD_ID, type: 'site-data', data: null, modified: 3000, deleted: true }
    ])
    expect(b.siteData.policy().blockAll).toBe(true)
    // The local copy is what the next collection publishes.
    const published = collectLocal(
      {
        model: b.state.model,
        settings: b.state.settings,
        shortcutOverrides: {},
        bookmarks: [],
        boosts: [],
        siteData: b.siteData.policy()
      },
      defaultScope()
    ).get(SITE_DATA_RECORD_ID)
    expect(published?.data).toEqual(b.siteData.policy())
  })

  it("a peer's phone menu order: a list is kept – the empty list of a Reset stored and re-sent, not deleted – a record without the key says nothing, a value that is no list deletes it", () => {
    const b = browser()
    const sent = (): Record<string, unknown> =>
      collectLocal(
        {
          model: b.state.model,
          settings: b.state.settings,
          shortcutOverrides: {},
          bookmarks: [],
          boosts: []
        },
        defaultScope()
      ).get(SETTINGS_RECORD_ID)?.data as Record<string, unknown>
    expect('menuOrder' in b.state.settings).toBe(false)
    expect(sent()).not.toHaveProperty('menuOrder')

    // The peer's order lands sanitised (its build's keys read against this one's later).
    applyRemote(b, [
      settingsRecord({ ...b.state.settings, menuOrder: ['row.settings', 3, 'row.newTab', ''] })
    ])
    expect(b.state.settings.menuOrder).toEqual(['row.settings', 'row.newTab'])
    expect(sent().menuOrder).toEqual(['row.settings', 'row.newTab'])

    // A peer that never touched the menu carries no key: its record leaves the order alone.
    const { menuOrder: _absent, ...untouched } = b.state.settings
    void _absent
    applyRemote(b, [settingsRecord({ ...untouched, colorScheme: 'dark' })])
    expect(b.state.settings.colorScheme).toBe('dark')
    expect(b.state.settings.menuOrder).toEqual(['row.settings', 'row.newTab'])

    // The peer's Reset: the empty list is stored as the value and carried in this device's own
    // records from now on, so a third device holding the old order offline takes the reset too.
    applyRemote(b, [settingsRecord({ ...b.state.settings, menuOrder: [] })])
    expect(b.state.settings.menuOrder).toEqual([])
    expect(sent().menuOrder).toEqual([])

    // Only something that is no list at all deletes the key.
    applyRemote(b, [settingsRecord({ ...b.state.settings, menuOrder: 'row.settings' })])
    expect('menuOrder' in b.state.settings).toBe(false)
    expect(sent()).not.toHaveProperty('menuOrder')
  })

  it('a record narrowed to the keys that won (per-key merge) lands those keys alone: every other setting, the new tab page and the engines included, stands', () => {
    const b = browser()
    b.updateSettings(
      {
        sidebarWidth: 300,
        newTab: { ...b.state.settings.newTab, background: 'solid' },
        menuOrder: ['row.settings'],
        fonts: { ...b.state.settings.fonts, size: 20 }
      },
      stub()
    )
    const engineId = b.searchEngines.add('Mine', 'https://mine.example/?q=%s', stub())
    b.updateSettings({ searchEngineId: engineId }, stub())
    const before = structuredClone(b.state.settings)
    expect(before.searchEngineId).toBe(engineId)

    // `winningRemote` hands over the winning keys as the record: two keys here, out of the
    // seventy a whole record carries.
    applyRemote(b, [
      {
        ...settingsRecord({ colorScheme: 'dark', languages: ['de', 'en'] }),
        keys: { languages: 900 }
      }
    ])
    expect(b.state.settings.colorScheme).toBe('dark')
    expect(b.state.settings.languages).toEqual(['de', 'en'])
    const { colorScheme: _scheme, languages: _languages, ...rest } = b.state.settings
    void _scheme
    void _languages
    const { colorScheme: _wasScheme, languages: _wasLanguages, ...wasRest } = before
    void _wasScheme
    void _wasLanguages
    expect(rest).toEqual(wasRest)
    expect(b.state.settings.newTab).toEqual(before.newTab)
    expect(b.state.settings.searchEngineId).toBe(engineId)
    expect(b.state.settings.menuOrder).toEqual(['row.settings'])
  })

  it("the pair travels as one: a record carrying the peer's engines and default lands both; one carrying newTabPhone alone (a 0.3.x phone's key) folds into newTab", () => {
    const b = browser()
    b.updateSettings({ newTab: { ...b.state.settings.newTab, background: 'solid' } }, stub())
    applyRemote(b, [
      settingsRecord({
        searchEngineId: 'custom:peer',
        searchEngines: [
          {
            id: 'custom:peer',
            name: 'Peer',
            searchUrl: 'https://peer.example/?q=%s',
            keyword: '@peer',
            active: true
          }
        ]
      })
    ])
    expect(b.state.settings.searchEngineId).toBe('custom:peer')
    expect(b.state.settings.searchEngines?.map((e) => e.id)).toEqual(['custom:peer'])
    expect(b.state.settings.newTab.background).toBe('solid')

    applyRemote(b, [settingsRecord({ newTabPhone: PEER_PHONE })])
    expect(b.state.settings.newTab).toEqual({
      ...DEFAULT_NEW_TAB_SETTINGS,
      preset: 'inspirational',
      background: 'image'
    })
    expect('newTabPhone' in b.state.settings).toBe(false)
    expect(b.state.settings.searchEngineId).toBe('custom:peer')
  })
})

describe('applyRemote: the settings record and Settings › On startup', () => {
  const MINE = ['https://mine.example/', 'https://mine.example/two']

  it("folds an old peer's restoreSession into the startup mode over this device's own pages and never lets the key land", () => {
    const b = browser()
    b.state.settings.startup = { mode: 'newTab', pages: MINE }
    // The record as a 0.4.x build writes it: the switch, no `startup`.
    applyRemote(b, [settingsRecord({ restoreSession: true })])
    expect(b.state.settings.startup).toEqual({ mode: 'continue', pages: MINE })
    expect('restoreSession' in b.state.settings).toBe(false)
    applyRemote(b, [settingsRecord({ restoreSession: false })])
    expect(b.state.settings.startup).toEqual({ mode: 'newTab', pages: MINE })
    expect('restoreSession' in b.state.settings).toBe(false)
    // A switch that is no boolean (a hand-edited record) says nothing.
    applyRemote(b, [settingsRecord({ restoreSession: 'yes' })])
    expect(b.state.settings.startup).toEqual({ mode: 'newTab', pages: MINE })
  })

  it("prefers a new peer's startup to the mirrored switch beside it, read like a profile's own: known modes, web addresses, no stray key", () => {
    const b = browser()
    b.state.settings.startup = { mode: 'newTab', pages: MINE }
    applyRemote(b, [
      settingsRecord({
        startup: {
          mode: 'pages',
          pages: ['peer.example', 'zenium://settings', 'https://peer.example/', 'not a url']
        },
        restoreSession: true
      })
    ])
    expect(b.state.settings.startup).toEqual({ mode: 'pages', pages: ['https://peer.example/'] })
    expect('restoreSession' in b.state.settings).toBe(false)
    // A mode a newer build knows reads as the default's; junk in the list is dropped.
    applyRemote(b, [settingsRecord({ startup: { mode: 'lastWindow', pages: [7] } })])
    expect(b.state.settings.startup).toEqual({ mode: 'continue', pages: [] })
    // A record without either key says nothing about the startup.
    b.state.settings.startup = { mode: 'newTab', pages: MINE }
    applyRemote(b, [settingsRecord({ colorScheme: 'dark' })])
    expect(b.state.settings.startup).toEqual({ mode: 'newTab', pages: MINE })
  })

  it('the settings record this device sends carries startup in its sanitised shape and the mirrored switch, never a stray', () => {
    const b = browser()
    b.state.settings.startup = { mode: 'pages', pages: MINE }
    const record = collectLocal(
      {
        model: b.state.model,
        settings: b.state.settings,
        shortcutOverrides: {},
        bookmarks: [],
        boosts: []
      },
      defaultScope()
    ).get(SETTINGS_RECORD_ID)
    const data = record?.data as Record<string, unknown>
    expect(data.startup).toEqual({ mode: 'pages', pages: MINE })
    expect(data.restoreSession).toBe(true)
    expect(Object.keys(data).filter((key) => !(key in b.state.settings))).toEqual([
      'restoreSession'
    ])
  })
})

describe("applyRemote: the agents' mark on space and folder records", () => {
  const space = (id: string, data: Record<string, unknown>, modified = 1000): SyncRecord => ({
    id,
    type: 'space',
    data: {
      name: 'Agents',
      icon: '',
      containerId: 'default',
      theme: null,
      pinnedCollapsed: false,
      ...data
    },
    modified,
    deleted: false
  })
  const folder = (
    id: string,
    spaceId: string,
    data: Record<string, unknown>,
    modified = 1000
  ): SyncRecord => ({
    id,
    type: 'folder',
    data: { spaceId, name: 'A · 3f9a', icon: '', collapsed: false, ...data },
    modified,
    deleted: false
  })

  it("lands a peer's marked space and group with their marks, and a later record re-stamps them", () => {
    const b = browser()
    applyRemote(b, [
      space('space_shared', { agent: { kind: 'shared' } }),
      space('space_own', {
        name: 'Research bot',
        agent: { kind: 'own', name: 'Research bot', createdAt: 7 }
      }),
      folder('folder_a', 'space_shared', { agent: { name: 'A', createdAt: 5 } }),
      folder('folder_mine', 'space_shared', { name: 'Mine' })
    ])
    const m = b.state.model
    expect(m.spaces.find((s) => s.id === 'space_shared')?.agent).toEqual({ kind: 'shared' })
    expect(m.spaces.find((s) => s.id === 'space_own')?.agent).toEqual({
      kind: 'own',
      name: 'Research bot',
      createdAt: 7
    })
    expect(m.folders.folder_a.agent).toEqual({ name: 'A', createdAt: 5 })
    // The user's folder in the shared space lands as it came: no mark.
    expect(m.folders.folder_mine).not.toHaveProperty('agent')
    // The peer's agent adopted the group: the newer record carries the adopter's name.
    applyRemote(b, [
      folder('folder_a', 'space_shared', { agent: { name: 'B', createdAt: 5 } }, 2000)
    ])
    expect(m.folders.folder_a.agent).toEqual({ name: 'B', createdAt: 5 })
    // Every device publishes the mark it holds, so the next peer gets it too.
    const published = collectLocal(
      { model: m, settings: b.state.settings, shortcutOverrides: {}, bookmarks: [], boosts: [] },
      defaultScope()
    )
    expect(published.get('space_shared')?.data).toMatchObject({ agent: { kind: 'shared' } })
    expect(published.get('folder_a')?.data).toMatchObject({ agent: { name: 'B', createdAt: 5 } })
    expect(published.get('folder_mine')?.data).not.toHaveProperty('agent')
  })

  it('a record without the field (a peer older than the mark) keeps the local mark; a malformed one is ignored', () => {
    const b = browser()
    const m = b.state.model
    const shared = createSpace('Agents', '')
    shared.agent = { kind: 'shared' }
    m.spaces.push(shared)
    const group = createFolder(m, shared.id, 'A · 3f9a', '')
    group.agent = { name: 'A', createdAt: 5 }
    applyRemote(b, [
      space(shared.id, { name: 'Agents (theirs)' }),
      folder(group.id, shared.id, { name: 'Renamed on the phone' })
    ])
    expect(shared.name).toBe('Agents (theirs)')
    expect(shared.agent).toEqual({ kind: 'shared' })
    expect(group.name).toBe('Renamed on the phone')
    expect(group.agent).toEqual({ name: 'A', createdAt: 5 })
    applyRemote(b, [
      space(shared.id, { agent: { kind: 'own' } }, 2000),
      folder(group.id, shared.id, { agent: { name: 'B' } }, 2000),
      space('space_odd', { agent: 'shared' }, 2000),
      folder('folder_odd', shared.id, { agent: { createdAt: 5 } }, 2000)
    ])
    expect(shared.agent).toEqual({ kind: 'shared' })
    expect(group.agent).toEqual({ name: 'A', createdAt: 5 })
    expect(m.spaces.find((s) => s.id === 'space_odd')).not.toHaveProperty('agent')
    expect(m.folders.folder_odd).not.toHaveProperty('agent')
  })
})
