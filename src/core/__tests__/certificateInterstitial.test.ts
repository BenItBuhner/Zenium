import { describe, expect, it } from 'vitest'
import type {
  CertificateDetails,
  HostCapabilities,
  Platform as PlatformOs,
  Tab
} from '../../shared/types'
import type { InterstitialAction } from '../../shared/interstitial'
import { Browser } from '../browser'
import type {
  Platform,
  SessionHost,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'

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
  /** Documents the core asked the view to load (`loadURL`). */
  readonly loads: string[]
  /** Error pages the core wrote into the failed entry (`showErrorPage`, the desktop's way). */
  readonly shown: string[]
  history: string[]
  jumps: number[]
  backs: number
  commit(url: string): void
}

interface Fixture {
  browser: Browser
  views: Recorded[]
  /** `sessions.allowCertificate` calls: what an engine deciding on its own side is told. */
  mirrored: { containerId: string; url: string; fingerprint: string }[]
}

/**
 * A browser over a stub platform. `inPlace` views offer `showErrorPage` (Electron writes the
 * interstitial into the failed entry); the others get the page loaded as a document of its own
 * (the Android WebView), and `mirror` says whether the platform mirrors exceptions to its engine.
 */
function fixture(opts: { inPlace: boolean; mirror?: boolean }): Fixture {
  const views: Recorded[] = []
  const mirrored: Fixture['mirrored'] = []
  const capabilities = stub<HostCapabilities>({ windows: true, updates: false, agents: false })
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
          shown: [],
          history: [],
          jumps: [],
          backs: 0,
          commit: (next) => {
            url = next
            events.onNavigated(next, false)
          }
        }
        views.push(record)
        // The stub answers every other key with a no-op function: a host without the optional
        // call must present it as absent, not as a function.
        const view: Partial<TabView> = {
          showErrorPage: undefined,
          isDestroyed: () => false,
          isVisible: () => false,
          hasDocument: () => url !== '',
          getURL: () => url,
          getTitle: () => '',
          canGoBack: () => record.history.length > 1,
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
          },
          goBack: () => {
            record.backs++
          }
        }
        if (opts.inPlace) {
          view.showErrorPage = (page: string) => {
            record.shown.push(page)
          }
        }
        return stub<TabView>(view)
      }
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: opts.mirror
      ? stub<SessionHost>({
          allowCertificate: async (containerId, url, fingerprint) => {
            mirrored.push({ containerId, url, fingerprint })
          }
        })
      : stub(),
    app: stub(),
    privacy: { apply: () => undefined },
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  return { browser, views, mirrored }
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

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const EXPIRED = 'https://expired.badssl.com/'
const CERTIFICATE: CertificateDetails = {
  subjectName: '*.badssl.com',
  issuerName: 'COMODO RSA Domain Validation Secure Server CA',
  validStart: 1_427_846_400_000,
  validExpiry: 1_428_883_200_000,
  fingerprint: 'sha256/6vrsUckLNSQnSOaQlHcoKdzhUR9ctSYNeHx0kSVR9gs='
}

function fail(
  view: Recorded,
  url = EXPIRED,
  certificate: CertificateDetails | null = CERTIFICATE
): void {
  view.events.onFailLoad(-201, 'net::ERR_CERT_DATE_INVALID', url, { certificate })
}

function press(f: Fixture, view: Recorded, action: InterstitialAction, url = EXPIRED): void {
  f.browser.handlePageMessage(view.tabId, { type: 'interstitial', action, url })
}

