import type { Cookie, Session } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SITE_DATA_POLICY, type SiteDataPolicy } from '../../../shared/siteData'
import type { SessionManager } from '../sessions'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/nowhere' },
  session: { fromPartition: () => ({}) }
}))

const { CookiePolicyEnforcer, ElectronSiteData, cookieCovers, cookieOrigin, cookieUrl, originReadings } =
  await import('../siteData')

type ChangedListener = (event: unknown, cookie: Cookie, cause: string, removed: boolean) => void

/** A session with a cookie jar that remembers what was asked of it. */
class FakeSession {
  jar: Cookie[]
  removed: Array<[string, string]> = []
  clearedData: Array<{ origins?: string[]; originMatchingMode?: string }> = []
  clearedStorage: Array<{ origin?: string }> = []
  listener: ChangedListener | null = null
  clearDataFails = false
  /** Leave `clearData` out, as an older Electron does. */
  noClearData = false

  constructor(jar: Cookie[] = []) {
    this.jar = jar
  }

  /**
   * Chromium's filters as Electron exposes them: `url` – the cookies a request for it carries
   * (the host's own and the domain cookies above it, Secure ones over https only, the path a
   * prefix of the URL's); `domain` – the cookies of that domain and its subdomains, every path.
   */
  readonly cookies = {
    get: async (filter: { url?: string; domain?: string }): Promise<Cookie[]> => {
      if (filter.url) {
        const u = new URL(filter.url)
        return this.jar.filter((c) => {
          const domain = (c.domain ?? '').replace(/^\./, '')
          if (!domain) return false
          const hostOnly = !(c.domain ?? '').startsWith('.')
          if (hostOnly ? u.hostname !== domain : !(u.hostname === domain || u.hostname.endsWith(`.${domain}`)))
            return false
          if (c.secure && u.protocol !== 'https:') return false
          return u.pathname.startsWith(c.path ?? '/')
        })
      }
      if (filter.domain) {
        const wanted = filter.domain.replace(/^\./, '')
        return this.jar.filter((c) => {
          const domain = (c.domain ?? '').replace(/^\./, '')
          return domain === wanted || domain.endsWith(`.${wanted}`)
        })
      }
      return [...this.jar]
    },
    remove: async (url: string, name: string): Promise<void> => {
      this.removed.push([url, name])
      this.jar = this.jar.filter((c) => c.name !== name || cookieUrl(c) !== url)
    },
    on: (_event: 'changed', listener: ChangedListener): void => {
      this.listener = listener
    }
  }

  clearData = async (options: {
    origins?: string[]
    originMatchingMode?: string
  }): Promise<void> => {
    if (this.clearDataFails) throw new Error('no')
    this.clearedData.push(options)
  }

  clearStorageData = async (options: { origin?: string }): Promise<void> => {
    this.clearedStorage.push(options)
  }

  asSession(): Session {
    const s = this as unknown as Record<string, unknown>
    if (this.noClearData) return { ...s, clearData: undefined } as unknown as Session
    return this as unknown as Session
  }

  /** The jar reports a cookie that landed. */
  landed(cookie: Cookie): void {
    this.jar.push(cookie)
    this.listener?.(undefined, cookie, 'explicit', false)
  }
}

function cookie(name: string, domain: string, secure = true, extra: Partial<Cookie> = {}): Cookie {
  return {
    name,
    value: 'v',
    domain,
    path: '/',
    secure,
    httpOnly: false,
    session: true,
    ...extra
  } as Cookie
}

