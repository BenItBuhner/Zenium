import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/nowhere',
    getPath: () => '/nowhere',
    configureHostResolver: () => undefined
  },
  ipcMain: { on: () => undefined },
  net: { fetch: () => Promise.reject(new Error('offline')) }
}))

const { WebRequestMultiplexer, HANDLER_ORDER } = await import('../webRequest')
const { BlockingHandler } = await import('../blocking')
const { PrivacyRequestHandler } = await import('../privacy')
const { edgeStoreUserAgent, navigationClientHints, webstoreClientHints } =
  await import('../requestHeaders')
const { RuleEngine } = await import('../../../core/blocking/engine')
const { BUILTIN_RULE_SETS, RULE_SET_PRIORITY } = await import('../../../core/blocking/rules')
const { httpsOnlyRule } = await import('../../../core/protection/service')
const { DEFAULT_PRIVACY_SETTINGS } = await import('../../../shared/privacy')
const { PRIVATE_CONTAINER_ID } = await import('../../../shared/types')

type Details = Electron.OnBeforeSendHeadersListenerDetails
type Received = Electron.OnHeadersReceivedListenerDetails
type Before = Electron.OnBeforeRequestListenerDetails
type PrivacyFlags = import('../../../shared/privacy').PrivacyFlags

/**
 * The identity providers Bennett signs into, as their sign-in pages arrive: a top-level
 * navigation from a third-party page (the referrer), a same-site POST from the sign-in page
 * itself, and the frames Google's page embeds.
 */
const IDENTITY_ORIGINS = [
  'https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn',
  'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x',
  'https://login.live.com/login.srf',
  'https://appleid.apple.com/sign-in',
  'https://idmsa.apple.com/appleauth/auth/signin',
  'https://github.com/login',
  'https://discord.com/login'
]

/** What Chrome 152 puts on a document request (client hints included). */
const CHROME_NAVIGATION_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Site': 'cross-site',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-User': '?1',
  'Sec-Fetch-Dest': 'document',
  'sec-ch-ua': '"Not?A_Brand";v="24", "Chromium";v="152"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Linux"',
  Referer: 'https://www.example.com/',
  Cookie: 'SID=abc; __Host-GAPS=def'
}

/** What the page's own XHR to its origin carries (the renderer adds the hints). */
const CHROME_XHR_HEADERS: Record<string, string> = {
  'User-Agent': CHROME_NAVIGATION_HEADERS['User-Agent'],
  Accept: '*/*',
  'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
  Origin: 'https://accounts.google.com',
  Referer: 'https://accounts.google.com/v3/signin/identifier',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
  'sec-ch-ua': '"Not?A_Brand";v="24", "Chromium";v="152"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Linux"',
  'X-Same-Domain': '1',
  Cookie: 'SID=abc; __Host-GAPS=def'
}

type BeforeRequestListener = (d: Before, cb: (r: Electron.CallbackResponse) => void) => void
type BeforeSendHeadersListener = (d: Details, cb: (r: Electron.BeforeSendResponse) => void) => void
type HeadersReceivedListener = (
  d: Received,
  cb: (r: Electron.HeadersReceivedResponse) => void
) => void

/** A `Session` recording the one listener the multiplexer installs per `webRequest` event. */
class FakeSession {
  beforeRequestListener!: BeforeRequestListener
  beforeSendHeadersListener!: BeforeSendHeadersListener
  headersReceivedListener!: HeadersReceivedListener
  webRequest = {
    onBeforeRequest: (l: BeforeRequestListener) => (this.beforeRequestListener = l),
    onBeforeSendHeaders: (l: BeforeSendHeadersListener) => (this.beforeSendHeadersListener = l),
    onHeadersReceived: (l: HeadersReceivedListener) => (this.headersReceivedListener = l),
    onSendHeaders: () => undefined,
    onResponseStarted: () => undefined,
    onBeforeRedirect: () => undefined,
    onCompleted: () => undefined,
    onErrorOccurred: () => undefined
  }
  asSession(): Session {
    return this as unknown as Session
  }
}

