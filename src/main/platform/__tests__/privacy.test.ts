import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Decision, RequestContext } from '../../../core/blocking/rules'
import type { PrivacyFlags, SafeBrowsingHit } from '../../../shared/privacy'
import { DEFAULT_SITE_DATA_POLICY } from '../../../shared/siteData'
import type {
  ElectronPrivacy as PrivacyHostImpl,
  HostResolverConfigurator,
  RequestTab,
  SafeBrowsingLookup
} from '../privacy'
import type { HostRequest, WebRequestBase } from '../webRequest'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/nowhere',
    configureHostResolver: () => {
      throw new Error('the test injects its own configurator')
    }
  },
  ipcMain: { on: () => undefined }
}))

const { ElectronPrivacy, PrivacyRequestHandler, SafeBrowsingHandler } = await import('../privacy')
const { HANDLER_ORDER } = await import('../webRequest')

const FLAGS: PrivacyFlags = {
  safeBrowsing: true,
  safeBrowsingBypassed: [],
  httpsOnly: 'ask',
  httpsOnlyAllowed: [],
  thirdPartyCookies: 'block',
  thirdPartyCookiesPrivate: 'default',
  thirdPartyCookieExceptions: [],
  gpc: false,
  dnt: false,
  secureDnsMode: 'automatic',
  secureDnsServers: [],
  siteData: DEFAULT_SITE_DATA_POLICY
}

const HIT: SafeBrowsingHit = {
  feedId: 'urlhaus',
  threat: 'malware',
  expression: 'evil.example',
  remote: false
}

function request(ctx: Partial<RequestContext> & { url: string }, tabId = 'tab-1'): HostRequest {
  const full: RequestContext = { type: 'main_frame', method: 'GET', ...ctx }
  const base: WebRequestBase = {
    requestId: '1',
    url: full.url,
    method: full.method,
    resourceType: full.type,
    frameId: full.type === 'main_frame' ? 0 : 7,
    parentFrameId: full.type === 'main_frame' ? -1 : 0,
    tabId,
    partition: 'default',
    initiator: full.initiator ?? null,
    documentUrl: full.documentUrl ?? null,
    timestamp: 0
  }
  return { ctx: full, containerId: 'default', tabId, base, state: new Map() }
}

/** The tabs the handlers report to, remembering what they were told. */
class FakeTabs {
  upgraded: Array<[string, string, string]> = []
  unsafe: Array<[string, string, SafeBrowsingHit]> = []
  viewForTab(tabId: string): RequestTab | undefined {
    if (tabId === 'gone') return undefined
    return {
      noteUpgraded: (from: string, to: string) => void this.upgraded.push([tabId, from, to]),
      noteUnsafeNavigation: (url: string, hit: SafeBrowsingHit) =>
        void this.unsafe.push([tabId, url, hit])
    }
  }
}

const listing = (hosts: string[]): SafeBrowsingLookup => ({
  lookup: (url: string): SafeBrowsingHit | null =>
    hosts.some((h) => new URL(url).hostname === h) ? HIT : null
})

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('SafeBrowsingHandler', () => {
  it('runs first and refuses the documents and frames the tables list, telling the tab', () => {
    const tabs = new FakeTabs()
    const handler = new SafeBrowsingHandler(listing(['evil.example']), tabs)
    expect(handler.order).toBe(HANDLER_ORDER.safeBrowsing)
    expect(handler.order).toBeLessThan(HANDLER_ORDER.ruleEngine)

    expect(handler.onBeforeRequest(request({ url: 'https://evil.example/login' }))).toEqual({
      cancel: true
    })
    expect(tabs.unsafe).toEqual([['tab-1', 'https://evil.example/login', HIT]])

    // A frame is refused too, but only a navigation becomes the tab's warning page.
    expect(
      handler.onBeforeRequest(
        request({
          url: 'https://evil.example/frame',
          type: 'sub_frame',
          documentUrl: 'https://a.example/'
        })
      )
    ).toEqual({ cancel: true })
    expect(tabs.unsafe).toHaveLength(1)
  })

  it('leaves subresources and unlisted pages to the rules, and copes with a tab that is gone', () => {
    const tabs = new FakeTabs()
    const handler = new SafeBrowsingHandler(listing(['evil.example']), tabs)
    expect(
      handler.onBeforeRequest(request({ url: 'https://evil.example/a.js', type: 'script' }))
    ).toBeUndefined()
    expect(handler.onBeforeRequest(request({ url: 'https://fine.example/' }))).toBeUndefined()
    expect(handler.onBeforeRequest(request({ url: 'https://evil.example/' }, 'gone'))).toEqual({
      cancel: true
    })
    expect(tabs.unsafe).toEqual([])
  })
})

