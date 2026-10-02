import { describe, expect, it } from 'vitest'
import type {
  HostCapabilities,
  Mod,
  Platform as PlatformOs,
  ReadingListEntry
} from '../../../shared/types'
import { DEFAULT_SETTINGS } from '../../../shared/defaults'
import {
  DEFAULT_BLOCKING_SETTINGS,
  effectiveLevel,
  sanitizeBlockingSettings
} from '../../../shared/blocking'
import { MAX_MOD_CSS, UNTITLED_MOD } from '../../../shared/mods'
import { DEFAULT_NEW_TAB_SETTINGS } from '../../../shared/newTab'
import { DEFAULT_READER_PREFERENCES } from '../../../shared/reader'
import { matchKeywordWord } from '../../../shared/search'
import { Browser } from '../../../core/browser'
import { NoExtensions } from '../../../core/hostDefaults'
import { createFolder, createSpace } from '../../../core/model'
import type {
  Platform,
  StoreIO,
  SyncedExtensionChange,
  TabView,
  TabViewHost,
  WindowHost
} from '../../../core/platform'
import { applyRemote } from '../apply'
import {
  DEVICE_LOCAL_SETTINGS,
  SETTINGS_RECORD_ID,
  SITE_DATA_RECORD_ID,
  collectLocal,
  defaultScope,
  diffLocal,
  hashData,
  metaFromRemote,
  modData,
  readingListEntryData,
  settingsKeyTime,
  winningRemote,
  withoutDeviceLocalSettings,
  type SyncRecord
} from '../records'
import { READING_LIST_CAP } from '../../../shared/readingList'

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

/**
 * A browser over an empty profile, or over the files given (`state.json` among them); with
 * `createExtensions`, over a host that has extensions (else `NoExtensions`, the phone's shape).
 */
