import { HELP_URL } from '../shared/links'
import type { Browser } from './browser'
import type { ZenWindow } from './window'

/**
 * Google's Safe Browsing report form, Chrome's Help › Report an unsafe site… target
 * (`IDC_REPORT_UNSAFE_SITE`, `feedback::ReportUnsafeSiteDialog`): Chrome opens a dialog of its
 * own that posts to it; Zenium has no such dialog and opens the form itself, the page's address
 * filled in (services' word on #578).
 */
export const REPORT_UNSAFE_SITE_FORM = 'https://safebrowsing.google.com/safebrowsing/report_phish/'

/**
 * The report form for `url`, or null when there is no page to report: the form takes a web
 * address, so a `zen://` page, a blank tab, a file or no tab at all has none. The Help rows read
 * it for their state – a menu that hides rows hides theirs, the menu bar greys its (§9.30).
 */
export function reportUnsafeSiteUrl(url: string | null | undefined): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null
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
