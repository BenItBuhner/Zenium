// The bundled tables are read from disk the way a host reads them: a test's fixture, not core code.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs'
// eslint-disable-next-line no-restricted-imports
import { fileURLToPath } from 'node:url'
// eslint-disable-next-line no-restricted-imports
import { gunzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../../shared/types'
import type { PrivacyFlags, PrivacySettings } from '../../../shared/privacy'
import { HTTPS_ONLY_PERMISSION, LOOKALIKE_PERMISSION } from '../../../shared/privacy'
import { ON_DEVICE_SITE_DATA_PERMISSION, cookieVerdict } from '../../../shared/siteData'
import { BLANK_URL } from '../../../shared/url'
import { Browser } from '../../browser'
import { BUILTIN_RULE_SETS } from '../../blocking/rules'
import { PrefixTable } from '../../safebrowsing/prefixes'
import type {
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../../platform'
import { ENGAGED_TYPED_VISITS, ENGAGED_VISITS, httpsOnlyRule } from '../service'

/** The tables the build ships, read the way the hosts read them. */
const LOOKALIKE_TABLES: Record<string, string> = Object.fromEntries(
  ['tranco-top', 'confusables'].map((name) => [
    name,
    gunzipSync(
      readFileSync(
        fileURLToPath(new URL(`../../../../resources/lookalikes/${name}.txt.gz`, import.meta.url))
      )
    ).toString('utf8')
  ])
)

/** The tables arrive a tick after start (`loadLookalikeTables` awaits the host). */
async function tablesLoaded(f: Fixture): Promise<void> {
  for (let i = 0; i < 10 && !f.browser.protection.lookalikes.ready; i++)
    await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.browser.protection.lookalikes.ready).toBe(true)
}

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

interface Recorded {
  readonly tabId: string
  readonly events: TabViewEvents
  readonly loads: string[]
  /** The back/forward stack the stub reports; tests fill it in. */
  history: string[]
  jumps: number[]
  /** Commit a navigation to `url` the way a host does after the document loaded. */
  commit(url: string): void
}

interface Fixture {
  browser: Browser
  views: Recorded[]
  applied: PrivacyFlags[]
}

/**
 * `io` shared between two fixtures is a restart: the second reads what the first persisted.
 * `caps` overrides the desktop-like capabilities (`lookalikeHolds: false` is the Android host).
 */
function fixture(io: StoreIO = memoryIo(), caps: Partial<HostCapabilities> = {}): Fixture {
  const views: Recorded[] = []
  const applied: PrivacyFlags[] = []
  const capabilities = stub<HostCapabilities>({
    windows: true,
    updates: false,
    agents: false,
    secureDns: true,
    quitsThroughCore: true,
    lookalikeHolds: true,
    ...caps
  })
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities,
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
      createView: (tab: Tab, events: TabViewEvents) => {
        let url = ''
        const record: Recorded = {
          tabId: tab.id,
          events,
          loads: [],
          history: [],
          jumps: [],
          commit: (next) => {
            url = next
            events.onNavigated(next, false)
          }
        }
        views.push(record)
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          hasDocument: () => url !== '',
          getURL: () => url,
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          loadURL: (u: string) => {
            url = u
            record.loads.push(u)
          },
          navigationEntries: () => ({
            entries: record.history.map((u) => ({ url: u, title: '' })),
            index: record.history.length - 1
          }),
          goToIndex: (index: number) => {
            record.jumps.push(index)
          }
        })
      }
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub(),
    privacy: {
      apply: (flags) => {
        applied.push(flags)
      },
      // The bundled lookalike tables the way a host hands them over (`resources/lookalikes`).
      bundledLookalikeTable: async (name) => LOOKALIKE_TABLES[name] ?? null
    },
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  return { browser, views, applied }
}

function open(f: Fixture, url: string): Recorded {
  const win = f.browser.focusedWindow()
  f.browser.handleCommand(win, 'urlbar.submit', {
    input: url,
    newTab: true,
    tabId: null,
    background: false
  })
  return f.views[f.views.length - 1]
}

function lastLoad(view: Recorded): URL {
  return new URL(view.loads[view.loads.length - 1])
}

/** Change the privacy settings the way the settings page does (`settings.update`). */
function setPrivacy(f: Fixture, patch: Partial<PrivacySettings>): void {
  f.browser.handleCommand(f.browser.focusedWindow(), 'settings.update', {
    privacy: { ...f.browser.state.settings.privacy, ...patch }
  })
}

function httpsOnlySet(f: Fixture): { enabled: boolean; excluded: string[] } {
  const summary = f.browser.blocking.engine
    .listRuleSets()
    .find((s) => s.id === BUILTIN_RULE_SETS.httpsOnly)
  const rules = f.browser.blocking.engine.rulesOf(BUILTIN_RULE_SETS.httpsOnly)
  return {
    enabled: summary?.enabled ?? false,
    excluded: rules?.[0]?.condition.excludedRequestDomains ?? []
  }
}