describe('PrivacyRequestHandler', () => {
  const thirdParty = (extra: Partial<RequestContext> = {}): HostRequest =>
    request({
      url: 'https://tracker.example/pixel',
      type: 'image',
      documentUrl: 'https://news.example/story',
      ...extra
    })

  it('drops the cookies of third-party requests where the policy blocks them, either way', () => {
    const handler = new PrivacyRequestHandler(() => FLAGS)
    expect(handler.order).toBe(HANDLER_ORDER.privacy)
    expect(handler.order).toBeGreaterThan(HANDLER_ORDER.ruleEngine)

    const sent = { cookie: 'id=1', Accept: '*/*' }
    handler.onBeforeSendHeaders(thirdParty(), sent)
    expect(sent).toEqual({ Accept: '*/*' })

    const received = { 'set-cookie': ['id=2'], 'Content-Type': ['image/gif'] }
    handler.onHeadersReceived(thirdParty(), received)
    expect(received).toEqual({ 'Content-Type': ['image/gif'] })
  })

  it('keeps the cookies of first-party requests, excepted sites, private-only mode in a normal window, and non-http schemes', () => {
    const cases: Array<[PrivacyFlags, HostRequest]> = [
      [
        FLAGS,
        request({
          url: 'https://news.example/api',
          type: 'xmlhttprequest',
          documentUrl: 'https://news.example/'
        })
      ],
      [FLAGS, request({ url: 'https://news.example/' })],
      [{ ...FLAGS, thirdPartyCookieExceptions: ['tracker.example'] }, thirdParty()],
      [{ ...FLAGS, thirdPartyCookies: 'block-private' }, thirdParty({ isPrivate: false })],
      [{ ...FLAGS, thirdPartyCookies: 'allow' }, thirdParty({ isPrivate: true })],
      // The private override never reaches a normal window, and `allow` lifts block-private there.
      [
        { ...FLAGS, thirdPartyCookies: 'allow', thirdPartyCookiesPrivate: 'block' },
        thirdParty({ isPrivate: false })
      ],
      [
        { ...FLAGS, thirdPartyCookies: 'block-private', thirdPartyCookiesPrivate: 'allow' },
        thirdParty({ isPrivate: true })
      ],
      [FLAGS, thirdParty({ url: 'chrome-extension://abc/pixel.png' })]
    ]
    for (const [flags, req] of cases) {
      const handler = new PrivacyRequestHandler(() => flags)
      const sent = { Cookie: 'id=1' }
      handler.onBeforeSendHeaders(req, sent)
      expect(sent, req.ctx.url).toEqual({ Cookie: 'id=1' })
      const received = { 'Set-Cookie': ['id=2'] }
      handler.onHeadersReceived(req, received)
      expect(received, req.ctx.url).toEqual({ 'Set-Cookie': ['id=2'] })
    }
    // block-private does bite in a private window, and so does a private `block` over `allow`.
    for (const flags of [
      { ...FLAGS, thirdPartyCookies: 'block-private' as const },
      { ...FLAGS, thirdPartyCookies: 'allow' as const, thirdPartyCookiesPrivate: 'block' as const }
    ]) {
      const handler = new PrivacyRequestHandler(() => flags)
      const sent = { Cookie: 'id=1' }
      handler.onBeforeSendHeaders(thirdParty({ isPrivate: true }), sent)
      expect(sent, flags.thirdPartyCookiesPrivate).toEqual({})
      const received = { 'Set-Cookie': ['id=2'] }
      handler.onHeadersReceived(thirdParty({ isPrivate: true }), received)
      expect(received, flags.thirdPartyCookiesPrivate).toEqual({})
    }
  })

  it('adds Sec-GPC and DNT to every http(s) and ws(s) request while the signals are on, replacing what a page set', () => {
    const handler = new PrivacyRequestHandler(() => ({ ...FLAGS, gpc: true, dnt: true }))
    const sent = { dnt: '0' }
    handler.onBeforeSendHeaders(request({ url: 'https://news.example/' }), sent)
    expect(sent).toEqual({ 'Sec-GPC': '1', DNT: '1' })

    const socket: Record<string, string> = {}
    handler.onBeforeSendHeaders(
      request({ url: 'wss://news.example/live', type: 'websocket' }),
      socket
    )
    expect(socket).toEqual({ 'Sec-GPC': '1', DNT: '1' })

    const gpcOnly = new PrivacyRequestHandler(() => ({ ...FLAGS, gpc: true }))
    const one: Record<string, string> = {}
    gpcOnly.onBeforeSendHeaders(request({ url: 'http://news.example/' }), one)
    expect(one).toEqual({ 'Sec-GPC': '1' })
  })

  it('does nothing before the core has pushed a policy', () => {
    const handler = new PrivacyRequestHandler(() => null)
    const sent = { Cookie: 'id=1' }
    handler.onBeforeSendHeaders(thirdParty(), sent)
    expect(sent).toEqual({ Cookie: 'id=1' })
  })
})

