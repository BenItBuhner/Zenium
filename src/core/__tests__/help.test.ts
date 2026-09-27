import { describe, expect, it } from 'vitest'
import { HELP_URL } from '../../shared/links'
import { PRIVATE_CONTAINER_ID } from '../../shared/types'
import {
  REPORT_UNSAFE_SITE_FORM,
  openHelp,
  openHelpTab,
  openReportUnsafeSite,
  reportUnsafeSiteUrl
} from '../help'
import { DESKTOP, PAGE_URL, harness, pageHarness } from './menusFixture'

describe("Report an Unsafe Site…'s address (shortcuts-menus-123)", () => {
  it("is Google Safe Browsing's public report form with the page's address in its url query, encoded once", () => {
    const page = 'https://example.com/login?next=/account&x=1#frag'
    expect(reportUnsafeSiteUrl(page)).toBe(
      `${REPORT_UNSAFE_SITE_FORM}?url=${encodeURIComponent(page)}`
    )
    expect(reportUnsafeSiteUrl(page)).toBe(
      'https://safebrowsing.google.com/safebrowsing/report_phish/?url=https%3A%2F%2Fexample.com%2Flogin%3Fnext%3D%2Faccount%26x%3D1%23frag'
    )
    expect(reportUnsafeSiteUrl('http://198.51.100.7:8080/')).toBe(
      `${REPORT_UNSAFE_SITE_FORM}?url=http%3A%2F%2F198.51.100.7%3A8080%2F`
    )
    // The scheme is read as a scheme, not as a prefix: an upper-case one is the same page.
    expect(reportUnsafeSiteUrl('HTTPS://Example.com/')).toBe(
      `${REPORT_UNSAFE_SITE_FORM}?url=${encodeURIComponent('HTTPS://Example.com/')}`
    )
    // The form's page itself is public and needs no key: the address never depends on a setting.
    expect(new URL(REPORT_UNSAFE_SITE_FORM).protocol).toBe('https:')
  })

  it("answers null where the page has no address the form can take – Zenium's and Chrome's pages, files, about:blank, data, blob, javascript and ftp addresses, an empty or unparsable one – so both menus grey the row (§9.17)", () => {
    for (const url of [
      'zen://settings/look?row=customize-toolbar',
      'zen://newtab',
      'file:///home/user/report.html',
      'about:blank',
      'data:text/html,<p>hi</p>',
      'blob:https://example.com/2f5b0a1e',
      'chrome://version',
      'javascript:void 0',
      'ftp://example.com/pub',
      '',
      'not a url',
      'https://',
      'example.com/no-scheme',
      null,
      undefined
    ])
      expect(reportUnsafeSiteUrl(url), String(url)).toBeNull()
  })
})

describe("the Help rows' openers (the fold of #578's helper into help.ts, the lead's ruling on #588)", () => {
  it('openHelpTab opens the page in a new tab in front, a child of the window’s active page, in that page’s container', () => {
    const h = pageHarness(DESKTOP)
    const page = h.browser.tabs.activeTabFor(h.win)!
    openHelpTab(h.browser, 'https://example.org/help', h.win)
    const opened = h.browser.tabs.activeTabFor(h.win)!
    expect(opened.id).not.toBe(page.id)
    expect(opened.url).toBe('https://example.org/help')
    expect(opened.openerTabId).toBe(page.id)
    expect(opened.containerId).toBe(page.containerId)
  })

  it('openHelp is the help page (`HELP_URL`) in that shape – the phone’s Help row, the desktop’s Zenium Help and the menu bar’s share it – and opens without a page too', () => {
    const h = pageHarness(DESKTOP)
    const page = h.browser.tabs.activeTabFor(h.win)!
    openHelp(h.browser, h.win)
    const help = h.browser.tabs.activeTabFor(h.win)!
    expect(help.url).toBe(HELP_URL)
    expect(help.openerTabId).toBe(page.id)
    // A window without a page (the bare harness's) still gets its help tab, with no opener.
    const bare = harness(DESKTOP)
    expect(bare.browser.tabs.activeTabFor(bare.win)).toBeUndefined()
    openHelp(bare.browser, bare.win)
    const first = bare.browser.tabs.activeTabFor(bare.win)!
    expect(first.url).toBe(HELP_URL)
    expect(first.openerTabId).toBeNull()
  })

  it('openReportUnsafeSite opens the form for the active http(s) page and answers true; over a page the form cannot take, or no page, it opens nothing and answers false', () => {
    const h = pageHarness(DESKTOP)
    const page = h.browser.tabs.activeTabFor(h.win)!
    expect(page.url).toBe(PAGE_URL)
    expect(openReportUnsafeSite(h.browser, h.win)).toBe(true)
    const report = h.browser.tabs.activeTabFor(h.win)!
    expect(report.id).not.toBe(page.id)
    expect(report.url).toBe(reportUnsafeSiteUrl(PAGE_URL))
    expect(report.openerTabId).toBe(page.id)
    expect(report.containerId).toBe(page.containerId)
    for (const url of ['zen://settings/look', 'file:///home/user/report.html', 'about:blank']) {
      const other = h.browser.tabs.createTab({ url, active: true }, h.win)
      expect(openReportUnsafeSite(h.browser, h.win), url).toBe(false)
      expect(h.browser.tabs.activeTabFor(h.win)?.id, url).toBe(other.id)
    }
    const bare = harness(DESKTOP)
    expect(openReportUnsafeSite(bare.browser, bare.win)).toBe(false)
    expect(bare.browser.tabs.activeTabFor(bare.win)).toBeUndefined()
  })

  it('keeps a private page’s report private: the form opens in the page’s private container', () => {
    const h = harness(DESKTOP)
    const privatePage = h.browser.tabs.createTab(
      { url: 'https://example.com/p', active: true, containerId: PRIVATE_CONTAINER_ID },
      h.win
    )
    expect(openReportUnsafeSite(h.browser, h.win)).toBe(true)
    const report = h.browser.tabs.activeTabFor(h.win)!
    expect(report.url).toBe(reportUnsafeSiteUrl('https://example.com/p'))
    expect(report.containerId).toBe(PRIVATE_CONTAINER_ID)
    expect(report.openerTabId).toBe(privatePage.id)
  })
})