describe('the certificate interstitial in the failed entry (a host with showErrorPage)', () => {
  it('writes the certificate variant of zen://error into the failed entry and keeps the site as the address', () => {
    const f = fixture({ inPlace: true })
    const view = open(f, 'https://start.example/')
    view.commit('https://start.example/')
    view.history = ['https://start.example/']

    f.browser.tabs.navigate(view.tabId, EXPIRED)
    view.history = ['https://start.example/', EXPIRED]
    fail(view)

    // Nothing loaded as a document of its own: the page went into the failed entry.
    expect(view.loads[view.loads.length - 1]).toBe(EXPIRED)
    expect(view.shown).toHaveLength(1)
    const page = new URL(view.shown[0])
    expect(page.protocol).toBe('zen:')
    expect(page.searchParams.get('code')).toBe('-201')
    expect(page.searchParams.get('url')).toBe(EXPIRED)
    expect(JSON.parse(page.searchParams.get('certificate') ?? 'null')).toEqual(CERTIFICATE)

    const tab = f.browser.tabs.tab(view.tabId)
    expect(tab?.url).toBe(EXPIRED)
    expect(tab?.errorCode).toBe(-201)
    expect(tab?.loading).toBe(false)
    expect(tab?.certificateError).toEqual({
      code: -201,
      url: EXPIRED,
      certificate: CERTIFICATE,
      bypassed: false
    })
    // Reload and copy know what the page stands in for; the engine may not go ahead yet.
    expect(f.browser.tabs.errorPageTarget(view.tabId)).toBe(EXPIRED)
    expect(f.browser.tabs.certificateAllowed(view.tabId, EXPIRED, CERTIFICATE.fingerprint)).toBe(
      false
    )
  })

  it('"Back to safety" leaves for the page before the failed one', () => {
    const f = fixture({ inPlace: true })
    const view = open(f, 'https://start.example/')
    view.commit('https://start.example/')
    f.browser.tabs.navigate(view.tabId, EXPIRED)
    view.history = ['https://start.example/', EXPIRED]
    fail(view)

    press(f, view, 'back')
    expect(view.jumps).toEqual([0])
    // The tab is still on the interstitial until the host commits the page before.
    view.commit('https://start.example/')
    const tab = f.browser.tabs.tab(view.tabId)
    expect(tab?.certificateError).toBeNull()
    expect(tab?.errorCode).toBeNull()
    expect(tab?.url).toBe('https://start.example/')
  })

  it('"Proceed" remembers the certificate for the session and asks for the address again, which then reads as not secure', async () => {
    const f = fixture({ inPlace: true })
    const view = open(f, 'https://start.example/')
    view.commit('https://start.example/')
    f.browser.tabs.navigate(view.tabId, EXPIRED)
    view.history = ['https://start.example/', EXPIRED]
    fail(view)

    press(f, view, 'proceed')
    // The engine's next handshake for the site over this certificate goes ahead; no other.
    expect(f.browser.tabs.certificateAllowed(view.tabId, EXPIRED, CERTIFICATE.fingerprint)).toBe(
      true
    )
    expect(
      f.browser.tabs.certificateAllowed(view.tabId, `${EXPIRED}deep/page`, CERTIFICATE.fingerprint)
    ).toBe(true)
    expect(f.browser.tabs.certificateAllowed(view.tabId, EXPIRED, 'sha256/other')).toBe(false)
    expect(
      f.browser.tabs.certificateAllowed(
        view.tabId,
        'https://self-signed.badssl.com/',
        CERTIFICATE.fingerprint
      )
    ).toBe(false)
    expect(f.browser.tabs.certificateAllowed('no-such-tab', EXPIRED, CERTIFICATE.fingerprint)).toBe(
      false
    )
    await flush()
    expect(view.loads[view.loads.length - 1]).toBe(EXPIRED)

    // The page loads over the excepted certificate: the tab says so, and reports not secure.
    view.commit(EXPIRED)
    const tab = f.browser.tabs.tab(view.tabId)
    expect(tab?.errorCode).toBeNull()
    expect(tab?.certificateError).toEqual({
      code: -201,
      url: EXPIRED,
      certificate: CERTIFICATE,
      bypassed: true
    })
    // Not an error page any more: nothing to stand in for.
    expect(f.browser.tabs.errorPageTarget(view.tabId)).toBeNull()
    // Another page of the site this session: the same exception, no interstitial.
    view.commit(`${EXPIRED}about`)
    expect(f.browser.tabs.tab(view.tabId)?.certificateError?.bypassed).toBe(true)
    // A site without one is as secure as ever.
    view.commit('https://start.example/')
    expect(f.browser.tabs.tab(view.tabId)?.certificateError).toBeNull()
    // The interstitial's buttons do nothing once it is gone.
    expect(f.browser.tabs.handleCertificateInterstitial(view.tabId, 'proceed', EXPIRED)).toBe(false)
  })

  it('offers no proceed path for a certificate the host could not describe, and none for other failures', async () => {
    const f = fixture({ inPlace: true })
    const view = open(f, 'https://start.example/')
    view.commit('https://start.example/')
    f.browser.tabs.navigate(view.tabId, EXPIRED)
    view.history = ['https://start.example/', EXPIRED]
    fail(view, EXPIRED, null)
    expect(new URL(view.shown[0]).searchParams.get('certificate')).toBeNull()
    expect(f.browser.tabs.tab(view.tabId)?.certificateError).toMatchObject({ certificate: null })
    const loads = view.loads.length
    press(f, view, 'proceed')
    await flush()
    // Handled (it is the certificate interstitial's button), but nothing to remember: no load.
    expect(view.loads).toHaveLength(loads)
    expect(f.browser.security.certificateExceptions.size).toBe(0)

    // A DNS failure is the plain error page, loaded as its own document, without a certificate error.
    f.browser.tabs.navigate(view.tabId, 'https://nowhere.invalid/')
    view.events.onFailLoad(-105, 'net::ERR_NAME_NOT_RESOLVED', 'https://nowhere.invalid/')
    expect(view.shown).toHaveLength(1)
    const page = new URL(view.loads[view.loads.length - 1])
    expect(page.protocol).toBe('zen:')
    expect(page.searchParams.get('code')).toBe('-105')
    expect(f.browser.tabs.tab(view.tabId)?.certificateError).toBeNull()
    // Its buttons are not this interstitial's.
    expect(
      f.browser.tabs.handleCertificateInterstitial(view.tabId, 'back', 'https://nowhere.invalid/')
    ).toBe(false)
  })

  it('a certificate-range code on a plain http address is no certificate error', () => {
    const f = fixture({ inPlace: true })
    const view = open(f, 'https://start.example/')
    view.commit('https://start.example/')
    f.browser.tabs.navigate(view.tabId, 'http://plain.example/')
    view.events.onFailLoad(-201, 'net::ERR_CERT_DATE_INVALID', 'http://plain.example/', {
      certificate: CERTIFICATE
    })
    expect(view.shown).toHaveLength(0)
    expect(f.browser.tabs.tab(view.tabId)?.certificateError).toBeNull()
    expect(f.browser.tabs.tab(view.tabId)?.errorCode).toBe(-201)
  })

  it('forgets the exceptions of a deleted container and when the cookies are cleared', async () => {
    const f = fixture({ inPlace: true })
    const view = open(f, 'https://start.example/')
    view.commit('https://start.example/')
    f.browser.tabs.navigate(view.tabId, EXPIRED)
    view.history = ['https://start.example/', EXPIRED]
    fail(view)
    press(f, view, 'proceed')
    await flush()
    const tab = f.browser.tabs.tab(view.tabId)
    expect(tab).toBeDefined()
    const exceptions = f.browser.security.certificateExceptions
    expect(exceptions.isAllowed(tab!.containerId, EXPIRED, CERTIFICATE.fingerprint)).toBe(true)

    // Another container's exceptions are its own.
    exceptions.allow('work', EXPIRED, -201, CERTIFICATE)
    f.browser.handleCommand(f.browser.focusedWindow(), 'container.delete', { id: 'work' })
    expect(exceptions.isAllowed('work', EXPIRED, CERTIFICATE.fingerprint)).toBe(false)
    expect(exceptions.isAllowed(tab!.containerId, EXPIRED, CERTIFICATE.fingerprint)).toBe(true)

    // Clearing cookies resets the certificate decisions with them, as Chrome does.
    await f.browser.privacy.clearBrowsingData('all', ['cookies'])
    expect(exceptions.size).toBe(0)
  })
})