describe('ElectronPrivacy', () => {
  function host(configure: HostResolverConfigurator = () => undefined): {
    privacy: PrivacyHostImpl
    tabs: FakeTabs
    dir: string
  } {
    const dir = mkdtempSync(join(tmpdir(), 'zenium-privacy-'))
    dirs.push(dir)
    const tabs = new FakeTabs()
    const privacy = new ElectronPrivacy(tabs, listing([]), dir, configure)
    return { privacy, tabs, dir }
  }

  it('configures the host resolver from the flags, once per distinct configuration, and survives a refusal', () => {
    const applied: Electron.ConfigureHostResolverOptions[] = []
    const { privacy } = host((o) => {
      applied.push(o)
      if (o.secureDnsMode === 'off') throw new Error('not now')
    })
    expect(privacy.current).toBeNull()

    privacy.apply(FLAGS)
    privacy.apply({ ...FLAGS, gpc: true })
    expect(applied).toEqual([{ secureDnsMode: 'automatic', secureDnsServers: [] }])
    expect(privacy.current?.gpc).toBe(true)

    // `provider` is Chromium's `secure` mode with the provider's templates.
    privacy.apply({
      ...FLAGS,
      secureDnsMode: 'provider',
      secureDnsServers: ['https://cloudflare-dns.com/dns-query']
    })
    expect(applied[1]).toEqual({
      secureDnsMode: 'secure',
      secureDnsServers: ['https://cloudflare-dns.com/dns-query']
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    privacy.apply({ ...FLAGS, secureDnsMode: 'off' })
    expect(applied).toHaveLength(3)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('exposes the navigator signals the preload asks for, both off before the first policy', () => {
    const { privacy } = host()
    expect(privacy.signals()).toEqual({ gpc: false, dnt: false })
    privacy.apply({ ...FLAGS, gpc: true })
    expect(privacy.signals()).toEqual({ gpc: true, dnt: false })
  })

  it('reads a bundled feed document by id and refuses ids that are not plain feed names', async () => {
    const { privacy, dir } = host()
    writeFileSync(join(dir, 'urlhaus.json'), '{"id":"urlhaus"}')
    expect(await privacy.bundledSafeBrowsingFeed('urlhaus')).toBe('{"id":"urlhaus"}')
    expect(await privacy.bundledSafeBrowsingFeed('phishing-database')).toBeNull()
    expect(await privacy.bundledSafeBrowsingFeed('../package')).toBeNull()
    expect(await privacy.bundledSafeBrowsingFeed('URLhaus')).toBeNull()
  })

  it('reports main-frame upgrades of the HTTPS-only rule set to their tab and no other decision', () => {
    const { privacy, tabs } = host()
    const base = request({ url: 'http://old.example/news' }).base
    const upgrade: Decision = {
      action: 'upgrade',
      redirectUrl: 'https://old.example/news',
      matched: { setId: 'builtin:https-only', ruleId: 1 }
    }
    privacy.observeDecision(base, upgrade)
    expect(tabs.upgraded).toEqual([
      ['tab-1', 'http://old.example/news', 'https://old.example/news']
    ])

    privacy.observeDecision(base, { ...upgrade, matched: { setId: 'builtin:easylist', ruleId: 1 } })
    privacy.observeDecision({ ...base, resourceType: 'image' }, upgrade)
    privacy.observeDecision({ ...base, tabId: null }, upgrade)
    privacy.observeDecision(base, { action: 'block', matched: upgrade.matched })
    expect(tabs.upgraded).toHaveLength(1)
  })

  it('hands out the two handlers in multiplexer order', () => {
    const { privacy } = host()
    expect(privacy.handlers().map((h) => [h.id, h.order])).toEqual([
      ['safe-browsing', HANDLER_ORDER.safeBrowsing],
      ['privacy', HANDLER_ORDER.privacy]
    ])
  })
})
