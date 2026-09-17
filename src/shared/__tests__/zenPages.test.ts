import { describe, expect, it } from 'vitest'
import { errorPageUrl } from '../url'
import { BLOCKED_BY_CLIENT_CODE, parseZenUrl, zenPageHtml } from '../zenPages'

describe('parseZenUrl', () => {
  it('names the page in hostname whatever the engine makes of a non-special scheme', () => {
    expect(parseZenUrl('zen://error?code=-102&url=http%3A%2F%2Fa.test%2F')?.hostname).toBe('error')
    expect(parseZenUrl('zen://blank')?.hostname).toBe('blank')
    expect(parseZenUrl('zen://reader?id=abc')?.searchParams.get('id')).toBe('abc')
  })

  it('rejects anything that is not a zen:// URL', () => {
    expect(parseZenUrl('https://example.com/')).toBeNull()
    expect(parseZenUrl('zen:error')).toBeNull()
    expect(parseZenUrl('zen://')).toBeNull()
  })
})

describe('zenPageHtml', () => {
  it('renders the error page for zen://error', () => {
    const html = zenPageHtml(
      errorPageUrl(-102, 'net::ERR_CONNECTION_REFUSED', 'http://127.0.0.1:1/')
    )
    expect(html).toContain('<title>Problem loading page</title>')
    expect(html).toContain('http://127.0.0.1:1/')
    expect(html).toContain('ERR_CONNECTION_REFUSED')
  })

  it('renders the Zenium blocked page when the request engine stopped the navigation', () => {
    const html = zenPageHtml(
      errorPageUrl(BLOCKED_BY_CLIENT_CODE, 'ERR_BLOCKED_BY_CLIENT', 'https://ads.example/')
    )
    expect(html).toContain('<title>Page blocked</title>')
    expect(html).toContain('Zenium blocked this page')
    expect(html).toContain('<strong>ads.example</strong>')
  })

  it('falls back to the blank page for unknown and malformed URLs', () => {
    expect(zenPageHtml('zen://blank')).toContain('<title>New Tab</title>')
    expect(zenPageHtml('zen://nonsense')).toContain('<title>New Tab</title>')
    expect(zenPageHtml('not a url')).toContain('<title>New Tab</title>')
  })
})
