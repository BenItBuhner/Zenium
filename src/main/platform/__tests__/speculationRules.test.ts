/**
 * A speculation-rules prefetch through the browser's own request handlers (W6-F5).
 *
 * Chromium's PrefetchService issues the `<script type="speculationrules">` prefetches – and the
 * prefetch a prerender starts with – from the browser process. Electron routes them through the
 * session's `webRequest` as `mainFrame` requests of the initiating tab (its `webContents`, its
 * document as `frame.url` and referrer) carrying four request headers only: `Sec-Purpose:
 * prefetch` (`prefetch;prerender` for the prerender's), `Sec-Speculation-Tags`, `Accept` and
 * `Upgrade-Insecure-Requests`; the User-Agent and the `Sec-Fetch-*` set are the network service's,
 * added after the hook. The handlers `index.ts` registers – Safe Browsing, lookalikes, the rule
 * engine, the privacy handler and the header rewrites – must let such a request through with its
 * purpose intact: that is what the server logs, what a speculation-rules-aware site keys on, and
 * what an extension's `chrome.webRequest` listener reads (Chrome shows it the same header). The
 * shapes here are the ones a packaged build was measured to hand the hook (Electron 44.4.5).
 */
import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'
import type { PrivacyFlags } from '../../../shared/privacy'
import { DEFAULT_SITE_DATA_POLICY } from '../../../shared/siteData'
import { PRIVATE_CONTAINER_ID } from '../../../shared/types'
import { RuleEngine } from '../../../core/blocking/engine'
import { RULE_SET_PRIORITY } from '../../../core/blocking/rules'
import { hasClientHints, lowEntropyClientHints } from '../../../shared/browserIdentity'
import { withChromeClientHints, withEdgeIdentity } from '../../../core/extensions/webstorePrivate'
import type { RequestHeaderHandler } from '../requestHeaders'
import type {
  BeforeRequestDetails,
  BeforeSendHeadersDetails,
  HeadersReceivedDetails
} from '../webRequest'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/nowhere',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    configureHostResolver: () => undefined
  },
  ipcMain: { on: () => undefined }
}))

const { HANDLER_ORDER, WebRequestMultiplexer, contextFor } = await import('../webRequest')
const { LookalikeHandler, PrivacyRequestHandler, SafeBrowsingHandler } = await import('../privacy')
const { BlockingHandler } = await import('../blocking')
const { edgeStoreUserAgent, navigationClientHints, webstoreClientHints } =
  await import('../requestHeaders')

type BeforeRequestListener = (
  details: BeforeRequestDetails,
  callback: (r: Electron.CallbackResponse) => void
) => void
type BeforeSendHeadersListener = (
  details: BeforeSendHeadersDetails,
  callback: (r: Electron.BeforeSendResponse) => void
) => void
type HeadersReceivedListener = (
  details: HeadersReceivedDetails,
  callback: (r: Electron.HeadersReceivedResponse) => void
) => void

/** A `Session` that keeps the blocking listeners installed on its `webRequest`. */
class FakeSession {
  beforeRequestListener: BeforeRequestListener | null = null
  beforeSendHeadersListener: BeforeSendHeadersListener | null = null
  headersReceivedListener: HeadersReceivedListener | null = null

  webRequest = {
    onBeforeRequest: (l: BeforeRequestListener) => void (this.beforeRequestListener = l),
    onBeforeSendHeaders: (l: BeforeSendHeadersListener) =>
      void (this.beforeSendHeadersListener = l),
    onSendHeaders: () => undefined,
    onHeadersReceived: (l: HeadersReceivedListener) => void (this.headersReceivedListener = l),
    onResponseStarted: () => undefined,
    onBeforeRedirect: () => undefined,
    onCompleted: () => undefined,
    onErrorOccurred: () => undefined
  }

  asSession(): Session {
    return this as unknown as Session
  }