describe('ProtectionService: the policy the hosts get', () => {
  it('pushes the flags at start and again only when the effective policy changes', () => {
    const f = fixture()
    expect(f.applied).toHaveLength(1)
    expect(f.applied[0]).toMatchObject({
      safeBrowsing: true,
      httpsOnly: 'ask',
      httpsOnlyAllowed: [],
      thirdPartyCookies: 'block-private',
      thirdPartyCookiesPrivate: 'default',
      gpc: false,
      dnt: false,
      secureDnsMode: 'automatic',
      secureDnsServers: []
    })

    setPrivacy(f, {})
    expect(f.applied).toHaveLength(1)

    setPrivacy(f, { gpc: true, dnt: true })
    expect(f.applied).toHaveLength(2)
    expect(f.applied[1]).toMatchObject({ gpc: true, dnt: true })
  })

  it('reports the private switch: on when private contexts block, locked under the global block', () => {
    const f = fixture()
    const status = (): { blocked: boolean; locked: boolean } =>
      f.browser.protection.status().privateThirdPartyCookies
    // The defaults: block-private blocks in private, nothing is locked.
    expect(status()).toEqual({ blocked: true, locked: false })
    expect(
      f.browser.state.snapshot(f.browser.focusedWindow()).privacy.privateThirdPartyCookies
    ).toEqual({
      blocked: true,
      locked: false
    })

    setPrivacy(f, { thirdPartyCookies: 'allow' })
    expect(status()).toEqual({ blocked: false, locked: false })
    setPrivacy(f, { thirdPartyCookiesPrivate: 'block' })
    expect(status()).toEqual({ blocked: true, locked: false })
    setPrivacy(f, { thirdPartyCookies: 'block-private', thirdPartyCookiesPrivate: 'allow' })
    expect(status()).toEqual({ blocked: false, locked: false })

    // The global block wins and locks the switch on, whatever the private choice.
    for (const thirdPartyCookiesPrivate of ['default', 'allow', 'block'] as const) {
      setPrivacy(f, { thirdPartyCookies: 'block', thirdPartyCookiesPrivate })
      expect(status(), thirdPartyCookiesPrivate).toEqual({ blocked: true, locked: true })
    }
    // Back from the global block, the private choice made under it still stands.
    setPrivacy(f, { thirdPartyCookies: 'block-private' })
    expect(status()).toEqual({ blocked: true, locked: false })
    setPrivacy(f, { thirdPartyCookies: 'allow' })
    expect(status()).toEqual({ blocked: true, locked: false })
  })

  it('takes the private switch through privacy.setThirdPartyCookiesPrivate and pushes the flags', () => {
    const io = memoryIo()
    const f = fixture(io)
    const win = f.browser.focusedWindow()
    expect(f.applied).toHaveLength(1)

    f.browser.handleCommand(win, 'privacy.setThirdPartyCookiesPrivate', { mode: 'block' })
    expect(f.browser.state.settings.privacy.thirdPartyCookiesPrivate).toBe('block')
    expect(f.applied).toHaveLength(2)
    expect(f.applied[1]).toMatchObject({
      thirdPartyCookies: 'block-private',
      thirdPartyCookiesPrivate: 'block'
    })
    // The same mode again changes nothing and pushes nothing.
    f.browser.handleCommand(win, 'privacy.setThirdPartyCookiesPrivate', { mode: 'block' })
    expect(f.applied).toHaveLength(2)

    f.browser.handleCommand(win, 'privacy.setThirdPartyCookiesPrivate', { mode: 'allow' })
    expect(f.browser.state.settings.privacy.thirdPartyCookiesPrivate).toBe('allow')
    expect(f.applied[2]).toMatchObject({ thirdPartyCookiesPrivate: 'allow' })
    expect(f.browser.protection.status().privateThirdPartyCookies).toEqual({
      blocked: false,
      locked: false
    })
    // Regular browsing is untouched by any of it.
    expect(f.browser.state.settings.privacy.thirdPartyCookies).toBe('block-private')

    // An unknown mode is refused and changes nothing.
    for (const mode of ['sometimes', 'block-private', '', 7, null, undefined])
      expect(() =>
        f.browser.handleCommand(win, 'privacy.setThirdPartyCookiesPrivate', { mode })
      ).toThrow(/Unknown private third-party cookie mode/)
    expect(f.browser.state.settings.privacy.thirdPartyCookiesPrivate).toBe('allow')
    expect(f.applied).toHaveLength(3)

    f.browser.handleCommand(win, 'privacy.setThirdPartyCookiesPrivate', { mode: 'default' })
    expect(f.applied[3]).toMatchObject({ thirdPartyCookiesPrivate: 'default' })

    // A restart keeps the private choice.
    f.browser.handleCommand(win, 'privacy.setThirdPartyCookiesPrivate', { mode: 'block' })
    f.browser.state.flushSync()
    const restarted = fixture(io)
    expect(restarted.browser.state.settings.privacy.thirdPartyCookiesPrivate).toBe('block')
    expect(restarted.applied[0]).toMatchObject({ thirdPartyCookiesPrivate: 'block' })
  })

  it('resolves the secure DNS provider into templates and falls back to automatic without one', () => {
    const f = fixture()
    setPrivacy(f, { secureDnsMode: 'provider', secureDnsProvider: 'quad9' })
    expect(f.applied[f.applied.length - 1]).toMatchObject({
      secureDnsMode: 'provider',
      secureDnsServers: ['https://dns.quad9.net/dns-query']
    })
    expect(f.browser.protection.status().secureDns).toEqual({
      supported: true,
      mode: 'provider',
      servers: ['https://dns.quad9.net/dns-query']
    })

    setPrivacy(f, { secureDnsProvider: 'custom', secureDnsCustomUrl: 'not a template' })
    expect(f.applied[f.applied.length - 1]).toMatchObject({
      secureDnsMode: 'automatic',
      secureDnsServers: []
    })
  })

  it('folds the On-device site data row into the cookie policy the hosts apply', () => {
    const f = fixture()
    const last = (): PrivacyFlags => f.applied[f.applied.length - 1]
    expect(last().siteData).toEqual({ blockAll: false, allow: [], clearOnExit: [], block: [] })

    // A site the row blocks joins the never list: pushed to the hosts at once, its cookies withheld.
    f.browser.permissions.set(ON_DEVICE_SITE_DATA_PERMISSION, 'https://tracker.example/x', 'deny')
    expect(last().siteData.block).toEqual(['https://tracker.example'])
    expect(cookieVerdict(last().siteData, 'https://tracker.example/pixel')).toBe('blocked')
    expect(cookieVerdict(last().siteData, 'http://tracker.example/pixel')).toBe('default')
    expect(f.browser.siteData.siteState('https://tracker.example/').state).toBe('block')

    // An allowed site joins the allow list; the row's default Block is the policy's block-all.
    f.browser.permissions.set(ON_DEVICE_SITE_DATA_PERMISSION, 'https://shop.example', 'allow')
    f.browser.permissions.chooseDefault(ON_DEVICE_SITE_DATA_PERMISSION, 'deny')
    expect(last().siteData).toMatchObject({
      blockAll: true,
      allow: ['https://shop.example'],
      block: ['https://tracker.example']
    })
    expect(cookieVerdict(last().siteData, 'https://shop.example/cart')).toBe('allowed')
    expect(cookieVerdict(last().siteData, 'https://other.example/')).toBe('blocked')

    // The Cookies-and-site-data lists keep their own say; a site on both stays blocked.
    f.browser.siteData.add('allow', '[*.]tracker.example')
    expect(cookieVerdict(last().siteData, 'https://tracker.example/pixel')).toBe('blocked')
    expect(cookieVerdict(last().siteData, 'https://cdn.tracker.example/pixel')).toBe('allowed')

    // Reset from the site-information sheet: the policy follows.
    f.browser.permissions.chooseDefault(ON_DEVICE_SITE_DATA_PERMISSION, 'allow')
    f.browser.permissions.resetOrigin('https://tracker.example')
    expect(last().siteData).toMatchObject({ blockAll: false, block: [] })
  })
})