let nextId = 1

function webContents(url: string): Electron.WebContents {
  return { id: 7, isDestroyed: () => false, getURL: () => url } as unknown as Electron.WebContents
}

/** Runs one request through all three phases and returns what went out and what came back. */
function run(
  ses: FakeSession,
  request: {
    url: string
    resourceType: 'mainFrame' | 'subFrame' | 'xhr' | 'script' | 'image'
    method?: string
    referrer?: string
    requestHeaders: Record<string, string>
    responseHeaders: Record<string, string[]>
    documentUrl?: string
  }
): {
  before: Electron.CallbackResponse
  sent: Record<string, string>
  received: Record<string, string[]>
} {
  const id = nextId++
  const base = {
    id,
    url: request.url,
    method: request.method ?? 'GET',
    resourceType: request.resourceType,
    referrer: request.referrer ?? '',
    timestamp: 0,
    webContents: webContents(request.documentUrl ?? request.url),
    frame: undefined
  }
  let before: Electron.CallbackResponse = {}
  ses.beforeRequestListener({ ...base, uploadData: [] } as unknown as Before, (r) => {
    before = r
  })
  let sent: Record<string, string> = {}
  ses.beforeSendHeadersListener(
    { ...base, requestHeaders: { ...request.requestHeaders } } as unknown as Details,
    (r) => {
      sent = (r.requestHeaders ?? {}) as Record<string, string>
    }
  )
  let received: Record<string, string[]> = {}
  ses.headersReceivedListener(
    {
      ...base,
      statusLine: 'HTTP/1.1 200 OK',
      statusCode: 200,
      responseHeaders: { ...request.responseHeaders }
    } as unknown as Received,
    (r) => {
      received = (r.responseHeaders ?? {}) as Record<string, string[]>
    }
  )
  return { before, sent, received }
}

/**
 * The browser's whole request pipeline as `index.ts` assembles it, with the shipped defaults:
 * the rule engine holding HTTPS-only mode's rule, the privacy handler on the default policy
 * (third-party cookies blocked in private windows only, GPC and DNT off), then the header
 * rewrites – navigation client hints for every session, the store identities for persistent
 * ones. No filter lists: those are the blocking engine's own tests' business.
 */
function pipeline(flags: Partial<PrivacyFlags> = {}): {
  normal: FakeSession
  secret: FakeSession
} {
  const engine = new RuleEngine()
  engine.setRuleSet({
    id: BUILTIN_RULE_SETS.httpsOnly,
    source: 'builtin',
    priority: RULE_SET_PRIORITY.httpsOnly,
    enabled: true,
    rules: [httpsOnlyRule('ask')]
  })
  const policy: PrivacyFlags = {
    safeBrowsing: DEFAULT_PRIVACY_SETTINGS.safeBrowsingEnabled,
    safeBrowsingBypassed: [],
    httpsOnly: DEFAULT_PRIVACY_SETTINGS.httpsOnly,
    httpsOnlyAllowed: [],
    thirdPartyCookies: DEFAULT_PRIVACY_SETTINGS.thirdPartyCookies,
    thirdPartyCookiesPrivate: DEFAULT_PRIVACY_SETTINGS.thirdPartyCookiesPrivate,
    thirdPartyCookieExceptions: [],
    gpc: DEFAULT_PRIVACY_SETTINGS.gpc,
    dnt: DEFAULT_PRIVACY_SETTINGS.dnt,
    secureDnsMode: DEFAULT_PRIVACY_SETTINGS.secureDnsMode,
    secureDnsServers: [],
    ...flags
  }
  const mux = new WebRequestMultiplexer({ tabIdForWebContents: () => 'tab-1' })
  mux.register(
    new BlockingHandler(
      { decide: (ctx) => engine.decide(ctx), recordBlocked: () => undefined },
      null
    )
  )
  mux.register(new PrivacyRequestHandler(() => policy))
  mux.registerHeaderRewrite(navigationClientHints)
  mux.registerHeaderRewrite(webstoreClientHints, { persistentOnly: true })
  mux.registerHeaderRewrite(edgeStoreUserAgent, { persistentOnly: true })
  expect(mux.handlerIds()).toEqual([
    'blocking',
    'privacy',
    'rewrite:navigation-client-hints',
    'rewrite:webstore-client-hints',
    'rewrite:edge-store-user-agent'
  ])
  expect(HANDLER_ORDER.ruleEngine).toBeLessThan(HANDLER_ORDER.privacy)
  const normal = new FakeSession()
  const secret = new FakeSession()
  mux.attach(normal.asSession(), 'default')
  mux.attach(secret.asSession(), PRIVATE_CONTAINER_ID)
  return { normal, secret }
}

