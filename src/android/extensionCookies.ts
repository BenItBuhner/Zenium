import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID, type Tab } from '@shared/types'
import {
  CookieError,
  ERROR_INVALID_STORE_ID,
  ERROR_NO_HOST_PERMISSION,
  ERROR_SET_FAILED,
  containerForStoreId,
  cookieMatchesFilter,
  cookieUrl,
  formatCookieError,
  normalizeGetAllDetails,
  normalizeGetDetails,
  normalizeRemoveDetails,
  normalizeSetDetails,
  sortCookies,
  storeIdForContainer,
  toChromeCookie,
  type ChromeCookie,
  type EngineCookie
} from '@core/extensions/api/cookies'
import type { AttachedExtension } from './extensionApi'

/**
 * What the WebView's jar answers for one URL: with `GET_COOKIE_INFO` (Chromium 120+) each cookie
 * in `Set-Cookie` syntax, attributes and all; on an older WebView `CookieManager.getCookie`'s
 * `name=value` pairs, which is all it knows.
 */
export interface JarReading {
  cookies: string[]
  detailed: boolean
}

export interface CookiesHost {
  /** The cookies a request to `url` from the container would carry. */
  read(containerId: string, url: string): Promise<JarReading>
  /** Store one `Set-Cookie` line against `url` in the container; false when the jar refused it. */
  write(containerId: string, url: string, setCookie: string): Promise<boolean>
  /** A granted host permission or an `activeTab` grant covering `url`, as Chrome's cookie checks go. */
  hostAccess(ext: AttachedExtension, url: string): boolean
  /** The extension's host patterns (`host_permissions` plus granted optional ones). */
  hostPatterns(ext: AttachedExtension): string[]
  allAttached(): AttachedExtension[]
  /** The tabs `ext` may see. */
  visibleTabs(ext: AttachedExtension): Tab[]
  chromeTabId(tabId: string): number
  emit(extensionId: string, ns: string, name: string, args: unknown[]): void
}

/** Where a call runs: a content script's tab (its container is the default store) or an extension page. */
export interface CookieCaller {
  tab: Tab | null
}

const PERMISSION_REQUIRED = "The 'cookies' permission is required."

/**
 * `chrome.cookies` on Android, over the WebView's per-container jars (`Profiles.cookieManager`):
 * Chrome's argument checks, `getAll` filter, ordering and store ids from the shared module; host
 * permissions per URL as on the desktop (explicit hosts or an `activeTab` grant). Store `"0"` is
 * the default container, `"1"` the private one (an extension allowed in private tabs only), other
 * containers by their id.
 *
 * The jar answers by URL only: `getAll` without a `url` reads the URLs of the hosts the extension
 * names (a `domain` filter is read directly), so cookies of hosts it can only reach through a
 * wildcard permission are not listed. `onChanged` fires for what extensions write through this
 * API (the WebView reports no other changes).
 */
export class AndroidCookies {
  constructor(private readonly host: CookiesHost) {}

  async call(
    ext: AttachedExtension,
    caller: CookieCaller,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    if (!ext.manifest.permissions.includes('cookies')) throw new Error(PERMISSION_REQUIRED)
    switch (method) {
      case 'get':
        return this.get(ext, caller, args[0])
      case 'getAll':
        return this.getAll(ext, caller, args[0])
      case 'set':
        return this.set(ext, caller, args[0])
      case 'remove':
        return this.remove(ext, caller, args[0])
      case 'getAllCookieStores':
        return this.getAllCookieStores(ext)
      case 'getPartitionKey':
        return { partitionKey: {} }
    }
    throw new Error(`chrome.cookies.${method} is not implemented on Zenium for Android`)
  }

  // ---------------------------------------------------------------------------
  // Stores
  // ---------------------------------------------------------------------------

  /** The store ids `ext` may use: the default container, the private one when allowed, other containers with tabs. */
  private storeIds(ext: AttachedExtension): string[] {
    const ids = new Set<string>([storeIdForContainer(DEFAULT_CONTAINER_ID)])
    for (const tab of this.host.visibleTabs(ext)) ids.add(storeIdForContainer(tab.containerId))
    if (ext.record.allowPrivate) ids.add(storeIdForContainer(PRIVATE_CONTAINER_ID))
    else ids.delete(storeIdForContainer(PRIVATE_CONTAINER_ID))
    return [...ids]
  }