describe('ProtectionService: HTTPS-only mode', () => {
  it('keeps the upgrade rule set in the engine, following the mode', () => {
    const f = fixture()
    expect(httpsOnlySet(f)).toEqual({ enabled: true, excluded: [] })
    const decision = f.browser.blocking.engine.decide({
      url: 'http://example.com/page',
      type: 'main_frame',
      method: 'GET'
    })
    expect(decision).toMatchObject({ action: 'upgrade', redirectUrl: 'https://example.com/page' })
    // `ask` leaves subresources alone; `always` upgrades them too.
    expect(
      f.browser.blocking.engine.decide({
        url: 'http://cdn.example.com/a.js',
        type: 'script',
        method: 'GET',
        documentUrl: 'https://example.com/'
      }).action
    ).toBe('allow')

    setPrivacy(f, { httpsOnly: 'always' })
    expect(
      f.browser.blocking.engine.decide({
        url: 'http://cdn.example.com/a.js',
        type: 'script',
        method: 'GET',
        documentUrl: 'https://example.com/'
      })
    ).toMatchObject({ action: 'upgrade', redirectUrl: 'https://cdn.example.com/a.js' })

    setPrivacy(f, { httpsOnly: 'off' })
    expect(httpsOnlySet(f).enabled).toBe(false)
    expect(
      f.browser.blocking.engine.decide({
        url: 'http://example.com/page',
        type: 'main_frame',
        method: 'GET'
      }).action
    ).toBe('allow')
  })

  it('never upgrades non-unique hosts: loopback, private addresses, names without a registrable suffix', () => {
    const f = fixture()
    const exempt = [
      'http://localhost:3000/',
      'http://app.localhost:3000/',
      'http://127.0.0.1/',
      'http://127.5.6.7:8080/',
      'http://[::1]:8080/',
      'http://10.0.0.7/',
      'http://172.20.1.1/',
      'http://192.168.1.1/admin',
      'http://169.254.169.254/latest',
      'http://[fe80::1]/',
      'http://[fd00:1::2]/',
      'http://0.0.0.0:8000/',
      'http://intranet/wiki',
      'http://printer.local/',
      'http://nas.lan/'
    ]
    for (const url of exempt)
      expect(
        f.browser.blocking.engine.decide({ url, type: 'main_frame', method: 'GET' }).action,
        url
      ).toBe('allow')
    // Public hosts and public addresses are upgraded as before.
    for (const url of ['http://example.com/', 'http://8.8.8.8/', 'http://[2606:4700::1111]/'])
      expect(
        f.browser.blocking.engine.decide({ url, type: 'main_frame', method: 'GET' }).action,
        url
      ).toBe('upgrade')

    // `always` mode leaves their subresources alone as well.
    setPrivacy(f, { httpsOnly: 'always' })
    for (const url of exempt)
      expect(
        f.browser.blocking.engine.decide({
          url,
          type: 'image',
          method: 'GET',
          documentUrl: 'https://example.com/'
        }).action,
        url
      ).toBe('allow')

    expect(httpsOnlyRule('always').condition).toMatchObject({
      urlFilter: '|http://',
      excludedNonUniqueHosts: true
    })
    expect(httpsOnlyRule('always').condition.resourceTypes).toBeUndefined()
    expect(httpsOnlyRule('ask').condition.resourceTypes).toEqual(['main_frame'])
    expect(httpsOnlyRule('ask', ['old.example']).condition.excludedRequestDomains).toEqual([
      'old.example'
    ])
  })

  it('never shows the plaintext question for a non-unique host, even after a stale upgrade', () => {
    const f = fixture()
    const view = open(f, 'https://start.example/')
    view.commit('https://start.example/')
    expect(f.browser.protection.allowsPlaintext('http://192.168.1.20/')).toBe(true)
    expect(f.browser.protection.allowsPlaintext('http://[::1]:8080/')).toBe(true)
    expect(f.browser.protection.allowsPlaintext('http://dev.localhost/')).toBe(true)
    expect(f.browser.protection.allowsPlaintext('http://example.com/')).toBe(false)

    // A rule set the host had yet to reload upgraded the address; https failed: the page loads
    // over plaintext without the question, and no exception is recorded for it.
    view.events.onUpgraded('http://192.168.1.20/', 'https://192.168.1.20/')
    view.events.onFailLoad(-102, 'net::ERR_CONNECTION_REFUSED', 'https://192.168.1.20/')
    expect(view.loads[view.loads.length - 1]).toBe('http://192.168.1.20/')
    expect(f.browser.protection.status().httpsOnlySessionExceptions).toEqual([])
    expect(f.browser.protection.status().httpsOnlyExceptions).toEqual([])
  })

  it('asks on the warning page after an engine upgrade fails, then honours the answer at once', () => {
    const f = fixture()
    const view = open(f, 'https://start.example/')
    view.commit('https://start.example/')
    view.history = ['https://start.example/']

    // The host's engine upgraded a link click; https then failed to connect.
    view.events.onUpgraded('http://old.example/news', 'https://old.example/news')
    view.events.onFailLoad(-102, 'net::ERR_CONNECTION_REFUSED', 'https://old.example/news')
    const warning = lastLoad(view)
    expect(warning.protocol).toBe('zen:')
    expect(warning.searchParams.get('kind')).toBe('https-only')
    expect(warning.searchParams.get('url')).toBe('http://old.example/news')
    view.commit(warning.href)
    expect(f.browser.tabs.tab(view.tabId)?.errorCode).toBe(-102)

    // "Back to safety" steps over the entry the failed https load left behind (the upgrade,
    // not the http page the warning names) to the last good page.
    view.history = ['https://start.example/', 'https://old.example/news', warning.href]
    f.browser.handlePageMessage(view.tabId, {
      type: 'interstitial',
      action: 'back',
      url: 'http://old.example/news'
    })
    expect(view.jumps).toEqual([0])
    view.history = ['https://start.example/']

    // "Continue to site" for this session.
    f.browser.handlePageMessage(view.tabId, {
      type: 'interstitial',
      action: 'continue',
      url: 'http://old.example/news'
    })
    expect(view.loads[view.loads.length - 1]).toBe('http://old.example/news')
    expect(f.browser.protection.allowsPlaintext('http://old.example/other')).toBe(true)
    expect(f.browser.protection.allowsPlaintext('http://sub.old.example/')).toBe(true)
    expect(f.browser.protection.allowsPlaintext('http://other.example/')).toBe(false)
    expect(httpsOnlySet(f).excluded).toContain('old.example')
    expect(f.applied[f.applied.length - 1].httpsOnlyAllowed).toEqual(['old.example'])
    expect(f.browser.protection.status().httpsOnlySessionExceptions).toEqual(['old.example'])
    expect(f.browser.protection.status().httpsOnlyExceptions).toEqual([])
    expect(
      f.browser.blocking.engine.decide({
        url: 'http://old.example/next',
        type: 'main_frame',
        method: 'GET'
      }).action
    ).toBe('allow')

    // A later failure of the same site loads plaintext without asking again.
    view.commit('https://start.example/')
    view.events.onUpgraded('http://old.example/more', 'https://old.example/more')
    view.events.onFailLoad(-102, 'net::ERR_CONNECTION_REFUSED', 'https://old.example/more')
    expect(view.loads[view.loads.length - 1]).toBe('http://old.example/more')
  })

  it('stores "always" answers as https-only permissions and forgets them on request', () => {
    const f = fixture()
    const view = open(f, 'https://start.example/')
    view.commit('https://start.example/')
    view.events.onUpgraded('http://legacy.example/', 'https://legacy.example/')
    view.events.onFailLoad(-118, 'net::ERR_CONNECTION_TIMED_OUT', 'https://legacy.example/')
    view.commit(view.loads[view.loads.length - 1])

    f.browser.handlePageMessage(view.tabId, {
      type: 'interstitial',
      action: 'continue-always',
      url: 'http://legacy.example/'
    })
    expect(view.loads[view.loads.length - 1]).toBe('http://legacy.example/')
    expect(f.browser.permissions.get(HTTPS_ONLY_PERMISSION, 'http://legacy.example')).toBe('allow')
    expect(f.browser.protection.status().httpsOnlyExceptions).toEqual(['legacy.example'])
    expect(f.browser.protection.status().httpsOnlySessionExceptions).toEqual([])
    expect(httpsOnlySet(f).excluded).toContain('legacy.example')

    // The site-information sheet's reset goes through the permission store; the policy follows.
    f.browser.permissions.resetOrigin('http://legacy.example')
    expect(f.browser.protection.allowsPlaintext('http://legacy.example/')).toBe(false)
    expect(httpsOnlySet(f).excluded).not.toContain('legacy.example')
    expect(f.applied[f.applied.length - 1].httpsOnlyAllowed).toEqual([])

    f.browser.protection.allowPlaintext('http://legacy.example/', true)
    f.browser.protection.forgetPlaintext('legacy.example')
    expect(
      f.browser.permissions.get(HTTPS_ONLY_PERMISSION, 'http://legacy.example')
    ).toBeUndefined()
  })

  it('falls back to plaintext silently with the mode off, and shows a plain error otherwise', () => {
    const f = fixture()
    setPrivacy(f, { httpsOnly: 'off' })
    const view = open(f, 'https://start.example/')
    view.commit('https://start.example/')
    view.events.onUpgraded('http://old.example/', 'https://old.example/')
    view.events.onFailLoad(-102, 'net::ERR_CONNECTION_REFUSED', 'https://old.example/')
    expect(view.loads[view.loads.length - 1]).toBe('http://old.example/')

    // A failure that is not a connection (or certificate) problem is not a fallback case.
    view.commit('https://start.example/')
    view.events.onUpgraded('http://old.example/', 'https://old.example/')
    view.events.onFailLoad(-321, 'net::ERR_INVALID_RESPONSE', 'https://old.example/')
    const error = lastLoad(view)
    expect(error.protocol).toBe('zen:')
    expect(error.searchParams.get('kind')).toBeNull()
    expect(error.searchParams.get('url')).toBe('https://old.example/')
  })

  it('ignores interstitial answers that do not match the page the tab shows', () => {
    const f = fixture()
    const view = open(f, 'https://start.example/')
    view.commit('https://start.example/')
    // Not on an interstitial at all.
    f.browser.handlePageMessage(view.tabId, {
      type: 'interstitial',
      action: 'continue',
      url: 'http://old.example/'
    })
    expect(f.browser.protection.allowsPlaintext('http://old.example/')).toBe(false)

    view.events.onUpgraded('http://old.example/', 'https://old.example/')
    view.events.onFailLoad(-102, 'net::ERR_CONNECTION_REFUSED', 'https://old.example/')
    view.commit(view.loads[view.loads.length - 1])
    // On the interstitial, but for another URL.
    f.browser.handlePageMessage(view.tabId, {
      type: 'interstitial',
      action: 'continue',
      url: 'http://forged.example/'
    })
    expect(f.browser.protection.allowsPlaintext('http://forged.example/')).toBe(false)
    // A Safe Browsing answer on an HTTPS-only page does nothing.
    f.browser.handlePageMessage(view.tabId, {
      type: 'interstitial',
      action: 'proceed',
      url: 'http://old.example/'
    })
    expect(f.browser.protection.safeBrowsing.isBypassed('http://old.example/')).toBe(false)
    expect(view.loads.filter((u) => u === 'http://old.example/')).toHaveLength(0)
  })
})