function sessions(map: Record<string, FakeSession>): SessionManager {
  const hooks: Array<(ses: Session, id: string) => void> = []
  return {
    configure: (hook: (ses: Session, id: string) => void): void => {
      hooks.push(hook)
      for (const [id, ses] of Object.entries(map)) hook(ses.asSession(), id)
    },
    get: (id: string) => map[id].asSession(),
    all: () => Object.values(map).map((s) => s.asSession())
  } as unknown as SessionManager
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('ElectronSiteData', () => {
  it('lists the origins the partition holds cookies for, one row each with the count, unsized', async () => {
    const ses = new FakeSession([
      cookie('a', '.example.com'),
      cookie('b', '.example.com'),
      cookie('c', 'www.example.com'),
      cookie('d', 'plain.example', false),
      cookie('e', '')
    ])
    const host = new ElectronSiteData(sessions({ default: ses }))
    const rows = await host.listOrigins('default')
    expect(rows).toEqual([
      { origin: 'https://example.com', cookies: 2, usageBytes: null },
      { origin: 'https://www.example.com', cookies: 1, usageBytes: null },
      { origin: 'http://plain.example', cookies: 1, usageBytes: null }
    ])
    expect(originReadings([])).toEqual([])
    expect(cookieOrigin({ domain: '.Example.COM', secure: true })).toBe('https://example.com')
    expect(cookieOrigin({ domain: '', secure: true })).toBeNull()
    expect(cookieUrl(cookie('x', '.example.com', true, { path: '/app' }))).toBe(
      'https://example.com/app'
    )
  })

  it('lists a host\'s cookies under the origin the user visited, since a cookie knows no port or scheme', async () => {
    const ses = new FakeSession([
      cookie('visit', '127.0.0.1', false),
      cookie('a', '.example.com'),
      cookie('b', 'www.example.com', false),
      cookie('stray', 'never-visited.example', false)
    ])
    const host = new ElectronSiteData(sessions({ default: ses }))
    // The probe is the core's known origins, most recent first: the port comes back with them,
    // a Secure cookie goes with the https origin when the host was visited both ways, a
    // non-Secure one with the most recent visit; a host on no origin keeps the jar's reading.
    const rows = await host.listOrigins('default', [
      'http://127.0.0.1:8080',
      'http://www.example.com:8080',
      'http://example.com',
      'https://example.com',
      'https://www.example.com'
    ])
    expect(rows).toEqual([
      { origin: 'http://127.0.0.1:8080', cookies: 1, usageBytes: null },
      { origin: 'https://example.com', cookies: 1, usageBytes: null },
      { origin: 'http://www.example.com:8080', cookies: 1, usageBytes: null },
      { origin: 'http://never-visited.example', cookies: 1, usageBytes: null }
    ])
    // Without a probe the reading is the jar's alone, as before.
    expect((await host.listOrigins('default')).map((r) => r.origin)).toEqual([
      'http://127.0.0.1',
      'https://example.com',
      'http://www.example.com',
      'http://never-visited.example'
    ])
    expect(originReadings([cookie('x', 'a.example')], ['not a url', 'https://b.example'])).toEqual([
      { origin: 'https://a.example', cookies: 1, usageBytes: null }
    ])
  })

  it("clears the origins' storage through clearData with third parties included, per origin without it", async () => {
    const ses = new FakeSession()
    const host = new ElectronSiteData(sessions({ default: ses }))
    await host.clearStorage('default', 'example.com', [
      'https://example.com',
      'https://www.example.com'
    ])
    expect(ses.clearedData).toEqual([
      {
        origins: ['https://example.com', 'https://www.example.com'],
        originMatchingMode: 'third-parties-included'
      }
    ])
    expect(ses.clearedStorage).toEqual([])
    await host.clearStorage('default', '', [])
    expect(ses.clearedData).toHaveLength(1)

    // A refusal falls through to the per-origin path, and so does a session without the call.
    ses.clearDataFails = true
    await host.clearStorage('default', '', ['https://a.example'])
    expect(ses.clearedStorage).toEqual([{ origin: 'https://a.example' }])
    const old = new FakeSession()
    old.noClearData = true
    await new ElectronSiteData(sessions({ default: old })).clearStorage('default', '', [
      'https://b.example'
    ])
    expect(old.clearedStorage).toEqual([{ origin: 'https://b.example' }])
  })

  it('removes the cookies a page receives and says how many went', async () => {
    const ses = new FakeSession([cookie('a', '.example.com'), cookie('b', 'other.example')])
    const host = new ElectronSiteData(sessions({ default: ses }))
    expect(await host.clearCookies('default', 'https://www.example.com/')).toBe(1)
    expect(ses.removed).toEqual([['https://example.com/', 'a']])
    expect(ses.jar.map((c) => c.name)).toEqual(['b'])
  })

  it("takes a host's Secure and sub-path cookies through an http origin too, and leaves a subdomain's own", async () => {
    // The viewer's row for `http://shop.example:8080` (the port the user visited): the host's
    // Secure cookie (a cross-site embed's `SameSite=None; Secure`) and the one set for `/app`
    // go, so does the domain cookie above it; `cdn.shop.example`'s own cookie is another host's.
    const ses = new FakeSession([
      cookie('embed', 'shop.example', true),
      cookie('app', 'shop.example', false, { path: '/app' }),
      cookie('shared', '.example', true),
      cookie('cdn', 'cdn.shop.example', false),
      cookie('other', 'other.example', false)
    ])
    const host = new ElectronSiteData(sessions({ default: ses }))
    expect(await host.clearCookies('default', 'http://shop.example:8080/')).toBe(3)
    expect(ses.jar.map((c) => c.name).sort()).toEqual(['cdn', 'other'])
    expect(ses.removed.map(([, name]) => name).sort()).toEqual(['app', 'embed', 'shared'])
    // A host-only cookie of the parent is not the subdomain's: `example`'s own stays when
    // `www.example` is cleared; an origin without a host clears nothing.
    const two = new FakeSession([cookie('own', 'example', false), cookie('dom', '.example', false)])
    expect(await new ElectronSiteData(sessions({ default: two })).clearCookies('default', 'https://www.example/')).toBe(1)
    expect(two.jar.map((c) => c.name)).toEqual(['own'])
    expect(await host.clearCookies('default', 'not a url')).toBe(0)
    expect(cookieCovers({ domain: 'a.example', hostOnly: true }, 'www.a.example')).toBe(false)
    expect(cookieCovers({ domain: 'a.example', hostOnly: false }, 'www.a.example')).toBe(true)
    expect(cookieCovers({ domain: '' }, 'a.example')).toBe(false)
  })
})

describe('CookiePolicyEnforcer', () => {
  const policy = (overrides: Partial<SiteDataPolicy>): SiteDataPolicy => ({
    ...DEFAULT_SITE_DATA_POLICY,
    ...overrides
  })

  it("sweeps every session of a never-site's cookies when the policy arrives, and leaves the rest", async () => {
    const one = new FakeSession([
      cookie('keep', '.news.example'),
      cookie('drop', '.never.example'),
      cookie('drop2', 'cdn.never.example', false)
    ])
    const two = new FakeSession([cookie('drop3', 'never.example')])
    const enforcer = new CookiePolicyEnforcer(sessions({ default: one, work: two }))
    enforcer.apply(policy({ block: ['[*.]never.example'] }))
    await tick()
    expect(one.jar.map((c) => c.name)).toEqual(['keep'])
    expect(two.jar).toEqual([])
    expect(one.removed).toEqual([
      ['https://never.example/', 'drop'],
      ['http://cdn.never.example/', 'drop2']
    ])
  })

  it('drops a refused cookie as it lands, and only then', async () => {
    const ses = new FakeSession()
    const enforcer = new CookiePolicyEnforcer(sessions({ default: ses }))
    enforcer.apply(policy({ block: ['never.example'] }))
    ses.landed(cookie('ok', '.news.example'))
    ses.landed(cookie('bad', 'never.example'))
    // The exact-host pattern leaves a domain cookie of the site alone: `.never.example` is
    // `never.example`'s own host cookie though, and goes.
    ses.landed(cookie('bad2', '.never.example'))
    ses.landed(cookie('sub', 'www.never.example'))
    await tick()
    expect(ses.jar.map((c) => c.name)).toEqual(['ok', 'sub'])
    // A removal event is not a landing.
    ses.listener?.(undefined, cookie('bad', 'never.example'), 'explicit', true)
    expect(ses.removed).toHaveLength(2)
  })

  it('under "block all cookies" refuses every site the lists leave out, and nothing without a policy', async () => {
    const ses = new FakeSession([cookie('a', '.news.example'), cookie('b', 'bank.example')])
    const enforcer = new CookiePolicyEnforcer(sessions({ default: ses }))
    expect(enforcer.refuses(cookie('a', '.news.example'))).toBe(false)
    enforcer.apply(policy({ blockAll: true, allow: ['bank.example'] }))
    await tick()
    expect(ses.jar.map((c) => c.name)).toEqual(['b'])
    expect(enforcer.refuses(cookie('x', '.other.example'))).toBe(true)
    expect(enforcer.refuses(cookie('x', 'bank.example'))).toBe(false)
    expect(enforcer.refuses(cookie('x', ''))).toBe(false)
    // The same policy again sweeps nothing more; a policy that refuses nothing neither.
    const swept = ses.removed.length
    enforcer.apply(policy({ blockAll: true, allow: ['bank.example'] }))
    enforcer.apply(policy({}))
    await tick()
    expect(ses.removed).toHaveLength(swept)
    expect(enforcer.refuses(cookie('x', '.other.example'))).toBe(false)
  })
})