describe('the certificate interstitial as a document of its own (a host without showErrorPage)', () => {
  it('loads the certificate variant of zen://error and reads the failure back from its URL', () => {
    const f = fixture({ inPlace: false, mirror: true })
    const view = open(f, 'https://start.example/')
    view.commit('https://start.example/')
    f.browser.tabs.navigate(view.tabId, EXPIRED)
    fail(view)

    const page = view.loads[view.loads.length - 1]
    const params = new URL(page).searchParams
    expect(params.get('url')).toBe(EXPIRED)
    expect(JSON.parse(params.get('certificate') ?? 'null')).toEqual(CERTIFICATE)
    // The tab shows the error page; the failure travels in its URL, so a commit (now, or from
    // history later) restores the certificate error and the interstitial stays actionable.
    view.commit(page)
    const tab = f.browser.tabs.tab(view.tabId)
    expect(tab?.url).toBe(page)
    expect(tab?.certificateError).toEqual({
      code: -201,
      url: EXPIRED,
      certificate: CERTIFICATE,
      bypassed: false
    })
    expect(f.browser.tabs.errorPageTarget(view.tabId)).toBe(EXPIRED)
  })

  it('"Proceed" mirrors the exception to the engine before asking for the address again', async () => {
    const f = fixture({ inPlace: false, mirror: true })
    const view = open(f, 'https://start.example/')
    view.commit('https://start.example/')
    f.browser.tabs.navigate(view.tabId, EXPIRED)
    fail(view)
    const page = view.loads[view.loads.length - 1]
    view.commit(page)

    press(f, view, 'proceed')
    expect(f.mirrored).toEqual([
      { containerId: 'default', url: EXPIRED, fingerprint: CERTIFICATE.fingerprint }
    ])
    // Not before the engine has it.
    expect(view.loads[view.loads.length - 1]).toBe(page)
    await flush()
    expect(view.loads[view.loads.length - 1]).toBe(EXPIRED)
    view.commit(EXPIRED)
    expect(f.browser.tabs.tab(view.tabId)?.certificateError?.bypassed).toBe(true)
  })

  it('"Back to safety" steps back over the refused navigation when the snapshot is the error page alone', () => {
    const f = fixture({ inPlace: false })
    const view = open(f, 'https://start.example/')
    view.commit('https://start.example/')
    f.browser.tabs.navigate(view.tabId, EXPIRED)
    fail(view)
    const page = view.loads[view.loads.length - 1]
    view.commit(page)
    // The page before and the core's page: back lands on the former.
    view.history = ['https://start.example/', page]
    press(f, view, 'back')
    expect(view.jumps).toEqual([0])
  })
})
