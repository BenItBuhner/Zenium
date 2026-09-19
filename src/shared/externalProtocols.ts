/**
 * Links that leave the web. A page may hand `mailto:`, `tel:`, `market:` or a custom scheme to
 * the app registered for it – after the user agreed in the external-protocol sheet – but must
 * never reach the schemes that name the browser's own or the device's private resources.
 */

export type ExternalUrlClass =
  /** `http(s)`: stays in a tab. */
  | { kind: 'web'; scheme: 'http' | 'https' }
  /** Never handed out of the browser. */
  | { kind: 'blocked'; scheme: string }
  /** Handled by another app, after confirmation. */
  | { kind: 'external'; scheme: string; label: string | null; canRemember: boolean }

/**
 * Schemes a page has no business opening outside of itself. `zen` and its user-facing alias
 * `zenium` name the browser's own pages: web content may not open `zenium://settings/privacy`,
 * as it may not open `chrome://settings` in Chrome (the Android host refuses the navigation in
 * `shouldOverrideUrlLoading`; a `window.open` to it is denied in `core/windowOpen.ts`).
 */
const BLOCKED_SCHEMES = new Set([
  'about',
  'blob',
  'chrome',
  'chrome-extension',
  'content',
  'data',
  'file',
  'filesystem',
  'javascript',
  'view-source',
  'ws',
  'wss',
  'zen',
  'zenium'
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
