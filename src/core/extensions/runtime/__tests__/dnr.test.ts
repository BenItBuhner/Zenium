import { describe, expect, it } from 'vitest'
import {
  decide,
  guessResourceType,
  normalizeRuleset,
  ruleMatches,
  urlFilterToRegExp,
  type NetRequest
} from '../dnr'

const ORIGIN = 'https://ddkjiahejlhfcafbddmgiahcphecmpfh.ext.zenium.invalid'

const request = (over: Partial<NetRequest>): NetRequest => ({
  url: 'https://ads.doubleclick.net/pixel.gif',
  initiator: 'https://news.example/',
  type: 'image',
  method: 'get',
  ...over
})

describe('urlFilterToRegExp', () => {
  const test = (filter: string, url: string, cs = false): boolean =>
    urlFilterToRegExp(filter, cs).test(url)
  it('implements ||, |, * and ^ like Chrome', () => {
    expect(test('||doubleclick.net^', 'https://ads.doubleclick.net/pixel.gif')).toBe(true)
    expect(test('||doubleclick.net^', 'https://doubleclick.net/')).toBe(true)
    expect(test('||doubleclick.net^', 'https://notdoubleclick.net/')).toBe(false)
    expect(test('||doubleclick.net^', 'https://x.com/?u=doubleclick.net')).toBe(false)
    expect(test('|https://ads.', 'https://ads.example/')).toBe(true)
    expect(test('|https://ads.', 'https://x/https://ads.')).toBe(false)
    expect(test('.gif|', 'https://a/b.gif')).toBe(true)
    expect(test('.gif|', 'https://a/b.gif?x')).toBe(false)
    expect(test('/ad*.js', 'https://a/adframe.js')).toBe(true)
    expect(test('/ads^', 'https://a/ads?x=1')).toBe(true)
    expect(test('/ads^', 'https://a/ads')).toBe(true)
    expect(test('/ads^', 'https://a/adsense')).toBe(false)
    expect(test('/ADS/', 'https://a/ads/x')).toBe(true)
    expect(test('/ADS/', 'https://a/ads/x', true)).toBe(false)
  })
})

describe('normalizeRuleset + ruleMatches', () => {
  const rules = normalizeRuleset(
    [
      {
        id: 1,
        priority: 1,
        action: { type: 'block' },
        condition: { urlFilter: '||doubleclick.net^', resourceTypes: ['image', 'script'] }
      },
      {
        id: 2,
        priority: 2,
        action: { type: 'allow' },
        condition: { urlFilter: '||doubleclick.net/keep', resourceTypes: ['image'] }
      },
      {
        id: 3,
        action: { type: 'block' },
        condition: {
          requestDomains: ['tracker.example'],
          excludedInitiatorDomains: ['trusted.example']
        }
      },
      {
        id: 4,
        action: { type: 'block' },
        condition: { urlFilter: 'beacon', domainType: 'thirdParty' }
      },
      {
        id: 5,
        action: {
          type: 'redirect',
          redirect: { extensionPath: '/web_accessible_resources/noop.js' }
        },
        condition: { regexFilter: 'analytics\\.js$', resourceTypes: ['script'] }
      },
      {
        id: 6,
        action: { type: 'upgradeScheme' },
        condition: { urlFilter: '|http://insecure.example', resourceTypes: ['main_frame'] }
      },
      {
        id: 7,
        action: { type: 'modifyHeaders', responseHeaders: [] },
        condition: { urlFilter: '*' }
      },
      { id: 'bad' },
      { id: 8, action: { type: 'block' }, condition: { urlFilter: 'x', requestMethods: ['post'] } }
    ],
    ORIGIN
  )

  it('drops malformed rules and normalises the rest', () => {
    expect(rules.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(rules[4].redirectUrl).toBe(`${ORIGIN}/web_accessible_resources/noop.js`)
    expect(rules[2].initiatorDomains).toEqual([])
    expect(rules[2].excludedInitiatorDomains).toEqual(['trusted.example'])
  })

  it('matches on resource type, domains, initiator, party and method', () => {
    expect(ruleMatches(rules[0], request({}))).toBe(true)
    expect(ruleMatches(rules[0], request({ type: 'stylesheet' }))).toBe(false)
    // No resource type filter: everything but main_frame.
    expect(
      ruleMatches(rules[2], request({ url: 'https://cdn.tracker.example/t.js', type: 'script' }))
    ).toBe(true)
    expect(
      ruleMatches(rules[2], request({ url: 'https://tracker.example/', type: 'main_frame' }))
    ).toBe(false)
    expect(
      ruleMatches(
        rules[2],
        request({ url: 'https://cdn.tracker.example/t.js', initiator: 'https://trusted.example/' })
      )
    ).toBe(false)
    expect(
      ruleMatches(
        rules[3],
        request({ url: 'https://news.example/beacon', initiator: 'https://www.news.example/' })
      )
    ).toBe(false)
    expect(
      ruleMatches(
        rules[3],
        request({ url: 'https://other.example/beacon', initiator: 'https://www.news.example/' })
      )
    ).toBe(true)
    expect(ruleMatches(rules[7], request({ url: 'https://a/x', method: 'get' }))).toBe(false)
    expect(ruleMatches(rules[7], request({ url: 'https://a/x', method: 'POST' }))).toBe(true)
  })

  it('decides by priority then action precedence, ignoring modifyHeaders', () => {
    expect(decide(rules, request({}))).toEqual({ action: 'block' })
    expect(decide(rules, request({ url: 'https://ads.doubleclick.net/keep/x.png' }))).toEqual({
      action: 'allow'
    })
    expect(
      decide(rules, request({ url: 'https://cdn.example/analytics.js', type: 'script' }))
    ).toEqual({
      action: 'redirect',
      url: `${ORIGIN}/web_accessible_resources/noop.js`
    })
    expect(
      decide(
        rules,
        request({ url: 'http://insecure.example/', type: 'main_frame', initiator: null })
      )
    ).toEqual({ action: 'upgradeScheme' })
    expect(
      decide(rules, request({ url: 'https://fine.example/app.js', type: 'script' }))
    ).toBeNull()
  })

  it('same priority: allow beats block', () => {
    const tie = normalizeRuleset(
      [
        {
          id: 1,
          action: { type: 'block' },
          condition: { urlFilter: 'x', resourceTypes: ['image'] }
        },
        {
          id: 2,
          action: { type: 'allow' },
          condition: { urlFilter: 'x', resourceTypes: ['image'] }
        }
      ],
      ORIGIN
    )
    expect(decide(tie, request({ url: 'https://a/x' }))).toEqual({ action: 'allow' })
  })
})

describe('guessResourceType', () => {
  it('uses frame flags, Accept and the extension', () => {
    expect(guessResourceType('https://a/', null, true, false)).toBe('main_frame')
    expect(guessResourceType('https://a/', null, false, true)).toBe('sub_frame')
    expect(guessResourceType('https://a/x.css', 'text/css,*/*;q=0.1', false, false)).toBe(
      'stylesheet'
    )
    expect(guessResourceType('https://a/x', 'image/avif,image/webp,*/*', false, false)).toBe(
      'image'
    )
    expect(guessResourceType('https://a/x.js', '*/*', false, false)).toBe('script')
    expect(guessResourceType('https://a/x.woff2', null, false, false)).toBe('font')
    expect(guessResourceType('https://a/api', 'application/json', false, false)).toBe(
      'xmlhttprequest'
    )
    expect(guessResourceType('https://a/x', 'text/html', false, false)).toBe('other')
  })
})