function browser(
  files: Record<string, string> = {},
  createExtensions?: Platform['createExtensions']
): Browser {
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
    readabilitySource: () => null,
    ...(createExtensions ? { createExtensions } : {})
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
      hiddenHosts: [],
      hiddenModules: [],
      safetyHubCard: {},
      educationalTips: { cards: {}, shownAt: null, browsingDataClearedAt: null }
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

  it("a peer's Memory Saver mode and timer and its Energy Saver mode never land – an older build still sends them – while the keep-active hosts and the rest apply (W8-2)", () => {
    const b = browser()
    // This laptop: Memory Saver at Balanced, Energy Saver at the threshold. The peer – a phone
    // on a build from before the keys were device-local, or a tower – sends its own values.
    b.state.settings.unloadEnabled = true
    b.state.settings.unloadTimeoutMinutes = 240
    b.state.settings.energySaver = 'low-battery'
    applyRemote(b, [
      settingsRecord({
        ...b.state.settings,
        unloadEnabled: false,
        unloadTimeoutMinutes: 20,
        energySaver: 'off',
        unloadExcludedDomains: ['zen.test'],
        colorScheme: 'dark'
      })
    ])
    expect(b.state.settings.unloadEnabled).toBe(true)
    expect(b.state.settings.unloadTimeoutMinutes).toBe(240)
    expect(b.state.settings.energySaver).toBe('low-battery')
    expect(b.state.settings.unloadExcludedDomains).toEqual(['zen.test'])
    expect(b.state.settings.colorScheme).toBe('dark')
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

/**
 * Reader View's text preferences (services pass 12, seed 16): the peer's `reader` is read through
 * `sanitizeReaderPreferences` at apply like every other object-valued setting, so a peer on an
 * older build (fewer fields) or a garbage value never leaves a hole or an off-ladder value in
 * `state.settings.reader` – what `ReaderService.preferences()` hands out as it stands.
 */
describe("applyRemote: the settings record and Reader View's text preferences (services pass 12)", () => {
  /** The record this device would send now (`collectLocal`), settings data alone. */
  const sent = (b: Browser): Record<string, unknown> =>
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

  it('a peer on an older build sends fewer fields: its object lands whole with every missing field at the default, and the reader service hands out no hole', () => {
    const b = browser()
    b.reader.setPreferences({ fontSize: 22, theme: 'sepia', lineSpacing: 'loose', syllables: true })
    expect(b.state.settings.reader).toMatchObject({ lineSpacing: 'loose', syllables: true })

    // The peer's build knows two fields fewer (built from the defaults, so the fixture is an
    // older build's before and after the next field is added); its own edits are the size and
    // the font.
    const {
      letterSpacing: _letterSpacing,
      syllables: _syllables,
      ...older
    } = DEFAULT_READER_PREFERENCES
    void _letterSpacing
    void _syllables
    const peer = { ...older, fontSize: 14, font: 'mono' }
    expect(Object.keys(peer)).toHaveLength(Object.keys(DEFAULT_READER_PREFERENCES).length - 2)
    applyRemote(b, [{ ...settingsRecord({ reader: peer }), keys: { reader: 900 } }])

    // The peer's key won whole: its edits land, the fields it lacks read as the defaults – not
    // this device's previous values – and nothing is `undefined`.
    expect(b.state.settings.reader).toEqual({
      ...DEFAULT_READER_PREFERENCES,
      fontSize: 14,
      font: 'mono'
    })
    expect(Object.keys(b.state.settings.reader).sort()).toEqual(
      Object.keys(DEFAULT_READER_PREFERENCES).sort()
    )
    expect(b.reader.preferences()).toEqual(b.state.settings.reader)
    // The record this device sends from now on carries the completed object.
    expect(sent(b).reader).toEqual(b.state.settings.reader)
  })

  it("a peer from before CT-35 sends Edge's one Text spacing step: it reads forward as the pair it stood for, and the record sent on carries the two keys and never the old one", () => {
    const b = browser()
    // The peer's object as its build wrote it: `spacing` and neither of the two rows' keys.
    const {
      lineSpacing: _lineSpacing,
      letterSpacing: _letterSpacing,
      ...rest
    } = DEFAULT_READER_PREFERENCES
    void _lineSpacing
    void _letterSpacing
    const peer = { ...rest, fontSize: 20, spacing: 'wider' }
    applyRemote(b, [{ ...settingsRecord({ reader: peer }), keys: { reader: 900 } }])
    expect(b.state.settings.reader).toEqual({
      ...DEFAULT_READER_PREFERENCES,
      fontSize: 20,
      lineSpacing: 'very-loose',
      letterSpacing: 'very-wide'
    })
    expect('spacing' in b.state.settings.reader).toBe(false)
    expect(b.reader.preferences()).toEqual(b.state.settings.reader)
    const onward = sent(b).reader as Record<string, unknown>
    expect(onward).toEqual(b.state.settings.reader)
    expect('spacing' in onward).toBe(false)

    // The other two steps, read the same way; a peer that already carries the two keys is
    // taken as it is, whatever old key rides along.
    applyRemote(b, [
      { ...settingsRecord({ reader: { ...rest, spacing: 'wide' } }), keys: { reader: 901 } }
    ])
    expect(b.state.settings.reader).toMatchObject({ lineSpacing: 'loose', letterSpacing: 'wide' })
    applyRemote(b, [
      { ...settingsRecord({ reader: { ...rest, spacing: 'normal' } }), keys: { reader: 902 } }
    ])
    expect(b.state.settings.reader).toMatchObject({
      lineSpacing: 'standard',
      letterSpacing: 'standard'
    })
    applyRemote(b, [
      {
        ...settingsRecord({
          reader: { ...DEFAULT_READER_PREFERENCES, lineSpacing: 'loose', spacing: 'wider' }
        }),
        keys: { reader: 903 }
      }
    ])
    expect(b.state.settings.reader).toMatchObject({
      lineSpacing: 'loose',
      letterSpacing: 'standard'
    })
  })

  it('a garbage value – off the ladder, unknown names, no object at all – lands as the defaults; a valid value lands as it is', () => {
    const b = browser()
    applyRemote(b, [
      settingsRecord({
        reader: {
          fontSize: 999,
          font: 'comic',
          theme: 'neon',
          width: 'huge',
          lineFocus: 2,
          lineSpacing: 'x',
          letterSpacing: 'wider',
          syllables: 'yes'
        }
      })
    ])
    expect(b.state.settings.reader).toEqual(DEFAULT_READER_PREFERENCES)

    applyRemote(b, [
      settingsRecord({ reader: { ...DEFAULT_READER_PREFERENCES, fontSize: 24, theme: 'dark' } })
    ])
    expect(b.state.settings.reader).toEqual({
      ...DEFAULT_READER_PREFERENCES,
      fontSize: 24,
      theme: 'dark'
    })

    // A value that is no object at all (a corrupted record) reads as the defaults, not a crash.
    applyRemote(b, [settingsRecord({ reader: 'big' })])
    expect(b.state.settings.reader).toEqual(DEFAULT_READER_PREFERENCES)
    applyRemote(b, [settingsRecord({ reader: null })])
    expect(b.state.settings.reader).toEqual(DEFAULT_READER_PREFERENCES)
  })

  it("a record without the key (a peer whose reader preferences did not win) leaves this device's alone", () => {
    const b = browser()
    b.reader.setPreferences({ fontSize: 22, theme: 'sepia', lineFocus: 3 })
    const mine = structuredClone(b.state.settings.reader)
    expect(mine).not.toEqual(DEFAULT_READER_PREFERENCES)

    applyRemote(b, [{ ...settingsRecord({ colorScheme: 'dark' }), keys: { colorScheme: 900 } }])
    expect(b.state.settings.colorScheme).toBe('dark')
    expect(b.state.settings.reader).toEqual(mine)
    expect(sent(b).reader).toEqual(mine)
  })
})

/**
 * Roll's best score (ERR-03, §9.17 (i)): a synced setting like Chrome's `net.easter_egg_high_score`
 * – in the settings record by default, read at apply as a whole number in the meter's range – with
 * one rule of its own: the number only rises. A peer's lower value wins its round and lands as the
 * record says, and this device's higher one is written back a macrotask later as an edit of its
 * own (`GameService.raiseAfterApply`), so every device converges on the highest.
 */
describe("applyRemote: the settings record and Roll's best score (ERR-03)", () => {
  const sent = (b: Browser): Record<string, unknown> =>
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

  const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

  it('travels in the settings record by default: not device-local, 0 on a fresh profile, a run’s best once set', () => {
    expect(DEVICE_LOCAL_SETTINGS).not.toContain('gameBestScore')
    expect('gameBestScore' in withoutDeviceLocalSettings(DEFAULT_SETTINGS)).toBe(true)
    const b = browser()
    expect(sent(b).gameBestScore).toBe(0)
    expect(b.game.raise(420)).toBe(true)
    expect(sent(b).gameBestScore).toBe(420)
  })

  it("a peer's higher best lands and is what this device sends from then on", async () => {
    const b = browser()
    b.game.raise(100)
    applyRemote(b, [{ ...settingsRecord({ gameBestScore: 900 }), keys: { gameBestScore: 900 } }])
    expect(b.state.settings.gameBestScore).toBe(900)
    expect(b.game.best()).toBe(900)
    await settled()
    expect(b.state.settings.gameBestScore).toBe(900)
    expect(sent(b).gameBestScore).toBe(900)
  })

  it("a peer's lower best lands as the record says, and this device's higher one is written back a macrotask later", async () => {
    const b = browser()
    b.game.raise(500)
    applyRemote(b, [{ ...settingsRecord({ gameBestScore: 300 }), keys: { gameBestScore: 300 } }])
    // The round's outcome first: the winner's value, as the record holds it.
    expect(b.state.settings.gameBestScore).toBe(300)
    await settled()
    // Then this device's edit: the higher number, to travel next round.
    expect(b.state.settings.gameBestScore).toBe(500)
    expect(sent(b).gameBestScore).toBe(500)
  })

  it('a garbage value lands as 0 or the bound, a fraction whole; a record without the key leaves this device’s alone', async () => {
    const b = browser()
    b.game.raise(50)
    applyRemote(b, [settingsRecord({ gameBestScore: '900' })])
    expect(b.state.settings.gameBestScore).toBe(0)
    await settled()
    // This device's 50 was higher than the landed 0: raised back.
    expect(b.state.settings.gameBestScore).toBe(50)
    applyRemote(b, [settingsRecord({ gameBestScore: 1e9 })])
    expect(b.state.settings.gameBestScore).toBe(99999)
    applyRemote(b, [settingsRecord({ gameBestScore: 77.7 })])
    expect(b.state.settings.gameBestScore).toBe(77)
    await settled()
    expect(b.state.settings.gameBestScore).toBe(99999)
    applyRemote(b, [{ ...settingsRecord({ colorScheme: 'dark' }), keys: { colorScheme: 900 } }])
    expect(b.state.settings.colorScheme).toBe('dark')
    expect(b.state.settings.gameBestScore).toBe(99999)
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

  it('the settings record this device sends carries startup in its sanitised shape and no retired switch beside it, never a stray', () => {
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
    expect(data).not.toHaveProperty('restoreSession')
    expect(Object.keys(data).filter((key) => !(key in b.state.settings))).toEqual([])
  })
})

describe('applyRemote: the settings record and the retired confirmCloseAll (the Lead\u2019s A3/S1 ruling, services pass 17)', () => {
  it("an older peer's record still carries the key: it applies cleanly, the key lands unread and rides on at the peer's time – no stamp, no second win, no fold", () => {
    // This device as the build after the retirement: no `confirmCloseAll` among its settings
    // (the default left with the type field in S1's stage 2), per-key entries for the rest.
    const b = browser()
    const settings = b.state.settings as unknown as Record<string, unknown>
    expect(settings).not.toHaveProperty('confirmCloseAll')
    expect(DEFAULT_SETTINGS).not.toHaveProperty('confirmCloseAll')
    const sources = (): Parameters<typeof collectLocal>[0] => ({
      model: b.state.model,
      settings: b.state.settings,
      shortcutOverrides: {},
      bookmarks: [],
      boosts: []
    })
    const first = diffLocal({}, collectLocal(sources(), defaultScope()), 500)
    const mine = diffLocal(first.meta, collectLocal(sources(), defaultScope()), 600, {
      stamp: null
    })
    expect(mine.meta[SETTINGS_RECORD_ID]!.keys).not.toHaveProperty('confirmCloseAll')

    // The peer's record as an older build writes it: this device's values and, beside them, the
    // retired switch – at the peer's time, 1000 (`settingsRecord`).
    const peer = settingsRecord({
      ...withoutDeviceLocalSettings(b.state.settings),
      confirmCloseAll: true
    })
    const remote = new Map([[SETTINGS_RECORD_ID, peer]])
    const won = winningRemote(mine.meta, remote)
    // Nothing else differs, so the key alone wins (a group this device holds nothing of).
    expect(won.map((r) => r.data)).toEqual([{ confirmCloseAll: true }])
    expect(() => applyRemote(b, won)).not.toThrow()
    // Carried, not read: it lands as any key this build does not know would (`Object.assign`),
    // the way a newer peer's key does; no reader is left (the phone's Close all asks nothing).
    expect(settings.confirmCloseAll).toBe(true)

    // The re-snapshot after the apply (`SyncEngine.run`, `stamp: null`) publishes the key at the
    // peer's time: this device made no edit, so no stamp – and the next round finds nothing to
    // win, so the record does not bounce between the two builds.
    const applied = { ...mine.meta, ...metaFromRemote(won, mine.meta) }
    const next = diffLocal(applied, collectLocal(sources(), defaultScope()), 2000, {
      stamp: null
    })
    const record = next.records.find((r) => r.id === SETTINGS_RECORD_ID)!
    expect((record.data as Record<string, unknown>).confirmCloseAll).toBe(true)
    expect(settingsKeyTime(record, 'confirmCloseAll')).toBe(1000)
    expect(next.meta[SETTINGS_RECORD_ID]!.keys!.confirmCloseAll).toEqual({
      hash: hashData(true),
      modified: 1000
    })
    expect(winningRemote(next.meta, remote)).toEqual([])
  })
})

describe('applyRemote: the settings record and Tracking prevention\u2019s "Always use Strict in private windows" (services pass 16, PS-49)', () => {
  const localSettings = (b: Browser): Parameters<typeof collectLocal>[0] => ({
    model: b.state.model,
    settings: b.state.settings,
    shortcutOverrides: {},
    bookmarks: [],
    boosts: []
  })

  it('the settings record this device sends carries blocking whole, levelPrivate with it: the key is not device-local', () => {
    const b = browser()
    b.state.settings.blocking = { ...DEFAULT_BLOCKING_SETTINGS, levelPrivate: 'strict' }
    expect(DEVICE_LOCAL_SETTINGS).not.toContain('blocking')
    expect(withoutDeviceLocalSettings(b.state.settings).blocking).toEqual(b.state.settings.blocking)
    const data = collectLocal(localSettings(b), defaultScope()).get(SETTINGS_RECORD_ID)
      ?.data as Record<string, unknown>
    expect(data.blocking).toEqual({ ...DEFAULT_BLOCKING_SETTINGS, levelPrivate: 'strict' })
    // The default rides along too: a peer that reads the key finds it in every record.
    b.state.settings.blocking = { ...DEFAULT_BLOCKING_SETTINGS }
    const again = collectLocal(localSettings(b), defaultScope()).get(SETTINGS_RECORD_ID)
      ?.data as Record<string, unknown>
    expect((again.blocking as Record<string, unknown>).levelPrivate).toBe('default')
  })

  it("a peer's switch lands with its blocking; a record from a build before the switch lacks the key, which every reader takes as the default", () => {
    const b = browser()
    applyRemote(b, [
      settingsRecord({ blocking: { ...DEFAULT_BLOCKING_SETTINGS, levelPrivate: 'strict' } })
    ])
    expect(b.state.settings.blocking.levelPrivate).toBe('strict')
    expect(effectiveLevel(b.state.settings.blocking, true)).toBe('strict')
    expect(effectiveLevel(b.state.settings.blocking, false)).toBe('balanced')
    // An older peer's record: `blocking` without the key. The record lands as the peer sent it
    // (`blocking` is taken whole, like the settings' other objects); the private override reads
    // as unset – `effectiveLevel` gives the level above – and the sanitiser the profile's load
    // and the next local edit go through fills in 'default'.
    const older: Record<string, unknown> = { ...DEFAULT_BLOCKING_SETTINGS }
    delete older.levelPrivate
    applyRemote(b, [settingsRecord({ blocking: older })])
    expect(effectiveLevel(b.state.settings.blocking, true)).toBe('balanced')
    expect(sanitizeBlockingSettings(b.state.settings.blocking)).toEqual({
      ...DEFAULT_BLOCKING_SETTINGS,
      levelPrivate: 'default'
    })
    // Junk in the key reads as the default as well.
    expect(
      sanitizeBlockingSettings({ ...older, levelPrivate: 'always' as never }).levelPrivate
    ).toBe('default')
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

/** An entry as a device holds it, in the normal form's order; `readAt` only when read. */
function rl(
  id: string,
  url: string,
  addedAt: number,
  extra: Partial<ReadingListEntry> = {}
): ReadingListEntry {
  const entry: ReadingListEntry = { id, url, title: `Page ${id}`, addedAt, updatedAt: addedAt }
  if (extra.favicon) entry.favicon = extra.favicon
  if (extra.readAt !== undefined) entry.readAt = extra.readAt
  return entry
}

/** A peer's live `reading-list-entry` record for the entry (plus whatever its build appended). */
function rlRecord(
  entry: ReadingListEntry,
  modified = 2000,
  extra: Record<string, unknown> = {}
): SyncRecord {
  return {
    id: entry.id,
    type: 'reading-list-entry',
    data: { ...readingListEntryData(entry), ...extra },
    modified,
    deleted: false
  }
}

function rlTombstone(id: string, modified = 2000): SyncRecord {
  return { id, type: 'reading-list-entry', data: null, modified, deleted: true }
}

describe('applyRemote: the reading list (services pass 11, ID-48)', () => {
  it("a won live record lands under its id – this device's favicon kept, the peer's dropped – and a tombstone removes", () => {
    const b = browser()
    const mine = b.readingList.add('https://a.example/', 'A', 'data:fav-mine')
    expect(mine).not.toBeNull()
    const readOnPhone = mine!.addedAt + 5
    applyRemote(b, [
      rlRecord(
        { ...mine!, title: 'A (read on the phone)', updatedAt: readOnPhone, readAt: readOnPhone },
        2000,
        { favicon: 'data:fav-phone', extra: 'a field of a later build' }
      ),
      rlRecord(rl('rl_new', 'https://n.example/', 10), 2000, { favicon: 'data:fav-phone' })
    ])
    // The peer's fields under the id, in the normal form's order, this device's favicon in its slot.
    const landed = b.readingList.get(mine!.id)
    expect(landed).toEqual({
      id: mine!.id,
      url: 'https://a.example/',
      title: 'A (read on the phone)',
      addedAt: mine!.addedAt,
      updatedAt: readOnPhone,
      favicon: 'data:fav-mine',
      readAt: readOnPhone
    })
    expect(Object.keys(landed!)).toEqual([
      'id',
      'url',
      'title',
      'addedAt',
      'updatedAt',
      'favicon',
      'readAt'
    ])
    // An entry this device never had lands without a favicon: the record carries none it keeps.
    expect(b.readingList.get('rl_new')).toEqual(rl('rl_new', 'https://n.example/', 10))
    expect('favicon' in b.readingList.get('rl_new')!).toBe(false)
    expect(b.readingList.unreadCount).toBe(1)
    expect(b.state.readingList.every((e) => !('extra' in e))).toBe(true)

    // The tombstone takes the entry out; one for an id this device never held is nothing.
    applyRemote(b, [rlTombstone('rl_new', 3000), rlTombstone('rl_unknown', 3000)])
    expect(b.readingList.get('rl_new')).toBeNull()
    expect(b.state.readingList.map((e) => e.id)).toEqual([mine!.id])

    // What the peers get back is the entry without the favicon: the sanitiser is idempotent on
    // it, so the landed record hashes as the peer sent it and the round stamps nothing.
    const published = collectLocal(
      {
        model: b.state.model,
        settings: b.state.settings,
        shortcutOverrides: {},
        bookmarks: [],
        boosts: [],
        readingList: b.state.readingList
      },
      defaultScope()
    ).get(mine!.id)
    expect(published).toEqual({
      type: 'reading-list-entry',
      data: {
        id: mine!.id,
        url: 'https://a.example/',
        title: 'A (read on the phone)',
        addedAt: mine!.addedAt,
        updatedAt: readOnPhone,
        readAt: readOnPhone
      }
    })
  })

  it('a record the sanitiser rejects – no web address, no data, a string, no addedAt – lands nothing', () => {
    const b = browser()
    applyRemote(b, [
      rlRecord(rl('rl_zen', 'zen://settings', 10)),
      rlRecord(rl('rl_file', 'file:///etc/hosts', 10)),
      { id: 'rl_null', type: 'reading-list-entry', data: null, modified: 2000, deleted: false },
      { id: 'rl_str', type: 'reading-list-entry', data: 'x', modified: 2000, deleted: false },
      {
        id: 'rl_noadd',
        type: 'reading-list-entry',
        data: { url: 'https://x.example/', title: 'X' },
        modified: 2000,
        deleted: false
      },
      // The record's id is the entry's, whatever the data says.
      rlRecord(rl('rl_ok', 'https://ok.example/', 10), 2000, { id: 'rl_other' })
    ])
    expect(b.state.readingList.map((e) => e.id)).toEqual(['rl_ok'])
  })

  it('the URL dedupe both directions: the later addedAt survives, a tie the greater id, the loser out of the list', () => {
    const b = browser()
    b.state.readingList = [
      rl('rl_local_old', 'https://one.example/', 100, { favicon: 'data:one' }),
      rl('rl_local_new', 'https://two.example/', 300),
      rl('rl_a', 'https://tie-a.example/', 500),
      rl('rl_z', 'https://tie-z.example/', 500)
    ]
    applyRemote(b, [
      // The peer's entry is the later one: it stays, the local one goes.
      rlRecord(rl('rl_peer_new', 'https://one.example/', 200)),
      // The local entry is the later one: the peer's never lands.
      rlRecord(rl('rl_peer_old', 'https://two.example/', 200)),
      // Ties: the lexically greater id, whichever side holds it.
      rlRecord(rl('rl_b', 'https://tie-a.example/', 500)),
      rlRecord(rl('rl_y', 'https://tie-z.example/', 500))
    ])
    expect(b.state.readingList.map((e) => e.id).sort()).toEqual([
      'rl_b',
      'rl_local_new',
      'rl_peer_new',
      'rl_z'
    ])
    // The survivor's bytes are the peer's, not a merge: nothing of the loser (its favicon) moves over.
    expect(b.readingList.get('rl_peer_new')).toEqual(rl('rl_peer_new', 'https://one.example/', 200))
    expect(b.readingList.findByUrl('https://one.example/')?.id).toBe('rl_peer_new')
    expect(b.readingList.findByUrl('https://two.example/')?.id).toBe('rl_local_new')
    expect(b.readingList.findByUrl('https://tie-a.example/')?.id).toBe('rl_b')
    expect(b.readingList.findByUrl('https://tie-z.example/')?.id).toBe('rl_z')
  })

  it('the removals land before the entries: a page removed and saved again under a new id on a slower clock keeps the new entry', () => {
    const b = browser()
    b.state.readingList = [rl('rl_old', 'https://again.example/', 500)]
    // The peer removed rl_old and saved the page anew as rl_new; its clock ran behind, so the
    // new entry's addedAt is the earlier one. Were the entries applied first, rl_new would lose
    // the URL dedupe to rl_old, whose tombstone then empties the list: the page lost everywhere.
    applyRemote(b, [rlRecord(rl('rl_new', 'https://again.example/', 400)), rlTombstone('rl_old')])
    expect(b.state.readingList).toEqual([rl('rl_new', 'https://again.example/', 400)])
  })

  it('the cap after apply bounds the READ half alone: landed unread entries over 1 000 all stay, landed read entries over 1 000 read drop the oldest by readAt', () => {
    const b = browser()
    // 1 000 unread and one read: a landed unread entry runs the list past the old cap, and
    // nothing goes – neither the read one (the read half is one) nor any unread one.
    const entries: ReadingListEntry[] = []
    for (let i = 1; i <= READING_LIST_CAP; i++) {
      const id = `rl_${String(i).padStart(4, '0')}`
      entries.push(rl(id, `https://p${i}.example/`, 10_000 + i, i === 7 ? { readAt: 20_000 } : {}))
    }
    b.state.readingList = entries
    applyRemote(b, [rlRecord(rl('rl_landed', 'https://landed.example/', 5))])
    expect(b.state.readingList).toHaveLength(READING_LIST_CAP + 1)
    expect(b.readingList.get('rl_landed')).not.toBeNull()
    expect(b.readingList.get('rl_0007')).not.toBeNull()
    expect(b.readingList.unreadCount).toBe(READING_LIST_CAP)

    // 1 000 read (rl_0007 read the earliest) and one unread: two landed READ entries run the
    // read half to 1 002, and the two oldest by `readAt` go – rl_0007, then rl_0001 – the unread
    // one never, whatever its age.
    b.state.readingList = [
      ...Array.from({ length: READING_LIST_CAP }, (_, k) => {
        const i = k + 1
        return rl(`rl_${String(i).padStart(4, '0')}`, `https://p${i}.example/`, 10_000 + i, {
          readAt: i === 7 ? 15_000 : 20_000 + i
        })
      }),
      rl('rl_unread', 'https://unread.example/', 1)
    ]
    applyRemote(b, [
      rlRecord(rl('rl_read_a', 'https://read-a.example/', 30_000, { readAt: 30_001 })),
      rlRecord(rl('rl_read_b', 'https://read-b.example/', 30_002, { readAt: 30_003 }))
    ])
    expect(b.state.readingList).toHaveLength(READING_LIST_CAP + 1)
    expect(b.readingList.get('rl_read_a')).not.toBeNull()
    expect(b.readingList.get('rl_read_b')).not.toBeNull()
    expect(b.readingList.get('rl_0007')).toBeNull()
    expect(b.readingList.get('rl_0001')).toBeNull()
    expect(b.readingList.get('rl_0002')).not.toBeNull()
    expect(b.readingList.get('rl_unread')).not.toBeNull()
    expect(b.readingList.unreadCount).toBe(1)
  })
})

/**
 * What a favicon may carry across the boundary (services pass 11, seed 6; `records.ts`
 * `wireFavicon`), on the apply side: a peer's build may still send a `data:` icon's bytes or its
 * cache's own address – neither lands – and a record WITHOUT a favicon keeps this device's own
 * for the same page: a missing favicon is the peer's icon staying home, not a deletion.
 */
describe('applyRemote: favicons at the boundary (services pass 11, seed 6)', () => {
  const DATA_ICON = 'data:image/png;base64,iVBORw0KGgo='
  const CACHE_ICON = 'zen://favicon/0123456789abcdef0123456789abcdef01234567'

  function bookmarkRecord(id: string, data: Record<string, unknown>, modified = 5000): SyncRecord {
    return { id, type: 'bookmark', modified, deleted: false, data }
  }

  it("a bookmark record without a favicon keeps this device's own icon for the same page; one with an address takes it; a changed url drops it", () => {
    const b = browser()
    const mine = b.bookmarks.create({
      title: 'Docs',
      url: 'https://docs.example/',
      favicon: DATA_ICON,
      parentId: '1'
    })!
    expect(b.bookmarks.tree.get(mine.id)?.favicon).toBe(DATA_ICON)

    // The peer renamed the node: its record carries no icon (its own is a data: URL too).
    applyRemote(b, [
      bookmarkRecord(mine.id, {
        parentId: '1',
        index: 0,
        type: 'url',
        title: 'The docs',
        url: 'https://docs.example/',
        dateAdded: mine.dateAdded
      })
    ])
    const renamed = b.bookmarks.tree.get(mine.id)!
    expect(renamed.title).toBe('The docs')
    expect(renamed.favicon).toBe(DATA_ICON)

    // A peer's build that still sends the bytes, or its cache's address: neither lands, and
    // this device's icon stands.
    for (const favicon of [DATA_ICON.replace('KGgo', 'PEER'), CACHE_ICON]) {
      applyRemote(b, [
        bookmarkRecord(mine.id, {
          parentId: '1',
          index: 0,
          type: 'url',
          title: 'The docs',
          url: 'https://docs.example/',
          favicon,
          dateAdded: mine.dateAdded
        })
      ])
      expect(b.bookmarks.tree.get(mine.id)?.favicon).toBe(DATA_ICON)
    }

    // An http(s) address travels and lands over this device's icon: the record won.
    applyRemote(b, [
      bookmarkRecord(mine.id, {
        parentId: '1',
        index: 0,
        type: 'url',
        title: 'The docs',
        url: 'https://docs.example/',
        favicon: 'https://docs.example/favicon.ico',
        dateAdded: mine.dateAdded
      })
    ])
    expect(b.bookmarks.tree.get(mine.id)?.favicon).toBe('https://docs.example/favicon.ico')

    // The peer pointed the bookmark at another page, no icon: the old page's icon does not carry.
    applyRemote(b, [
      bookmarkRecord(mine.id, {
        parentId: '1',
        index: 0,
        type: 'url',
        title: 'The docs',
        url: 'https://docs.example/v2/',
        dateAdded: mine.dateAdded
      })
    ])
    expect(b.bookmarks.tree.get(mine.id)).not.toHaveProperty('favicon')

    // A node this device never had lands without an icon when the record carries none.
    applyRemote(b, [
      bookmarkRecord('bm_new', {
        parentId: '1',
        index: 1,
        type: 'url',
        title: 'New',
        url: 'https://new.example/',
        favicon: DATA_ICON,
        dateAdded: 1
      })
    ])
    expect(b.bookmarks.tree.get('bm_new')).not.toHaveProperty('favicon')

    // What this device publishes back for the renamed node: no icon of its own (a data: URL
    // stays home), the record hashing as the peer's did – nothing to bounce.
    const local = collectLocal(
      {
        model: b.state.model,
        settings: b.state.settings,
        shortcutOverrides: {},
        bookmarks: b.state.bookmarks,
        boosts: []
      },
      defaultScope()
    )
    expect(local.get('bm_new')?.data).not.toHaveProperty('favicon')
  })

  it("a tab record's data: or host-local favicon never lands; a record without one leaves this device's icon; an address fills an empty one", () => {
    const b = browser()
    const space = b.state.model.spaces[0]
    const pinned = (id: string, favicon: string | null): SyncRecord => ({
      id,
      type: 'tab',
      modified: 5000,
      deleted: false,
      data: {
        url: 'https://pinned.example/',
        pinnedUrl: 'https://pinned.example/',
        title: 'Pinned',
        customTitle: null,
        customIcon: null,
        favicon,
        pinned: true,
        essential: false,
        spaceId: space.id,
        folderId: null,
        containerId: space.containerId,
        muted: false
      }
    })
    // Landed new with the bytes: no icon (this device fetches its own when the page loads).
    applyRemote(b, [pinned('tab_inline', DATA_ICON)])
    expect(b.state.model.tabs['tab_inline'].favicon).toBeNull()
    applyRemote(b, [pinned('tab_cached', CACHE_ICON)])
    expect(b.state.model.tabs['tab_cached'].favicon).toBeNull()
    // Landed new with an address: the address.
    applyRemote(b, [pinned('tab_addressed', 'https://pinned.example/favicon.ico')])
    expect(b.state.model.tabs['tab_addressed'].favicon).toBe('https://pinned.example/favicon.ico')
    // This device's icon stands when the record carries none, or one that may not travel.
    b.state.model.tabs['tab_inline'].favicon = DATA_ICON
    applyRemote(b, [pinned('tab_inline', null)])
    expect(b.state.model.tabs['tab_inline'].favicon).toBe(DATA_ICON)
    applyRemote(b, [pinned('tab_inline', CACHE_ICON)])
    expect(b.state.model.tabs['tab_inline'].favicon).toBe(DATA_ICON)
    // An address fills an empty slot only: a tab with an icon keeps it (as before).
    b.state.model.tabs['tab_cached'].favicon = null
    applyRemote(b, [pinned('tab_cached', 'https://pinned.example/other.ico')])
    expect(b.state.model.tabs['tab_cached'].favicon).toBe('https://pinned.example/other.ico')
    applyRemote(b, [pinned('tab_cached', 'https://pinned.example/third.ico')])
    expect(b.state.model.tabs['tab_cached'].favicon).toBe('https://pinned.example/other.ico')
  })
})

/** A peer's live `mod` record for the Mod (plus whatever its build appended). */
function modRecord(mod: Mod, modified = 2000, extra: Record<string, unknown> = {}): SyncRecord {
  return { id: mod.id, type: 'mod', data: { ...modData(mod), ...extra }, modified, deleted: false }
}

function modTombstone(id: string, modified = 2000): SyncRecord {
  return { id, type: 'mod', data: null, modified, deleted: true }
}

/** What the peers get back for the Mods this device holds. */
function publishedMods(b: Browser): Map<string, { type: string; data: unknown }> {
  const out = new Map<string, { type: string; data: unknown }>()
  const local = collectLocal(
    {
      model: b.state.model,
      settings: b.state.settings,
      shortcutOverrides: {},
      bookmarks: [],
      boosts: [],
      mods: b.mods.all()
    },
    defaultScope()
  )
  for (const [id, record] of local) if (record.type === 'mod') out.set(id, record)
  return out
}

describe('applyRemote: the Mods (services pass 15, ID-43)', () => {
  it('a won live record lands the Mod whole under its id – in place when held, appended when new – and a tombstone removes it', () => {
    const b = browser()
    const mine = b.mods.add('Compact tabs', '.tab { padding: 2px; }')
    const other = b.mods.add('Second', '.second {}')
    expect(b.mods.all().map((m) => m.id)).toEqual([mine.id, other.id])

    // The phone turned the first Mod off and edited its CSS; a later build appended a field.
    applyRemote(b, [
      modRecord(
        { ...mine, css: '.tab { padding: 4px; }', enabled: false, updatedAt: mine.updatedAt + 5 },
        2000,
        { extra: 'a field of a later build' }
      ),
      modRecord(
        {
          id: 'mod_phone',
          name: 'From the phone',
          source: 'phone.css',
          css: '.phone {}',
          enabled: true,
          updatedAt: 10
        },
        2000
      )
    ])
    // The peer's fields under the id, in the normal form's order; the Mod keeps its place in the
    // list (the order is this device's own), the new one goes last.
    expect(b.mods.all().map((m) => m.id)).toEqual([mine.id, other.id, 'mod_phone'])
    const landed = b.mods.all().find((m) => m.id === mine.id)!
    expect(landed).toEqual({
      id: mine.id,
      name: 'Compact tabs',
      source: null,
      css: '.tab { padding: 4px; }',
      enabled: false,
      updatedAt: mine.updatedAt + 5
    })
    expect(Object.keys(landed)).toEqual(['id', 'name', 'source', 'css', 'enabled', 'updatedAt'])
    expect(b.mods.all().every((m) => !('extra' in m))).toBe(true)
    expect(b.mods.all().find((m) => m.id === 'mod_phone')).toEqual({
      id: 'mod_phone',
      name: 'From the phone',
      source: 'phone.css',
      css: '.phone {}',
      enabled: true,
      updatedAt: 10
    })
    // The landed list reaches the chrome as the user's own edits do (`BrowserState.mods`).
    expect(b.state.snapshot(b.focusedWindow()).mods.map((m) => m.id)).toEqual([
      mine.id,
      other.id,
      'mod_phone'
    ])

    // The tombstone takes the Mod out; one for an id this device never held is nothing.
    applyRemote(b, [modTombstone('mod_phone', 3000), modTombstone('mod_unknown', 3000)])
    expect(b.mods.all().map((m) => m.id)).toEqual([mine.id, other.id])

    // What the peers get back is the Mod as received: the sanitiser is idempotent on it, so the
    // landed record hashes as the peer sent it and the round stamps nothing.
    expect(publishedMods(b).get(mine.id)).toEqual({
      type: 'mod',
      data: {
        name: 'Compact tabs',
        source: null,
        css: '.tab { padding: 4px; }',
        enabled: false,
        updatedAt: mine.updatedAt + 5
      }
    })
  })

  it('a record the sanitiser rejects – no CSS, CSS that is not text, no data, a string – lands nothing; an unnamed one takes the fallback name, an oversized one is cut at the cap', () => {
    const b = browser()
    applyRemote(b, [
      { id: 'mod_nocss', type: 'mod', data: { name: 'No CSS' }, modified: 2000, deleted: false },
      { id: 'mod_num', type: 'mod', data: { css: 42 }, modified: 2000, deleted: false },
      { id: 'mod_null', type: 'mod', data: null, modified: 2000, deleted: false },
      { id: 'mod_str', type: 'mod', data: 'x', modified: 2000, deleted: false },
      // The record's id is the Mod's, whatever the data says.
      {
        id: 'mod_ok',
        type: 'mod',
        data: { css: 'a {}', id: 'mod_other' },
        modified: 2000,
        deleted: false
      },
      {
        id: 'mod_big',
        type: 'mod',
        data: { css: 'x'.repeat(MAX_MOD_CSS + 1), name: ' ' },
        modified: 2000,
        deleted: false
      }
    ])
    expect(b.mods.all().map((m) => m.id)).toEqual(['mod_ok', 'mod_big'])
    expect(b.mods.all()[0]).toEqual({
      id: 'mod_ok',
      name: UNTITLED_MOD,
      source: null,
      css: 'a {}',
      enabled: true,
      updatedAt: 0
    })
    const big = b.mods.all()[1]!
    expect(big.name).toBe(UNTITLED_MOD)
    expect(big.css).toHaveLength(MAX_MOD_CSS)
    // The cut Mod is what goes back out – at the peer's time, `stamp: null` at the round – so
    // the peers converge on the cap rather than bounce the oversized record between them.
    expect((publishedMods(b).get('mod_big')!.data as Mod).css).toHaveLength(MAX_MOD_CSS)
  })

  it('a record equal to the Mod held changes nothing (no write, no broadcast)', () => {
    const b = browser()
    const mine = b.mods.add('Same', '.same {}')
    const before = JSON.stringify(b.mods.all())
    expect(b.mods.put({ ...mine })).toBe(false)
    applyRemote(b, [modRecord(mine)])
    expect(JSON.stringify(b.mods.all())).toBe(before)
  })
})

/** An extension host that records what the apply hands it – the desktop's shape, without the store. */
class RecordingExtensions extends NoExtensions {
  readonly batches: SyncedExtensionChange[][] = []

  applySyncedExtensions(changes: readonly SyncedExtensionChange[]): void {
    this.batches.push([...changes])
  }
}

const EXT_A = 'abcdefghijklmnopabcdefghijklmnop'
const EXT_B = 'ppppoooonnnnmmmmllllkkkkjjjjiiii'
const EXT_C = 'cccccccccccccccccccccccccccccccc'

function extensionRecord(
  id: string,
  data: Record<string, unknown> | null,
  modified = 2000
): SyncRecord {
  return { id, type: 'extension', data, modified, deleted: data === null }
}

describe('applyRemote: the extensions (services pass 16, ID-44)', () => {
  it('hands the host one batch per apply: a live record as its read data with the origin device, a tombstone as data null; ignores an unknown store, garbage and a bad id; nothing for a host without the method', () => {
    const host = { current: null as RecordingExtensions | null }
    const b = browser({}, (browser) => (host.current = new RecordingExtensions(browser)))
    const origins = new Map<string, string>([
      [EXT_A, 'Work laptop'],
      [EXT_B, 'Pixel 9']
    ])
    applyRemote(
      b,
      [
        extensionRecord(EXT_A, { store: 'chrome-web-store', enabled: true, toolbarPinned: false }),
        extensionRecord(EXT_B, null, 3000),
        // A later build's store: ignored – null from the reader, nothing to the host.
        extensionRecord(EXT_C, { store: 'firefox-add-ons', enabled: true, toolbarPinned: true }),
        extensionRecord(EXT_C, { store: 'crx', enabled: true, toolbarPinned: true }),
        extensionRecord(EXT_C, { store: 'chrome-web-store', enabled: 'yes', toolbarPinned: true }),
        extensionRecord(EXT_C, 'nonsense' as unknown as Record<string, unknown>),
        extensionRecord('not-an-extension-id', {
          store: 'chrome-web-store',
          enabled: true,
          toolbarPinned: true
        }),
        // A later build appended a field: the known ones land, the rest rides along. This one
        // carries the switches' clocks (round 2) and the install's time (round 5): each travels
        // as it is.
        extensionRecord(
          EXT_C,
          {
            store: 'edge-add-ons',
            enabled: false,
            toolbarPinned: true,
            enabledAt: 1500,
            toolbarPinnedAt: 1200,
            installedAt: 1100,
            version: '2.0'
          },
          2500
        )
      ],
      (r) => origins.get(r.id) ?? null
    )
    // The live records first, the tombstones after them – the batch's order for every type.
    // A record without a switch's clock (an older build's; a switch the phone never flipped) is
    // read at 0 for it – never at the record's `modified`, 2000 here (`syncedExtensionData`);
    // a record without the install's time (a build before round 5's field) reads 0 for it too.
    expect(host.current!.batches).toEqual([
      [
        {
          id: EXT_A,
          data: {
            store: 'chrome-web-store',
            enabled: true,
            toolbarPinned: false,
            enabledAt: 0,
            toolbarPinnedAt: 0,
            installedAt: 0
          },
          from: 'Work laptop'
        },
        {
          id: EXT_C,
          data: {
            store: 'edge-add-ons',
            enabled: false,
            toolbarPinned: true,
            enabledAt: 1500,
            toolbarPinnedAt: 1200,
            installedAt: 1100
          },
          from: null
        },
        { id: EXT_B, data: null, from: 'Pixel 9' }
      ]
    ])
    // Without an origin callback the device is unknown (null), never a guess.
    applyRemote(b, [extensionRecord(EXT_B, null, 4000)])
    expect(host.current!.batches[1]).toEqual([{ id: EXT_B, data: null, from: null }])
    // A batch with no extension record hands the host nothing.
    applyRemote(b, [modTombstone('mod_unknown', 3000)])
    expect(host.current!.batches).toHaveLength(2)

    // The phone's host (no `applySyncedExtensions`) lands none and errs on none.
    const phone = browser()
    expect(phone.extensions.applySyncedExtensions).toBeUndefined()
    expect(() =>
      applyRemote(phone, [
        extensionRecord(EXT_A, { store: 'chrome-web-store', enabled: true, toolbarPinned: false })
      ])
    ).not.toThrow()
  })

  it('a batch of extension records alone touches no state: no repair, no commit – the extensions live in the host’s registry', () => {
    const files: Record<string, string> = {}
    const b = browser(files, (browser) => new RecordingExtensions(browser))
    const before = files['state.json']
    const commits = { count: 0 }
    const commit = b.state.commit.bind(b.state)
    b.state.commit = () => {
      commits.count += 1
      commit()
    }
    applyRemote(b, [
      extensionRecord(EXT_A, { store: 'chrome-web-store', enabled: true, toolbarPinned: false }),
      extensionRecord(EXT_B, null, 3000)
    ])
    expect(commits.count).toBe(0)
    expect(files['state.json']).toBe(before)
    // A Mod in the same batch commits as it did.
    applyRemote(b, [
      extensionRecord(EXT_A, { store: 'chrome-web-store', enabled: false, toolbarPinned: false }),
      modRecord({ id: 'mod_x', name: 'X', source: null, css: '.x {}', enabled: true, updatedAt: 1 })
    ])
    expect(commits.count).toBe(1)
  })

  it('the extension records land after the state’s (the model, the settings, the Mods) within a batch', () => {
    const order: string[] = []
    const b = browser({}, (browser) => {
      const host = new RecordingExtensions(browser)
      host.applySyncedExtensions = (changes) => {
        order.push(`extensions:${changes.map((c) => c.id).join(',')}`)
      }
      return host
    })
    const put = b.mods.put.bind(b.mods)
    b.mods.put = (mod) => {
      order.push(`mod:${mod.id}`)
      return put(mod)
    }
    applyRemote(b, [
      extensionRecord(EXT_A, { store: 'chrome-web-store', enabled: true, toolbarPinned: false }),
      modRecord({ id: 'mod_y', name: 'Y', source: null, css: '.y {}', enabled: true, updatedAt: 1 })
    ])
    expect(order).toEqual(['mod:mod_y', `extensions:${EXT_A}`])
  })
})
