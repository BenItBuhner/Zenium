import type { Cookie, CookiesSetDetails, Session } from 'electron'
import {
  CookieError,
  ERROR_INVALID_STORE_ID,
  ERROR_NO_COOKIE_STORE,
  ERROR_NO_HOST_PERMISSION,
  ERROR_SET_FAILED,
  cookieMatchesFilter,
  cookieUrl,
  formatCookieError,
  normalizeGetAllDetails,
  normalizeGetDetails,
  normalizeRemoveDetails,
  normalizeSetDetails,
  sortCookies,
  storeIdForContainer,
  toChangeCause,
  toChromeCookie,
  type ChromeCookie
} from '../../../core/extensions/api/cookies'
import {
  ApiError,
  type ApiContext,
  type ApiHost,
  type LoadedExtension,
  type NamespaceHandlers
} from './types'

interface Store {
  id: string
  containerId: string
  session: Session
}

/**
 * `chrome.cookies` over Electron's `session.cookies`: one cookie store per Zenium container
 * partition (`"0"` for the default container, other containers by their id; the private session
 * holds no extensions and is no store), Chrome's argument checks and `getAll` filter from the
 * core module, host permissions per URL from the extension's explicit origins (Chrome does not
 * count `activeTab` here either), and `onChanged` from the sessions' `changed` events with
 * Chrome's cause names. `partitionKey` is accepted and ignored: Zenium partitions cookies per
 * container, never per top-level site.
 */
export class CookiesApi {
  private readonly attached = new WeakSet<Session>()

  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = {
    get: (ctx, details) => this.get(ctx, details),
    getAll: (ctx, details) => this.getAll(ctx, details),
    set: (ctx, details) => this.set(ctx, details),
    remove: (ctx, details) => this.remove(ctx, details),
    getAllCookieStores: (ctx) => this.getAllCookieStores(ctx)
  }

  // ---------------------------------------------------------------------------
  // Stores
  // ---------------------------------------------------------------------------

  private stores(): Store[] {
    return this.host.sessions.persistent().map(([containerId, session]) => ({
      id: storeIdForContainer(containerId),
      containerId,
      session
    }))
  }

  /** The store a call names, else the caller's own session's store. */
  private storeFor(ctx: ApiContext, storeId: string | null): Store {
    const stores = this.stores()
    if (storeId !== null) {
      const store = stores.find((s) => s.id === storeId)
      if (!store) throw new ApiError(formatCookieError(ERROR_INVALID_STORE_ID, storeId))
      if (!ctx.extension.sessions.includes(store.session)) {
        throw new ApiError(formatCookieError(ERROR_INVALID_STORE_ID, storeId))
      }
      return store
    }
    const own = stores.find((s) => s.session === ctx.session)
    if (!own) throw new ApiError(ERROR_NO_COOKIE_STORE)
    return own
  }

  // ---------------------------------------------------------------------------
  // Permissions
  // ---------------------------------------------------------------------------

  private requirePermission(ext: LoadedExtension): void {
    if (!this.host.grants(ext.id).permissions.includes('cookies')) {
      throw new ApiError("The 'cookies' permission is required.")
    }
  }

  /** A granted host permission or an `activeTab` grant, as Chrome's cookie access checks go. */
  private hasHostPermission(ext: LoadedExtension, url: string): boolean {
    return this.host.hostAccess(ext.id, url)
  }

  private requireHostPermission(ext: LoadedExtension, url: string): void {
    if (!this.hasHostPermission(ext, url)) {
      throw new ApiError(formatCookieError(ERROR_NO_HOST_PERMISSION, url))
    }
  }

  // ---------------------------------------------------------------------------
  // Routed calls
  // ---------------------------------------------------------------------------

  private async get(ctx: ApiContext, raw: unknown): Promise<ChromeCookie | null> {
    this.requirePermission(ctx.extension)
    const details = normalize(() => normalizeGetDetails(raw))
    this.requireHostPermission(ctx.extension, details.url)
    const store = this.storeFor(ctx, details.storeId)
    const cookies = await store.session.cookies.get({ url: details.url, name: details.name })
    // The engine already orders like the cookie monster (longest path, then oldest first).
    const first = cookies[0]
    return first ? toChromeCookie(first, store.id) : null
  }

