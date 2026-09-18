/**
 * How the desktop browser presents itself to sites, shaped after Chrome: the user-agent string,
 * the low-entropy user-agent client hints and the `Accept-Language` list. Pure functions, so
 * the Electron host and the tests share them; the Android host has its own Kotlin twin
 * (`UserAgent.kt`) because the system WebView's string starts from a different place.
 *
 * Chrome's shape matters beyond looks: sites take an unreduced `Chrome/152.0.7977.78`, a
 * navigation without `Sec-CH-UA` or an `Accept-Language` without the base language as the marks
 * of an embedded Chromium and serve degraded pages – Google's sign-in refuses outright.
 */

/**
 * The plain Chrome user agent for Electron's default string: the `Electron/x.y.z` and
 * `<app>/<version>` product tokens go, and the Chrome version is reduced to `<major>.0.0.0`,
 * which is what every Chrome since 101 sends (the full version lives in the client hints, where
 * Electron reports it already). A string already in Chrome's shape passes unchanged.
 */
export function chromeUserAgent(fallback: string, appName: string): string {
  return fallback
    .replace(/\sElectron\/[\d.]+/, '')
    .replace(new RegExp(`\\s${escapeRegExp(appName)}\\/[\\d.]+`), '')
    .replace(/Chrome\/(\d+)(?:\.\d+)+/, 'Chrome/$1.0.0.0')
}

/** A user-agent client hints brand entry (`Sec-CH-UA`, `Sec-CH-UA-Full-Version-List`). */
export interface ClientHintBrand {
  brand: string
  version: string
}

const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_']
const GREASE_VERSIONS = ['8', '99', '24']

/**
 * The brand list Chromium builds for a Chromium-branded build (Electron is one): a GREASE entry
 * and `Chromium`, both in a stable order seeded by the major version – the same algorithm as
 * `GenerateBrandVersionList` in components/embedder_support/user_agent_utils.cc, so a header
 * written from it matches what the renderer puts on its own requests. `full` gives the
 * `Sec-CH-UA-Full-Version-List` form (full Chromium version, `<n>.0.0.0` for the GREASE entry).
 */
export function chromiumBrands(chromiumVersion: string, full = false): ClientHintBrand[] {
  const major = chromiumVersion.split('.')[0]
  const seed = Number.parseInt(major, 10) || 0
  const greaseVersion = GREASE_VERSIONS[seed % GREASE_VERSIONS.length]
  const grease: ClientHintBrand = {
    brand: `Not${GREASE_CHARS[seed % GREASE_CHARS.length]}A${GREASE_CHARS[(seed + 1) % GREASE_CHARS.length]}Brand`,
    version: full ? `${greaseVersion}.0.0.0` : greaseVersion
  }
  const chromium: ClientHintBrand = {
    brand: 'Chromium',
    version: full ? normalizeVersion(chromiumVersion) : major
  }
  // GetRandomOrder for two entries: {seed % 2, (seed + 1) % 2}; shuffled[order[i]] = list[i].
  const list = [grease, chromium]
  const shuffled: ClientHintBrand[] = []
  list.forEach((entry, i) => {
    shuffled[(seed + i) % 2] = entry
  })
  return shuffled
}

/** `"Not?A_Brand";v="24", "Chromium";v="152"`: a brand list as a structured-header value. */
export function formatBrands(brands: readonly ClientHintBrand[]): string {
  return brands.map((entry) => `"${entry.brand}";v="${entry.version}"`).join(', ')
}

/** `Sec-CH-UA-Platform` for a Node / Electron `process.platform` (Chromium's platform names). */
export function clientHintPlatform(platform: string): string {
  switch (platform) {
    case 'win32':
      return 'Windows'
    case 'darwin':
      return 'macOS'
    case 'android':
      return 'Android'
    default:
      return 'Linux'
  }
}

/**
 * The low-entropy client hints Chrome puts on every request, navigations included, by their wire
 * names in Chrome's casing. Electron's renderer adds them to the requests it makes itself but
 * the browser-side navigation requests go out without any (there is no client-hints delegate),
 * which no Chrome has done since 89; the host adds these to such requests.
 */
export function lowEntropyClientHints(
  chromiumVersion: string,
  platform: string
): Record<string, string> {
  return {
    'sec-ch-ua': formatBrands(chromiumBrands(chromiumVersion)),
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${clientHintPlatform(platform)}"`
  }
}

/** Whether a header map already carries the `Sec-CH-UA` brand list (any casing). */
export function hasClientHints(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === 'sec-ch-ua')
}

/** A language tag as `Accept-Language` takes it: `en`, `en-US`, `zh-Hant-TW`, `es-419`. */
const LANGUAGE_TAG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

/**
 * Chrome's `Accept-Language` list for the system's languages: the application locale first,
 * then the user's preferred languages, each region variant followed by its base language when
 * the list does not name it (`net::HttpUtil::ExpandLanguageList`), without duplicates. Entries
 * that are not language tags (a POSIX `C` or `POSIX` locale, a bare charset) are dropped, and
 * `en_US` spellings become `en-US`. The network layer turns `en-US,en` into `en-US,en;q=0.9`,
 * the header every en-US Chrome sends.
 */
export function acceptLanguages(locale: string, preferred: readonly string[]): string {
  const out: string[] = []
  const add = (tag: string): void => {
    if (!LANGUAGE_TAG_RE.test(tag)) return
    if (out.some((have) => have.toLowerCase() === tag.toLowerCase())) return
    out.push(tag)
  }
  for (const raw of [locale, ...preferred]) {
    const tag = raw
      .trim()
      .replace(/_/g, '-')
      .replace(/[.@].*$/, '')
    add(tag)
    const dash = tag.indexOf('-')
    if (dash > 0) add(tag.slice(0, dash))
  }
  return out.length > 0 ? out.join(',') : 'en-US,en'
}

function normalizeVersion(version: string): string {
  const parts = version.split('.').filter((part) => /^\d+$/.test(part))
  while (parts.length < 4) parts.push('0')
  return parts.slice(0, 4).join('.')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