describe('ProtectionService: Safe Browsing interstitial', () => {
  it('turns a block the host applied into the warning page and lets the user proceed once bypassed', () => {
    const f = fixture()
    f.browser.protection.safeBrowsing.setTable(
      'urlhaus',
      PrefixTable.fromHosts(['evil.example']),
      1
    )
    const hit = f.browser.protection.safeBrowsing.lookup('http://evil.example/payload')
    expect(hit).toMatchObject({ feedId: 'urlhaus', threat: 'malware' })

    const view = open(f, 'https://start.example/')
    view.commit('https://start.example/')
    view.history = ['https://start.example/']
    view.events.onUnsafeNavigation('http://evil.example/payload', hit!)
    view.events.onFailLoad(-20, 'net::ERR_BLOCKED_BY_CLIENT', 'http://evil.example/payload')
    const warning = lastLoad(view)
    expect(warning.protocol).toBe('zen:')
    expect(warning.searchParams.get('kind')).toBe('safebrowsing')
    expect(warning.searchParams.get('url')).toBe('http://evil.example/payload')
    expect(warning.searchParams.get('threat')).toBe('malware')
    view.commit(warning.href)

    // "Back to safety" returns to the last good entry, never to the blocked page.
    view.history = ['https://start.example/', warning.href]
    f.browser.handlePageMessage(view.tabId, {
      type: 'interstitial',
      action: 'back',
      url: 'http://evil.example/payload'
    })
    expect(view.jumps).toEqual([0])

    // "Proceed anyway" bypasses the host for the session and reloads the page; HTTPS-only
    // mode's upgrade of that reload is covered by the same answer.
    f.browser.handlePageMessage(view.tabId, {
      type: 'interstitial',
      action: 'proceed',
      url: 'http://evil.example/payload'
    })
    expect(f.browser.protection.safeBrowsing.isBypassed('http://evil.example/other')).toBe(true)
    expect(f.browser.protection.safeBrowsing.lookup('http://evil.example/other')).toBeNull()
    expect(f.browser.protection.safeBrowsing.lookup('https://evil.example/payload')).toBeNull()
    expect(view.loads[view.loads.length - 1]).toBe('http://evil.example/payload')
    // The Android guard learns of the bypass from the flags, pushed before the reload.
    expect(f.applied[f.applied.length - 1].safeBrowsingBypassed).toEqual(['evil.example'])
  })

  it('leaves for a blank page when the tab has no history to go back to', () => {
    const f = fixture()
    const view = open(f, 'http://evil.example/')
    const hit = { feedId: 'urlhaus', threat: 'malware', expression: 'evil.example/', remote: false }
    view.events.onUnsafeNavigation('http://evil.example/', hit as never)
    view.events.onFailLoad(-20, 'net::ERR_BLOCKED_BY_CLIENT', 'http://evil.example/')
    view.commit(view.loads[view.loads.length - 1])
    view.history = [view.loads[view.loads.length - 1]]
    f.browser.handlePageMessage(view.tabId, {
      type: 'interstitial',
      action: 'back',
      url: 'http://evil.example/'
    })
    expect(view.jumps).toEqual([])
    expect(view.loads[view.loads.length - 1]).toBe(BLANK_URL)
  })

  it('reports Safe Browsing in the state and reflects the switch', () => {
    const f = fixture()
    expect(f.browser.protection.status().safeBrowsing.enabled).toBe(true)
    setPrivacy(f, { safeBrowsingEnabled: false })
    expect(f.browser.protection.status().safeBrowsing.enabled).toBe(false)
    expect(f.applied[f.applied.length - 1].safeBrowsing).toBe(false)
    f.browser.protection.safeBrowsing.setTable(
      'urlhaus',
      PrefixTable.fromHosts(['evil.example']),
      1
    )
    expect(f.browser.protection.safeBrowsing.lookup('http://evil.example/')).toBeNull()
  })
})

