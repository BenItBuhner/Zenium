import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../../shared/types'
import type { PrivacyFlags, PrivacySettings } from '../../../shared/privacy'
import { HTTPS_ONLY_PERMISSION } from '../../../shared/privacy'
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
import { httpsOnlyRule } from '../service'

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

function fixture(): Fixture {
  const views: Recorded[] = []
  const applied: PrivacyFlags[] = []
  const capabilities = stub<HostCapabilities>({
    windows: true,
    updates: false,
    agents: false,
    secureDns: true
  })
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities,
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
      }
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