  beforeRequest(details: BeforeRequestDetails): Electron.CallbackResponse {
    let out: Electron.CallbackResponse = {}
    this.beforeRequestListener!(details, (r) => void (out = r))
    return out
  }

  beforeSendHeaders(details: BeforeSendHeadersDetails): Electron.BeforeSendResponse {
    let out: Electron.BeforeSendResponse = {}
    this.beforeSendHeadersListener!(details, (r) => void (out = r))
    return out
  }

  headersReceived(details: HeadersReceivedDetails): Electron.HeadersReceivedResponse {
    let out: Electron.HeadersReceivedResponse = {}
    this.headersReceivedListener!(details, (r) => void (out = r))
    return out
  }
}

const CHROMIUM = '152.0.7977.130'
const LANDING = 'http://127.0.0.1:18621/'
const TAB_ID = 'tab-landing'

/** The tab's `WebContents`, on the landing page that carries the rules. */
const tab = {
  id: 7,
  isDestroyed: () => false,
  getURL: () => LANDING
} as unknown as Electron.WebContents

const views = {
  tabIdForWebContents: (wc: Electron.WebContents) => (wc === tab ? TAB_ID : undefined)
}

let nextId = 1
/**
 * What Electron hands the hook for a PrefetchService request: a `mainFrame` request of the
 * initiating tab, its document as the frame and the referrer, no upload data.
 */
function prefetchDetails(url: string): BeforeRequestDetails {
  return {
    id: nextId++,
    url,
    method: 'GET',
    resourceType: 'mainFrame',
    referrer: LANDING,
    timestamp: 0,
    webContentsId: tab.id,
    webContents: tab,
    frame: { url: LANDING, parent: null, frameTreeNodeId: 1 } as unknown as Electron.WebFrameMain,
    uploadData: []
  } as unknown as BeforeRequestDetails
}

/** The four headers the hook sees on the prefetch; `purpose` is the `Sec-Purpose` value. */
function prefetchHeaders(purpose: 'prefetch' | 'prefetch;prerender'): Record<string, string> {
  return {
    'Upgrade-Insecure-Requests': '1',
    'Sec-Purpose': purpose,
    'Sec-Speculation-Tags': 'null',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'
  }
}

function sendHeadersDetails(
  url: string,
  purpose: 'prefetch' | 'prefetch;prerender'
): BeforeSendHeadersDetails {
  return {
    ...prefetchDetails(url),
    requestHeaders: prefetchHeaders(purpose)
  } as unknown as BeforeSendHeadersDetails
}

const FLAGS: PrivacyFlags = {
  safeBrowsing: true,
  safeBrowsingBypassed: [],
  httpsOnly: 'ask',
  httpsOnlyAllowed: [],
  thirdPartyCookies: 'block',
  thirdPartyCookiesPrivate: 'default',
  thirdPartyCookieExceptions: [],
  gpc: true,
  dnt: true,
  secureDnsMode: 'automatic',
  secureDnsServers: [],
  siteData: DEFAULT_SITE_DATA_POLICY
}

