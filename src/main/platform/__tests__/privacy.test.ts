import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Decision, RequestContext } from '../../../core/blocking/rules'
import type {
  LookalikeVerdict,
  PreloadPagesLevel,
  PrivacyFlags,
  SafeBrowsingHit
} from '../../../shared/privacy'
import { DEFAULT_SITE_DATA_POLICY } from '../../../shared/siteData'
import type {
  ElectronPrivacy as PrivacyHostImpl,
  HostResolverConfigurator,
  RequestTab,
  SafeBrowsingLookup
} from '../privacy'
import type { HostRequest, RequestHandler, WebRequestBase } from '../webRequest'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/nowhere',
    configureHostResolver: () => {
      throw new Error('the test injects its own configurator')
    }
  },
  ipcMain: { on: () => undefined }
}))

const {
  ElectronPrivacy,
  LookalikeHandler,
  PreloadHandler,
  PrivacyRequestHandler,
  SafeBrowsingHandler
} = await import('../privacy')
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
  preloadPages: 'standard',
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
  lookalikes: Array<[string, string, LookalikeVerdict]> = []
  viewForTab(tabId: string): RequestTab | undefined {
    if (tabId === 'gone') return undefined
    return {
      noteUpgraded: (from: string, to: string) => void this.upgraded.push([tabId, from, to]),
      noteUnsafeNavigation: (url: string, hit: SafeBrowsingHit) =>
        void this.unsafe.push([tabId, url, hit]),
      noteLookalikeNavigation: (url: string, verdict: LookalikeVerdict) =>
        void this.lookalikes.push([tabId, url, verdict])
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

describe('LookalikeHandler', () => {
  const VERDICT: LookalikeVerdict = { target: 'google.com', reason: 'edit-distance', source: 'top' }
  const asking = (): {
    lookup: { check: (url: string) => LookalikeVerdict | null }
    asked: string[]
  } => {
    const asked: string[] = []
    return {
      asked,
      lookup: {
        check: (url: string) => {
          asked.push(url)
          return new URL(url).hostname === 'gogle.com' ? VERDICT : null
        }
      }
    }
  }

  it("runs after Safe Browsing and before the rules, holds a lookalike document on the core's verdict and tells the tab", () => {
    const tabs = new FakeTabs()
    const { lookup, asked } = asking()
    const handler = new LookalikeHandler(lookup, tabs)
    expect(handler.order).toBe(HANDLER_ORDER.lookalike)
    expect(handler.order).toBeGreaterThan(HANDLER_ORDER.safeBrowsing)
    expect(handler.order).toBeLessThan(HANDLER_ORDER.ruleEngine)

    expect(handler.onBeforeRequest(request({ url: 'https://gogle.com/' }))).toEqual({
      cancel: true
    })
    expect(tabs.lookalikes).toEqual([['tab-1', 'https://gogle.com/', VERDICT]])
    expect(asked).toEqual(['https://gogle.com/'])
  })

  it('asks the core about documents of tabs alone: never a frame, a subresource or a tabless request', () => {
    const tabs = new FakeTabs()
    const { lookup, asked } = asking()
    const handler = new LookalikeHandler(lookup, tabs)
    expect(
      handler.onBeforeRequest(
        request({
          url: 'https://gogle.com/frame',
          type: 'sub_frame',
          documentUrl: 'https://a.example/'
        })
      )
    ).toBeUndefined()
    expect(
      handler.onBeforeRequest(request({ url: 'https://gogle.com/a.js', type: 'script' }))
    ).toBeUndefined()
    expect(handler.onBeforeRequest(request({ url: 'https://gogle.com/' }, 'gone'))).toBeUndefined()
    expect(handler.onBeforeRequest(request({ url: 'https://fine.example/' }))).toBeUndefined()
    expect(asked).toEqual(['https://fine.example/'])
    expect(tabs.lookalikes).toEqual([])
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

  /** The headers of `req` after both stages, given `flags`. */
  const afterBothStages = (
    flags: PrivacyFlags,
    req: HostRequest
  ): { sent: Record<string, string>; received: Record<string, string[]> } => {
    const handler = new PrivacyRequestHandler(() => flags)
    const sent: Record<string, string> = { Cookie: 'id=1', Accept: '*/*' }
    handler.onBeforeSendHeaders(req, sent)
    const received: Record<string, string[]> = {
      'Set-Cookie': ['id=2'],
      'Content-Type': ['text/html']
    }
    handler.onHeadersReceived(req, received)
    return { sent, received }
  }
  const stripped = { sent: { Accept: '*/*' }, received: { 'Content-Type': ['text/html'] } }
  const intact = {
    sent: { Cookie: 'id=1', Accept: '*/*' },
    received: { 'Set-Cookie': ['id=2'], 'Content-Type': ['text/html'] }
  }

  it("strips Cookie and Set-Cookie from every request of a never-site, the document's own included", () => {
    const flags: PrivacyFlags = {
      ...FLAGS,
      thirdPartyCookies: 'allow',
      siteData: { ...DEFAULT_SITE_DATA_POLICY, block: ['[*.]never.example'] }
    }
    expect(afterBothStages(flags, request({ url: 'https://never.example/' }))).toEqual(stripped)
    expect(
      afterBothStages(
        flags,
        request({
          url: 'https://api.never.example/me',
          type: 'xmlhttprequest',
          documentUrl: 'https://never.example/'
        })
      )
    ).toEqual(stripped)
    expect(
      afterBothStages(
        flags,
        request({
          url: 'https://never.example/embed',
          type: 'sub_frame',
          documentUrl: 'https://news.example/'
        })
      )
    ).toEqual(stripped)
    // The site next to it is untouched.
    expect(afterBothStages(flags, request({ url: 'https://news.example/' }))).toEqual(intact)
  })

  it("leaves an allow-listed site's cookies alone even as a third party the mode would block", () => {
    const flags: PrivacyFlags = {
      ...FLAGS,
      siteData: { ...DEFAULT_SITE_DATA_POLICY, allow: ['[*.]widgets.example'] }
    }
    expect(
      afterBothStages(flags, thirdParty({ url: 'https://cdn.widgets.example/embed.js' }))
    ).toEqual(intact)
    // The page on the list does not carry its trackers along.
    const page: PrivacyFlags = {
      ...FLAGS,
      siteData: { ...DEFAULT_SITE_DATA_POLICY, allow: ['[*.]news.example'] }
    }
    expect(afterBothStages(page, thirdParty())).toEqual(stripped)
  })

  it('under "block all cookies" strips every site the lists leave out and no listed one', () => {
    const flags: PrivacyFlags = {
      ...FLAGS,
      thirdPartyCookies: 'allow',
      siteData: {
        ...DEFAULT_SITE_DATA_POLICY,
        blockAll: true,
        allow: ['bank.example'],
        clearOnExit: ['[*.]shop.example']
      }
    }
    expect(afterBothStages(flags, request({ url: 'https://news.example/' }))).toEqual(stripped)
    expect(afterBothStages(flags, request({ url: 'https://bank.example/' }))).toEqual(intact)
    expect(afterBothStages(flags, request({ url: 'https://www.bank.example/' }))).toEqual(stripped)
    expect(afterBothStages(flags, request({ url: 'https://cart.shop.example/' }))).toEqual(intact)
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

  it("turns navigator's Do Not Track on for an extension's value too, per kind of window (the preload's IPC asking for the sender's), the user's setting still winning when on", async () => {
    let handler: ((event: { sender: unknown; returnValue?: unknown }) => void) | undefined
    const electron = await import('electron')
    const on = vi.spyOn(electron.ipcMain, 'on').mockImplementation(((
      channel: string,
      listener: typeof handler
    ) => {
      if (channel === 'zen:privacy-signals') handler = listener
      return electron.ipcMain
    }) as typeof electron.ipcMain.on)
    const { privacy } = host()
    privacy.apply(FLAGS)
    // Before the extension layer is attached: the user's setting alone, whatever the window.
    expect(privacy.signals(true)).toEqual({ gpc: false, dnt: false })

    // An extension holding `privacy` turned Do Not Track on for normal windows only (it is not
    // allowed in private ones): the page of a normal tab says so, a private tab's does not.
    const values = new Map<boolean, boolean>([
      [false, true],
      [true, false]
    ])
    privacy.attachExtensionSignals(
      { doNotTrack: (privateWindow) => values.get(privateWindow) === true },
      (sender) => {
        const s = sender as unknown as { private?: boolean }
        if (s.private === undefined) throw new Error('gone')
        return s.private
      }
    )
    expect(privacy.signals(false)).toEqual({ gpc: false, dnt: true })
    expect(privacy.signals(true)).toEqual({ gpc: false, dnt: false })
    expect(privacy.signals()).toEqual({ gpc: false, dnt: true })

    // The preload's IPC answers for the sender's kind of window; a sender the lookup cannot
    // place (a page window's, a destroyed one) reads as a normal window's.
    privacy.attach({
      multiplexer: { register: () => undefined },
      onDecision: () => undefined
    } as unknown as Parameters<PrivacyHostImpl['attach']>[0])
    expect(handler).toBeDefined()
    const ask = (sender: unknown): unknown => {
      const event = { sender, returnValue: undefined as unknown }
      handler?.(event)
      return event.returnValue
    }
    expect(ask({ private: false })).toEqual({ gpc: false, dnt: true })
    expect(ask({ private: true })).toEqual({ gpc: false, dnt: false })
    expect(ask({})).toEqual({ gpc: false, dnt: true })

    // The user's own setting keeps the signal on where the extension's value is off.
    privacy.apply({ ...FLAGS, dnt: true })
    expect(ask({ private: true })).toEqual({ gpc: false, dnt: true })
    expect(privacy.signals(false)).toEqual({ gpc: false, dnt: true })

    // The extension's value gone (cleared, or the extension unloaded) leaves the user's alone.
    values.set(false, false)
    privacy.apply(FLAGS)
    expect(ask({ private: false })).toEqual({ gpc: false, dnt: false })
    on.mockRestore()
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

  it('hands out the three handlers in multiplexer order', () => {
    const { privacy } = host()
    expect(privacy.handlers().map((h) => [h.id, h.order])).toEqual([
      ['safe-browsing', HANDLER_ORDER.safeBrowsing],
      ['preload', HANDLER_ORDER.preload],
      ['privacy', HANDLER_ORDER.privacy]
    ])
  })
})

describe('PreloadHandler (Preload pages, PS-43)', () => {
  // What Electron 44 / Chromium 152 put on the wire, measured against a loopback server: the
  // link prefetch is `other` with `Sec-Purpose: prefetch`; a speculation-rules prefetch and the
  // prefetch a prerender starts with are `mainFrame` with `prefetch` / `prefetch;prerender`.
  const linkPrefetch = (): [HostRequest, Record<string, string>] => [
    request({ url: 'http://127.0.0.1:8080/link-prefetch.js', type: 'other' }),
    { 'Sec-Purpose': 'prefetch', 'Sec-Fetch-Dest': 'empty', Accept: '*/*' }
  ]
  const rulesPrefetch = (): [HostRequest, Record<string, string>] => [
    request({ url: 'https://news.example/next' }),
    { 'Sec-Purpose': 'prefetch', 'Sec-Fetch-Dest': 'document' }
  ]
  const rulesPrerender = (): [HostRequest, Record<string, string>] => [
    request({ url: 'https://news.example/after' }),
    { 'sec-purpose': 'prefetch;prerender', 'Sec-Fetch-Dest': 'document' }
  ]
  const navigation = (): [HostRequest, Record<string, string>] => [
    request({ url: 'https://news.example/' }),
    { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' }
  ]
  const beacon = (): [HostRequest, Record<string, string>] => [
    request({ url: 'https://news.example/beacon', type: 'other' }),
    { 'Sec-Fetch-Dest': 'empty', 'Content-Type': 'text/plain' }
  ]

  it('sits between the lookalike check and the rule engine, a header stage', () => {
    const handler = new PreloadHandler(() => FLAGS)
    expect(handler.order).toBe(HANDLER_ORDER.preload)
    expect(handler.order).toBeGreaterThan(HANDLER_ORDER.lookalike)
    expect(handler.order).toBeLessThan(HANDLER_ORDER.ruleEngine)
    expect((handler as RequestHandler).onBeforeRequest).toBeUndefined()
  })

  it('refuses every speculative load under "none" – link prefetch, speculation-rules prefetch, the prefetch of a prerender – and nothing else', () => {
    const handler = new PreloadHandler(() => ({ ...FLAGS, preloadPages: 'none' }))
    for (const [req, headers] of [linkPrefetch(), rulesPrefetch(), rulesPrerender()])
      expect(handler.onBeforeSendHeaders(req, headers), req.ctx.url).toEqual({ cancel: true })
    for (const [req, headers] of [navigation(), beacon()])
      expect(handler.onBeforeSendHeaders(req, headers), req.ctx.url).toBeUndefined()
    // A page cannot forge the header, but a scheme the engine does not govern is left alone.
    expect(
      handler.onBeforeSendHeaders(
        request({ url: 'chrome-extension://abc/next.js', type: 'other' }),
        { 'Sec-Purpose': 'prefetch' }
      )
    ).toBeUndefined()
  })

  it('is the whole of "none": the fetch every prerender starts with (Sec-Purpose: prefetch;prerender) is refused, so no prerender activates – live at the level the core last pushed, with no startup switch behind it', () => {
    // The #522 addendum of 06:02: no `Prerender2` switch under `none` (`deriveStartupProfile`
    // puts none on), so a change of level needs no relaunch – the next request meets the level
    // the core pushed last, both ways.
    let level: PreloadPagesLevel = 'none'
    const handler = new PreloadHandler(() => ({ ...FLAGS, preloadPages: level }))
    expect(handler.onBeforeSendHeaders(...rulesPrerender())).toEqual({ cancel: true })
    level = 'standard'
    expect(handler.onBeforeSendHeaders(...rulesPrerender())).toBeUndefined()
    level = 'none'
    expect(handler.onBeforeSendHeaders(...rulesPrerender())).toEqual({ cancel: true })
  })

  it('refuses nothing under "standard" or "extended", nor before the core has pushed a policy', () => {
    for (const flags of [FLAGS, { ...FLAGS, preloadPages: 'extended' as const }, null]) {
      const handler = new PreloadHandler(() => flags)
      for (const [req, headers] of [linkPrefetch(), rulesPrefetch(), rulesPrerender()])
        expect(handler.onBeforeSendHeaders(req, headers), req.ctx.url).toBeUndefined()
    }
  })

  it("is one of the host's handlers, at the level the core last pushed", () => {
    const host = new ElectronPrivacy(
      { viewForTab: () => undefined },
      { lookup: () => null },
      '/nowhere',
      () => undefined
    )
    const handler = host.handlers().find((h) => h.id === 'preload')
    expect(handler).toBeDefined()
    const [req, headers] = linkPrefetch()
    expect(handler!.onBeforeSendHeaders!(req, headers, {} as never)).toBeUndefined()
    host.apply({ ...FLAGS, preloadPages: 'none' })
    expect(handler!.onBeforeSendHeaders!(req, headers, {} as never)).toEqual({ cancel: true })
    host.apply(FLAGS)
    expect(handler!.onBeforeSendHeaders!(req, headers, {} as never)).toBeUndefined()
  })
})