describe('ProtectionService: the lookalike-domain warning (PS-18)', () => {
  const LOOKALIKE = 'https://gogle.com/'

  it('loads the bundled tables once after start, off the boot path, and answers with a verdict', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const f = fixture()
    expect(f.browser.protection.lookalikes.ready).toBe(false)
    await tablesLoaded(f)
    expect(f.browser.protection.lookalikes.topCount).toBe(2000)
    // The boot record's one line: when the tables landed on the core's clock, what the host
    // read and the indexing cost, and the row counts – once per start.
    const confusables = f.browser.protection.lookalikes.confusableCount
    expect(confusables).toBeGreaterThan(0)
    const logged = (): string[] =>
      info.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('[zen] lookalikes:'))
    expect(logged()).toHaveLength(1)
    expect(logged()[0]).toMatch(
      new RegExp(
        `^\\[zen\\] lookalikes: tables loaded at \\+\\d+ ms \\(fetch \\d+ ms, parse \\d+ ms\\): ` +
          `2000 top domains, ${confusables} confusables$`
      )
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(logged()).toHaveLength(1)
    info.mockRestore()
    expect(f.browser.protection.checkLookalike(LOOKALIKE)).toEqual({
      target: 'google.com',
      reason: 'edit-distance',
      source: 'top'
    })
    expect(f.browser.protection.checkLookalike('https://google.com/')).toBeNull()
    // The check sits under the Safe Browsing switch.
    setPrivacy(f, { safeBrowsingEnabled: false })
    expect(f.browser.protection.checkLookalike(LOOKALIKE)).toBeNull()
  })

  it("turns the host engine's hold into the question page before commit and lets the user continue once (desktop)", async () => {
    const io = memoryIo()
    const f = fixture(io)
    await tablesLoaded(f)
    const view = open(f, 'https://start.example/')
    view.commit('https://start.example/')
    view.history = ['https://start.example/']

    // The hold: the engine cancelled the main frame on the core's verdict, the way Safe
    // Browsing's does; the failed load asks for the verdict and shows the question in its place.
    const verdict = f.browser.protection.checkLookalike(LOOKALIKE)!
    view.events.onLookalikeNavigation!(LOOKALIKE, verdict)
    view.events.onFailLoad(-20, 'net::ERR_BLOCKED_BY_CLIENT', LOOKALIKE)
    const warning = lastLoad(view)
    expect(warning.protocol).toBe('zen:')
    expect(warning.searchParams.get('kind')).toBe('lookalike')
    expect(warning.searchParams.get('url')).toBe(LOOKALIKE)
    expect(warning.searchParams.get('target')).toBe('google.com')
    expect(warning.searchParams.get('reason')).toBe('edit-distance')
    expect(warning.searchParams.get('source')).toBe('top')
    view.commit(warning.href)
    expect(f.browser.tabs.tab(view.tabId)!.errorCode).toBe(-20)
    // The verdict was consumed: another failure of the tab is its own.
    expect(f.browser.protection.takePendingLookalike(view.tabId, LOOKALIKE)).toBeNull()

    // Back returns to the last good entry.
    view.history = ['https://start.example/', warning.href]
    f.browser.handlePageMessage(view.tabId, {
      type: 'interstitial',
      action: 'back',
      url: LOOKALIKE
    })
    expect(view.jumps).toEqual([0])

    // "Continue to gogle.com": the host is allowed from now on and the address reloads.
    expect(f.browser.protection.isLookalikeAllowed(LOOKALIKE)).toBe(false)
    f.browser.handlePageMessage(view.tabId, {
      type: 'interstitial',
      action: 'proceed',
      url: LOOKALIKE
    })
    expect(view.loads[view.loads.length - 1]).toBe(LOOKALIKE)
    expect(f.browser.protection.isLookalikeAllowed(LOOKALIKE)).toBe(true)
    expect(f.browser.protection.checkLookalike(LOOKALIKE)).toBeNull()
    expect(f.browser.protection.checkLookalike('https://gogle.com/another')).toBeNull()
    // The allow is written for the host, beside HTTPS-only's in the permission store; the apex
    // covers its subdomains, an allowed subdomain covers no sibling.
    expect(f.browser.permissions.get(LOOKALIKE_PERMISSION, 'https://gogle.com')).toBe('allow')
    expect(f.browser.protection.checkLookalike('https://mail.gogle.com/')).toBeNull()
    f.browser.protection.allowLookalike('https://www.paypa1.com/')
    expect(f.browser.protection.checkLookalike('https://www.paypa1.com/')).toBeNull()
    expect(f.browser.protection.checkLookalike('https://paypa1.com/')).not.toBeNull()
    // A restart keeps the allow: it lives in permissions.json.
    f.browser.permissions.flushSync()
    const restarted = fixture(io)
    await tablesLoaded(restarted)
    expect(restarted.browser.protection.isLookalikeAllowed(LOOKALIKE)).toBe(true)
    expect(restarted.browser.protection.checkLookalike(LOOKALIKE)).toBeNull()
    expect(restarted.browser.protection.checkLookalike('https://paypa1.com/')).not.toBeNull()
  })

  it('takes "Go to google.com" to the site the address looks like, over https, as a typed visit', async () => {
    const f = fixture()
    await tablesLoaded(f)
    const view = open(f, LOOKALIKE)
    const verdict = f.browser.protection.checkLookalike(LOOKALIKE)!
    view.events.onLookalikeNavigation!(LOOKALIKE, verdict)
    view.events.onFailLoad(-20, 'net::ERR_BLOCKED_BY_CLIENT', LOOKALIKE)
    view.commit(lastLoad(view).href)
    f.browser.handlePageMessage(view.tabId, {
      type: 'interstitial',
      action: 'suggested',
      url: LOOKALIKE
    })
    expect(view.loads[view.loads.length - 1]).toBe('https://google.com/')
    // Nothing was allowed by going to the right site.
    expect(f.browser.protection.isLookalikeAllowed(LOOKALIKE)).toBe(false)
    // A stale answer for another address is ignored.
    f.browser.handlePageMessage(view.tabId, {
      type: 'interstitial',
      action: 'proceed',
      url: 'https://paypa1.com/'
    })
    expect(f.browser.protection.isLookalikeAllowed('https://paypa1.com/')).toBe(false)
  })

  it('is quiet for the safe browsing hold, an unrelated failure and an expired or other-URL verdict', async () => {
    const f = fixture()
    await tablesLoaded(f)
    const view = open(f, 'https://start.example/')
    view.commit('https://start.example/')
    // A verdict noted for one address does not explain the failure of another.
    f.browser.protection.notePendingLookalike(view.tabId, LOOKALIKE, {
      target: 'google.com',
      reason: 'edit-distance',
      source: 'top'
    })
    view.events.onFailLoad(-102, 'net::ERR_CONNECTION_REFUSED', 'https://other.example/')
    expect(lastLoad(view).searchParams.get('kind')).toBeNull()
    expect(f.browser.protection.takePendingLookalike(view.tabId, LOOKALIKE)).toBeNull()
  })

  it('never asks about an engaged site, and history drives engagement', async () => {
    const f = fixture()
    await tablesLoaded(f)
    expect(f.browser.protection.checkLookalike(LOOKALIKE)).not.toBeNull()
    // Typed visits to the site make it the user's own.
    for (let i = 0; i < ENGAGED_TYPED_VISITS; i++)
      f.browser.history.visit('https://gogle.com/', 'Gogle', null, { transition: 'typed' })
    expect(f.browser.protection.engaged()).toContain('gogle.com')
    expect(f.browser.protection.checkLookalike(LOOKALIKE)).toBeNull()
    expect(f.browser.protection.checkLookalike('https://www.gogle.com/x')).toBeNull()
    // Plain visits count too, at the higher bar; pages of one site fold together.
    for (let i = 0; i < ENGAGED_VISITS; i++)
      f.browser.history.visit(`https://mybank.example/page${i % 3}`, 'Bank', null)
    expect(f.browser.protection.engaged()).toContain('mybank.example')
    // The engaged site is a target: its neighbour is a lookalike of it, "a site you visit".
    expect(f.browser.protection.checkLookalike('https://mybamk.example/')).toEqual({
      target: 'mybank.example',
      reason: 'edit-distance',
      source: 'engaged'
    })
    // Below the bar nothing changes.
    f.browser.history.visit('https://twice.example/', 'Twice', null, { transition: 'typed' })
    f.browser.history.visit('https://twice.example/', 'Twice', null, { transition: 'typed' })
    expect(f.browser.protection.engaged()).not.toContain('twice.example')
  })

  it('on a host without the hold (Android) turns a browser-asked navigation into the question before any request', async () => {
    const f = fixture(memoryIo(), { lookalikeHolds: false })
    await tablesLoaded(f)
    // Typed into the address bar of a tab: `navigate` loads the question, never the address.
    const view = open(f, 'https://start.example/')
    view.commit('https://start.example/')
    f.browser.handleCommand(f.browser.focusedWindow(), 'urlbar.submit', {
      input: LOOKALIKE,
      newTab: false,
      tabId: view.tabId,
      background: false
    })
    expect(view.loads).toEqual(['https://start.example/', expect.stringMatching(/^zen:/)])
    const warning = lastLoad(view)
    expect(warning.searchParams.get('kind')).toBe('lookalike')
    expect(warning.searchParams.get('url')).toBe(LOOKALIKE)
    expect(warning.searchParams.get('target')).toBe('google.com')
    const tab = f.browser.tabs.tab(view.tabId)!
    expect(tab.url).toBe(warning.href)
    expect(tab.errorCode).toBe(-20)
    view.commit(warning.href)

    // Continue: the allow is written, then the address loads for real.
    f.browser.handlePageMessage(view.tabId, {
      type: 'interstitial',
      action: 'proceed',
      url: LOOKALIKE
    })
    expect(view.loads[view.loads.length - 1]).toBe(LOOKALIKE)
    expect(f.browser.protection.isLookalikeAllowed(LOOKALIKE)).toBe(true)
    // The next visit goes straight through.
    const again = open(f, LOOKALIKE)
    expect(again.loads).toEqual([LOOKALIKE])

    // A new tab opened on a lookalike (a link in a new tab, an intent) is held the same way:
    // its view is created on the question page.
    const fresh = open(f, 'https://paypa1.com/')
    expect(fresh.loads).toHaveLength(1)
    expect(lastLoad(fresh).searchParams.get('kind')).toBe('lookalike')
    expect(lastLoad(fresh).searchParams.get('target')).toBe('paypal.com')
    expect(lastLoad(fresh).searchParams.get('reason')).toBe('skeleton')
    expect(f.browser.tabs.tab(fresh.tabId)!.errorCode).toBe(-20)
  })

  it('on a host without the hold replaces a link or redirect commit with the question, and leaves the desktop commit alone', async () => {
    const android = fixture(memoryIo(), { lookalikeHolds: false })
    await tablesLoaded(android)
    const view = open(android, 'https://start.example/')
    view.commit('https://start.example/')
    // A link took the tab to the lookalike: the host committed it without asking.
    view.commit(LOOKALIKE)
    const warning = lastLoad(view)
    expect(warning.searchParams.get('kind')).toBe('lookalike')
    expect(warning.searchParams.get('url')).toBe(LOOKALIKE)
    expect(android.browser.tabs.tab(view.tabId)!.errorCode).toBe(-20)

    // The desktop's engine held it before commit; a commit is the real page.
    const desktop = fixture()
    await tablesLoaded(desktop)
    const held = open(desktop, 'https://start.example/')
    held.commit('https://start.example/')
    held.commit(LOOKALIKE)
    expect(held.loads).toEqual(['https://start.example/'])
    expect(desktop.browser.tabs.tab(held.tabId)!.url).toBe(LOOKALIKE)
  })

  it('renders the question page for the URL the core builds', async () => {
    const f = fixture()
    await tablesLoaded(f)
    const page = f.browser.protection.lookalikePage('tab', LOOKALIKE, {
      target: 'google.com',
      reason: 'edit-distance',
      source: 'engaged'
    })
    const url = new URL(page)
    expect(url.protocol).toBe('zen:')
    expect(url.searchParams.get('kind')).toBe('lookalike')
    expect(url.searchParams.get('code')).toBe('-20')
    expect(url.searchParams.get('target')).toBe('google.com')
    expect(url.searchParams.get('reason')).toBe('edit-distance')
    expect(url.searchParams.get('source')).toBe('engaged')
  })
})

