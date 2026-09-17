import { describe, expect, it } from 'vitest'
import {
  countNetworkFilters,
  isCosmeticFilter,
  isNetworkFilter,
  parseExpires,
  parseListHeader,
  prepareListText,
  validateFilterText
} from '../lists'

const EASYLIST_HEAD = `[Adblock Plus 2.0]
! Version: 202609170830
! Title: EasyList
! Last modified: 17 Sep 2026 08:30 UTC
! Expires: 4 days (update frequency)
! Homepage: https://easylist.to/
! Licence: https://easylist.to/pages/licence.html
!
! Please report any unblocked adverts or problems
!-----------------------General advert blocking filters-----------------------!
! *** easylist:easylist/easylist_general_block.txt ***
&ad_box_
&ad_channel=
||ads.example^$third-party
@@||cdn.example/ok.js$script
example.com##.ad-banner
example.com#@#.ad-banner
example.com##+js(nowoif)
`

describe('parseListHeader', () => {
  it('reads the standard header block', () => {
    const h = parseListHeader(EASYLIST_HEAD)
    expect(h).toEqual({
      title: 'EasyList',
      version: '202609170830',
      expiresMs: 4 * 86_400_000,
      homepage: 'https://easylist.to/',
      licence: 'https://easylist.to/pages/licence.html'
    })
  })

  it('accepts the American spelling and stops after the first filters', () => {
    const h = parseListHeader('! License: CC0\n||a^\n||b^\n||c^\n||d^\n||e^\n||f^\n! Title: Late\n')
    expect(h.licence).toBe('CC0')
    expect(h.title).toBeNull()
    expect(parseListHeader('')).toEqual({
      title: null,
      version: null,
      expiresMs: null,
      homepage: null,
      licence: null
    })
  })

  it('parses expiry values in days and hours', () => {
    expect(parseExpires('4 days (update frequency)')).toBe(4 * 86_400_000)
    expect(parseExpires('12 hours')).toBe(12 * 3_600_000)
    expect(parseExpires('1 day')).toBe(86_400_000)
    expect(parseExpires('soon')).toBeNull()
    expect(parseExpires('0 days')).toBeNull()
  })
})

describe('filter classification', () => {
  it('tells network filters from comments and cosmetic filters', () => {
    expect(isNetworkFilter('||ads.example^$third-party')).toBe(true)
    expect(isNetworkFilter('@@||cdn.example/ok.js')).toBe(true)
    expect(isNetworkFilter('/banner/*/ad.')).toBe(true)
    expect(isNetworkFilter('! comment')).toBe(false)
    expect(isNetworkFilter('[Adblock Plus 2.0]')).toBe(false)
    expect(isNetworkFilter('# hosts comment')).toBe(false)
    expect(isNetworkFilter('')).toBe(false)
    expect(isNetworkFilter('example.com##.ad')).toBe(false)
    expect(isCosmeticFilter('example.com#@#.ad')).toBe(true)
    expect(isCosmeticFilter('example.com#?#.ad:has(span)')).toBe(true)
    expect(isCosmeticFilter('example.com#$#body { margin: 0 }')).toBe(true)
    expect(isCosmeticFilter('example.com#%#//scriptlet("abort")')).toBe(true)
    expect(isCosmeticFilter('||a.example/#/hash')).toBe(false)
    expect(countNetworkFilters(EASYLIST_HEAD)).toBe(4)
  })
})

describe('prepareListText', () => {
  it('keeps network filters only', () => {
    const p = prepareListText(EASYLIST_HEAD)
    expect(p.text.split('\n')).toEqual([
      '&ad_box_',
      '&ad_channel=',
      '||ads.example^$third-party',
      '@@||cdn.example/ok.js$script'
    ])
    expect(p.count).toBe(4)
  })

  it('turns hosts files and bare hostnames into ||host^ filters, skipping local names', () => {
    const p = prepareListText(
      [
        '# hosts list',
        '127.0.0.1 localhost',
        '0.0.0.0 0.0.0.0',
        '::1 ip6-localhost',
        '0.0.0.0 Ads.Tracker.example  # inline comment',
        '127.0.0.1\ttelemetry.example',
        'bare.host.example',
        'Another.Host',
        '||already.example^',
        '\r\n'
      ].join('\n')
    )
    expect(p.text.split('\n')).toEqual([
      '||ads.tracker.example^',
      '||telemetry.example^',
      '||bare.host.example^',
      '||another.host^',
      '||already.example^'
    ])
    expect(p.count).toBe(5)
    expect(prepareListText('')).toEqual({ text: '', count: 0 })
  })
})

describe('validateFilterText', () => {
  it('accepts filters both engines understand', () => {
    expect(
      validateFilterText(
        [
          '! my filters',
          '||ads.example^$third-party,script',
          '@@||cdn.example^$document',
          '/^https:\\/\\/[a-z]+\\.ads\\./$image',
          '||x.example^$domain=a.example|~b.example,important',
          '||y.example^$xhr,method=post',
          'example.com##.ad',
          '||z.example^$redirect=noopjs',
          "||w.example^$csp=script-src 'none'",
          '||v.example^$removeparam=utm_source',
          ''
        ].join('\n')
      )
    ).toEqual([])
  })

  it('points at the broken line', () => {
    const errors = validateFilterText(
      [
        '||ok.example^',
        '||bad.example^$bogus',
        '/(/',
        '||x^$domain',
        '||',
        '*$script',
        'a$script,'
      ].join('\n')
    )
    expect(errors).toEqual([
      { line: 2, message: 'Unknown option "bogus"' },
      { line: 3, message: 'Invalid regular expression' },
      { line: 4, message: 'Unknown option "domain"' },
      { line: 5, message: 'The filter matches every request' },
      { line: 6, message: 'The filter matches every request' },
      { line: 7, message: 'Empty option' }
    ])
    expect(validateFilterText('/abc/def')).toEqual([
      { line: 1, message: 'Text after the closing / of a regular expression' }
    ])
  })
})
