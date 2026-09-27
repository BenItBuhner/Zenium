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

const INTENT_MARK = '#Intent;'

/**
 * The `name=value` pairs of an `intent:` URL's `#Intent;…end` part, in the shape Android's
 * `Intent.parseUri` reads (the parser behind Chrome's external navigation and the Android host's
 * `ExternalProtocols.parse`): after the LAST `#`, `Intent;`, then `;`-terminated pairs up to
 * `end`. A URL without the part, or with a part that never reaches `end`, is no intent to that
 * parser – Chrome loads it as it is and fails on the scheme, the host answers `handler: 'none'`
 * – so it carries nothing here either: null. Values are as written (the caller decodes what it
 * needs); the first of a repeated name counts. Never throws.
 */
function intentExtras(url: string): Map<string, string> | null {
  if (schemeOf(url) !== 'intent') return null
  const trimmed = url.trim()
  const hash = trimmed.lastIndexOf('#')
  if (hash < 0 || !trimmed.startsWith(INTENT_MARK, hash)) return null
  const out = new Map<string, string>()
  let at = hash + INTENT_MARK.length
  while (!trimmed.startsWith('end', at)) {
    const semi = trimmed.indexOf(';', at)
    if (semi < 0) return null
    const pair = trimmed.slice(at, semi)
    const eq = pair.indexOf('=')
    if (eq > 0 && !out.has(pair.slice(0, eq))) out.set(pair.slice(0, eq), pair.slice(eq + 1))
    at = semi + 1
  }
  return out
}

/**
 * The `S.browser_fallback_url` an `intent://` URL carries, when it is a web address; null for
 * anything else, a malformed intent included – never a throw.
 */
export function intentFallbackUrl(url: string): string | null {
  const raw = intentExtras(url)?.get('S.browser_fallback_url')
  if (!raw) return null
  try {
    const fallback = decodeURIComponent(raw)
    return /^https?:\/\//i.test(fallback) ? fallback : null
  } catch {
    return null
  }
}

/**
 * The `package=` an `intent://` URL names (the app it wants; its store listing when missing):
 * a package-name token, else null – a malformed intent included, never a throw.
 */
export function intentPackage(url: string): string | null {
  const pkg = intentExtras(url)?.get('package')
  return pkg && /^[a-zA-Z0-9_.]+$/.test(pkg) ? pkg : null
}
