import { describe, expect, it } from 'vitest'
import { UNSAFE_SITE_REPORT_FORM, unsafeSiteReportUrl } from '../unsafeSiteReport'

describe("Report an Unsafe Site…'s address (shortcuts-menus-123)", () => {
  it("is Google Safe Browsing's public report form with the page's address in its url query, encoded once", () => {
    const page = 'https://example.com/login?next=/account&x=1#frag'
    expect(unsafeSiteReportUrl(page)).toBe(
      `${UNSAFE_SITE_REPORT_FORM}?url=${encodeURIComponent(page)}`
    )
    expect(unsafeSiteReportUrl(page)).toBe(
      'https://safebrowsing.google.com/safebrowsing/report_phish/?url=https%3A%2F%2Fexample.com%2Flogin%3Fnext%3D%2Faccount%26x%3D1%23frag'
    )
    expect(unsafeSiteReportUrl('http://198.51.100.7:8080/')).toBe(
      `${UNSAFE_SITE_REPORT_FORM}?url=http%3A%2F%2F198.51.100.7%3A8080%2F`
    )
    // The form's page itself is public and needs no key: the address never depends on a setting.
    expect(new URL(UNSAFE_SITE_REPORT_FORM).protocol).toBe('https:')
  })

  it("answers null where the page has no address the form can take – Zenium's pages, files, about:blank, data and blob pages, an empty or broken address – so the row is left out", () => {
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
      null,
      undefined
    ])
      expect(unsafeSiteReportUrl(url), String(url)).toBeNull()
  })
})
