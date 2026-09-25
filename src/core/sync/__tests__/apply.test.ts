import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs } from '../../../shared/types'
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
  type SyncRecord
} from '../records'

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

function browser(): Browser {
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities: stub<HostCapabilities>({ windows: false, updates: false, agents: false }),
    io: memoryIo(),
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
