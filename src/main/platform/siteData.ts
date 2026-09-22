import type { Cookie, Session } from 'electron'
import type { SiteCookie } from '../../shared/siteInfo'
import { cookieVerdict, type SiteDataPolicy } from '../../shared/siteData'
import type { SiteDataHost, SiteDataOriginReading, SiteStorageReading } from '../../core/platform'
import type { SessionManager } from './sessions'

/**
 * Cookies and storage per site on Electron: every container is a session partition, and
 * Chromium's cookie store answers with full attributes. Storage usage is not exposed per origin
 * here; the core takes it from the page's own `navigator.storage.estimate()`, and the site-data
 * viewer says "size unavailable" (`usageBytes: null`) rather than guess.
 */
export class ElectronSiteData implements SiteDataHost {
  constructor(private readonly sessions: SessionManager) {}

  async cookies(containerId: string, url: string): Promise<SiteCookie[]> {
    const list = await this.sessions.get(containerId).cookies.get({ url })
    return list.map(cookieFromElectron)
  }

  async storage(): Promise<SiteStorageReading> {
    return { usageBytes: null, quotaBytes: null, origins: [] }
  }

  async clearCookies(containerId: string, url: string): Promise<number> {
    const store = this.sessions.get(containerId).cookies
    const list = await store.get({ url })
    let removed = 0
    await Promise.all(
      list.map(async (cookie) => {
        try {
          await store.remove(cookieUrl(cookie), cookie.name)
          removed++
        } catch {
          /* already gone */
        }
      })
    )
    return removed
  }

  /**
   * Everything the origins stored – cookies, storage, caches, service workers, and what third
   * parties partitioned under them – through `session.clearData` (Electron's
   * `BrowsingDataRemover` with an origin filter); `clearStorageData` per origin on a session
   * without it.
   */
  async clearStorage(containerId: string, _site: string, origins: string[]): Promise<void> {
    const ses = this.sessions.get(containerId)
    if (origins.length === 0) return
    if (typeof ses.clearData === 'function') {
      try {
        await ses.clearData({ origins, originMatchingMode: 'third-parties-included' })
        return
      } catch {
        /* fall through to the per-origin path */
      }
    }
    for (const origin of origins) {
      try {
        await ses.clearStorageData({ origin })
      } catch {
        /* an origin without data */
      }
    }
  }

  /**
   * Every origin the partition holds cookies for, one row per origin with its cookie count.
   * Chromium's store enumerates (`cookies.get({})`), so `probe` is not needed; storage cannot
   * be sized per origin without the debugger, so `usageBytes` is null throughout.
   */
  async listOrigins(containerId: string): Promise<SiteDataOriginReading[]> {
    const list = await this.sessions.get(containerId).cookies.get({})
    return originReadings(list)
  }
}

/** Cookies grouped under the origin a page receiving them would have (`cookieOrigin`). */
export function originReadings(cookies: readonly Cookie[]): SiteDataOriginReading[] {
  const counts = new Map<string, number>()
  for (const cookie of cookies) {
    const origin = cookieOrigin(cookie)
    if (!origin) continue
    counts.set(origin, (counts.get(origin) ?? 0) + 1)
  }
  return [...counts].map(([origin, count]) => ({ origin, cookies: count, usageBytes: null }))
}

export function cookieFromElectron(cookie: Cookie): SiteCookie {
  return {
    name: cookie.name,
    domain: cookie.domain ?? '',
    path: cookie.path ?? '/',
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    session: cookie.session ?? cookie.expirationDate === undefined,
    size: cookie.name.length + cookie.value.length
  }
}

/** The URL `cookies.remove` needs: the cookie's own host, path and scheme. */
export function cookieUrl(cookie: Cookie): string {
  const host = (cookie.domain ?? '').replace(/^\./, '')
  return `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path ?? '/'}`
}

/** The origin a cookie is listed under: its domain without the leading dot, https when Secure. */
export function cookieOrigin(cookie: Pick<Cookie, 'domain' | 'secure'>): string | null {
  const host = (cookie.domain ?? '').replace(/^\./, '').toLowerCase()
  if (!host) return null
  return `${cookie.secure ? 'https' : 'http'}://${host}`
}

/**
 * The cookie jar's half of the per-site policy on desktop. The header stage keeps a never-site's
 * cookies off the wire, but `document.cookie` writes land in the jar behind it; this drops them
 * as they land (`cookies.on('changed')`) and sweeps the jar whenever the policy changes, so a
 * never-site (and, under "block all cookies", every site the lists leave out) holds no cookie
 * across a page load. The private partition is swept like the rest: Chrome's cookie settings
 * apply in Incognito too.
 */
export class CookiePolicyEnforcer {
  private policy: SiteDataPolicy | null = null
  private readonly attached = new WeakSet<Session>()

  constructor(private readonly sessions: SessionManager) {
    sessions.configure((ses) => this.attach(ses))
  }

  /** The core pushed a policy: sweep every session and keep dropping what it refuses. */
  apply(policy: SiteDataPolicy): void {
    const changed = JSON.stringify(policy) !== JSON.stringify(this.policy)
    this.policy = policy
    if (!changed || !enforces(policy)) return
    for (const ses of this.sessions.all()) void this.sweep(ses)
  }

  /** Whether the policy refuses a cookie of `cookie.domain`. */
  refuses(cookie: Pick<Cookie, 'domain' | 'secure'>): boolean {
    const policy = this.policy
    if (!policy || !enforces(policy)) return false
    const origin = cookieOrigin(cookie)
    // A domain cookie (`.example.com`) is refused when its bare domain is: the never-list's
    // `[*.]example.com` covers it, an exact `example.com` covers the host cookie alone.
    return origin !== null && cookieVerdict(policy, origin) === 'blocked'
  }

  private attach(ses: Session): void {
    if (this.attached.has(ses)) return
    this.attached.add(ses)
    ses.cookies.on('changed', (_event, cookie, _cause, removed) => {
      if (removed || !this.refuses(cookie)) return
      void ses.cookies.remove(cookieUrl(cookie), cookie.name).catch(() => undefined)
    })
  }

  /** Remove every cookie the policy refuses from `ses`; resolves with how many went. */
  async sweep(ses: Session): Promise<number> {
    let removed = 0
    let list: Cookie[]
    try {
      list = await ses.cookies.get({})
    } catch {
      return 0
    }
    for (const cookie of list) {
      if (!this.refuses(cookie)) continue
      try {
        await ses.cookies.remove(cookieUrl(cookie), cookie.name)
        removed++
      } catch {
        /* already gone */
      }
    }
    return removed
  }
}

/** Whether the policy refuses anything at all (the jar is left alone otherwise). */
function enforces(policy: SiteDataPolicy): boolean {
  return policy.blockAll || policy.block.length > 0
}
