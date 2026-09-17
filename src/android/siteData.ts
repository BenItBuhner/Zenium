import type { SiteCookie } from '@shared/siteInfo'
import type { SiteDataHost, SiteStorageReading } from '@core/platform'
import type { Bridge } from './bridge'

/** What Kotlin's `site.cookies` answers for one cookie (see `CookieJar.Classified`). */
export interface NativeCookie {
  name: string
  domain: string
  secure: boolean | null
  size: number
}

/**
 * Cookies and storage per site, read from the container's WebView profile. Kotlin can only infer
 * cookie attributes from the jar's answers for related URLs, so path and expiry stay unknown and
 * HttpOnly is left for the core to work out from the page's own `document.cookie`.
 */
export class AndroidSiteData implements SiteDataHost {
  constructor(private readonly bridge: Bridge) {}

  async cookies(containerId: string, url: string): Promise<SiteCookie[]> {
    const raw = await this.bridge.call<NativeCookie[] | null>('site.cookies', { containerId, url })
    return (Array.isArray(raw) ? raw : []).map(cookieFromNative)
  }

  async storage(containerId: string, site: string): Promise<SiteStorageReading> {
    const raw = await this.bridge.call<{
      usageBytes?: number | null
      quotaBytes?: number | null
      origins?: string[]
    } | null>('site.storage', { containerId, site })
    return {
      usageBytes: typeof raw?.usageBytes === 'number' ? raw.usageBytes : null,
      quotaBytes: typeof raw?.quotaBytes === 'number' ? raw.quotaBytes : null,
      origins: Array.isArray(raw?.origins) ? raw.origins.map(String) : []
    }
  }

  async clearCookies(containerId: string, url: string): Promise<number> {
    const raw = await this.bridge.call<{ removed?: number } | null>('site.clearCookies', {
      containerId,
      url
    })
    return typeof raw?.removed === 'number' ? raw.removed : 0
  }

  async clearStorage(containerId: string, site: string, origins: string[]): Promise<void> {
    await this.bridge.call('site.clearStorage', { containerId, site, origins })
  }
}

export function cookieFromNative(raw: NativeCookie): SiteCookie {
  return {
    name: typeof raw.name === 'string' ? raw.name : '',
    domain: typeof raw.domain === 'string' ? raw.domain : '',
    path: '',
    secure: typeof raw.secure === 'boolean' ? raw.secure : null,
    httpOnly: null,
    session: null,
    size: typeof raw.size === 'number' && Number.isFinite(raw.size) ? Math.max(0, raw.size) : 0
  }
}
