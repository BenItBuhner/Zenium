/**
 * `chrome.cookies`, the host-neutral part: Chrome's argument validation and defaults for `get`,
 * `getAll`, `set` and `remove`, the `Cookie` shape the API returns, the `getAll` filter (Chrome's
 * `cookies_helpers.cc` domain and session matching) and the `onChanged` cause names. Hosts own the
 * cookie jar (Electron's `session.cookies`) and the store ids.
 */
import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID } from '../../../shared/types'

export type CookieSameSite = 'no_restriction' | 'lax' | 'strict' | 'unspecified'

export type CookieChangeCause =
  'evicted' | 'expired' | 'explicit' | 'expired_overwrite' | 'overwrite'

/** `cookies.Cookie` as extensions see it. */
export interface ChromeCookie {
  name: string
  value: string
  domain: string
  hostOnly: boolean
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: CookieSameSite
  session: boolean
  expirationDate?: number
  storeId: string
}

/** A cookie as the engine reports it (Electron's `Cookie` fields, all optional but name/value). */
export interface EngineCookie {
  name: string
  value: string
  domain?: string
  hostOnly?: boolean
  path?: string
  secure?: boolean
  httpOnly?: boolean
  session?: boolean
  expirationDate?: number
  sameSite?: string
}

export interface CookieGetDetails {
  url: string
  name: string
  storeId: string | null
}

export interface CookieGetAllDetails {
  url?: string
  name?: string
  domain?: string
  path?: string
  secure?: boolean
  session?: boolean
  storeId: string | null
}

export interface CookieSetDetails {
  url: string
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: CookieSameSite
  expirationDate?: number
  storeId: string | null
}

export class CookieError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CookieError'
  }
}

export const ERROR_INVALID_URL = 'Invalid url: "*".'
export const ERROR_NO_HOST_PERMISSION = 'No host permissions for cookies at url: "*".'
export const ERROR_INVALID_STORE_ID = 'Invalid cookie store id: "*".'
export const ERROR_NO_COOKIE_STORE =
  'No accessible cookie store found for the current execution context.'
export const ERROR_SET_FAILED = 'Failed to parse or set cookie named "*".'

export function formatCookieError(template: string, arg: string): string {
  return template.replace('*', arg)
}

const COOKIEABLE_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:', 'file:'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Chrome accepts a URL for cookie calls when it parses and has a scheme cookies apply to. */
export function isCookieUrl(url: string): boolean {
  try {
    return COOKIEABLE_SCHEMES.has(new URL(url).protocol)
  } catch {
    return false
  }
}

function readUrl(raw: Record<string, unknown>, required: boolean): string | undefined {
  const url = raw.url
  if (url === undefined) {
    if (required) throw new CookieError("Missing required property 'url'.")
    return undefined
  }
  if (typeof url !== 'string' || !isCookieUrl(url)) {
    throw new CookieError(
      formatCookieError(ERROR_INVALID_URL, typeof url === 'string' ? url : String(url))
    )
  }
  return url
}

function readString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new CookieError(`Invalid value for '${key}'.`)
  return value
}

function readBoolean(raw: Record<string, unknown>, key: string): boolean | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new CookieError(`Invalid value for '${key}'.`)
  return value
}

function readStoreId(raw: Record<string, unknown>): string | null {
  const value = raw.storeId
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new CookieError(`Invalid value for 'storeId'.`)
  return value
}

export function normalizeGetDetails(raw: unknown): CookieGetDetails {
  if (!isRecord(raw)) throw new CookieError('Invalid details.')
  const url = readUrl(raw, true) as string
  const name = readString(raw, 'name')
  if (name === undefined) throw new CookieError("Missing required property 'name'.")
  return { url, name, storeId: readStoreId(raw) }
}

export function normalizeGetAllDetails(raw: unknown): CookieGetAllDetails {
  if (raw === undefined || raw === null) return { storeId: null }
  if (!isRecord(raw)) throw new CookieError('Invalid details.')
  const out: CookieGetAllDetails = { storeId: readStoreId(raw) }
  const url = readUrl(raw, false)
  if (url !== undefined) out.url = url
  const name = readString(raw, 'name')
  if (name !== undefined) out.name = name
  const domain = readString(raw, 'domain')
  if (domain !== undefined) out.domain = domain
  const path = readString(raw, 'path')
  if (path !== undefined) out.path = path
  const secure = readBoolean(raw, 'secure')
  if (secure !== undefined) out.secure = secure
  const session = readBoolean(raw, 'session')
  if (session !== undefined) out.session = session
  return out
}

const SAME_SITE_VALUES: readonly CookieSameSite[] = [
  'no_restriction',
  'lax',
  'strict',
  'unspecified'
]