  private async getAll(ctx: ApiContext, raw: unknown): Promise<ChromeCookie[]> {
    this.requirePermission(ctx.extension)
    const details = normalize(() => normalizeGetAllDetails(raw))
    if (details.url !== undefined) this.requireHostPermission(ctx.extension, details.url)
    const store = this.storeFor(ctx, details.storeId)
    const filter: { url?: string; name?: string } = {}
    if (details.url !== undefined) filter.url = details.url
    if (details.name !== undefined) filter.name = details.name
    const engineCookies = await store.session.cookies.get(filter)
    const out: ChromeCookie[] = []
    for (const engineCookie of engineCookies) {
      const cookie = toChromeCookie(engineCookie, store.id)
      if (!cookieMatchesFilter(cookie, details)) continue
      // Without a URL, Chrome still hands out only the cookies the extension may see.
      if (details.url === undefined && !this.hasHostPermission(ctx.extension, cookieUrl(cookie))) {
        continue
      }
      out.push(cookie)
    }
    return sortCookies(out)
  }

  private async set(ctx: ApiContext, raw: unknown): Promise<ChromeCookie | null> {
    this.requirePermission(ctx.extension)
    const details = normalize(() => normalizeSetDetails(raw))
    this.requireHostPermission(ctx.extension, details.url)
    const store = this.storeFor(ctx, details.storeId)
    const set: CookiesSetDetails = {
      url: details.url,
      name: details.name,
      value: details.value,
      sameSite: details.sameSite ?? 'unspecified'
    }
    if (details.domain !== undefined) set.domain = details.domain
    if (details.path !== undefined) set.path = details.path
    if (details.secure !== undefined) set.secure = details.secure
    if (details.httpOnly !== undefined) set.httpOnly = details.httpOnly
    if (details.expirationDate !== undefined) set.expirationDate = details.expirationDate
    try {
      await store.session.cookies.set(set)
    } catch {
      throw new ApiError(formatCookieError(ERROR_SET_FAILED, details.name))
    }
    const cookies = await store.session.cookies.get({ url: details.url, name: details.name })
    const match = pickSetCookie(cookies, details.path, details.domain)
    return match ? toChromeCookie(match, store.id) : null
  }

  private async remove(
    ctx: ApiContext,
    raw: unknown
  ): Promise<{ url: string; name: string; storeId: string } | null> {
    this.requirePermission(ctx.extension)
    const details = normalize(() => normalizeRemoveDetails(raw))
    this.requireHostPermission(ctx.extension, details.url)
    const store = this.storeFor(ctx, details.storeId)
    const cookies = await store.session.cookies.get({ url: details.url, name: details.name })
    if (cookies.length === 0) return null
    await store.session.cookies.remove(details.url, details.name)
    return { url: details.url, name: details.name, storeId: store.id }
  }

  private getAllCookieStores(ctx: ApiContext): Array<{ id: string; tabIds: number[] }> {
    this.requirePermission(ctx.extension)
    const out: Array<{ id: string; tabIds: number[] }> = []
    for (const store of this.stores()) {
      if (!ctx.extension.sessions.includes(store.session)) continue
      const tabIds = this.host.model
        .allTabs()
        .filter((tab) => tab.containerId === store.containerId)
        .map((tab) => this.host.model.chromeTabId(tab))
      out.push({ id: store.id, tabIds })
    }
    return out
  }

  // ---------------------------------------------------------------------------
  // onChanged
  // ---------------------------------------------------------------------------

  /** Follow one persistent session's cookie jar. */
  attachSession(ses: Session, containerId: string): void {
    if (this.attached.has(ses)) return
    this.attached.add(ses)
    const storeId = storeIdForContainer(containerId)
    ses.cookies.on('changed', (_event, cookie: Cookie, cause: string, removed: boolean) => {
      const chromeCookie = toChromeCookie(cookie, storeId)
      const url = cookieUrl(chromeCookie)
      const info = { removed, cookie: chromeCookie, cause: toChangeCause(cause) }
      this.host.broadcast('cookies', 'onChanged', (ext) => {
        if (!ext.sessions.includes(ses)) return null
        if (!this.host.grants(ext.id).permissions.includes('cookies')) return null
        if (!this.host.hostAccess(ext.id, url)) return null
        return [info]
      })
    })
  }
}

/** Chrome's argument errors become `runtime.lastError` messages, verbatim. */
function normalize<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof CookieError) throw new ApiError(error.message)
    throw error
  }
}

/** After `set`, the cookie that was written: same path and (when given) domain as requested. */
function pickSetCookie(
  cookies: Cookie[],
  path: string | undefined,
  domain: string | undefined
): Cookie | undefined {
  const wantedDomain = domain?.replace(/^\./, '').toLowerCase()
  return (
    cookies.find((cookie) => {
      if (path !== undefined && (cookie.path ?? '/') !== path) return false
      if (wantedDomain !== undefined) {
        const actual = (cookie.domain ?? '').replace(/^\./, '').toLowerCase()
        if (actual !== wantedDomain) return false
      }
      return true
    }) ?? cookies[0]
  )
}
