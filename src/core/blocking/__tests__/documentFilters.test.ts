import { describe, expect, it } from 'vitest'
import { DocumentFilters, optionsIndex } from '../documentFilters'

const LIST = [
  '[Adblock Plus 2.0]',
  '! comment',
  '||ads.example^',
  '-ad-banner.',
  '||malware.example^$all',
  '||phish.example^$document',
  '||scam.example^$doc,important',
  '@@||scam.example^$document',
  '||shop.example/checkout$document,~third-party',
  '@@||trusted.example^$document',
  '@@||partly.example/safe/$document',
  '/^https?:\\/\\/[a-z0-9-]+\\.lander\\.example\\//$document',
  '||regional.example^$document,domain=regional.example|~eu.regional.example',
  '||notdoc.example^$~document',
  '||csp.example^$csp=script-src none,document',
  '||third.example^$document,third-party',
  '||gone.example^$document',
  '||gone.example^$document,badfilter',
  'example.com##.ad',
  ''
].join('\n')

describe('optionsIndex', () => {
  it('finds the options separator and skips dollars inside regular expressions', () => {
    expect(optionsIndex('||a.example^$document')).toBe(12)
    expect(optionsIndex('||a.example^')).toBe(-1)
    expect(optionsIndex('/ads\\.js$/')).toBe(-1)
    expect(optionsIndex('/ads\\.js$/$script,document')).toBe(10)
    expect(optionsIndex("||a.example^$csp=script-src 'none'")).toBe(12)
  })
})

describe('DocumentFilters', () => {
  const filters = DocumentFilters.parse([LIST])

  it('keeps only the lines that apply to documents', () => {
    expect(filters.lines).toEqual([
      '||malware.example^$all',
      '||phish.example^$document',
      '||scam.example^$doc,important',
      '@@||scam.example^$document',
      '||shop.example/checkout$document,~third-party',
      '@@||trusted.example^$document',
      '@@||partly.example/safe/$document',
      '/^https?:\\/\\/[a-z0-9-]+\\.lander\\.example\\//$document',
      '||regional.example^$document,domain=regional.example|~eu.regional.example'
    ])
    expect(filters.size).toBe(9)
    expect(DocumentFilters.EMPTY.size).toBe(0)
    expect(DocumentFilters.EMPTY.decide('https://malware.example/')).toBeNull()
  })

  it('blocks navigations only through $document and $all filters', () => {
    expect(filters.decide('https://ads.example/')).toBeNull()
    expect(filters.decide('https://site.example/-ad-banner.html')).toBeNull()
    expect(filters.decide('https://malware.example/landing')).toEqual({
      action: 'block',
      filter: '||malware.example^$all'
    })
    expect(filters.decide('https://cdn.phish.example/')).toEqual({
      action: 'block',
      filter: '||phish.example^$document'
    })
    expect(filters.decide('https://phish.example.evil/')).toBeNull()
    expect(filters.decide('https://shop.example/checkout/step-2')).toMatchObject({
      action: 'block'
    })
    expect(filters.decide('https://shop.example/basket')).toBeNull()
    expect(filters.decide('https://x1.lander.example/offer')).toMatchObject({ action: 'block' })
    expect(filters.decide('https://lander.example/offer')).toBeNull()
    expect(filters.decide('https://notdoc.example/')).toBeNull()
    expect(filters.decide('https://csp.example/')).toBeNull()
    expect(filters.decide('https://third.example/')).toBeNull()
    expect(filters.decide('https://gone.example/')).toBeNull()
  })

  it('resolves important over exceptions over blocks and honours domain options', () => {
    expect(filters.decide('https://scam.example/')).toEqual({
      action: 'block',
      filter: '||scam.example^$doc,important'
    })
    expect(filters.decide('https://trusted.example/')).toEqual({
      action: 'allow',
      filter: '@@||trusted.example^$document'
    })
    expect(filters.decide('https://www.regional.example/')).toMatchObject({ action: 'block' })
    expect(filters.decide('https://eu.regional.example/')).toBeNull()
  })

  it('reports the $document exception whitelisting a page', () => {
    expect(filters.exception('https://www.trusted.example/page?x=1')).toBe(
      '@@||trusted.example^$document'
    )
    expect(filters.exception('https://partly.example/safe/index.html')).toBe(
      '@@||partly.example/safe/$document'
    )
    expect(filters.exception('https://partly.example/other/')).toBeNull()
    expect(filters.exception('https://malware.example/')).toBeNull()
    expect(filters.exception('https://scam.example/')).toBe('@@||scam.example^$document')
    expect(filters.exception('about:blank')).toBeNull()
  })

  it('parses several lists at once and round-trips its own lines', () => {
    const two = DocumentFilters.parse(['||a.example^$all', '@@||b.example^$document\n||c.example^'])
    expect(two.lines).toEqual(['||a.example^$all', '@@||b.example^$document'])
    const again = DocumentFilters.parse([two.lines.join('\n')])
    expect(again.lines).toEqual(two.lines)
    expect(again.decide('https://a.example/')).toMatchObject({ action: 'block' })
  })
})
