/**
 * Chrome's Help › "Report an unsafe site…" (`IDC_REPORT_UNSAFE_SITE`, `HelpMenuModel::Build`;
 * shortcuts-menus-123): the page the menu was opened over, reported to Google Safe Browsing's
 * public phishing / malware form, which takes the address in its `url` query. The form is a
 * public page and needs no key, so the row shows whether or not Safe Browsing is on – Chrome's
 * own row hides with Safe Browsing off and in Incognito, its dialog being a WebUI feedback form
 * that pre-fills the tab's address and screenshot; Zenium opens the form itself, in a new tab.
 *
 * Only an http(s) page has an address the form can take: `zen://`, `file:`, `about:blank`,
 * `data:`, `blob:` and an empty or unparsable address answer `null`, and the row is left out of
 * the menu rather than greyed (the app menu's rule for what the host cannot do). Chrome gates
 * nothing on the scheme – its dialog lets the user type another address – which the round's
 * PR names as the one difference in the row's showing.
 *
 * One pure helper so the desktop app menu's Help ▸ row and the macOS menu bar's Help menu
 * (W8-4) build the same address.
 */

export const UNSAFE_SITE_REPORT_FORM = 'https://safebrowsing.google.com/safebrowsing/report_phish/'

/** The form's address for `pageUrl`, or `null` when the page has no address the form can take. */
export function unsafeSiteReportUrl(pageUrl: string | null | undefined): string | null {
  if (!pageUrl) return null
  let parsed: URL
  try {
    parsed = new URL(pageUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return `${UNSAFE_SITE_REPORT_FORM}?url=${encodeURIComponent(pageUrl)}`
}
