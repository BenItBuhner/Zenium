import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONTAINER_ID,
  PRIVATE_CONTAINER_ID,
  type HostCapabilities,
  type Platform as PlatformOs,
  type Tab
} from '../../shared/types'
import type { PrivacyFlags, PrivacySettings } from '../../shared/privacy'
import { SITE_DATA_ORIGIN_CAP, type SiteDataPolicy } from '../../shared/siteData'
import { Browser } from '../browser'
import type {
  AppHost,
  EngineDataKind,
  Platform,
  PrivacyHost,
  SessionHost,
  SiteDataHost,
  SiteDataOriginReading,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'
import { SITE_DATA_FILE, patternsCoverSite, type PendingClear } from '../siteData'
import type { ZenWindow } from '../window'

function memoryIo(seed: Record<string, string> = {}): StoreIO & { files: Record<string, string> } {
  const files: Record<string, string> = { ...seed }
  return {
    files,
    readSync: (name) => files[name] ?? null,
    write: async (name, text) => {
      files[name] = text
    },
    writeSync: (name, text) => {
      files[name] = text
    }
  }
}

/** Anything the browser touches on the host answers with a harmless no-op. */
function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

interface FakeView {
  readonly tab: Tab
  view: TabView
  readonly events: TabViewEvents
  url: string
}

function fakeView(tab: Tab, events: TabViewEvents): FakeView {
  const fake: FakeView = { tab, events, url: tab.url, view: undefined as unknown as TabView }
  let destroyed = false
  const overrides: Partial<TabView> = {
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true
    },
    loadURL: (u) => {
      fake.url = u
    },
    getURL: () => fake.url,
    getTitle: () => '',
    hasDocument: () => fake.url !== '',
    canGoBack: () => false,
    canGoForward: () => false,
    getZoom: () => 1,
    isCurrentlyAudible: () => false,
    isVisible: () => true
  }
  fake.view = new Proxy(overrides as TabView, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
  return fake
}

/** The engine's site-data calls, as the core made them. */
interface EngineLog {
  clearedCookies: Array<{ containerId: string; url: string }>
  clearedStorage: Array<{ containerId: string; site: string; origins: string[] }>
  listed: Array<{ containerId: string; probe: string[] }>
  cleared: Array<{ containerIds: string[]; kinds: EngineDataKind[] }>
  applied: PrivacyFlags[]
  quit: number
}

interface Options {
  capabilities?: Partial<HostCapabilities>
  files?: Record<string, string>
  /** What `listOrigins` answers per container. */
  origins?: Record<string, SiteDataOriginReading[]>
  /** Leave `listOrigins` out, as a host without the reading does. */
  noListing?: boolean
  /** A `clearStorage` that never answers (the on-exit budget's case). */
  hangStorage?: boolean
}

interface Fixture {
  browser: Browser
  win: ZenWindow
  io: ReturnType<typeof memoryIo>
  log: EngineLog
  navigate(tabId: string, url: string): void
  command<T>(name: string, args?: unknown): T
  /** The persisted document. */
  stored(): { policy: SiteDataPolicy; pendingClear: PendingClear | null }
}

function fixture(options: Options = {}): Fixture {
  const views: FakeView[] = []
  const io = memoryIo(options.files)
  const log: EngineLog = {
    clearedCookies: [],
    clearedStorage: [],
    listed: [],
    cleared: [],
    applied: [],
    quit: 0
  }
  const siteData: SiteDataHost = {
    cookies: async () => [],
    storage: async () => ({ usageBytes: null, quotaBytes: null, origins: [] }),
    clearCookies: async (containerId, url) => {
      log.clearedCookies.push({ containerId, url })
      return 1
    },
    clearStorage: (containerId, site, origins) => {
      log.clearedStorage.push({ containerId, site, origins })
      return options.hangStorage ? new Promise<void>(() => undefined) : Promise.resolve()
    },
    ...(options.noListing
      ? {}
      : {
          listOrigins: async (containerId: string, probe: string[]) => {
            log.listed.push({ containerId, probe })
            return options.origins?.[containerId] ?? []
          }
        })
  }
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities: stub<HostCapabilities>({
      windows: true,
      updates: false,
      agents: false,
      passwords: false,
      extensions: false,
      requestBlocking: true,
      privateTabs: false,
      quitsThroughCore: true,
      ...options.capabilities
    }),
    io,
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
      createView: (tab, events) => {
        const fake = fakeView(tab, events)
        views.push(fake)
        return fake.view
      }
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub<SessionHost>({
      clearPrivate: async () => undefined,
      clearBrowsingData: async (containerIds: string[], kinds: EngineDataKind[]) => {
        log.cleared.push({ containerIds, kinds })
      }
    }),
    privacy: stub<PrivacyHost>({
      apply: (flags) => {
        log.applied.push(flags)
      }
    }),
    siteData,
    app: stub<AppHost>({
      quit: () => {
        log.quit++
      }
    }),
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  const win = browser.allWindows()[0]
  return {
    browser,
    win,
    io,
    log,
    navigate: (tabId, url) => {
      const v = views.find((x) => x.tab.id === tabId)
      if (!v) throw new Error(`no view for ${tabId}`)
      v.url = url
      v.events.onNavigated(url, false)
    },
    command: <T>(name: string, args: unknown = {}): T =>
      browser.handleCommand(win, name, args) as T,
    stored: () => {
      browser.siteData.flushSync()
      const text = io.files[SITE_DATA_FILE]
      if (!text) return { policy: browser.siteData.policy(), pendingClear: null }
      return JSON.parse(text) as { policy: SiteDataPolicy; pendingClear: PendingClear | null }
    }
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await tick()
}

const lastFlags = (f: Fixture): PrivacyFlags => f.log.applied[f.log.applied.length - 1]

/** The containers whose data outlives the session: the model's, default first, private excluded. */
const persistentContainers = (f: Fixture): string[] =>
  f.browser.state.model.containers.map((c) => c.id).filter((id) => id !== PRIVATE_CONTAINER_ID)

/** `log` entries of the default container alone (every container gets the same calls). */
const inDefault = <T extends { containerId: string }>(entries: T[]): T[] =>
  entries.filter((e) => e.containerId === DEFAULT_CONTAINER_ID)

// ---------------------------------------------------------------------------
// PS-23: the three lists and the default
// ---------------------------------------------------------------------------

describe('the per-site cookie policy', () => {
  it('adds a pattern as written (a bare host is that host alone, as Chrome stores it) and refuses what is not one', () => {
    const f = fixture()
    expect(f.command('siteData.add', { list: 'allow', pattern: ' Example.com ' })).toEqual({
      ok: true,
      pattern: 'example.com'
    })
    expect(f.command('siteData.add', { list: 'allow', pattern: '[*.]Example.com' })).toEqual({
      ok: true,
      pattern: '[*.]example.com'
    })
    expect(
      f.command('siteData.add', { list: 'block', pattern: 'https://ads.example:8443' })
    ).toEqual({
      ok: true,
      pattern: 'https://ads.example:8443'
    })
    expect(f.command('siteData.add', { list: 'clearOnExit', pattern: '10.0.0.7' })).toEqual({
      ok: true,
      pattern: '10.0.0.7'
    })
    const refused = f.command<{ ok: boolean; problem?: string }>('siteData.add', {
      list: 'allow',
      pattern: 'https://example.com/path'
    })
    expect(refused.ok).toBe(false)
    expect(refused.problem).toContain('[*.]example.com')
    expect(f.command('siteData.add', { list: 'nope', pattern: 'a.example' })).toEqual({
      ok: false,
      problem: 'Unknown list'
    })
    expect(f.browser.siteData.policy()).toEqual({
      blockAll: false,
      allow: ['example.com', '[*.]example.com'],
      clearOnExit: ['10.0.0.7'],
      block: ['https://ads.example:8443']
    })
  })

  it('adds the site of a page from the sheet, moves a pattern between lists, removes it', () => {
    const f = fixture()
    expect(
      f.command('siteData.addSite', { list: 'block', url: 'https://Tracker.example/p?x=1' })
    ).toEqual({ ok: true, pattern: '[*.]tracker.example' })
    expect(f.command('siteData.addSite', { list: 'allow', url: 'about:blank' })).toEqual({
      ok: false,
      problem: 'This page has no site to add'
    })
    // The same pattern onto another list leaves the first.
    f.command('siteData.add', { list: 'allow', pattern: '[*.]tracker.example' })
    expect(f.browser.siteData.policy()).toMatchObject({ block: [], allow: ['[*.]tracker.example'] })
    f.command('siteData.remove', { pattern: ' [*.]TRACKER.example ' })
    expect(f.browser.siteData.policy().allow).toEqual([])
    // Removing what is not there, or not a pattern, changes nothing.
    const pushes = f.log.applied.length
    f.command('siteData.remove', { pattern: 'gone.example' })
    f.command('siteData.remove', { pattern: 'not/a/pattern' })
    expect(f.log.applied.length).toBe(pushes)
  })

  it('persists the policy, pushes it to the host inside the privacy flags, and shows it sorted', () => {
    const f = fixture()
    f.command('siteData.add', { list: 'allow', pattern: '[*.]example.com' })
    f.command('siteData.add', { list: 'allow', pattern: 'www.example.com' })
    f.command('siteData.add', { list: 'block', pattern: 'never.example' })
    expect(f.stored().policy).toEqual({
      blockAll: false,
      allow: ['[*.]example.com', 'www.example.com'],
      clearOnExit: [],
      block: ['never.example']
    })
    expect(lastFlags(f).siteData).toEqual(f.browser.siteData.policy())
    const status = f.browser.state.snapshot(f.win).siteData
    expect(status).toEqual({
      default: 'block-third-party',
      allow: ['www.example.com', '[*.]example.com'],
      clearOnExit: [],
      block: ['never.example'],
      clearOnExitTypes: [],
      clearsAtNextLaunch: false,
      pendingClear: false
    })
    // A fresh browser over the same profile reads it back.
    const again = fixture({ files: f.io.files })
    expect(again.browser.siteData.policy()).toEqual(f.browser.siteData.policy())
    expect(lastFlags(again).siteData.block).toEqual(['never.example'])
  })

  it('caps a list at its limit with a reason', () => {
    const f = fixture()
    const policy = f.browser.siteData.policy()
    for (let i = 0; i < 1000; i++) policy.allow.push(`s${i}.example`)
    expect(f.browser.siteData.add('allow', 'one-more.example')).toEqual({
      ok: false,
      problem: 'This list holds 1000 sites at most'
    })
    // Moving a pattern from a full list onto another is fine: the full list loses one.
    expect(f.browser.siteData.add('block', 's0.example').ok).toBe(true)
    expect(f.browser.siteData.policy().allow).not.toContain('s0.example')
  })

  it('keeps the default in step with the third-party cookie mode, block-all being its own bit', () => {
    const f = fixture()
    const privacy = (): PrivacySettings => f.browser.state.settings.privacy
    expect(f.browser.siteData.default()).toBe('block-third-party')
    expect(privacy().thirdPartyCookies).toBe('block-private')

    f.command('siteData.setDefault', { default: 'allow' })
    expect(f.browser.siteData.default()).toBe('allow')
    expect(privacy().thirdPartyCookies).toBe('allow')
    expect(f.browser.siteData.policy().blockAll).toBe(false)

    f.command('siteData.setDefault', { default: 'block-all' })
    expect(f.browser.siteData.default()).toBe('block-all')
    expect(f.browser.siteData.policy().blockAll).toBe(true)
    expect(lastFlags(f).siteData.blockAll).toBe(true)
    // The third-party mode is left as it was: block-all says more, not something else.
    expect(privacy().thirdPartyCookies).toBe('allow')

    f.command('siteData.setDefault', { default: 'block-third-party' })
    expect(f.browser.siteData.policy().blockAll).toBe(false)
    expect(privacy().thirdPartyCookies).toBe('block-private')
    expect(f.browser.siteData.default()).toBe('block-third-party')

    // A stricter third-party mode is kept by the middle radio.
    f.browser.updateSettings({ privacy: { ...privacy(), thirdPartyCookies: 'block' } }, f.win)
    f.command('siteData.setDefault', { default: 'block-third-party' })
    expect(privacy().thirdPartyCookies).toBe('block')
    expect(() => f.browser.siteData.setDefault('nope' as 'allow')).toThrow(
      /Unknown site-data default/
    )
  })

  it('answers the site-information sheet with the state, the deciding pattern and what "Add" adds', () => {
    const f = fixture()
    f.command('siteData.add', { list: 'clearOnExit', pattern: '[*.]shop.example' })
    expect(f.browser.siteData.siteState('https://cart.shop.example/checkout')).toEqual({
      state: 'clear-on-exit',
      pattern: '[*.]shop.example',
      addable: '[*.]cart.shop.example',
      default: 'block-third-party'
    })
    expect(f.browser.siteData.siteState('https://other.example/')).toEqual({
      state: 'default',
      pattern: null,
      addable: '[*.]other.example',
      default: 'block-third-party'
    })
    expect(f.browser.siteData.siteState('')).toMatchObject({ state: 'default', addable: null })
  })

  it('takes a synced copy whole, and only when it differs', () => {
    const f = fixture()
    const pushes = f.log.applied.length
    f.browser.siteData.applySynced({ blockAll: true, block: ['never.example', 'bad/'], allow: [] })
    expect(f.browser.siteData.policy()).toEqual({
      blockAll: true,
      allow: [],
      clearOnExit: [],
      block: ['never.example']
    })
    expect(f.log.applied.length).toBe(pushes + 1)
    f.browser.siteData.applySynced({ blockAll: true, block: ['never.example'] })
    expect(f.log.applied.length).toBe(pushes + 1)
  })

  it('takes the stored data of a site newly put on the never list', async () => {
    const f = fixture()
    f.command('siteData.add', { list: 'block', pattern: '[*.]never.example' })
    await settle()
    // The pattern's own hosts on both schemes, in every persistent container, as one whole site.
    expect(inDefault(f.log.clearedStorage)).toEqual([
      {
        containerId: 'default',
        site: 'never.example',
        origins: ['https://never.example', 'http://never.example']
      }
    ])
    expect([...new Set(f.log.clearedStorage.map((c) => c.containerId))]).toEqual(
      persistentContainers(f)
    )
    expect(
      inDefault(f.log.clearedCookies)
        .map((c) => c.url)
        .sort()
    ).toEqual(['http://never.example/', 'https://never.example/'])
    // Moving it to another list clears nothing more.
    const before = f.log.clearedStorage.length
    f.command('siteData.add', { list: 'allow', pattern: '[*.]never.example' })
    await settle()
    expect(f.log.clearedStorage.length).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// PS-25: the viewer
// ---------------------------------------------------------------------------

describe('the site-data viewer', () => {
  it('lists every origin with data across the containers, most data first, with its permissions and state', async () => {
    const f = fixture({
      origins: {
        default: [
          { origin: 'https://big.example', cookies: 2, usageBytes: 5_000_000 },
          { origin: 'https://cookies.example', cookies: 7, usageBytes: null },
          { origin: 'https://cookies.example', cookies: 1, usageBytes: 0 },
          { origin: 'https://empty.example', cookies: 0, usageBytes: 0 },
          { origin: 'not an origin', cookies: 3, usageBytes: null }
        ]
      }
    })
    f.browser.permissions.set('camera', 'https://cam.example', 'allow')
    f.browser.permissions.set('geolocation', 'https://big.example/', 'deny')
    f.command('siteData.add', { list: 'block', pattern: 'cookies.example' })
    const tab = f.browser.tabs.createTab({ url: 'https://visited.example/', active: true }, f.win)
    f.navigate(tab.id, 'https://visited.example/page')
    await settle()
    // (The never list's sweep asked the engine too; the viewer's own readings are what follow.)
    f.log.listed.length = 0

    const listing = await f.command<ReturnType<Browser['siteData']['list']>>('siteData.list')
    expect(listing.rows.map((r) => r.origin)).toEqual([
      'https://big.example',
      'https://cookies.example',
      'https://cam.example'
    ])
    expect(listing.rows[0]).toEqual({
      origin: 'https://big.example',
      site: 'big.example',
      cookies: 2,
      usageBytes: 5_000_000,
      permissions: [{ permission: 'geolocation', decision: 'deny' }],
      state: 'default'
    })
    // Two readings of one origin add up; the never list's word shows on the row.
    expect(listing.rows[1]).toMatchObject({ cookies: 8, usageBytes: 0, state: 'block' })
    // An origin with a permission alone is listed for it, unsized.
    expect(listing.rows[2]).toMatchObject({
      cookies: 0,
      usageBytes: null,
      permissions: [{ permission: 'camera', decision: 'allow' }]
    })
    expect(listing).toMatchObject({ total: 3, truncated: false, sized: true })
    // The engine was asked per persistent container, with the origins the core knows of to probe.
    expect(f.log.listed.map((l) => l.containerId)).toEqual(persistentContainers(f))
    expect(f.log.listed[0].probe).toEqual(
      expect.arrayContaining([
        'https://visited.example',
        'https://cam.example',
        'https://big.example'
      ])
    )
  })

  it('says "unsized" when no host can size an origin, and copes without the reading at all', async () => {
    const f = fixture({
      origins: { default: [{ origin: 'https://a.example', cookies: 1, usageBytes: null }] }
    })
    expect(await f.browser.siteData.list()).toMatchObject({ total: 1, sized: false })
    const bare = fixture({ noListing: true })
    bare.browser.permissions.set('camera', 'https://cam.example', 'allow')
    const listing = await bare.browser.siteData.list()
    expect(listing.rows.map((r) => r.origin)).toEqual(['https://cam.example'])
    expect(listing.sized).toBe(false)
  })

  it('caps the listing at the limit and says how many there are', async () => {
    const many: SiteDataOriginReading[] = Array.from(
      { length: SITE_DATA_ORIGIN_CAP + 3 },
      (_, i) => ({
        origin: `https://s${i}.example`,
        cookies: 1,
        usageBytes: null
      })
    )
    const f = fixture({ origins: { default: many } })
    const listing = await f.browser.siteData.list()
    expect(listing.rows).toHaveLength(SITE_DATA_ORIGIN_CAP)
    expect(listing.total).toBe(SITE_DATA_ORIGIN_CAP + 3)
    expect(listing.truncated).toBe(true)
  })

  it("clears one origin in every container and everything through the dialog's path", async () => {
    const f = fixture()
    await f.command('siteData.clearSite', { origin: 'https://One.example/some/path' })
    expect(inDefault(f.log.clearedStorage)).toEqual([
      { containerId: 'default', site: '', origins: ['https://one.example'] }
    ])
    expect(inDefault(f.log.clearedCookies)).toEqual([
      { containerId: 'default', url: 'https://one.example/' }
    ])
    expect(f.log.clearedStorage.map((c) => c.containerId)).toEqual(persistentContainers(f))
    await f.command('siteData.clearSite', { origin: 'about:blank' })
    expect(inDefault(f.log.clearedStorage)).toHaveLength(1)

    await f.command('siteData.clearAll')
    expect(f.log.cleared).toEqual([
      { containerIds: persistentContainers(f), kinds: ['cookies', 'storage'] }
    ])
  })
})

// ---------------------------------------------------------------------------
// PS-24: clear browsing data on exit
// ---------------------------------------------------------------------------

describe('clear browsing data on exit', () => {
  const chooseOnExit = (f: Fixture, types: string[]): void => {
    const privacy = f.browser.state.settings.privacy
    f.browser.updateSettings(
      { privacy: { ...privacy, clearOnExit: { types: types as never } } },
      f.win
    )
  }

  it('keeps the chosen types in the settings, passwords never among them', () => {
    const f = fixture()
    chooseOnExit(f, ['cache', 'passwords', 'history', 'cache'])
    expect(f.browser.siteData.clearOnExitTypes()).toEqual(['history', 'cache'])
    expect(f.browser.state.snapshot(f.win).siteData.clearOnExitTypes).toEqual(['history', 'cache'])
    expect(f.browser.siteData.clearsOnExit()).toBe(true)
  })

  it("on the desktop runs at quit: the types through the dialog's path, the listed sites' data, no marker left", async () => {
    const f = fixture()
    const tab = f.browser.tabs.createTab({ url: 'https://news.example/', active: true }, f.win)
    f.navigate(tab.id, 'https://news.example/story')
    f.navigate(tab.id, 'https://cdn.shop.example/item')
    chooseOnExit(f, ['history', 'cache'])
    f.command('siteData.add', { list: 'clearOnExit', pattern: '[*.]shop.example' })
    f.command('siteData.add', { list: 'block', pattern: 'never.example' })
    await settle()
    f.log.clearedStorage.length = 0
    f.log.clearedCookies.length = 0
    expect(f.browser.history.recent(10)).toHaveLength(2)

    await expect(f.browser.siteData.runOnExit()).resolves.toBe('done')
    expect(f.browser.history.recent(10)).toEqual([])
    expect(f.log.cleared).toEqual([{ containerIds: persistentContainers(f), kinds: ['cache'] }])
    // The clear-on-exit site went as a whole (its subdomain was visited), the never-site by origin.
    expect(inDefault(f.log.clearedStorage)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          site: 'shop.example',
          origins: expect.arrayContaining(['https://cdn.shop.example', 'https://shop.example'])
        }),
        {
          containerId: 'default',
          site: '',
          origins: ['https://never.example', 'http://never.example']
        }
      ])
    )
    expect(f.log.clearedCookies.map((c) => c.url)).toContain('https://cdn.shop.example/')
    expect(f.log.clearedCookies.map((c) => c.url)).not.toContain('https://news.example/')
    expect(f.stored().pendingClear).toBeNull()
    // Nothing more to say for a second close in this process.
    f.browser.siteData.noteExiting()
    expect(f.stored().pendingClear).toBeNull()
  })

  it('is nothing when nothing is chosen, and skips the sites when the cookies type takes everything', async () => {
    const f = fixture()
    await expect(f.browser.siteData.runOnExit()).resolves.toBe('nothing')
    expect(f.log.cleared).toEqual([])

    const g = fixture()
    g.command('siteData.add', { list: 'clearOnExit', pattern: '[*.]shop.example' })
    chooseOnExit(g, ['cookies'])
    await settle()
    g.log.clearedStorage.length = 0
    await expect(g.browser.siteData.runOnExit()).resolves.toBe('done')
    expect(g.log.cleared).toEqual([
      { containerIds: persistentContainers(g), kinds: ['cookies', 'storage'] }
    ])
    expect(g.log.clearedStorage).toEqual([])
  })

  it('gives the run a budget, and leaves what did not finish to the next launch', async () => {
    const f = fixture({ hangStorage: true })
    chooseOnExit(f, ['downloads'])
    f.command('siteData.add', { list: 'clearOnExit', pattern: 'slow.example' })
    await settle()
    await expect(f.browser.siteData.runOnExit(20)).resolves.toBe('deferred')
    const stored = f.stored()
    expect(stored.pendingClear).toMatchObject({ types: ['downloads'], patterns: ['slow.example'] })
    expect(f.browser.state.snapshot(f.win).siteData.pendingClear).toBe(true)

    // The next launch finds the marker, runs it ahead of the windows and drops it once done.
    const next = fixture({ files: f.io.files })
    expect(next.browser.siteData.status().pendingClear).toBe(true)
    expect(next.log.clearedStorage[0]).toMatchObject({
      origins: ['https://slow.example', 'http://slow.example']
    })
    await settle()
    expect(next.stored().pendingClear).toBeNull()
    expect(next.browser.siteData.status().pendingClear).toBe(false)
  })

  it("runs from the quit path once the quit is agreed, before the profile's final write", async () => {
    const f = fixture()
    const tab = f.browser.tabs.createTab({ url: 'https://news.example/', active: true }, f.win)
    f.navigate(tab.id, 'https://news.example/story')
    chooseOnExit(f, ['history'])
    await expect(f.browser.requestQuit(f.win)).resolves.toBe(true)
    expect(f.log.quit).toBe(1)
    expect(f.browser.history.recent(10)).toEqual([])
    const persisted = JSON.parse(f.io.files['history.json'] ?? '{"entries":[]}') as {
      entries?: unknown[]
    }
    expect(persisted.entries ?? []).toEqual([])
    expect(f.stored().pendingClear).toBeNull()
  })

  it('on a host without a quit path writes the marker when the app goes away and takes it back when it returns', async () => {
    const f = fixture({ capabilities: { quitsThroughCore: false } })
    expect(f.browser.state.snapshot(f.win).siteData.clearsAtNextLaunch).toBe(true)
    // Nothing chosen: no marker.
    f.browser.siteData.noteExiting()
    expect(f.stored().pendingClear).toBeNull()

    chooseOnExit(f, ['cache'])
    f.command('siteData.add', { list: 'block', pattern: 'never.example' })
    await settle()
    f.browser.siteData.noteExiting()
    expect(f.stored().pendingClear).toMatchObject({ types: ['cache'], patterns: ['never.example'] })
    expect(f.browser.state.snapshot(f.win).siteData.pendingClear).toBe(true)
    // Back to the foreground: the close did not happen.
    f.browser.siteData.noteResumed()
    expect(f.stored().pendingClear).toBeNull()
    // Nothing ran meanwhile.
    expect(f.log.cleared).toEqual([])

    // A close the process did not survive (the host flushes the profile on the way out, as
    // Android's `pause` does): the next launch runs the marker.
    f.browser.siteData.noteExiting()
    f.browser.flushSync()
    const next = fixture({ capabilities: { quitsThroughCore: false }, files: f.io.files })
    await settle()
    expect(next.log.cleared).toEqual([
      { containerIds: persistentContainers(next), kinds: ['cache'] }
    ])
    expect(next.stored().pendingClear).toBeNull()
  })

  it('knows when a site goes as a whole', () => {
    expect(patternsCoverSite(['[*.]example.com'], 'example.com')).toBe(true)
    expect(patternsCoverSite(['[*.]example.com'], 'sub.example.com')).toBe(true)
    expect(patternsCoverSite(['[*.]sub.example.com'], 'example.com')).toBe(false)
    expect(patternsCoverSite(['example.com'], 'example.com')).toBe(false)
    expect(patternsCoverSite(['https://[*.]example.com'], 'example.com')).toBe(false)
    expect(patternsCoverSite(['[*.]example.com'], 'notexample.com')).toBe(false)
    expect(patternsCoverSite(['bad/'], 'example.com')).toBe(false)
  })
})