const SET_COOKIE = {
  'set-cookie': ['__Host-GAPS=1:abc; Path=/; Secure; HttpOnly; SameSite=None'],
  'content-type': ['text/html; charset=utf-8'],
  'accept-ch': ['Sec-CH-UA-Arch, Sec-CH-UA-Full-Version-List']
}

describe('identity origins pass through the request pipeline untouched', () => {
  const versions = process.versions
  beforeAll(() => {
    // Electron's main process reports the Chromium build here; Node alone does not.
    Object.defineProperty(process, 'versions', {
      value: { ...versions, chrome: '152.0.7977.78' },
      configurable: true
    })
  })
  afterAll(() => {
    Object.defineProperty(process, 'versions', { value: versions, configurable: true })
  })

  it.each(IDENTITY_ORIGINS)('%s: a Chrome-shaped sign-in navigation is not rewritten', (url) => {
    const { normal, secret } = pipeline()
    for (const ses of [normal, secret]) {
      const { before, sent, received } = run(ses, {
        url,
        resourceType: 'mainFrame',
        referrer: 'https://www.example.com/',
        requestHeaders: CHROME_NAVIGATION_HEADERS,
        responseHeaders: SET_COOKIE
      })
      expect(before).toEqual({})
      expect(sent).toEqual(CHROME_NAVIGATION_HEADERS)
      expect(received).toEqual(SET_COOKIE)
    }
  })

  it('leaves the sign-in page’s own POST alone, cookies included, in both windows', () => {
    const { normal, secret } = pipeline()
    for (const ses of [normal, secret]) {
      const { before, sent, received } = run(ses, {
        url: 'https://accounts.google.com/_/lookup/accountlookup?rt=j',
        resourceType: 'xhr',
        method: 'POST',
        referrer: 'https://accounts.google.com/v3/signin/identifier',
        documentUrl: 'https://accounts.google.com/v3/signin/identifier',
        requestHeaders: CHROME_XHR_HEADERS,
        responseHeaders: SET_COOKIE
      })
      expect(before).toEqual({})
      expect(sent).toEqual(CHROME_XHR_HEADERS)
      expect(received).toEqual(SET_COOKIE)
    }
  })

  it('only completes Electron’s hint-less navigation with Chrome’s low-entropy hints', () => {
    const { normal } = pipeline()
    const electron = { ...CHROME_NAVIGATION_HEADERS }
    delete electron['sec-ch-ua']
    delete electron['sec-ch-ua-mobile']
    delete electron['sec-ch-ua-platform']
    const { sent } = run(normal, {
      url: IDENTITY_ORIGINS[0],
      resourceType: 'mainFrame',
      requestHeaders: electron,
      responseHeaders: SET_COOKIE
    })
    const added = Object.keys(sent).filter((name) => !(name in electron))
    expect(added.sort()).toEqual(['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'])
    for (const [name, value] of Object.entries(electron)) expect(sent[name]).toBe(value)
    expect(sent['sec-ch-ua']).toMatch(/^"[^"]+";v="\d+", "[^"]+";v="\d+"$/)
    expect(sent['sec-ch-ua']).toContain('"Chromium";v="')
    expect(sent['sec-ch-ua']).not.toContain('Google Chrome')
  })

  it('keeps Google’s embedded frames and their cookies in a normal window', () => {
    const { normal } = pipeline()
    const frame = run(normal, {
      url: 'https://accounts.youtube.com/accounts/CheckConnection?pmpo=https%3A%2F%2Faccounts.google.com',
      resourceType: 'subFrame',
      referrer: 'https://accounts.google.com/',
      documentUrl: 'https://accounts.google.com/v3/signin/identifier',
      requestHeaders: CHROME_NAVIGATION_HEADERS,
      responseHeaders: SET_COOKIE
    })
    expect(frame.before).toEqual({})
    expect(frame.sent).toEqual(CHROME_NAVIGATION_HEADERS)
    expect(frame.received).toEqual(SET_COOKIE)
    const script = run(normal, {
      url: 'https://www.gstatic.com/_/mss/boq-identity/_/js/k=boq-identity.js',
      resourceType: 'script',
      referrer: 'https://accounts.google.com/',
      documentUrl: 'https://accounts.google.com/v3/signin/identifier',
      requestHeaders: CHROME_XHR_HEADERS,
      responseHeaders: SET_COOKIE
    })
    expect(script.sent).toEqual(CHROME_XHR_HEADERS)
    expect(script.received).toEqual(SET_COOKIE)
  })

  it('in a private window, the default policy withholds only third-party frame cookies', () => {
    const { secret } = pipeline()
    const frame = run(secret, {
      url: 'https://accounts.youtube.com/accounts/CheckConnection',
      resourceType: 'subFrame',
      referrer: 'https://accounts.google.com/',
      documentUrl: 'https://accounts.google.com/v3/signin/identifier',
      requestHeaders: CHROME_NAVIGATION_HEADERS,
      responseHeaders: SET_COOKIE
    })
    const withoutCookie = { ...CHROME_NAVIGATION_HEADERS }
    delete withoutCookie.Cookie
    expect(frame.sent).toEqual(withoutCookie)
    expect(frame.received['set-cookie']).toBeUndefined()
    // A same-site frame keeps them.
    const own = run(secret, {
      url: 'https://accounts.google.com/_/bscframe',
      resourceType: 'subFrame',
      referrer: 'https://accounts.google.com/',
      documentUrl: 'https://accounts.google.com/v3/signin/identifier',
      requestHeaders: CHROME_NAVIGATION_HEADERS,
      responseHeaders: SET_COOKIE
    })
    expect(own.sent).toEqual(CHROME_NAVIGATION_HEADERS)
    expect(own.received).toEqual(SET_COOKIE)
  })

  it('adds no GPC or DNT header by default, and only those when switched on', () => {
    const { normal } = pipeline({ gpc: true, dnt: true })
    const { sent } = run(normal, {
      url: IDENTITY_ORIGINS[0],
      resourceType: 'mainFrame',
      requestHeaders: CHROME_NAVIGATION_HEADERS,
      responseHeaders: {}
    })
    expect(sent).toEqual({ ...CHROME_NAVIGATION_HEADERS, 'Sec-GPC': '1', DNT: '1' })
  })

  it('HTTPS-only mode leaves https sign-in pages alone and only upgrades plaintext documents', () => {
    const { normal } = pipeline()
    expect(
      run(normal, {
        url: 'http://accounts.google.com/',
        resourceType: 'mainFrame',
        requestHeaders: {},
        responseHeaders: {}
      }).before
    ).toEqual({ redirectURL: 'https://accounts.google.com/' })
    expect(
      run(normal, {
        url: 'http://localhost:8080/oauth/callback?code=abc',
        resourceType: 'mainFrame',
        requestHeaders: {},
        responseHeaders: {}
      }).before
    ).toEqual({})
  })
})
