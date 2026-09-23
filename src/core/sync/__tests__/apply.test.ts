import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs } from '../../../shared/types'
import { DEFAULT_NEW_TAB_SETTINGS } from '../../../shared/newTab'
import { matchKeywordWord } from '../../../shared/search'
import { Browser } from '../../../core/browser'
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