  /** The container a call reads: the store it names, else the caller's own (a content script's tab, or the default). */
  private containerFor(
    ext: AttachedExtension,
    caller: CookieCaller,
    storeId: string | null
  ): string {
    if (storeId !== null) {
      if (!this.storeIds(ext).includes(storeId))
        throw new Error(formatCookieError(ERROR_INVALID_STORE_ID, storeId))
      return containerForStoreId(storeId)
    }
    const own = caller.tab?.containerId ?? DEFAULT_CONTAINER_ID
    return own === PRIVATE_CONTAINER_ID && !ext.record.allowPrivate ? DEFAULT_CONTAINER_ID : own
  }

  private requireHostPermission(ext: AttachedExtension, url: string): void {
    if (!this.host.hostAccess(ext, url))
      throw new Error(formatCookieError(ERROR_NO_HOST_PERMISSION, url))
  }

  // ---------------------------------------------------------------------------
  // Routed calls
  // ---------------------------------------------------------------------------

  private async get(
    ext: AttachedExtension,
    caller: CookieCaller,
    raw: unknown
  ): Promise<ChromeCookie | null> {
    const details = normalize(() => normalizeGetDetails(raw))
    this.requireHostPermission(ext, details.url)
    const container = this.containerFor(ext, caller, details.storeId)
    const cookies = await this.readUrl(container, details.url)
    return sortCookies(cookies.filter((c) => c.name === details.name))[0] ?? null
  }

  private async getAll(
    ext: AttachedExtension,
    caller: CookieCaller,
    raw: unknown
  ): Promise<ChromeCookie[]> {
    const details = normalize(() => normalizeGetAllDetails(raw))
    if (details.url !== undefined) this.requireHostPermission(ext, details.url)
    const container = this.containerFor(ext, caller, details.storeId)
    const urls =
      details.url !== undefined
        ? [details.url]
        : details.domain !== undefined
          ? domainUrls(details.domain)
          : permittedUrls(this.host.hostPatterns(ext))
    const out = new Map<string, ChromeCookie>()
    for (const url of urls) {
      for (const cookie of await this.readUrl(container, url)) {
        if (!cookieMatchesFilter(cookie, details)) continue
        // Without a URL, Chrome still hands out only the cookies the extension may see.
        if (details.url === undefined && !this.host.hostAccess(ext, cookieUrl(cookie))) continue
        out.set(cookieKey(cookie), cookie)
      }
    }
    return sortCookies([...out.values()])
  }

  private async set(
    ext: AttachedExtension,
    caller: CookieCaller,
    raw: unknown
  ): Promise<ChromeCookie | null> {
    const details = normalize(() => normalizeSetDetails(raw))
    this.requireHostPermission(ext, details.url)
    const container = this.containerFor(ext, caller, details.storeId)
    const storeId = storeIdForContainer(container)
    const line = setCookieLine(details)
    const before = (await this.readUrl(container, details.url)).filter(
      (c) => c.name === details.name
    )
    const ok = await this.host.write(container, details.url, line)
    if (!ok) throw new Error(formatCookieError(ERROR_SET_FAILED, details.name))
    const after = await this.readUrl(container, details.url)
    const written = pickSetCookie(
      after.filter((c) => c.name === details.name),
      details.path,
      details.domain
    )
    if (!written) throw new Error(formatCookieError(ERROR_SET_FAILED, details.name))
    const overwritten = before.find((c) => cookieKey(c) === cookieKey(written))
    if (overwritten)
      this.changed(storeId, { removed: true, cookie: overwritten, cause: 'overwrite' })
    this.changed(storeId, { removed: false, cookie: written, cause: 'explicit' })
    return written
  }

  private async remove(
    ext: AttachedExtension,
    caller: CookieCaller,
    raw: unknown
  ): Promise<{ url: string; name: string; storeId: string } | null> {
    const details = normalize(() => normalizeRemoveDetails(raw))
    this.requireHostPermission(ext, details.url)
    const container = this.containerFor(ext, caller, details.storeId)
    const storeId = storeIdForContainer(container)
    const cookies = (await this.readUrl(container, details.url)).filter(
      (c) => c.name === details.name
    )
    if (cookies.length === 0) return null
    // Chrome deletes the one a request to the URL would send first (the longest path).
    const cookie = sortCookies(cookies)[0]
    await this.host.write(container, cookieUrl(cookie), expiredLine(cookie))
    this.changed(storeId, { removed: true, cookie, cause: 'explicit' })
    return { url: details.url, name: details.name, storeId }
  }

