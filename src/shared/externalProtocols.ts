/**
 * Links that leave the web. A page may hand `mailto:`, `tel:`, `magnet:`, `ms-*`, `market:` or a
 * custom scheme to the app registered for it – after the user agreed – but must never reach the
 * schemes that name the browser's own or the device's private resources.
 *
 * Desktop stores an "Always allow" decision next to camera / location in permissions.json as
 * `<origin>|external:<scheme>` (private windows never persist). Android remembers at scheme
 * level in `settings.externalProtocols`.
 */

export type ExternalUrlClass =
  /** `http(s)`: stays in a tab. */
  | { kind: 'web'; scheme: 'http' | 'https' }
  /** Never handed out of the browser. */
  | { kind: 'blocked'; scheme: string }
  /** Handled by another app, after confirmation. */
  | { kind: 'external'; scheme: string; label: string | null; canRemember: boolean }

/** Schemes a page has no business opening outside of itself. */
const BLOCKED_SCHEMES = new Set([
  'about',
  'blob',
  'chrome',
  'chrome-extension',
  'content',
  'data',
  'devtools',
  'file',
  'filesystem',
  'ftp',
  'javascript',
  'view-source',
  'ws',
  'wss',
  'zen'
])

/** What the sheet calls the common schemes, so "Open in another app?" says what would open. */
const SCHEME_LABELS: Record<string, string> = {
  mailto: 'email address',
  tel: 'phone number',
  sms: 'text message',
  smsto: 'text message',
  mms: 'text message',
  mmsto: 'text message',
  market: 'Play Store listing',
  geo: 'map location',
  intent: 'app link',
  'android-app': 'app link'
}

/**
 * Schemes whose target changes with every link (`intent://` names an app itself): "always allow"
 * would cover every app at once, so the sheet does not offer it.
 */
const NEVER_REMEMBER = new Set(['intent', 'android-app'])

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i

/** The scheme of `url`, lower-case, or null when it has none. */
export function schemeOf(url: string): string | null {
  const match = SCHEME_RE.exec(url.trim())
  return match ? match[1].toLowerCase() : null
}

export function classifyExternalUrl(url: string): ExternalUrlClass {
  const scheme = schemeOf(url)
  if (scheme === null) return { kind: 'blocked', scheme: '' }
  if (scheme === 'http' || scheme === 'https') return { kind: 'web', scheme }
  if (BLOCKED_SCHEMES.has(scheme)) return { kind: 'blocked', scheme }
  return {
    kind: 'external',
    scheme,
    label: SCHEME_LABELS[scheme] ?? null,
    canRemember: !NEVER_REMEMBER.has(scheme)
  }
}

/** The scheme (lower-case, no colon) when `url` belongs to another application, else null. */
export function externalScheme(url: string): string | null {
  const cls = classifyExternalUrl(url)
  return cls.kind === 'external' ? cls.scheme : null
}

export function isExternalUrl(url: string): boolean {
  return classifyExternalUrl(url).kind === 'external'
}

export const EXTERNAL_PERMISSION_PREFIX = 'external:'

/**
 * The permission an "Always allow" decision is stored under, next to camera / location in
 * permissions.json: `<origin>|external:<scheme>`.
 */
export function externalPermission(scheme: string): string {
  return `${EXTERNAL_PERMISSION_PREFIX}${scheme.toLowerCase()}`
}

/** Inverse of `externalPermission`; null for ordinary permissions. */
export function externalPermissionScheme(permission: string): string | null {
  if (!permission.startsWith(EXTERNAL_PERMISSION_PREFIX)) return null
  const scheme = permission.slice(EXTERNAL_PERMISSION_PREFIX.length)
  return scheme ? scheme : null
}

/** "Open mailto links" for the site-information sheet; null for ordinary permissions. */
export function externalPermissionLabel(permission: string): string | null {
  const scheme = externalPermissionScheme(permission)
  return scheme ? `Open ${scheme} links` : null
}

/** The `S.browser_fallback_url` an `intent://` URL carries, when it is a web address. */
export function intentFallbackUrl(url: string): string | null {
  if (schemeOf(url) !== 'intent') return null
  const match = /[;#]S\.browser_fallback_url=([^;#]+)/.exec(url)
  if (!match) return null
  try {
    const fallback = decodeURIComponent(match[1])
    return /^https?:\/\//i.test(fallback) ? fallback : null
  } catch {
    return null
  }
}

/** The `package=` an `intent://` URL names (the app it wants; its store listing when missing). */
export function intentPackage(url: string): string | null {
  if (schemeOf(url) !== 'intent') return null
  const match = /[;#]package=([a-zA-Z0-9_.]+)(?=[;#]|$)/.exec(url)
  return match ? match[1] : null
}
