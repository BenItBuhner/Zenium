import type { HomepageMode, HomepageSettings } from './types'
import { displayUrl, inputToUrl } from './url'

/**
 * The homepage setting (SET-36 / NTP-30, Chrome's and Edge's "Homepage"): the mode a Home
 * action follows and the page a `url` homepage opens. Shared by the core (the sanitiser on load
 * and on every patch, the Home command's destination) and the chrome (the Settings rows, the
 * bar's Home button).
 */

export const HOMEPAGE_MODES: readonly HomepageMode[] = ['off', 'newtab', 'url']

export const DEFAULT_HOMEPAGE: HomepageSettings = { mode: 'newtab', url: '' }

export function isHomepageMode(value: unknown): value is HomepageMode {
  return typeof value === 'string' && (HOMEPAGE_MODES as readonly string[]).includes(value)
}

/**
 * What was typed for the homepage as the address it stands for: `example.com` becomes
 * `https://example.com/`, a full address keeps its path and query; null for anything that is
 * not a web page – the Home action loads a page, so an internal page, a search or an empty
 * field is refused (Chrome accepts web addresses alone here too).
 */
export function homepageAddress(input: string): string | null {
  const address = inputToUrl(input.trim())
  if (!address || !/^https?:\/\//i.test(address)) return null
  try {
    return new URL(address).href
  } catch {
    return null
  }
}

/**
 * The setting as read from disk or a peer: a mode this build does not know reads as the
 * default's (the new tab page), an address that is not a web page's as none.
 */
export function sanitizeHomepage(raw: unknown): HomepageSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_HOMEPAGE }
  const { mode, url } = raw as Record<string, unknown>
  return {
    mode: isHomepageMode(mode) ? mode : DEFAULT_HOMEPAGE.mode,
    url: typeof url === 'string' ? (homepageAddress(url) ?? '') : ''
  }
}

/** Whether the setting names a page of the user's that a Home action can open. */
export function homepageHasPage(homepage: HomepageSettings): boolean {
  return homepage.mode === 'url' && homepage.url !== ''
}

/** The homepage as the Settings row shows it: the page's address without its scheme, or nothing. */
export function homepageDisplay(homepage: HomepageSettings): string {
  return homepageHasPage(homepage) ? displayUrl(homepage.url).replace(/\/$/, '') : ''
}
