import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSING_DATA_ADVANCED,
  DEFAULT_CONTAINER_ID,
  PRIVATE_CONTAINER_ID,
  type BrowsingDataCount,
  type ClearBrowsingDataResult,
  type HostCapabilities,
  type PermissionPrompt,
  type PermissionRule,
  type Platform as PlatformOs,
  type ReauthOutcome,
  type RevokedSitePermissions,
  type SafetyCheckResult,
  type Tab
} from '../../shared/types'
import type { SiteInfoSnapshot } from '../../shared/siteInfo'
import { crashPageUrl, errorPageUrl } from '../../shared/url'
import { TEXT_MATCH_SET_ID } from '../blocking/engine'
import { Browser } from '../browser'
import { REVOKED_PERMISSIONS_KEPT_MS, coarseVisitTime } from '../permissions'
import { DEVICE_LOCAL_SETTINGS } from '../sync/records'
import {
  UNUSED_PERMISSIONS_FIRST_SWEEP_DELAY_MS,
  UNUSED_PERMISSIONS_SWEEP_INTERVAL_MS
} from '../unusedPermissions'
import {
  MANY_PERMISSIONS,
  UNUSED_PERMISSION_MS,
  composeSafetyCheck,
  rangeStart,
  readSafeBrowsingSetting,
  type SafetyCheckInput
} from '../privacy'
import type {
  EngineDataKind,
  Platform,
  SessionHost,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'
import type { ZenWindow } from '../window'

function memoryIo(): StoreIO & { files: Record<string, string> } {
  const files: Record<string, string> = {}
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

interface Fixture {
  browser: Browser
  win: ZenWindow
  io: ReturnType<typeof memoryIo>
  views: FakeView[]
  viewOf(tabId: string): FakeView
  sessions: {
    clearPrivate: number
    cleared: Array<{ containerIds: string[]; kinds: EngineDataKind[] }>
    counted: string[][]
  }
  /** The page of a tab committed a document (the host's `navigated` event). */
  navigate(tabId: string, url: string): void
  command<T>(name: string, args?: unknown): T
}

function fixture(capabilities: Partial<HostCapabilities> = {}): Fixture {
  const views: FakeView[] = []
  const io = memoryIo()
  const sessions: Fixture['sessions'] = { clearPrivate: 0, cleared: [], counted: [] }
  const platform: Platform = {
    info: { os: 'android' as PlatformOs, version: '0.0.0' },
    capabilities: stub<HostCapabilities>({
      windows: false,
      updates: false,
      agents: false,
      passwords: false,
      extensions: false,
      requestBlocking: true,
      privateTabs: true,
      ...capabilities
    }),
    io,
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 400, height: 800 }),
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
      clearPrivate: async () => {
        sessions.clearPrivate++
      },
      clearBrowsingData: async (containerIds: string[], kinds: EngineDataKind[]) => {
        sessions.cleared.push({ containerIds, kinds })
      },
      browsingDataCounts: async (containerIds: string[]) => {
        sessions.counted.push(containerIds)
        return { cookieSites: 4, cacheBytes: 1_500_000 }
      }
    }),
    app: stub(),
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  const win = browser.allWindows()[0]
  const viewOf = (tabId: string): FakeView => {
    const found = views.find((v) => v.tab.id === tabId)
    if (!found) throw new Error(`no view for ${tabId}`)
    return found
  }
  return {
    browser,
    win,
    io,
    views,
    viewOf,
    sessions,
    navigate: (tabId, url) => {
      const v = viewOf(tabId)
      v.url = url
      v.events.onNavigated(url, false)
    },
    command: <T>(name: string, args: unknown = {}): T => browser.handleCommand(win, name, args) as T
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** The containers whose data outlives the session: the model's, default first, private excluded. */
const persistentContainers = (f: Fixture): string[] =>
  f.browser.state.model.containers.map((c) => c.id).filter((id) => id !== PRIVATE_CONTAINER_ID)

// ---------------------------------------------------------------------------
// PS-10: private browsing as tabs (hosts with `privateTabs`)
// ---------------------------------------------------------------------------

describe('private tabs', () => {
  it('opens a tab in the private container that leaves no history and is never persisted', () => {
    const f = fixture()
    const id = f.command<string | null>('tab.newPrivate', { url: 'https://secret.example/' })
    expect(id).not.toBeNull()
    const tab = f.browser.tabs.tab(id!)!
    expect(tab.containerId).toBe(PRIVATE_CONTAINER_ID)
    expect(f.viewOf(tab.id).tab.containerId).toBe(PRIVATE_CONTAINER_ID)
    expect(f.browser.tabs.privateTabs().map((t) => t.id)).toEqual([tab.id])

    f.navigate(tab.id, 'https://secret.example/inbox')
    const normal = f.browser.tabs.createTab({ url: 'https://public.example/', active: true }, f.win)
    f.navigate(normal.id, 'https://public.example/')
    const history = f.browser.history.recent(50).map((e) => e.url)
    expect(history).toEqual(['https://public.example/'])

    f.browser.state.flushSync()
    const persisted = JSON.parse(f.io.files['state.json']) as { tabs: Array<{ id: string }> }
    expect(persisted.tabs.map((t) => t.id)).toContain(normal.id)
    expect(persisted.tabs.map((t) => t.id)).not.toContain(tab.id)
    expect(f.browser.state.snapshot(f.win).tabs[tab.id]?.containerId).toBe(PRIVATE_CONTAINER_ID)
  })

  it('wipes the private session once the last private tab closes, and not before', () => {
    const f = fixture()
    const a = f.command<string>('tab.newPrivate', { url: 'https://a.example/' })
    const b = f.command<string>('tab.newPrivate', { url: 'https://b.example/' })
    expect(f.sessions.clearPrivate).toBe(0)
    f.browser.tabs.closeTab(a, true, f.win)
    expect(f.sessions.clearPrivate).toBe(0)
    f.browser.tabs.closeTab(b, true, f.win)
    expect(f.sessions.clearPrivate).toBe(1)
    expect(f.browser.tabs.privateTabs()).toEqual([])
  })

  it('closes every private tab at once (the "close private tabs" action)', () => {
    const f = fixture()
    f.command('tab.newPrivate', { url: 'https://a.example/' })
    f.command('tab.newPrivate', { url: 'https://b.example/' })
    const keep = f.browser.tabs.createTab({ url: 'https://keep.example/', active: true }, f.win)
    f.command('tab.closePrivate')
    expect(f.browser.tabs.privateTabs()).toEqual([])
    expect(f.browser.tabs.tab(keep.id)).toBeDefined()
    expect(f.sessions.clearPrivate).toBe(1)
  })

  it('is a no-op on hosts that offer private windows instead', () => {
    const f = fixture({ privateTabs: false })
    expect(f.command('tab.newPrivate', { url: 'https://a.example/' })).toBeNull()
    expect(f.browser.tabs.privateTabs()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// MW-01: in-chrome permission prompts
// ---------------------------------------------------------------------------

describe('permission prompts through the chrome', () => {
  it('queues a prompt per tab in the state and answers the request when the chrome responds', async () => {
    const f = fixture()
    const tab = f.browser.tabs.createTab({ url: 'https://cam.example/', active: true }, f.win)
    const decision = f.browser.permissions.decide('media', 'https://cam.example/call', {
      tabId: tab.id,
      mediaTypes: ['video']
    })
    await tick()
    const prompts = f.browser.state.snapshot(f.win).permissionPrompts
    expect(prompts).toHaveLength(1)
    const prompt: PermissionPrompt = prompts[0]
    expect(prompt.tabId).toBe(tab.id)
    expect(prompt.permission).toBe('camera')
    expect(prompt.origin).toBe('https://cam.example')
    expect(prompt.allowOnce).toBe(true)
    expect(prompt.message).toBe('Allow cam.example to use your camera?')

    f.command('permissions.respond', { id: prompt.id, answer: 'allow' })
    await expect(decision).resolves.toBe(true)
    expect(f.browser.state.snapshot(f.win).permissionPrompts).toEqual([])
    expect(f.browser.permissions.rules()).toEqual([
      {
        origin: 'https://cam.example',
        permission: 'camera',
        decision: 'allow',
        lastVisitedAt: coarseVisitTime(Date.now())
      }
    ])
    // Remembered: the next request is answered without a prompt.
    await expect(
      f.browser.permissions.decide('media', 'https://cam.example/', {
        tabId: tab.id,
        mediaTypes: ['video']
      })
    ).resolves.toBe(true)
    expect(f.browser.permissionPrompts.list()).toEqual([])
  })

  it('"Allow once" lasts while the tab stays on the site and is not a rule', async () => {
    const f = fixture()
    const tab = f.browser.tabs.createTab({ url: 'https://geo.example/', active: true }, f.win)
    const first = f.browser.permissions.decide('geolocation', 'https://geo.example/map', {
      tabId: tab.id
    })
    await tick()
    const [prompt] = f.browser.permissionPrompts.list()
    f.command('permissions.respond', { id: prompt.id, answer: 'allow-once' })
    await expect(first).resolves.toBe(true)
    expect(f.browser.permissions.rules()).toEqual([])
    await expect(
      f.browser.permissions.decide('geolocation', 'https://geo.example/other', { tabId: tab.id })
    ).resolves.toBe(true)
    expect(f.browser.permissionPrompts.list()).toEqual([])
    // Same site in another tab: asked again (the grant belongs to the tab).
    const other = f.browser.tabs.createTab({ url: 'https://geo.example/', active: true }, f.win)
    const again = f.browser.permissions.decide('geolocation', 'https://geo.example/', {
      tabId: other.id
    })
    await tick()
    expect(f.browser.permissionPrompts.list()).toHaveLength(1)
    // Dismissed, not blocked: a block would be a rule for the site and settle the question below.
    f.command('permissions.respond', {
      id: f.browser.permissionPrompts.list()[0].id,
      answer: 'dismiss'
    })
    await expect(again).resolves.toBe(false)
    expect(f.browser.permissions.rules()).toEqual([])
    // The first tab leaves the site: its grant ends with the document.
    f.navigate(tab.id, 'https://elsewhere.example/')
    const later = f.browser.permissions.decide('geolocation', 'https://geo.example/', {
      tabId: tab.id
    })
    await tick()
    expect(f.browser.permissionPrompts.list()).toHaveLength(1)
    f.browser.permissionPrompts.cancel(f.browser.permissionPrompts.list()[0].id)
    await expect(later).resolves.toBe(false)
  })

  it('withdraws a pending prompt when its tab navigates or closes, refusing that once', async () => {
    const f = fixture()
    const tab = f.browser.tabs.createTab({ url: 'https://mic.example/', active: true }, f.win)
    const pending = f.browser.permissions.decide('microphone', 'https://mic.example/', {
      tabId: tab.id
    })
    await tick()
    expect(f.browser.permissionPrompts.forTab(tab.id)).toHaveLength(1)
    f.navigate(tab.id, 'https://mic.example/next')
    await expect(pending).resolves.toBe(false)
    expect(f.browser.permissionPrompts.list()).toEqual([])
    expect(f.browser.permissions.rules()).toEqual([])

    const closing = f.browser.permissions.decide('microphone', 'https://mic.example/next', {
      tabId: tab.id
    })
    await tick()
    f.browser.tabs.closeTab(tab.id, true, f.win)
    await expect(closing).resolves.toBe(false)
    expect(f.browser.permissionPrompts.list()).toEqual([])
  })

  it('answers stale ids quietly and dismissals three times running block the site', async () => {
    const f = fixture()
    const tab = f.browser.tabs.createTab({ url: 'https://push.example/', active: true }, f.win)
    expect(() => f.command('permissions.respond', { id: 'gone', answer: 'allow' })).not.toThrow()
    for (let i = 0; i < 3; i++) {
      const ask = f.browser.permissions.decide('notifications', 'https://push.example/', {
        tabId: tab.id
      })
      await tick()
      const [prompt] = f.browser.permissionPrompts.list()
      expect(prompt.allowOnce).toBe(false)
      f.command('permissions.respond', { id: prompt.id, answer: 'dismiss' })
      await expect(ask).resolves.toBe(false)
    }
    expect(f.browser.permissions.rules()).toEqual([
      { origin: 'https://push.example', permission: 'notifications', decision: 'deny' }
    ])
  })
})

// ---------------------------------------------------------------------------
// PS-15: defaults and per-site lists through commands
// ---------------------------------------------------------------------------

describe('site settings commands', () => {
  it('lists every catalogue default, changes one, and lists the sites under it', () => {
    const f = fixture()
    const defaults = f.command<Record<string, string>>('permissions.defaults')
    expect(defaults.camera).toBe('ask')
    expect(defaults.popups).toBe('deny')
    expect(defaults.notifications).toBe('ask')
    f.command('permissions.setDefault', { permission: 'notifications', decision: 'deny' })
    expect(f.command<Record<string, string>>('permissions.defaults').notifications).toBe('deny')
    expect(f.browser.permissions.resolve('notifications', 'https://any.example/')).toBe('deny')
    f.command('permissions.set', {
      origin: 'https://ok.example',
      permission: 'notifications',
      decision: 'allow'
    })
    expect(
      f.command<Array<{ origin: string; decision: string }>>('permissions.listForPermission', {
        permission: 'notifications'
      })
    ).toEqual([{ origin: 'https://ok.example', decision: 'allow' }])
    f.command('permissions.resetOrigin', { origin: 'https://ok.example' })
    expect(f.command('permissions.listForPermission', { permission: 'notifications' })).toEqual([])
    // Back to the built-in default drops the stored one.
    f.command('permissions.setDefault', { permission: 'notifications', decision: 'ask' })
    expect(f.browser.permissions.defaultFor('notifications')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// PS-13: Clear browsing data
// ---------------------------------------------------------------------------

describe('clear browsing data', () => {
  it('previews every type in the dialog’s order, with the engine’s counts and what is unavailable', async () => {
    const f = fixture()
    const tab = f.browser.tabs.createTab({ url: 'https://a.example/', active: true }, f.win)
    f.navigate(tab.id, 'https://a.example/')
    f.navigate(tab.id, 'https://b.example/')
    f.browser.permissions.set('camera', 'https://a.example', 'allow')
    const counts = await f.command<Promise<BrowsingDataCount[]>>(
      'privacy.clearBrowsingDataCounts',
      {
        range: 'all'
      }
    )
    // The Advanced set's rows, then the phone's `tabs` row (in neither set; HB-07).
    expect(counts.map((c) => c.type)).toEqual([...BROWSING_DATA_ADVANCED, 'tabs'])
    const by = Object.fromEntries(counts.map((c) => [c.type, c]))
    expect(by.history).toMatchObject({ count: 2, unit: 'visits', rangeApplies: true })
    expect(by.cookies).toMatchObject({ count: 4, unit: 'sites', rangeApplies: false })
    expect(by.cache).toMatchObject({ count: 1_500_000, unit: 'bytes' })
    expect(by.downloads).toMatchObject({ count: 0, unit: 'downloads', rangeApplies: true })
    expect(by.passwords.unavailable).toMatch(/no password vault/)
    expect(by.autofill.unavailable).toMatch(/does not save form entries/)
    expect(by.sitePermissions).toMatchObject({ count: 1, unit: 'permissions' })
    expect(by.recentlyClosed).toMatchObject({ count: 0, unit: 'entries' })
    // Every persistent container is counted (the seeded ones too); the private one never is.
    expect(f.sessions.counted).toEqual([persistentContainers(f)])
  })

  it('clears the chosen types: history, the engine’s kinds per container, site rules but not defaults', async () => {
    const f = fixture()
    const tab = f.browser.tabs.createTab({ url: 'https://a.example/', active: true }, f.win)
    f.navigate(tab.id, 'https://a.example/')
    f.browser.permissions.set('camera', 'https://a.example', 'allow')
    f.browser.permissions.chooseDefault('notifications', 'deny')
    const result = await f.command<Promise<ReauthOutcome<ClearBrowsingDataResult>>>(
      'privacy.clearBrowsingData',
      { range: 'all', types: ['history', 'cookies', 'cache', 'sitePermissions', 'recentlyClosed'] }
    )
    expect(result).toEqual({
      status: 'ok',
      value: { cleared: ['history', 'cookies', 'cache', 'sitePermissions', 'recentlyClosed'] }
    })
    expect(f.browser.history.recent(10)).toEqual([])
    expect(f.sessions.cleared).toEqual([
      { containerIds: persistentContainers(f), kinds: ['cookies', 'storage', 'cache'] }
    ])
    expect(f.browser.permissions.rules()).toEqual([])
    expect(f.browser.permissions.defaultFor('notifications')).toBe('deny')
  })

  it('stamps a clearing on the tip card’s device memory (NTP-20: the Quick Delete card rests 30 days from it); a clearing that was denied stamps nothing', async () => {
    const f = fixture()
    expect(f.browser.state.newTabDevice.educationalTips.browsingDataClearedAt).toBeNull()
    const before = Date.now()
    await f.command<Promise<unknown>>('privacy.clearBrowsingData', {
      range: 'hour',
      types: ['cache']
    })
    const stamped = f.browser.state.newTabDevice.educationalTips.browsingDataClearedAt
    expect(stamped).not.toBeNull()
    expect(stamped!).toBeGreaterThanOrEqual(before)
    // Passwords on a device without a vault: denied, nothing cleared, the stamp as it was.
    const result = await f.command<Promise<ReauthOutcome<ClearBrowsingDataResult>>>(
      'privacy.clearBrowsingData',
      { range: 'all', types: ['passwords'] }
    )
    expect(result.status).toBe('denied')
    expect(f.browser.state.newTabDevice.educationalTips.browsingDataClearedAt).toBe(stamped)
  })

  it('asks the engine only for what was chosen, and never for the private session', async () => {
    const f = fixture()
    f.command('tab.newPrivate', { url: 'https://secret.example/' })
    await f.command<Promise<unknown>>('privacy.clearBrowsingData', {
      range: 'hour',
      types: ['cache']
    })
    expect(f.sessions.cleared).toEqual([
      { containerIds: persistentContainers(f), kinds: ['cache'] }
    ])
    expect(f.sessions.cleared[0].containerIds).not.toContain(PRIVATE_CONTAINER_ID)
    expect(f.sessions.cleared[0].containerIds[0]).toBe(DEFAULT_CONTAINER_ID)
    await f.command<Promise<unknown>>('privacy.clearBrowsingData', {
      range: 'hour',
      types: ['downloads']
    })
    expect(f.sessions.cleared).toHaveLength(1)
  })

  it('clears nothing when passwords are chosen on a device without a vault', async () => {
    const f = fixture()
    const tab = f.browser.tabs.createTab({ url: 'https://a.example/', active: true }, f.win)
    f.navigate(tab.id, 'https://a.example/')
    const result = await f.command<Promise<ReauthOutcome<ClearBrowsingDataResult>>>(
      'privacy.clearBrowsingData',
      { range: 'all', types: ['passwords', 'history'] }
    )
    expect(result.status).toBe('denied')
    expect(f.browser.history.recent(10)).toHaveLength(1)
    expect(f.sessions.cleared).toEqual([])
  })

  it('measures ranges from the given moment, Chrome’s four weeks for a month', () => {
    const now = 10_000_000_000
    expect(rangeStart('15min', now)).toBe(now - 900_000)
    expect(rangeStart('hour', now)).toBe(now - 3_600_000)
    expect(rangeStart('day', now)).toBe(now - 86_400_000)
    expect(rangeStart('week', now)).toBe(now - 7 * 86_400_000)
    expect(rangeStart('month', now)).toBe(now - 28 * 86_400_000)
    expect(rangeStart('all', now)).toBe(0)
  })

  it('remembers the range the dialog last deleted with (seed #20): the last hour until a Delete writes another; a range no picker offers reads the last hour; the key is the device’s own', () => {
    const f = fixture()
    expect(f.browser.state.settings.clearBrowsingDataRange).toBe('hour')
    // The dialog's Delete writes the range it went with through the settings path.
    f.command('settings.update', { clearBrowsingDataRange: 'month' })
    expect(f.browser.state.settings.clearBrowsingDataRange).toBe('month')
    f.command('settings.update', { clearBrowsingDataRange: '15min' })
    expect(f.browser.state.settings.clearBrowsingDataRange).toBe('15min')
    // A malformed patch reads as Chrome's default, never as a range the pickers lack.
    for (const bad of ['year', 3, null, { range: 'all' }]) {
      f.command('settings.update', { clearBrowsingDataRange: bad })
      expect(f.browser.state.settings.clearBrowsingDataRange, JSON.stringify(bad)).toBe('hour')
    }
    // Chrome stopped syncing browser.clear_data.time_period (CL 5398105): device-local here too.
    expect(DEVICE_LOCAL_SETTINGS).toContain('clearBrowsingDataRange')
  })
})

// ---------------------------------------------------------------------------
// HB-07 / MOT-24: Quick Delete's tab half – `Tab.lastNavigatedAt`, `privacy.tabsInRange`,
// the `'tabs'` type (Chrome Android's `QuickDeleteTabsFilter`)
// ---------------------------------------------------------------------------

describe('quick delete: the tabs of a range', () => {
  const T0 = 1_700_000_000_000
  const at = (ms: number): void => {
    vi.setSystemTime(T0 + ms)
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    at(0)
  })
  afterEach(() => vi.useRealTimers())

  /** A tab created at `T0 + ms` whose page committed there. */
  function tabAt(f: Fixture, ms: number, url: string, opts: { pinned?: boolean } = {}): Tab {
    at(ms)
    const tab = f.browser.tabs.createTab({ url, active: true, ...opts }, f.win)
    f.navigate(tab.id, url)
    return tab
  }

  /**
   * A chrome page typed into `fromTabId` opens in a tab of its own, active
   * (`PageService.routeNavigation`, as Chrome Android leaves the current tab alone) – drawn by
   * the chrome, with no view and so no navigation stamp. The Settings tab the phone's form is a
   * sheet over (seed #26) is one; History is another chrome page, and no seat of the form.
   */
  function openPage(f: Fixture, fromTabId: string, url: string, id: string): Tab {
    f.browser.tabs.navigate(fromTabId, url)
    const page = f.browser.tabs.activeTabFor(f.win)
    if (!page || page.id === fromTabId || f.browser.pages.pageOf(page)?.id !== id)
      throw new Error(`${url} did not open as the active tab`)
    return page
  }
  const openSettings = (f: Fixture, fromTabId: string): Tab =>
    openPage(f, fromTabId, 'zen://settings', 'settings')

  it('stamps a tab at every committed main-frame navigation, a same-document one too, and never before', () => {
    const f = fixture()
    const tab = f.browser.tabs.createTab({ url: 'https://a.example/', active: true }, f.win)
    expect(tab.lastNavigatedAt).toBeNull()
    at(1_000)
    f.navigate(tab.id, 'https://a.example/')
    expect(f.browser.tabs.tab(tab.id)?.lastNavigatedAt).toBe(T0 + 1_000)
    // A pushState within the document: Chrome stamps `lastNavigationCommittedTimestampMillis`
    // on any committed navigation (`TabImpl.handleDidFinishNavigation`), so the same-document
    // commit moves the stamp as well.
    at(2_000)
    f.viewOf(tab.id).events.onNavigated('https://a.example/#part', true)
    expect(f.browser.tabs.tab(tab.id)?.lastNavigatedAt).toBe(T0 + 2_000)
    expect(f.browser.tabs.tab(tab.id)?.url).toBe('https://a.example/#part')
  })

  it('stamps a committed error page as Chrome does, but not the crash page – Chrome’s sad tab is no navigation', () => {
    const f = fixture()
    const tab = f.browser.tabs.createTab({ url: 'https://a.example/', active: true }, f.win)
    at(1_000)
    f.navigate(tab.id, 'https://a.example/')
    // A load that failed commits Chrome's error page through the same `didFinishNavigation`
    // (`TabWebContentsObserver.java:318–327`, `setIsShowingErrorPage` after the stamp): the
    // user went there, the stamp moves.
    at(5_000)
    f.navigate(tab.id, errorPageUrl(-106, 'ERR_INTERNET_DISCONNECTED', 'https://b.example/'))
    expect(f.browser.tabs.tab(tab.id)?.lastNavigatedAt).toBe(T0 + 5_000)
    // The renderer's death shows a sad tab over the page in Chrome (`primaryMainFrameRenderProcessGone`
    // → `showSadTab`, `:221–222`), no commit, no stamp; Zenium loads its crash page, which
    // must not read as a visit – or a tab last seen hours ago would go with the last 15 minutes.
    at(3_600_000)
    f.navigate(tab.id, crashPageUrl('CRASHED', 'https://b.example/'))
    expect(f.browser.tabs.tab(tab.id)?.lastNavigatedAt).toBe(T0 + 5_000)
    expect(f.browser.tabs.tab(tab.id)?.errorCode).toBe(-1)
    // Quick Delete's list agrees: the crashed tab is in the hour of its last real commit only
    // (read from the Settings tab a form would be up over, so the crashed tab is not the one
    // the form is confirmed from).
    openSettings(f, tab.id)
    expect(f.command<string[]>('privacy.tabsInRange', { range: '15min' })).not.toContain(tab.id)
    expect(f.command<string[]>('privacy.tabsInRange', { range: 'day' })).toContain(tab.id)
  })

  it('lists the tabs whose last commit is in the range, pinned included, in the strip’s order, before anything closes', () => {
    const f = fixture()
    // The window's first tab (the new tab page, a document) never committed here: in no bounded
    // range, but in the All time list – active or not, it is no Settings tab, so no seat of a
    // form (seed #26).
    const first = f.browser.tabs.activeTabFor(f.win)!
    expect(first.lastNavigatedAt).toBeNull()
    expect(f.command<string[]>('privacy.tabsInRange', { range: 'all' })).toEqual([first.id])
    const old = tabAt(f, 0, 'https://old.example/')
    const pinned = tabAt(f, 10 * 60_000, 'https://pinned.example/', { pinned: true })
    const recent = tabAt(f, 20 * 60_000, 'https://recent.example/')
    const fresh = f.browser.tabs.createTab({ url: 'https://never.example/', active: true }, f.win)
    // The form is a sheet over the Settings tab, the window's active tab when the chrome asks:
    // that tab is in no list (seed #26), whatever the range.
    const settings = openSettings(f, fresh.id)
    at(24 * 60_000)
    // Fifteen minutes back is T0 + 9 min: the pinned tab (10) and the recent one (20) are in.
    expect(f.command<string[]>('privacy.tabsInRange', { range: '15min' })).toEqual([
      pinned.id,
      recent.id
    ])
    expect(f.command<string[]>('privacy.tabsInRange', { range: 'hour' })).toEqual([
      pinned.id,
      old.id,
      recent.id
    ])
    // "All time" is every tab of the regular model, stamped or not – Chrome's ALL_TIME answers
    // true before it reads a timestamp – less the tab the form is confirmed from, while a tab
    // that never committed a document is in no bounded range at all.
    expect(f.command<string[]>('privacy.tabsInRange', { range: 'all' })).toEqual([
      pinned.id,
      first.id,
      old.id,
      recent.id,
      fresh.id
    ])
    expect(f.command<string[]>('privacy.tabsInRange', { range: 'all' })).not.toContain(settings.id)
    expect(f.command<string[]>('privacy.tabsInRange', { range: 'hour' })).not.toContain(fresh.id)
    // Nothing closed: this is the read the chrome takes before its motion.
    expect(f.browser.tabs.tab(old.id)).toBeDefined()
    expect(f.browser.tabs.tab(recent.id)).toBeDefined()
    // Another chrome page is no seat of the form: History opened as the active tab is in the All
    // time list like any other – and the Settings tab, no longer the confirming one, is a tab of
    // the period again. Only the active Settings tab is kept.
    const history = openPage(f, fresh.id, 'zen://history', 'history')
    const withHistory = f.command<string[]>('privacy.tabsInRange', { range: 'all' })
    expect(withHistory).toEqual(expect.arrayContaining([history.id, settings.id]))
    expect(withHistory).toHaveLength(7)
  })

  it('leaves private tabs out, as Chrome’s filter runs on the regular model only', () => {
    const f = fixture()
    const normal = tabAt(f, 0, 'https://a.example/')
    at(1_000)
    const secretId = f.command<string>('tab.newPrivate', { url: 'https://secret.example/' })
    f.navigate(secretId, 'https://secret.example/')
    at(2_000)
    expect(f.command<string[]>('privacy.tabsInRange', { range: '15min' })).toEqual([normal.id])
    expect(f.command<string[]>('privacy.tabsInRange', { range: 'all' })).not.toContain(secretId)
  })

  it('counts the range’s tabs as a row of the preview, outside the Basic and Advanced sets', async () => {
    const f = fixture()
    tabAt(f, 0, 'https://old.example/')
    tabAt(f, 20 * 60_000, 'https://recent.example/')
    // Quick Delete from the app menu over a site: the window's active tab is a site navigated
    // in the range, a tab of the period like any other (seed #26, the lead's ruling) – counted,
    // as Chrome's row counts the tabs that will close and this one closes.
    const site = tabAt(f, 22 * 60_000, 'https://site.example/')
    at(24 * 60_000)
    expect(f.browser.tabs.activeTabFor(f.win)?.id).toBe(site.id)
    const tabsRow = async (range: string): Promise<BrowsingDataCount | undefined> =>
      (
        await f.command<Promise<BrowsingDataCount[]>>('privacy.clearBrowsingDataCounts', {
          range
        })
      ).find((c) => c.type === 'tabs')
    expect(await tabsRow('15min')).toEqual({
      type: 'tabs',
      count: 2,
      unit: 'tabs',
      rangeApplies: true,
      unavailable: null
    })
    // All time: every tab of the model – the window's first tab, old, recent, the site.
    expect((await tabsRow('all'))?.count).toBe(4)
    // From the Settings tab (the phone's form is a sheet over it) the seat is left out: the
    // same fifteen minutes count the same two – Settings carries no stamp – and All time counts
    // every tab but Settings, four of five.
    openSettings(f, site.id)
    expect((await tabsRow('15min'))?.count).toBe(2)
    expect((await tabsRow('all'))?.count).toBe(4)
    expect(BROWSING_DATA_ADVANCED).not.toContain('tabs')
  })

  it('closes exactly the range’s tabs with no undo and no recently-closed entry, other types untouched', async () => {
    const f = fixture()
    const old = tabAt(f, 0, 'https://old.example/')
    const pinned = tabAt(f, 10 * 60_000, 'https://pinned.example/', { pinned: true })
    const recent = tabAt(f, 20 * 60_000, 'https://recent.example/')
    // Quick Delete from the app menu over a site: the window's active tab is a site navigated
    // in the range, and it goes with the period like any other (seed #26, the lead's ruling –
    // as in Chrome, where the surface the user acts from is never a tab); the list the chrome
    // read for its motion names exactly the tabs that go.
    const site = tabAt(f, 22 * 60_000, 'https://site.example/')
    at(24 * 60_000)
    expect(f.browser.tabs.activeTabFor(f.win)?.id).toBe(site.id)
    const listed = f.command<string[]>('privacy.tabsInRange', { range: '15min' })
    expect(listed).toEqual([pinned.id, recent.id, site.id])
    const sent = vi.spyOn(f.win, 'send')
    const before = f.browser.state.recentlyClosed.length
    const result = await f.command<Promise<ClearBrowsingDataResult>>('privacy.clearBrowsingData', {
      range: '15min',
      types: ['tabs']
    })
    expect(result).toEqual({ status: 'ok', value: { cleared: ['tabs'] } })
    for (const id of listed) expect(f.browser.tabs.tab(id)).toBeUndefined()
    expect(f.browser.tabs.tab(old.id)).toBeDefined()
    // The site's close selected a neighbour, as any close of the active tab does.
    const active = f.browser.tabs.activeTabFor(f.win)
    expect(active).toBeDefined()
    expect(active?.id).not.toBe(site.id)
    // Chrome's `allowUndo(false).saveToTabRestoreService(false)`: the list stays as it was and
    // the chrome hears no `session.recentlyClosedChanged` – no toast offers to undo.
    expect(f.browser.state.recentlyClosed).toHaveLength(before)
    expect(sent.mock.calls.map(([name]) => name)).not.toContain('session.recentlyClosedChanged')
    // Only the tabs were asked for: the engine cleared nothing, history stands.
    expect(f.sessions.cleared).toEqual([])
    expect(f.browser.history.recent(10).length).toBeGreaterThan(0)
  })

  it('keeps the Settings tab the form is confirmed from under All time, and closes every other tab (seed #26)', async () => {
    const f = fixture()
    const old = tabAt(f, 0, 'https://old.example/')
    const recent = tabAt(f, 20 * 60_000, 'https://recent.example/')
    const settings = openSettings(f, recent.id)
    at(24 * 60_000)
    // A chrome page is drawn by the chrome, with no view to commit a document: the Settings tab
    // carries no navigation stamp, so on its own it is in no bounded range – All time, which
    // takes every tab of the model (Chrome's ALL_TIME), is where it went before this rule.
    expect(f.browser.tabs.tab(settings.id)?.lastNavigatedAt).toBeNull()
    expect(f.command<string[]>('privacy.tabsInRange', { range: '15min' })).toEqual([recent.id])
    const all = f.command<string[]>('privacy.tabsInRange', { range: 'all' })
    expect(all).not.toContain(settings.id)
    expect(all).toEqual(expect.arrayContaining([old.id, recent.id]))
    // The count row agrees with the list: the tabs that will close.
    const counts = await f.command<Promise<BrowsingDataCount[]>>(
      'privacy.clearBrowsingDataCounts',
      { range: 'all' }
    )
    expect(counts.find((c) => c.type === 'tabs')?.count).toBe(all.length)
    const result = await f.command<Promise<ClearBrowsingDataResult>>('privacy.clearBrowsingData', {
      range: 'all',
      types: ['tabs']
    })
    expect(result).toEqual({ status: 'ok', value: { cleared: ['tabs'] } })
    for (const id of all) expect(f.browser.tabs.tab(id)).toBeUndefined()
    expect(f.browser.tabs.tab(settings.id)).toBeDefined()
    expect(f.browser.tabs.activeTabFor(f.win)?.id).toBe(settings.id)
    // The overview after the close: the Settings tab alone, and nothing left for the range.
    expect(f.command<string[]>('privacy.tabsInRange', { range: 'all' })).toEqual([])
    expect(f.browser.tabs.tabsNavigatedSince(null).map((t) => t.id)).toEqual([settings.id])
  })

  it('keeps the Settings tab the form is confirmed from under a bounded range – were it ever stamped within it – and closes the rest (seed #26)', async () => {
    const f = fixture()
    const old = tabAt(f, 0, 'https://old.example/')
    const recent = tabAt(f, 20 * 60_000, 'https://recent.example/')
    const settings = openSettings(f, recent.id)
    // A chrome page carries no navigation stamp today (no view commits a document there), so on
    // its own the Settings tab is in no bounded range; stamped within the range all the same –
    // as a stamp on chrome pages would one day – the seat is kept: the predicate is the page,
    // not the stamp.
    const stamped = f.browser.tabs.tab(settings.id)!
    stamped.lastNavigatedAt = T0 + 23 * 60_000
    at(24 * 60_000)
    const inRange = f.browser.tabs.tabsNavigatedSince(T0 + 9 * 60_000).map((t) => t.id)
    expect(inRange).toEqual(expect.arrayContaining([recent.id, settings.id]))
    expect(f.command<string[]>('privacy.tabsInRange', { range: '15min' })).toEqual([recent.id])
    const counts = await f.command<Promise<BrowsingDataCount[]>>(
      'privacy.clearBrowsingDataCounts',
      { range: '15min' }
    )
    expect(counts.find((c) => c.type === 'tabs')?.count).toBe(1)
    const result = await f.command<Promise<ClearBrowsingDataResult>>('privacy.clearBrowsingData', {
      range: '15min',
      types: ['tabs']
    })
    expect(result).toEqual({ status: 'ok', value: { cleared: ['tabs'] } })
    expect(f.browser.tabs.tab(recent.id)).toBeUndefined()
    expect(f.browser.tabs.tab(old.id)).toBeDefined()
    expect(f.browser.tabs.tab(settings.id)).toBeDefined()
    expect(f.browser.tabs.activeTabFor(f.win)?.id).toBe(settings.id)
  })

  it('keeps nothing without a command window: the exclusion is the command context’s', () => {
    const f = fixture()
    const recent = tabAt(f, 20 * 60_000, 'https://recent.example/')
    const settings = openSettings(f, recent.id)
    at(24 * 60_000)
    // The chrome's two calls come with their window and leave its Settings tab out; the service
    // asked with none (no window to read a seat from) answers the whole model.
    expect(f.command<string[]>('privacy.tabsInRange', { range: 'all' })).not.toContain(settings.id)
    const unasked = f.browser.privacy.tabsInRange('all')
    expect(unasked).toEqual(expect.arrayContaining([recent.id, settings.id]))
    expect(unasked).toHaveLength(3)
  })

  it('a tab closed by hand still goes to recently closed – the ordinary path is unchanged', () => {
    const f = fixture()
    const tab = tabAt(f, 0, 'https://a.example/')
    f.browser.tabs.createTab({ url: 'https://b.example/', active: true }, f.win)
    const before = f.browser.state.recentlyClosed.length
    f.browser.tabs.closeTab(tab.id, true, f.win)
    expect(f.browser.state.recentlyClosed.length).toBe(before + 1)
  })
})

// ---------------------------------------------------------------------------
// PS-28: Safety check
// ---------------------------------------------------------------------------

function safetyInput(patch: Partial<SafetyCheckInput> = {}): SafetyCheckInput {
  return {
    now: 1_000_000_000_000,
    updates: null,
    safeBrowsing: { configured: false, enabled: null },
    passwords: null,
    rules: [],
    revoked: [],
    notificationsShown: [],
    extensions: null,
    ...patch
  }
}

describe('safety check', () => {
  it('reports what the host cannot check as unavailable, and a clean profile as safe', () => {
    const result: SafetyCheckResult = composeSafetyCheck(safetyInput())
    expect(result.updates.state).toBe('unavailable')
    expect(result.safeBrowsing.state).toBe('unavailable')
    expect(result.passwords.state).toBe('unavailable')
    expect(result.extensions.state).toBe('unavailable')
    expect(result.permissions).toMatchObject({ state: 'safe', grantedSites: 0, review: [] })
    expect(result.notifications).toMatchObject({ state: 'safe', sites: [] })
    const live = f().command<SafetyCheckResult>('privacy.safetyCheck')
    expect(live.checkedAt).toBeGreaterThan(0)
    expect(live.updates.state).toBe('unavailable')
  })

  it('flags sites with many permissions and sites not visited for two months', () => {
    const now = 1_000_000_000_000
    // The clock is the rule's own coarse visit stamp (PS-41), not the history's last visit: a
    // site whose grants carry none (an allow from before the clock, unvisited since) is not
    // flagged, as a site without a history row was not.
    const rules: PermissionRule[] = [
      { origin: 'https://busy.example', permission: 'camera', decision: 'allow' },
      { origin: 'https://busy.example', permission: 'microphone', decision: 'allow' },
      { origin: 'https://busy.example', permission: 'geolocation', decision: 'allow' },
      {
        origin: 'https://old.example',
        permission: 'geolocation',
        decision: 'allow',
        lastVisitedAt: now - UNUSED_PERMISSION_MS - 1
      },
      {
        origin: 'https://fine.example',
        permission: 'camera',
        decision: 'allow',
        lastVisitedAt: now - 1000
      },
      // The site's newest stamp counts: one grant visited lately keeps the site off the list.
      {
        origin: 'https://mixed.example',
        permission: 'camera',
        decision: 'allow',
        lastVisitedAt: now - UNUSED_PERMISSION_MS - 1
      },
      {
        origin: 'https://mixed.example',
        permission: 'microphone',
        decision: 'allow',
        lastVisitedAt: now - 1000
      },
      // Content rows and refusals are not capabilities a site holds.
      { origin: 'https://ads.example', permission: 'popups', decision: 'allow' },
      { origin: 'https://no.example', permission: 'camera', decision: 'deny' }
    ]
    const result = composeSafetyCheck(safetyInput({ now, rules }))
    expect(result.permissions.state).toBe('info')
    expect(result.permissions.grantedSites).toBe(4)
    expect(result.permissions.revoked).toEqual([])
    expect(result.permissions.review).toEqual([
      {
        origin: 'https://busy.example',
        permissions: ['camera', 'microphone', 'geolocation'],
        reason: 'many'
      },
      { origin: 'https://old.example', permissions: ['geolocation'], reason: 'unused' }
    ])
    expect(MANY_PERMISSIONS).toBe(3)
  })

  it('lists the sites allowed to notify, busiest first', () => {
    const result = composeSafetyCheck(
      safetyInput({
        rules: [
          { origin: 'https://quiet.example', permission: 'notifications', decision: 'allow' },
          { origin: 'https://loud.example', permission: 'notifications', decision: 'allow' },
          { origin: 'https://muted.example', permission: 'notifications', decision: 'deny' }
        ],
        notificationsShown: [{ origin: 'https://loud.example', count: 12 }]
      })
    )
    expect(result.notifications.state).toBe('info')
    expect(result.notifications.sites).toEqual([
      { origin: 'https://loud.example', shown: 12 },
      { origin: 'https://quiet.example', shown: 0 }
    ])
    expect(result.notifications.summary).toBe('2 sites may send notifications; 1 did this session')
  })

  it('reads the Safe Browsing switch however the settings spell it', () => {
    expect(readSafeBrowsingSetting({})).toEqual({ configured: false, enabled: null })
    expect(readSafeBrowsingSetting({ safeBrowsing: true })).toEqual({
      configured: true,
      enabled: true
    })
    expect(readSafeBrowsingSetting({ safeBrowsing: { enabled: false } })).toEqual({
      configured: true,
      enabled: false
    })
    expect(readSafeBrowsingSetting({ safeBrowsing: { level: 'off' } })).toEqual({
      configured: true,
      enabled: false
    })
    expect(readSafeBrowsingSetting({ safeBrowsing: { mode: 'standard' } })).toEqual({
      configured: true,
      enabled: true
    })
    const off = composeSafetyCheck(
      safetyInput({ safeBrowsing: { configured: true, enabled: false } })
    )
    expect(off.safeBrowsing.state).toBe('warning')
  })

  it('reviews extensions that failed, ask for new permissions or come from nowhere', () => {
    const ext = (
      patch: Record<string, unknown>
    ): SafetyCheckInput['extensions'] extends Array<infer E> | null ? E : never =>
      ({
        id: 'x',
        name: 'X',
        version: '1',
        enabled: true,
        source: 'chrome-web-store',
        publisher: 'store',
        error: null,
        pendingWarnings: [],
        updateState: 'idle',
        updateError: null,
        ...patch
      }) as never
    const result = composeSafetyCheck(
      safetyInput({
        extensions: [
          ext({ id: 'ok' }),
          ext({ id: 'broken', name: 'Broken', error: 'manifest invalid' }),
          ext({ id: 'greedy', name: 'Greedy', pendingWarnings: ['Read your browsing history'] }),
          ext({ id: 'stranger', name: 'Stranger', publisher: null, source: 'sideload' }),
          ext({ id: 'dev', name: 'Dev', publisher: null, source: 'unpacked' })
        ]
      })
    )
    expect(result.extensions.state).toBe('warning')
    expect(result.extensions.flagged.map((e) => e.id)).toEqual(['broken', 'greedy', 'stranger'])
    expect(result.extensions.flagged[0].reasons).toEqual(['Could not be loaded: manifest invalid'])
    expect(composeSafetyCheck(safetyInput({ extensions: [] })).extensions.state).toBe('safe')
  })
})

const f = (): Fixture => fixture()

// ---------------------------------------------------------------------------
// PS-14: the site-information snapshot for the desktop popover
// ---------------------------------------------------------------------------

describe('siteInfo.snapshot', () => {
  it('adds the blocker’s state and whether the tab is private to the site information', async () => {
    const fx = fixture()
    const tab = fx.browser.tabs.createTab(
      { url: 'https://shop.example/cart', active: true },
      fx.win
    )
    fx.navigate(tab.id, 'https://shop.example/cart')
    tab.blockedCount = 7
    fx.browser.permissions.set('camera', 'https://shop.example', 'allow')
    const snapshot = await fx.command<Promise<SiteInfoSnapshot | null>>('siteInfo.snapshot', {
      tabId: tab.id
    })
    expect(snapshot).not.toBeNull()
    expect(snapshot!.tabId).toBe(tab.id)
    expect(snapshot!.blocking).toEqual({
      blockedCount: 7,
      enabled: fx.browser.blocking.enabled,
      excepted: false,
      available: true
    })
    expect(snapshot!.isPrivate).toBe(false)
    expect(snapshot!.permissions).toEqual([{ permission: 'camera', decision: 'allow' }])

    const privateId = fx.command<string>('tab.newPrivate', { url: 'https://shop.example/' })
    fx.navigate(privateId, 'https://shop.example/')
    const secret = await fx.command<Promise<SiteInfoSnapshot | null>>('siteInfo.snapshot', {
      tabId: privateId
    })
    expect(secret!.isPrivate).toBe(true)
    expect(await fx.command<Promise<unknown>>('siteInfo.snapshot', { tabId: 'nope' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PS-33: the tracker report is the document's own – the record on disk carries none of it
// ---------------------------------------------------------------------------

describe('the tracker report on disk (PS-33)', () => {
  it('writes the tab with its count at zero and without its blocked sites', () => {
    const fx = fixture()
    const tab = fx.browser.tabs.createTab({ url: 'https://news.example/', active: true }, fx.win)
    fx.navigate(tab.id, 'https://news.example/')
    fx.browser.blocking.recordBlocked(tab.id, 3, [
      { host: 'ads.example', setId: TEXT_MATCH_SET_ID, count: 3 }
    ])
    expect(tab.blockedCount).toBe(3)
    expect(tab.blockedSites).toEqual([{ domain: 'ads.example', category: 'tracker', count: 3 }])

    fx.browser.state.flushSync()
    const persisted = JSON.parse(fx.io.files['state.json']) as {
      tabs: Array<Record<string, unknown>>
    }
    const record = persisted.tabs.find((t) => t.id === tab.id)
    expect(record).toBeDefined()
    expect(record!.blockedCount).toBe(0)
    expect(record).not.toHaveProperty('blockedSites')
    // The live tab keeps its report: only the written record goes without.
    expect(tab.blockedSites).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// PS-41: unused site permissions – the visit seat, the sweep's schedule, the review's commands
// ---------------------------------------------------------------------------

describe('unused site permissions in the browser (PS-41)', () => {
  const DAY = 24 * 3_600_000
  /** A Sunday noon; the fixtures move the clock from here. */
  const T0 = Date.UTC(2026, 8, 27, 12)
  const WEEK0 = coarseVisitTime(T0)
  const OLD = T0 - 10 * 7 * DAY
  const OLD_WEEK = coarseVisitTime(OLD)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A browser whose `site` holds `permission` allowed ten weeks ago, unvisited since. */
  const withStale = (site: string, permission = 'camera'): Fixture => {
    const fx = fixture()
    vi.setSystemTime(OLD)
    fx.browser.permissions.set(permission, site, 'allow')
    vi.setSystemTime(T0)
    return fx
  }
  const stampOf = (fx: Fixture, site: string, permission = 'camera'): number | undefined =>
    fx.browser.permissions.rules().find((r) => r.origin === site && r.permission === permission)
      ?.lastVisitedAt

  it('a non-private tab’s page commit refreshes the site’s stamps; a same-document navigation, a private tab and a history clear do not touch them', () => {
    const fx = withStale('https://cam.example')
    vi.setSystemTime(OLD)
    fx.browser.permissions.set('camera', 'https://secret.example', 'allow')
    vi.setSystemTime(T0)
    expect(stampOf(fx, 'https://cam.example')).toBe(OLD_WEEK)

    const tab = fx.browser.tabs.createTab({ url: 'https://cam.example/', active: true }, fx.win)
    fx.viewOf(tab.id).events.onNavigated('https://cam.example/inbox', true)
    expect(stampOf(fx, 'https://cam.example')).toBe(OLD_WEEK)
    fx.navigate(tab.id, 'https://cam.example/inbox')
    expect(stampOf(fx, 'https://cam.example')).toBe(WEEK0)

    const privateId = fx.command<string>('tab.newPrivate', { url: 'https://secret.example/' })
    fx.navigate(privateId, 'https://secret.example/')
    expect(stampOf(fx, 'https://secret.example')).toBe(OLD_WEEK)

    fx.browser.history.clear()
    expect(fx.browser.history.recent(10)).toEqual([])
    expect(stampOf(fx, 'https://cam.example')).toBe(WEEK0)
    // Ten weeks unvisited, but the history says nothing about it any more: the stamp decides.
    expect(fx.browser.permissions.sweepUnused(true).revoked.map((r) => r.origin)).toEqual([
      'https://secret.example'
    ])
  })

  it('runs its first sweep off the boot path, then daily; a run that changed the list pushes the state', () => {
    const fx = withStale('https://cam.example')
    expect(fx.browser.state.snapshot(fx.win).revokedUnusedPermissions).toEqual([])
    vi.advanceTimersByTime(UNUSED_PERMISSIONS_FIRST_SWEEP_DELAY_MS - 1)
    expect(fx.browser.permissions.revokedUnused()).toEqual([])
    vi.advanceTimersByTime(1)
    const first = fx.browser.permissions.revokedUnused()
    expect(first).toEqual([
      {
        origin: 'https://cam.example',
        permissions: ['camera'],
        revokedAt: T0 + UNUSED_PERMISSIONS_FIRST_SWEEP_DELAY_MS,
        expiresAt: T0 + UNUSED_PERMISSIONS_FIRST_SWEEP_DELAY_MS + REVOKED_PERMISSIONS_KEPT_MS
      }
    ])
    expect(fx.browser.state.snapshot(fx.win).revokedUnusedPermissions).toEqual(first)

    // Another site goes stale before the next daily run.
    const now = Date.now()
    vi.setSystemTime(OLD)
    fx.browser.permissions.set('microphone', 'https://mic.example', 'allow')
    vi.setSystemTime(now)
    vi.advanceTimersByTime(UNUSED_PERMISSIONS_SWEEP_INTERVAL_MS)
    expect(fx.browser.permissions.revokedUnused().map((r) => r.origin)).toEqual([
      'https://mic.example',
      'https://cam.example'
    ])
    expect(fx.browser.state.snapshot(fx.win).revokedUnusedPermissions).toHaveLength(2)
  })

  it('the setting off holds the sweep (the stamps still run); switching it on sweeps at once', () => {
    const fx = withStale('https://cam.example')
    fx.command('settings.update', { autoRevokeUnusedPermissions: false })
    expect(fx.browser.state.settings.autoRevokeUnusedPermissions).toBe(false)
    vi.advanceTimersByTime(UNUSED_PERMISSIONS_FIRST_SWEEP_DELAY_MS)
    expect(fx.browser.permissions.revokedUnused()).toEqual([])
    const check = fx.command<SafetyCheckResult>('privacy.safetyCheck')
    expect(check.permissions.revoked).toEqual([])
    // Off, the Safety check still names the stale grant as before.
    expect(check.permissions.review).toEqual([
      { origin: 'https://cam.example', permissions: ['camera'], reason: 'unused' }
    ])
    const tab = fx.browser.tabs.createTab({ url: 'https://cam.example/', active: true }, fx.win)
    fx.navigate(tab.id, 'https://cam.example/')
    expect(stampOf(fx, 'https://cam.example')).toBe(WEEK0)

    vi.setSystemTime(OLD)
    fx.browser.permissions.set('geolocation', 'https://map.example', 'allow')
    vi.setSystemTime(T0)
    fx.command('settings.update', { autoRevokeUnusedPermissions: true })
    expect(fx.browser.permissions.revokedUnused().map((r) => r.origin)).toEqual([
      'https://map.example'
    ])
    // The freshly visited site was not touched.
    expect(stampOf(fx, 'https://cam.example')).toBe(WEEK0)
  })

  it('the Safety check sweeps first and carries the revoked list; the swept site is not flagged as well', () => {
    const fx = fixture()
    vi.setSystemTime(T0 - 130 * DAY)
    fx.browser.permissions.set('camera', 'https://kept.example', 'allow')
    // 65 days on: `kept` is swept and allowed again (kept from the sweep from now on); `cam` is
    // allowed the same day and never visited again.
    vi.setSystemTime(T0 - 65 * DAY)
    expect(fx.browser.permissions.sweepUnused(true).revoked.map((r) => r.origin)).toEqual([
      'https://kept.example'
    ])
    fx.browser.permissions.regrantRevoked('https://kept.example')
    fx.browser.permissions.set('camera', 'https://cam.example', 'allow')
    vi.setSystemTime(T0)
    const check = fx.command<SafetyCheckResult>('privacy.safetyCheck')
    expect(check.permissions.revoked).toEqual([
      { origin: 'https://cam.example', permissions: ['camera'], revokedAt: T0 }
    ])
    expect(check.permissions.grantedSites).toBe(1)
    expect(check.permissions.review).toEqual([
      { origin: 'https://kept.example', permissions: ['camera'], reason: 'unused' }
    ])
    // The row is Chrome's module sentence in the info state while the list holds anything,
    // ahead of the flagged grant's sentence.
    expect(check.permissions.state).toBe('info')
    expect(check.permissions.summary).toBe('Permissions removed from 1 site')
    // Past 30 days the record is gone at the next check, and the row says what the grants say.
    vi.setSystemTime(T0 + REVOKED_PERMISSIONS_KEPT_MS)
    const later = fx.command<SafetyCheckResult>('privacy.safetyCheck')
    expect(later.permissions.revoked).toEqual([])
    expect(later.permissions.summary).toBe(
      '1 site worth a look: unused permissions or several at once'
    )
  })

  it('the row’s sentence counts the revoked sites – "Permissions removed from N sites" – and returns to today’s once they are reviewed', () => {
    const fx = withStale('https://cam.example')
    vi.setSystemTime(OLD)
    fx.browser.permissions.set('geolocation', 'https://cam.example', 'allow')
    fx.browser.permissions.set('midi', 'https://midi.example', 'allow')
    vi.setSystemTime(T0)
    const check = fx.command<SafetyCheckResult>('privacy.safetyCheck')
    expect(check.permissions.revoked.map((r) => r.origin)).toEqual([
      'https://cam.example',
      'https://midi.example'
    ])
    expect(check.permissions).toMatchObject({
      state: 'info',
      summary: 'Permissions removed from 2 sites',
      grantedSites: 0
    })
    // Got it: the list goes, no site holds a permission any more, the row is safe again.
    fx.command('permissions.acknowledgeRevoked')
    expect(fx.command<SafetyCheckResult>('privacy.safetyCheck').permissions).toMatchObject({
      state: 'safe',
      summary: 'No site holds extra permissions',
      revoked: []
    })
    // Allow again on one site: it holds its permission (kept from the sweep) and the row counts it.
    fx.command('permissions.restoreRevokedList', {
      records: check.permissions.revoked.map((r) => ({
        ...r,
        expiresAt: r.revokedAt + REVOKED_PERMISSIONS_KEPT_MS
      }))
    })
    fx.command('permissions.regrantRevoked', { origin: 'https://midi.example' })
    expect(fx.command<SafetyCheckResult>('privacy.safetyCheck').permissions).toMatchObject({
      state: 'info',
      summary: 'Permissions removed from 1 site',
      grantedSites: 1
    })
  })

  it('the review’s commands: Allow again and its undo, Got it and its undo, through the command map', () => {
    const fx = withStale('https://cam.example')
    vi.setSystemTime(OLD)
    fx.browser.permissions.set('geolocation', 'https://cam.example', 'allow')
    fx.browser.permissions.set('midi', 'https://midi.example', 'allow')
    vi.setSystemTime(T0)
    fx.browser.unusedPermissions.run()
    const snapshot = (): RevokedSitePermissions[] =>
      fx.browser.state.snapshot(fx.win).revokedUnusedPermissions
    expect(snapshot().map((r) => r.origin)).toEqual(['https://cam.example', 'https://midi.example'])
    const camRecord = snapshot()[0]!

    vi.setSystemTime(T0 + 3 * DAY)
    fx.command('permissions.regrantRevoked', { origin: 'https://cam.example/page' })
    expect(snapshot().map((r) => r.origin)).toEqual(['https://midi.example'])
    expect(fx.browser.permissions.rules()).toEqual([
      {
        origin: 'https://cam.example',
        permission: 'camera',
        decision: 'allow',
        lastVisitedAt: coarseVisitTime(T0 + 3 * DAY),
        keepGranted: true
      },
      {
        origin: 'https://cam.example',
        permission: 'geolocation',
        decision: 'allow',
        lastVisitedAt: coarseVisitTime(T0 + 3 * DAY),
        keepGranted: true
      }
    ])
    fx.command('permissions.undoRegrantRevoked', { origin: 'https://cam.example' })
    expect(fx.browser.permissions.rules()).toEqual([])
    expect(snapshot()).toEqual([
      camRecord,
      expect.objectContaining({ origin: 'https://midi.example' })
    ])

    const acknowledged = fx.command<RevokedSitePermissions[]>('permissions.acknowledgeRevoked')
    expect(acknowledged.map((r) => r.origin)).toEqual([
      'https://cam.example',
      'https://midi.example'
    ])
    expect(snapshot()).toEqual([])
    expect(fx.browser.permissions.rules()).toEqual([])
    expect(fx.command<RevokedSitePermissions[]>('permissions.acknowledgeRevoked')).toEqual([])

    fx.command('permissions.restoreRevokedList', { records: acknowledged })
    expect(snapshot()).toEqual(acknowledged)
    fx.browser.state.flushSync()
    fx.browser.permissions.flushSync()
    const file = JSON.parse(fx.io.files['permissions.json']!) as { revokedUnused: unknown }
    expect(file.revokedUnused).toEqual(acknowledged)
  })
})
