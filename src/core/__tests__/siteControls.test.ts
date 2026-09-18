import { describe, expect, it } from 'vitest'
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
  type SafetyCheckResult,
  type Tab
} from '../../shared/types'
import type { SiteInfoSnapshot } from '../../shared/siteInfo'
import { Browser } from '../browser'
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
      { origin: 'https://cam.example', permission: 'camera', decision: 'allow' }
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
    expect(counts.map((c) => c.type)).toEqual(BROWSING_DATA_ADVANCED)
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
    expect(rangeStart('hour', now)).toBe(now - 3_600_000)
    expect(rangeStart('day', now)).toBe(now - 86_400_000)
    expect(rangeStart('week', now)).toBe(now - 7 * 86_400_000)
    expect(rangeStart('month', now)).toBe(now - 28 * 86_400_000)
    expect(rangeStart('all', now)).toBe(0)
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
    lastVisitByOrigin: new Map(),
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
    const rules: PermissionRule[] = [
      { origin: 'https://busy.example', permission: 'camera', decision: 'allow' },
      { origin: 'https://busy.example', permission: 'microphone', decision: 'allow' },
      { origin: 'https://busy.example', permission: 'geolocation', decision: 'allow' },
      { origin: 'https://old.example', permission: 'geolocation', decision: 'allow' },
      { origin: 'https://fine.example', permission: 'camera', decision: 'allow' },
      // Content rows and refusals are not capabilities a site holds.
      { origin: 'https://ads.example', permission: 'popups', decision: 'allow' },
      { origin: 'https://no.example', permission: 'camera', decision: 'deny' }
    ]
    const result = composeSafetyCheck(
      safetyInput({
        now,
        rules,
        lastVisitByOrigin: new Map([
          ['https://old.example', now - UNUSED_PERMISSION_MS - 1],
          ['https://fine.example', now - 1000]
        ])
      })
    )
    expect(result.permissions.state).toBe('info')
    expect(result.permissions.grantedSites).toBe(3)
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
