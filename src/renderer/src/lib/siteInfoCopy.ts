import type { Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'
import { builtInDefault } from '@shared/contentSettings'
import {
  cookieBytes,
  describeSite,
  formatBytes,
  type SiteInfoSnapshot,
  type SiteSecurity
} from '@shared/siteInfo'
import type { MenulistOption } from '@renderer/components/siteControls/primitives'

/**
 * The words of the desktop site-information popover (`components/siteControls/SiteInfoPopover`):
 * what the connection, cookies, blocking and permission rows say, kept apart from the rendering
 * so they can be read and tested on their own.
 */

/** The popover's levels: the overview and the four it pushes in to. */
export type LevelId =
  'overview' | 'connection' | 'cookies' | 'permissions' | 'clear-data' | 'clear-cookies'

export function security(info: SiteInfoSnapshot | null, url: string): SiteSecurity {
  if (info) return info.security
  return { state: describeSite(url).state, certificate: null, mixedContent: null }
}

/** "Secure connection", "Not secure", … as the connection row and level headline say it. */
export function connectionHeadline(s: SiteSecurity): string {
  switch (s.state) {
    case 'secure':
      return s.mixedContent ? 'Partly secure' : 'Secure'
    case 'insecure':
      return 'Not secure'
    case 'local':
      return 'Local page'
    case 'internal':
      return 'Zenium page'
    default:
      return 'Unknown'
  }
}

export function connectionDetail(s: SiteSecurity): string {
  switch (s.state) {
    case 'secure':
      return s.mixedContent
        ? 'The page is encrypted, but some of what it loaded came over a plain connection.'
        : 'Everything you send to this site is encrypted on the way.'
    case 'insecure':
      return 'What you send to this site can be read by anyone along the way.'
    case 'local':
      return 'Served from this device; nothing crosses the network.'
    case 'internal':
      return 'Built into the browser; no site is involved.'
    default:
      return 'Zenium could not tell how this page reached you.'
  }
}

/**
 * The title block's line: the connection, who vouched for it, and what sets this tab apart – a
 * container other than the default, or the private session.
 */
export function summaryLine(info: SiteInfoSnapshot | null, tab: Tab, state: UIState): string {
  const s = security(info, tab.url)
  const parts = [connectionHeadline(s)]
  if (s.state === 'secure' && s.certificate?.issuer) parts.push(s.certificate.issuer)
  if (info?.isPrivate) parts.push('Private tab')
  else if (tab.containerId !== DEFAULT_CONTAINER_ID) {
    const container = state.containers.find((c) => c.id === tab.containerId)?.name
    if (container) parts.push(container)
  }
  return parts.join(' · ')
}

/** "4 cookies · 542 B", "1.2 MB stored", "None". */
export function cookiesSummary(info: SiteInfoSnapshot): string {
  const cookies = info.cookies.items
  const parts: string[] = []
  if (cookies.length > 0)
    parts.push(
      `${cookies.length} cookie${cookies.length === 1 ? '' : 's'} · ${formatBytes(cookieBytes(cookies))}`
    )
  const stored = info.storage.usageBytes
  if (stored !== null && stored > 0) parts.push(`${formatBytes(stored)} stored`)
  else if (cookies.length === 0 && storesAnything(info)) parts.push('Stored data')
  return parts.length > 0 ? parts.join(' · ') : 'None'
}

/** Anything beyond quota-managed storage: Web Storage items or service workers. */
export function storesAnything(info: SiteInfoSnapshot): boolean {
  const s = info.storage
  return (
    (s.localStorageItems ?? 0) > 0 ||
    (s.sessionStorageItems ?? 0) > 0 ||
    (s.serviceWorkers ?? 0) > 0 ||
    s.origins.length > 0
  )
}

export function blockingSummary(info: SiteInfoSnapshot): string {
  const b = info.blocking
  if (!b.enabled) return 'Blocking off'
  if (b.excepted) return 'Off for this site'
  return String(b.blockedCount)
}

export type PermissionChoice = 'allow' | 'deny' | 'default'

/** Allow / Block / back to the default, the default named for what it is. */
export function permissionOptions(permission: string): MenulistOption<PermissionChoice>[] {
  const fallback = builtInDefault(permission)
  const label = fallback === 'ask' ? 'Ask' : fallback === 'allow' ? 'Allow' : 'Block'
  return [
    { value: 'default', label: `${label} (default)` },
    { value: 'allow', label: 'Allow' },
    { value: 'deny', label: 'Block' }
  ]
}

/** The levels, for the tests' `data-level` selectors. */
export const SITE_INFO_LEVELS: readonly LevelId[] = [
  'overview',
  'connection',
  'cookies',
  'permissions',
  'clear-data',
  'clear-cookies'
]
