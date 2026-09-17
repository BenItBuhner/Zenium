import type { Cookie } from 'electron'
import type { SiteCookie } from '../../shared/siteInfo'
import type { SiteDataHost, SiteStorageReading } from '../../core/platform'
import type { SessionManager } from './sessions'

/**
 * Cookies and storage per site on Electron: every container is a session partition, and
 * Chromium's cookie store answers with full attributes. Storage usage is not exposed per origin
 * here; the core takes it from the page's own `navigator.storage.estimate()`.
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

  async clearStorage(containerId: string, _site: string, origins: string[]): Promise<void> {
    const ses = this.sessions.get(containerId)
    for (const origin of origins) {
      try {
        await ses.clearStorageData({ origin })
      } catch {
        /* an origin without data */
      }
    }
  }
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
