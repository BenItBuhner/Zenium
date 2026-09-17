import { describe, expect, it } from 'vitest'
import { compileRule, compileRuleSet } from '../compile'
import type { Rule } from '../rules'

describe('compileRule', () => {
  it('turns block and allow rules into filters with type, party and domain options', () => {
    expect(
      compileRule({
        id: 1,
        action: { type: 'block' },
        condition: {
          urlFilter: '||ads.example^',
          resourceTypes: ['script', 'image', 'sub_frame'],
          domainType: 'thirdParty',
          initiatorDomains: ['News.Example'],
          excludedInitiatorDomains: ['safe.example']
        }
      })
    ).toEqual({
      filters: [
        '||ads.example^$script,image,subdocument,third-party,domain=news.example|~safe.example'
      ],
      unsupported: []
    })
    expect(
      compileRule({
        id: 2,
        action: { type: 'allow' },
        condition: { urlFilter: '||cdn.example^', domainType: 'firstParty' }
      })
    ).toEqual({
      filters: ['@@||cdn.example^$~third-party'],
      unsupported: []
    })
  })

  it('expands requestDomains without a pattern into one ||domain^ filter each', () => {
    const r = compileRule({
      id: 3,
      action: { type: 'block' },
      condition: {
        requestDomains: ['a.example', 'B.example'],
        excludedResourceTypes: ['main_frame']
      }
    })
    expect(r.filters).toEqual(['||a.example^$~document', '||b.example^$~document'])
    expect(r.unsupported).toEqual([])
    expect(compileRule({ id: 4, action: { type: 'block' }, condition: {} }).filters).toEqual(['*'])
  })

  it('maps allowAllRequests to $document / $subdocument exceptions', () => {
    expect(
      compileRule({
        id: 5,
        action: { type: 'allowAllRequests' },
        condition: {
          requestDomains: ['trusted.example'],
          resourceTypes: ['main_frame', 'sub_frame']
        }
      }).filters
    ).toEqual(['@@||trusted.example^$document,subdocument'])
    expect(
      compileRule({
        id: 6,
        action: { type: 'allowAllRequests' },
        condition: { urlFilter: '||t.example^' }
      }).filters
    ).toEqual(['@@||t.example^$document'])
  })

  it('carries regexFilter, methods and match-case', () => {
    const r = compileRule({
      id: 7,
      action: { type: 'block' },
      condition: {
        regexFilter: '^https://[a-z]+\\.ads\\.',
        requestMethods: ['POST'],
        excludedRequestMethods: ['head'],
        isUrlFilterCaseSensitive: true
      }
    })
    expect(r.filters).toEqual(['/^https://[a-z]+\\.ads\\./$method=post,method=~head,match-case'])
  })

  it('reports everything the filter syntax cannot carry', () => {
    const reasons = (rule: Rule): string[] => compileRule(rule).unsupported
    expect(reasons({ id: 1, action: { type: 'upgradeScheme' }, condition: {} })[0]).toMatch(
      /upgradeScheme/
    )
    expect(
      reasons({
        id: 2,
        action: { type: 'redirect', redirect: { url: 'https://x/' } },
        condition: {}
      })[0]
    ).toMatch(/redirect/)
    expect(
      reasons({ id: 3, action: { type: 'modifyHeaders', requestHeaders: [] }, condition: {} })[0]
    ).toMatch(/modifyHeaders/)
    expect(
      reasons({
        id: 4,
        action: { type: 'block' },
        condition: { urlFilter: 'x', tabIds: [1], excludedRequestDomains: ['a'] }
      })
    ).toEqual([expect.stringMatching(/tabIds/), expect.stringMatching(/excludedRequestDomains/)])
    expect(
      reasons({ id: 5, priority: 3, action: { type: 'block' }, condition: { urlFilter: 'x' } })[0]
    ).toMatch(/priority/)
    expect(
      reasons({
        id: 6,
        action: { type: 'block' },
        condition: { urlFilter: 'x', requestDomains: ['a'] }
      })[0]
    ).toMatch(/requestDomains with urlFilter/)
    const partial = compileRule({
      id: 7,
      action: { type: 'block' },
      condition: { urlFilter: 'x', resourceTypes: ['webbundle', 'script'] }
    })
    expect(partial.filters).toEqual(['x$script'])
    expect(partial.unsupported[0]).toMatch(/webbundle/)
    expect(
      compileRule({
        id: 8,
        action: { type: 'block' },
        condition: { urlFilter: 'x', resourceTypes: ['webtransport'] }
      })
    ).toEqual({
      filters: [],
      unsupported: [expect.stringMatching(/webtransport/), 'no expressible resource types']
    })
  })
})

describe('compileRuleSet', () => {
  it('passes filter text through, appends compiled rules and attributes problems to rule ids', () => {
    const out = compileRuleSet({
      id: 'mixed',
      source: 'dnr',
      priority: 5,
      enabled: true,
      filterText: '||one.example^\r\n||two.example^\n\n',
      rules: [
        { id: 10, action: { type: 'block' }, condition: { urlFilter: '||three.example^' } },
        { id: 11, action: { type: 'upgradeScheme' }, condition: {} }
      ]
    })
    expect(out.filterText).toBe('||one.example^\n||two.example^\n||three.example^')
    expect(out.unsupported).toEqual([
      { ruleId: 11, reason: expect.stringMatching(/upgradeScheme/) }
    ])
  })
})