  private getAllCookieStores(ext: AttachedExtension): Array<{ id: string; tabIds: number[] }> {
    const tabs = this.host.visibleTabs(ext)
    return this.storeIds(ext).map((id) => {
      const container = containerForStoreId(id)
      return {
        id,
        tabIds: tabs
          .filter((tab) => tab.containerId === container)
          .map((tab) => this.host.chromeTabId(tab.id))
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Jar readings and onChanged
  // ---------------------------------------------------------------------------

  private async readUrl(container: string, url: string): Promise<ChromeCookie[]> {
    const storeId = storeIdForContainer(container)
    const reading = await this.host.read(container, url)
    const out: ChromeCookie[] = []
    for (const line of reading.cookies) {
      const engine = reading.detailed ? parseSetCookie(line, url) : parsePair(line, url)
      if (engine) out.push(toChromeCookie(engine, storeId))
    }
    return out
  }

  private changed(
    storeId: string,
    info: { removed: boolean; cookie: ChromeCookie; cause: string }
  ): void {
    const url = cookieUrl(info.cookie)
    const isPrivate = storeId === storeIdForContainer(PRIVATE_CONTAINER_ID)
    for (const ext of this.host.allAttached()) {
      if (!ext.manifest.permissions.includes('cookies')) continue
      if (isPrivate && !ext.record.allowPrivate) continue
      if (!this.host.hostAccess(ext, url)) continue
      this.host.emit(ext.record.id, 'cookies', 'onChanged', [info])
    }
  }
}

/** Chrome's argument errors become `runtime.lastError` messages, verbatim. */
function normalize<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof CookieError) throw new Error(error.message)
    throw error
  }
}

function cookieKey(cookie: ChromeCookie): string {
  return `${cookie.name}\n${cookie.domain}\n${cookie.path}`
}

/** After `set`, the cookie that was written: same path and (when given) domain as requested. */
function pickSetCookie(
  cookies: ChromeCookie[],
  path: string | undefined,
  domain: string | undefined
): ChromeCookie | undefined {
  const wantedDomain = domain?.replace(/^\./, '').toLowerCase()
  return (
    cookies.find((cookie) => {
      if (path !== undefined && cookie.path !== path) return false
      if (wantedDomain !== undefined && cookie.domain.replace(/^\./, '') !== wantedDomain)
        return false
      return true
    }) ?? sortCookies(cookies)[0]
  )
}

/** The URLs a `domain` filter is read through: the domain itself, over both schemes. */
function domainUrls(domain: string): string[] {
  const host = domain.replace(/^\./, '').toLowerCase()
  if (!host) return []
  return [`https://${host}/`, `http://${host}/`]
}

/**
 * The URLs an unfiltered `getAll` reads: one per concrete host an extension's patterns name
 * (`*.example.com` reads `example.com`, where its domain cookies live). Wildcard hosts name none.
 */
export function permittedUrls(patterns: readonly string[]): string[] {
  const out = new Set<string>()
  for (const pattern of patterns) {
    const separator = pattern.indexOf('://')
    if (separator <= 0) continue
    const scheme = pattern.slice(0, separator)
    if (scheme !== '*' && scheme !== 'http' && scheme !== 'https') continue
    const rest = pattern.slice(separator + 3)
    const slash = rest.indexOf('/')
    if (slash < 0) continue
    let host = rest
      .slice(0, slash)
      .replace(/:(\d+|\*)$/, '')
      .toLowerCase()
    if (host.startsWith('*.')) host = host.slice(2)
    if (!host || host.includes('*')) continue
    const schemes = scheme === '*' ? ['https', 'http'] : [scheme]
    for (const s of schemes) out.add(`${s}://${host}/`)
  }
  return [...out]
}

// ---------------------------------------------------------------------------
// Set-Cookie syntax
// ---------------------------------------------------------------------------

/** The `Set-Cookie` line that stores what a `cookies.set` asked for. */
export function setCookieLine(details: {
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: string
  expirationDate?: number
}): string {
  const parts = [`${details.name}=${details.value}`]
  if (details.domain !== undefined && details.domain !== '') parts.push(`Domain=${details.domain}`)
  if (details.path !== undefined && details.path !== '') parts.push(`Path=${details.path}`)
  if (details.expirationDate !== undefined) {
    parts.push(`Expires=${new Date(details.expirationDate * 1000).toUTCString()}`)
  }
  if (details.secure) parts.push('Secure')
  if (details.httpOnly) parts.push('HttpOnly')
  switch (details.sameSite) {
    case 'no_restriction':
      parts.push('SameSite=None')
      break
    case 'lax':
      parts.push('SameSite=Lax')
      break
    case 'strict':
      parts.push('SameSite=Strict')
      break
  }
  return parts.join('; ')
}

/** The `Set-Cookie` line that removes `cookie`: the same name, domain and path, already expired. */
export function expiredLine(cookie: ChromeCookie): string {
  const parts = [
    `${cookie.name}=`,
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
    `Path=${cookie.path || '/'}`
  ]
  if (!cookie.hostOnly) parts.push(`Domain=${cookie.domain}`)
  if (cookie.secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * One cookie in `Set-Cookie` syntax, as `CookieManagerCompat.getCookieInfo` lists them, read
 * against the URL it was asked for: a `Domain` attribute makes a domain cookie (Chrome keeps
 * those with a leading dot), none a host-only cookie of the URL's host; the path defaults to
 * the URL's directory (RFC 6265 §5.1.4); `Expires` / `Max-Age` make it persistent.
 */
export function parseSetCookie(line: string, url: string, now = Date.now()): EngineCookie | null {
  const parts = line.split(';')
  const first = parts.shift()?.trim() ?? ''
  const eq = first.indexOf('=')
  const name = eq === -1 ? '' : first.slice(0, eq).trim()
  const value = eq === -1 ? first : first.slice(eq + 1).trim()
  if (!name && !value) return null
  const requestHost = hostOf(url)
  const cookie: EngineCookie = {
    name,
    value,
    domain: requestHost,
    hostOnly: true,
    path: defaultPath(url),
    secure: false,
    httpOnly: false,
    session: true,
    sameSite: 'unspecified'
  }
  for (const part of parts) {
    const attr = part.trim()
    if (!attr) continue
    const at = attr.indexOf('=')
    const key = (at === -1 ? attr : attr.slice(0, at)).trim().toLowerCase()
    const attrValue = at === -1 ? '' : attr.slice(at + 1).trim()
    switch (key) {
      case 'domain': {
        const domain = attrValue.toLowerCase()
        if (!domain) break
        if (domain.startsWith('.')) {
          cookie.domain = domain
          cookie.hostOnly = false
        } else if (domain === requestHost) {
          cookie.domain = domain
          cookie.hostOnly = true
        } else {
          cookie.domain = `.${domain}`
          cookie.hostOnly = false
        }
        break
      }
      case 'path':
        if (attrValue.startsWith('/')) cookie.path = attrValue
        break
      case 'expires': {
        const at = Date.parse(attrValue)
        if (Number.isFinite(at) && cookie.session) {
          cookie.session = false
          cookie.expirationDate = Math.floor(at / 1000)
        }
        break
      }
      case 'max-age': {
        const seconds = Number(attrValue)
        if (Number.isFinite(seconds)) {
          // Max-Age wins over Expires, as in the RFC.
          cookie.session = false
          cookie.expirationDate = Math.floor(now / 1000) + Math.floor(seconds)
        }
        break
      }
      case 'secure':
        cookie.secure = true
        break
      case 'httponly':
        cookie.httpOnly = true
        break
      case 'samesite':
        switch (attrValue.toLowerCase()) {
          case 'none':
            cookie.sameSite = 'no_restriction'
            break
          case 'lax':
            cookie.sameSite = 'lax'
            break
          case 'strict':
            cookie.sameSite = 'strict'
            break
          default:
            cookie.sameSite = 'unspecified'
        }
        break
    }
  }
  return cookie
}

/** A `name=value` pair from `CookieManager.getCookie`: host-only on the URL's host, at `/`, session; the rest unknown. */
function parsePair(pair: string, url: string): EngineCookie | null {
  const part = pair.trim()
  if (!part) return null
  const eq = part.indexOf('=')
  return {
    name: eq === -1 ? '' : part.slice(0, eq).trim(),
    value: eq === -1 ? part : part.slice(eq + 1),
    domain: hostOf(url),
    hostOnly: true,
    path: '/',
    secure: url.startsWith('https:'),
    httpOnly: false,
    session: true,
    sameSite: 'unspecified'
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** RFC 6265 §5.1.4: the request path up to (not including) its last `/`, or `/`. */
function defaultPath(url: string): string {
  let path = '/'
  try {
    path = new URL(url).pathname
  } catch {
    return '/'
  }
  if (!path.startsWith('/')) return '/'
  const last = path.lastIndexOf('/')
  return last <= 0 ? '/' : path.slice(0, last)
}