export function normalizeSetDetails(raw: unknown): CookieSetDetails {
  if (!isRecord(raw)) throw new CookieError('Invalid details.')
  const url = readUrl(raw, true) as string
  const out: CookieSetDetails = {
    url,
    name: readString(raw, 'name') ?? '',
    value: readString(raw, 'value') ?? '',
    storeId: readStoreId(raw)
  }
  const domain = readString(raw, 'domain')
  if (domain !== undefined) out.domain = domain
  const path = readString(raw, 'path')
  if (path !== undefined) out.path = path
  const secure = readBoolean(raw, 'secure')
  if (secure !== undefined) out.secure = secure
  const httpOnly = readBoolean(raw, 'httpOnly')
  if (httpOnly !== undefined) out.httpOnly = httpOnly
  if (raw.sameSite !== undefined && raw.sameSite !== null) {
    if (!SAME_SITE_VALUES.includes(raw.sameSite as CookieSameSite)) {
      throw new CookieError("Invalid value for 'sameSite'.")
    }
    out.sameSite = raw.sameSite as CookieSameSite
  }
  if (raw.expirationDate !== undefined && raw.expirationDate !== null) {
    if (typeof raw.expirationDate !== 'number' || !Number.isFinite(raw.expirationDate)) {
      throw new CookieError("Invalid value for 'expirationDate'.")
    }
    out.expirationDate = raw.expirationDate
  }
  return out
}

export function normalizeRemoveDetails(raw: unknown): CookieGetDetails {
  return normalizeGetDetails(raw)
}

/** Chrome's `cookies.Cookie` from an engine cookie. */
export function toChromeCookie(cookie: EngineCookie, storeId: string): ChromeCookie {
  const domain = cookie.domain ?? ''
  const hostOnly = cookie.hostOnly ?? !domain.startsWith('.')
  const session = cookie.session ?? cookie.expirationDate === undefined
  const out: ChromeCookie = {
    name: cookie.name,
    value: cookie.value,
    domain,
    hostOnly,
    path: cookie.path ?? '/',
    secure: cookie.secure ?? false,
    httpOnly: cookie.httpOnly ?? false,
    sameSite: toSameSite(cookie.sameSite),
    session,
    storeId
  }
  if (!session && cookie.expirationDate !== undefined) out.expirationDate = cookie.expirationDate
  return out
}

function toSameSite(value: string | undefined): CookieSameSite {
  switch (value) {
    case 'no_restriction':
    case 'lax':
    case 'strict':
      return value
    default:
      return 'unspecified'
  }
}

/**
 * Chrome's domain filter (`cookies_helpers::DomainMatches`): the cookie's domain equals the filter
 * or is a sub-domain of it; leading dots on either side do not matter.
 */
export function cookieDomainMatches(cookieDomain: string, filter: string): boolean {
  const wanted = (filter.startsWith('.') ? filter : `.${filter}`).toLowerCase()
  const actual = (cookieDomain.startsWith('.') ? cookieDomain : `.${cookieDomain}`).toLowerCase()
  return actual === wanted || actual.endsWith(wanted)
}

/** The in-memory part of a `getAll` filter (the host applies `url` through the cookie jar). */
export function cookieMatchesFilter(cookie: ChromeCookie, details: CookieGetAllDetails): boolean {
  if (details.name !== undefined && cookie.name !== details.name) return false
  if (details.domain !== undefined && !cookieDomainMatches(cookie.domain, details.domain))
    return false
  if (details.path !== undefined && cookie.path !== details.path) return false
  if (details.secure !== undefined && cookie.secure !== details.secure) return false
  if (details.session !== undefined && cookie.session !== details.session) return false
  return true
}

/**
 * Chrome orders `getAll` results like the cookie monster: longer paths first, then older cookies
 * first. Engines keep creation order internally, so a stable sort on the path is the closest.
 */
export function sortCookies(cookies: ChromeCookie[]): ChromeCookie[] {
  return [...cookies].sort((a, b) => b.path.length - a.path.length)
}

/** Electron's `changed` causes, mapped onto Chrome's `OnChangedCause` names. */
export function toChangeCause(cause: string): CookieChangeCause {
  switch (cause) {
    case 'overwrite':
      return 'overwrite'
    case 'expired':
      return 'expired'
    case 'evicted':
      return 'evicted'
    case 'expired-overwrite':
    case 'expired_overwrite':
      return 'expired_overwrite'
    default:
      return 'explicit'
  }
}

/**
 * The URL a cookie applies to, for host-permission checks and for `remove`: Chrome's
 * `cookies_helpers::GetURLFromCanonicalCookie` (scheme from `secure`, the domain without its
 * leading dot, the cookie's path).
 */
export function cookieUrl(cookie: Pick<ChromeCookie, 'domain' | 'secure' | 'path'>): string {
  const host = cookie.domain.replace(/^\./, '')
  return `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`
}

/**
 * Chrome's cookie store ids: `"0"` for the regular profile, `"1"` for incognito. Zenium maps its
 * default container to `"0"`, the private session to `"1"` and every other container to its own
 * id, so ids stay stable across restarts.
 */
export function storeIdForContainer(containerId: string): string {
  if (containerId === DEFAULT_CONTAINER_ID) return '0'
  if (containerId === PRIVATE_CONTAINER_ID) return '1'
  return containerId
}

export function containerForStoreId(storeId: string): string {
  if (storeId === '0') return DEFAULT_CONTAINER_ID
  if (storeId === '1') return PRIVATE_CONTAINER_ID
  return storeId
}
