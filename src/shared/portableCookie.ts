/**
 * A cookie as it moves between two of the user's browsers (`zen_cookies`): everything the
 * engine needs to set it again elsewhere. Only ever leaves a device sealed to the receiving
 * device's key (`core/agent/cookieTransfer.ts`).
 */
export interface PortableCookie {
  name: string
  value: string
  /** The cookie's domain; a leading dot marks a domain cookie. */
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  /** Seconds since the epoch; absent for a session cookie. */
  expirationDate?: number
  hostOnly?: boolean
}

/** Whether the cookie belongs to `site` (a registrable domain such as `github.com`). */
export function cookieOfSite(cookie: Pick<PortableCookie, 'domain'>, site: string): boolean {
  const domain = cookie.domain.replace(/^\./, '').toLowerCase()
  const s = site.replace(/^\./, '').toLowerCase()
  return domain === s || domain.endsWith(`.${s}`)
}

/** A site as an agent may name it – `github.com`, `https://github.com/x`, `.github.com` – or null. */
export function normalizeSite(input: string): string | null {
  let s = input.trim().toLowerCase()
  if (!s) return null
  try {
    if (s.includes('://')) s = new URL(s).hostname
  } catch {
    return null
  }
  s = s.replace(/^\.+/, '').replace(/\/.*$/, '').replace(/:\d+$/, '')
  if (s.startsWith('www.')) s = s.slice(4)
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null
}