describe('ProtectionService: the custom resolver check', () => {
  it('asks the resolver one question and refuses one that does not answer', async () => {
    const f = fixture()
    const asked: string[] = []
    let answer: { ok: boolean; status: number; text: string } | Error = {
      ok: true,
      status: 200,
      text: ''
    }
    f.browser.platform.net.fetchText = async (url) => {
      asked.push(url)
      if (answer instanceof Error) throw answer
      return answer
    }
    expect(await f.browser.protection.checkResolver('https://dns.example/dns-query{?dns}')).toEqual(
      { ok: true }
    )
    const probe = new URL(asked[0])
    expect(probe.host).toBe('dns.example')
    expect(probe.pathname).toBe('/dns-query')
    expect(probe.searchParams.get('dns')).toMatch(/^[A-Za-z0-9_-]+$/)

    answer = { ok: false, status: 404, text: '' }
    expect(await f.browser.protection.checkResolver('https://dns.example/nothing')).toEqual({
      ok: false,
      problem: 'The resolver did not answer a DNS-over-HTTPS query at this address (HTTP 404)'
    })
    answer = new Error('ECONNREFUSED')
    expect(await f.browser.protection.checkResolver('https://dns.example/dns-query')).toEqual({
      ok: false,
      problem: 'Zenium could not reach a resolver at this address'
    })
    expect(await f.browser.protection.checkResolver('http://dns.example/dns-query')).toMatchObject({
      ok: false
    })
    expect(asked).toHaveLength(3)
  })
})
