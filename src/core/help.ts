import { HELP_URL } from '../shared/links'
import type { Browser } from './browser'
import type { ZenWindow } from './window'

/**
 * Google's Safe Browsing report form, Chrome's Help › Report an unsafe site… target
 * (`IDC_REPORT_UNSAFE_SITE`, `HelpMenuModel::Build`; shortcuts-menus-123): Chrome opens a WebUI
 * feedback dialog of its own that pre-fills the tab's address and screenshot and posts to it;
 * Zenium has no such dialog and opens the form itself, the page's address in its `url` query
 * (services' word on #578). The form is a public page and needs no key, so the rows show whether
 * or not Safe Browsing is on – Chrome's own row hides with Safe Browsing off and in Incognito.
 */
export const REPORT_UNSAFE_SITE_FORM = 'https://safebrowsing.google.com/safebrowsing/report_phish/'

/**
 * The report form for `url`, or null when the page has no address the form can take: only an
 * http(s) page has one, so a `zen://` or `chrome://` page, a blank tab, a `file:`, `data:`,
 * `blob:`, `javascript:` or `ftp:` address, an empty or unparsable one, or no tab at all answers
 * null. Chrome gates nothing on the scheme – its dialog lets the user type another address –
 * the one difference in the row's showing. The Help rows of both menus read it for their state
 * and grey the row rather than hide it, the menu keeping its shape (§9.17, §9.30; the lead's
 * ruling on #588).
 */
export function reportUnsafeSiteUrl(url: string | null | undefined): string | null {
  if (!url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return `${REPORT_UNSAFE_SITE_FORM}?url=${encodeURIComponent(url)}`
}

/**
 * A help page in a new tab in front, a child of the window's active page – back returns there
 * – in that page's own container, so a private page's help stays private: the phone's Help
 * row's shape (`Menus.showPhoneMenu`), and Chrome's `ShowHelp`, which opens its help in a
 * singleton tab (`chrome_pages.cc`) rather than in another browser.
 */
export function openHelpTab(browser: Browser, url: string, win: ZenWindow): void {
  const active = browser.tabs.activeTabFor(win)
  browser.tabs.createTab(
    { url, active: true, openerTabId: active?.id, containerId: active?.containerId },
    win
  )
}

/** Zenium Help: `HELP_URL` in a new tab in front (the lead's ruling on #578). */
export function openHelp(browser: Browser, win: ZenWindow): void {
  openHelpTab(browser, HELP_URL, win)
}

/**
 * Report an Unsafe Site…: the Safe Browsing form for the window's active page in a new tab in
 * front. False – nothing opened – when the page is not one the form takes (`reportUnsafeSiteUrl`).
 */
export function openReportUnsafeSite(browser: Browser, win: ZenWindow): boolean {
  const url = reportUnsafeSiteUrl(browser.tabs.activeTabFor(win)?.url)
  if (!url) return false
  openHelpTab(browser, url, win)
  return true
}