/** The handlers of `index.ts` on one multiplexer over a normal and the private session. */
function browserChain(): {
  normal: FakeSession
  secret: FakeSession
  unsafe: string[]
  lookalikesAsked: string[]
  blockedByEngine: Array<string | undefined>
} {
  const mux = new WebRequestMultiplexer(views)
  const normal = new FakeSession()
  const secret = new FakeSession()
  mux.attach(normal.asSession(), 'default')
  mux.attach(secret.asSession(), PRIVATE_CONTAINER_ID)

  const unsafe: string[] = []
  const lookalikesAsked: string[] = []
  const tabs = {
    viewForTab: (tabId: string) =>
      tabId === TAB_ID
        ? {
            noteUpgraded: () => undefined,
            noteUnsafeNavigation: (url: string) => void unsafe.push(url),
            noteLookalikeNavigation: () => undefined
          }
        : undefined
  }
  mux.register(
    new SafeBrowsingHandler(
      {
        lookup: (url) =>
          new URL(url).hostname === 'evil.example'
            ? { feedId: 'urlhaus', threat: 'malware', expression: 'evil.example', remote: false }
            : null
      },
      tabs
    )
  )
  mux.register(
    new LookalikeHandler(
      {
        check: (url) => {
          lookalikesAsked.push(url)
          return null
        }
      },
      tabs
    )
  )

  const engine = new RuleEngine()
  engine.setRuleSet({
    id: 'filter-list:easylist',
    source: 'filter-list',
    priority: RULE_SET_PRIORITY.filterList,
    enabled: true,
    rules: [{ id: 1, action: { type: 'block' }, condition: { urlFilter: '||ads.example^' } }]
  })
  const blockedByEngine: Array<string | undefined> = []
  mux.register(
    new BlockingHandler(
      {
        decide: (ctx) => engine.decide(ctx),
        recordBlocked: (tabId) => void blockedByEngine.push(tabId)
      },
      null
    )
  )
  mux.register(new PrivacyRequestHandler(() => FLAGS))

  // The rewrites of `index.ts`, with the Chromium version pinned (`process.versions.chrome` is
  // Electron's alone).
  const navigationHints: RequestHeaderHandler = {
    ...navigationClientHints,
    rewrite: (headers, details) =>
      (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') &&
      !hasClientHints(headers)
        ? { ...headers, ...lowEntropyClientHints(CHROMIUM, 'linux') }
        : headers
  }
  const storeHints: RequestHeaderHandler = {
    ...webstoreClientHints,
    rewrite: (headers) => withChromeClientHints(headers, CHROMIUM)
  }
  const edgeIdentity: RequestHeaderHandler = {
    ...edgeStoreUserAgent,
    rewrite: (headers) => withEdgeIdentity(headers, CHROMIUM)
  }
  mux.registerHeaderRewrite(navigationHints)
  mux.registerHeaderRewrite(storeHints, { persistentOnly: true })
  mux.registerHeaderRewrite(edgeIdentity, { persistentOnly: true })

  expect(mux.handlerIds()).toEqual([
    'safe-browsing',
    'lookalike',
    'blocking',
    'privacy',
    'rewrite:navigation-client-hints',
    'rewrite:webstore-client-hints',
    'rewrite:edge-store-user-agent'
  ])
  return { normal, secret, unsafe, lookalikesAsked, blockedByEngine }
}

describe('a speculation-rules prefetch through the browser handlers', () => {
  it('is the initiating tab’s main-frame request to the core, document-free like a navigation', () => {
    const ctx = contextFor(prefetchDetails(`${LANDING}prefetched.html`), 'default', TAB_ID)
    expect(ctx).toEqual({
      url: `${LANDING}prefetched.html`,
      type: 'main_frame',
      method: 'GET',
      partition: 'default',
      isPrivate: false,
      initiator: LANDING,
      tabId: TAB_ID,
      chromeTabId: tab.id
    })
  })

  it('passes the request stage of every handler, the lookalike check included, with no verdict', () => {
    const { normal, secret, lookalikesAsked, blockedByEngine, unsafe } = browserChain()
    for (const ses of [normal, secret]) {
      expect(ses.beforeRequest(prefetchDetails(`${LANDING}prefetched.html`))).toEqual({})
      expect(ses.beforeRequest(prefetchDetails(`${LANDING}prerendered.html`))).toEqual({})
    }
    // The lookalike table is consulted for the prefetch as for the navigation it stands in for.
    expect(lookalikesAsked).toEqual([
      `${LANDING}prefetched.html`,
      `${LANDING}prerendered.html`,
      `${LANDING}prefetched.html`,
      `${LANDING}prerendered.html`
    ])
    expect(blockedByEngine).toEqual([])
    expect(unsafe).toEqual([])
  })

  it('keeps Sec-Purpose and Sec-Speculation-Tags verbatim while the edits of the chain land', () => {
    const { normal, secret } = browserChain()
    for (const purpose of ['prefetch', 'prefetch;prerender'] as const) {
      const url = `${LANDING}${purpose === 'prefetch' ? 'prefetched' : 'prerendered'}.html`
      const out = normal.beforeSendHeaders(sendHeadersDetails(url, purpose))
      expect(out.cancel).toBeUndefined()
      expect(out.requestHeaders).toEqual({
        ...prefetchHeaders(purpose),
        // The privacy handler's signals, as on any request of the tab.
        'Sec-GPC': '1',
        DNT: '1',
        // The navigation hints: a main-frame request without any gets Chrome's low-entropy set.
        ...lowEntropyClientHints(CHROMIUM, 'linux')
      })
      // The private window's prefetch goes the same way, without the store rewrites.
      const secretOut = secret.beforeSendHeaders(sendHeadersDetails(url, purpose))
      expect(secretOut.cancel).toBeUndefined()
      expect(secretOut.requestHeaders?.['Sec-Purpose']).toBe(purpose)
      expect(secretOut.requestHeaders?.['Sec-Speculation-Tags']).toBe('null')
    }
  })

  it('leaves the prefetched response alone at the headers stage', () => {
    const { normal } = browserChain()
    const responseHeaders = {
      'content-type': ['text/html; charset=utf-8'],
      'cache-control': ['no-cache'],
      'x-fixture-served': ['prefetched']
    }
    const out = normal.headersReceived({
      ...prefetchDetails(`${LANDING}prefetched.html`),
      statusLine: 'HTTP/1.1 200 OK',
      statusCode: 200,
      responseHeaders
    } as unknown as HeadersReceivedDetails)
    expect(out.cancel).toBeUndefined()
    expect(out.statusLine).toBeUndefined()
    expect(out.responseHeaders).toEqual(responseHeaders)
  })

  it('refuses the prefetch of a page the tab would be refused – Safe Browsing and the rules alike', () => {
    const { normal, unsafe, blockedByEngine } = browserChain()
    expect(normal.beforeRequest(prefetchDetails('https://evil.example/landing'))).toEqual({
      cancel: true
    })
    expect(unsafe).toEqual(['https://evil.example/landing'])
    expect(normal.beforeRequest(prefetchDetails('https://ads.example/next'))).toEqual({
      cancel: true
    })
    expect(blockedByEngine).toEqual([TAB_ID])
  })

  it('shows a header-stage handler placed ahead of the rules the purpose untouched, and lets it refuse', () => {
    // Where a "No preloading" refusal sits (services' PS-43: between the lookalike check and the
    // rules): it reads `Sec-Purpose` as Chromium sent it, and its cancel is the chain's answer.
    const { normal } = browserChain()
    const seen: Array<string | undefined> = []
    let refuse = false
    const mux = new WebRequestMultiplexer(views)
    const ses = new FakeSession()
    mux.attach(ses.asSession(), 'default')
    mux.register(new PrivacyRequestHandler(() => FLAGS))
    mux.register({
      id: 'preload-probe',
      order: (HANDLER_ORDER.lookalike + HANDLER_ORDER.ruleEngine) / 2,
      onBeforeSendHeaders: (_request, headers) => {
        seen.push(headers['Sec-Purpose'])
        return refuse ? { cancel: true } : undefined
      }
    })
    expect(mux.handlerIds()).toEqual(['preload-probe', 'privacy'])

    const url = `${LANDING}prerendered.html`
    expect(ses.beforeSendHeaders(sendHeadersDetails(url, 'prefetch;prerender')).cancel).toBe(
      undefined
    )
    refuse = true
    expect(ses.beforeSendHeaders(sendHeadersDetails(url, 'prefetch;prerender'))).toEqual({
      cancel: true
    })
    expect(seen).toEqual(['prefetch;prerender', 'prefetch;prerender'])
    // The full chain of the browser's own handlers never refuses it.
    expect(normal.beforeSendHeaders(sendHeadersDetails(url, 'prefetch;prerender')).cancel).toBe(
      undefined
    )
  })
})
