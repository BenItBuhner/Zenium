import { describe, expect, it } from 'vitest'
import { RuleEngine, TEXT_MATCH_SET_ID, resourceTypeFromElectron, type TextMatch } from '../engine'
import type { RequestContext, Rule, RuleSet, RuleSetChange } from '../rules'
import { BUILTIN_RULE_SETS, RULE_SET_PRIORITY } from '../rules'

function set(id: string, rules: Rule[], extra: Partial<RuleSet> = {}): RuleSet {
  return { id, source: 'dnr', priority: 5, enabled: true, rules, ...extra }
}

function req(url: string, extra: Partial<RequestContext> = {}): RequestContext {
  return { url, type: 'script', method: 'GET', ...extra }
}

const block = (id: number, condition: Rule['condition'], priority?: number): Rule => ({
  id,
  priority,
  action: { type: 'block' },
  condition
})
const allow = (id: number, condition: Rule['condition'], priority?: number): Rule => ({
  id,
  priority,
  action: { type: 'allow' },
  condition
})

describe('RuleEngine conditions', () => {
  it('matches urlFilter anchors and the request domain lists', () => {
    const e = new RuleEngine()
    e.setRuleSet(set('a', [block(1, { urlFilter: '||ads.example^' })]))
    expect(e.decide(req('https://ads.example/x.js')).action).toBe('block')
    expect(e.decide(req('https://sub.ads.example/x.js')).action).toBe('block')
    expect(e.decide(req('https://good.example/ads.example')).action).toBe('allow')

    e.setRuleSet(set('b', [block(1, { requestDomains: ['Tracker.Example'] })]))
    expect(e.decide(req('https://cdn.tracker.example/p.gif')).action).toBe('block')
    expect(e.decide(req('https://nottracker.example/p.gif')).action).toBe('allow')

    e.setRuleSet(set('c', [block(1, { excludedRequestDomains: ['safe.example'] })]))
    expect(e.decide(req('https://safe.example/')).action).toBe('allow')
    expect(e.decide(req('https://anything.example/')).action).toBe('block')
  })

  it('filters on resource types, methods, tab ids and initiator domains', () => {
    const e = new RuleEngine()
    e.setRuleSet(
      set('types', [
        block(1, { urlFilter: 'pixel', resourceTypes: ['image', 'ping'] }),
        block(2, { urlFilter: 'beacon', excludedResourceTypes: ['xmlhttprequest'] })
      ])
    )
    expect(e.decide(req('https://a/pixel', { type: 'image' })).action).toBe('block')
    expect(e.decide(req('https://a/pixel', { type: 'script' })).action).toBe('allow')
    expect(e.decide(req('https://a/beacon', { type: 'xmlhttprequest' })).action).toBe('allow')
    expect(e.decide(req('https://a/beacon', { type: 'script' })).action).toBe('block')

    e.setRuleSet(
      set('methods', [
        block(1, { urlFilter: '/collect', requestMethods: ['post'] }),
        block(2, { urlFilter: '/log', excludedRequestMethods: ['GET'] })
      ])
    )
    expect(e.decide(req('https://a/collect', { method: 'POST' })).action).toBe('block')
    expect(e.decide(req('https://a/collect', { method: 'GET' })).action).toBe('allow')
    expect(e.decide(req('https://a/log', { method: 'GET' })).action).toBe('allow')
    expect(e.decide(req('https://a/log', { method: 'PUT' })).action).toBe('block')

    e.setRuleSet(
      set('tabs', [
        block(1, { urlFilter: '/tabbed', tabIds: [7] }),
        block(2, { urlFilter: '/untabbed', excludedTabIds: [7] })
      ])
    )
    expect(e.decide(req('https://a/tabbed', { tabId: 'tab-7' })).action).toBe('block')
    expect(e.decide(req('https://a/tabbed', { tabId: 'tab-8' })).action).toBe('allow')
    expect(e.decide(req('https://a/tabbed')).action).toBe('allow')
    expect(e.decide(req('https://a/untabbed', { tabId: 'tab-7' })).action).toBe('allow')
    expect(e.decide(req('https://a/untabbed', { tabId: 'tab-9' })).action).toBe('block')

    e.setRuleSet(
      set('initiators', [
        block(1, { urlFilter: '/from-news', initiatorDomains: ['news.example'] }),
        block(2, { urlFilter: '/not-from-shop', excludedInitiatorDomains: ['shop.example'] })
      ])
    )
    expect(
      e.decide(req('https://a/from-news', { initiator: 'https://www.news.example/story' })).action
    ).toBe('block')
    expect(
      e.decide(req('https://a/from-news', { initiator: 'https://other.example' })).action
    ).toBe('allow')
    expect(e.decide(req('https://a/from-news')).action).toBe('allow')
    expect(
      e.decide(req('https://a/not-from-shop', { initiator: 'https://shop.example' })).action
    ).toBe('allow')
    expect(
      e.decide(req('https://a/not-from-shop', { initiator: 'https://blog.example' })).action
    ).toBe('block')
  })

  it('computes third-party from the registrable domains when the host did not', () => {
    const e = new RuleEngine()
    e.setRuleSet(
      set('3p', [
        block(1, { urlFilter: 'widget.js', domainType: 'thirdParty' }),
        block(2, { urlFilter: 'self.js', domainType: 'firstParty' })
      ])
    )
    expect(
      e.decide(
        req('https://cdn.tracker.example/widget.js', { initiator: 'https://www.site.example/' })
      ).action
    ).toBe('block')
    expect(
      e.decide(
        req('https://static.site.example/widget.js', { initiator: 'https://www.site.example/' })
      ).action
    ).toBe('allow')
    expect(
      e.decide(req('https://static.site.co.uk/widget.js', { initiator: 'https://www.site.co.uk/' }))
        .action
    ).toBe('allow')
    expect(
      e.decide(req('https://static.site.example/self.js', { initiator: 'https://site.example/' }))
        .action
    ).toBe('block')
    expect(
      e.decide(req('https://x.example/self.js', { initiator: 'https://site.example/' })).action
    ).toBe('allow')
    // A precomputed flag wins over the derivation.
    expect(
      e.decide(
        req('https://static.site.example/widget.js', {
          initiator: 'https://site.example/',
          isThirdParty: true
        })
      ).action
    ).toBe('block')
  })

  it('supports regexFilter with substitution redirects and skips invalid expressions', () => {
    const e = new RuleEngine()
    e.setRuleSet(
      set('re', [
        {
          id: 1,
          action: {
            type: 'redirect',
            redirect: { regexSubstitution: 'https://\\1.clean.example/\\2' }
          },
          condition: { regexFilter: '^https://(\\w+)\\.tracker\\.example/(.*)$' }
        },
        { id: 2, action: { type: 'block' }, condition: { regexFilter: '(' } },
        {
          id: 3,
          action: { type: 'redirect', redirect: { url: 'https://empty.example/' } },
          condition: { urlFilter: '/heavy.js' }
        }
      ])
    )
    const d = e.decide(req('https://cdn.tracker.example/p.js'))
    expect(d.action).toBe('redirect')
    expect(d.redirectUrl).toBe('https://cdn.clean.example/p.js')
    expect(e.decide(req('https://a/(')).action).toBe('allow')
    expect(e.decide(req('https://a/heavy.js'))).toMatchObject({
      action: 'redirect',
      redirectUrl: 'https://empty.example/'
    })
    expect(e.listRuleSets()[0].ruleCount).toBe(2)
  })

  it('upgrades http requests only', () => {
    const e = new RuleEngine()
    e.setRuleSet(
      set('up', [
        { id: 1, action: { type: 'upgradeScheme' }, condition: { urlFilter: '||upgrade.example^' } }
      ])
    )
    expect(e.decide(req('http://upgrade.example/a?b=c'))).toMatchObject({
      action: 'upgrade',
      redirectUrl: 'https://upgrade.example/a?b=c'
    })
    expect(e.decide(req('https://upgrade.example/a')).action).toBe('allow')
  })
})

describe('RuleEngine priority resolution', () => {
  it('lets the higher rule priority win and allow beat block inside one priority', () => {
    const e = new RuleEngine()
    e.setRuleSet(
      set('p', [
        block(1, { urlFilter: '||a.example^' }, 1),
        allow(2, { urlFilter: '||a.example/ok' }, 1),
        block(3, { urlFilter: '||a.example/ok/really-not' }, 2)
      ])
    )
    expect(e.decide(req('https://a.example/x')).action).toBe('block')
    expect(e.decide(req('https://a.example/ok/')).action).toBe('allow')
    expect(e.decide(req('https://a.example/ok/really-not')).action).toBe('block')
  })

  it('lets a higher-priority set beat a lower one whatever the rule priorities say', () => {
    const e = new RuleEngine()
    e.setRuleSet(set('low', [block(1, { urlFilter: '||a.example^' }, 1_000_000)], { priority: 1 }))
    e.setRuleSet(set('high', [allow(1, { urlFilter: '||a.example^' }, 1)], { priority: 2 }))
    expect(e.decide(req('https://a.example/')).matched).toEqual({ setId: 'high', ruleId: 1 })
    e.setRuleSet(
      set('high', [allow(1, { urlFilter: '||a.example^' }, 1)], { priority: 2, enabled: false })
    )
    expect(e.decide(req('https://a.example/')).matched).toEqual({ setId: 'low', ruleId: 1 })
  })

  it('scopes allowAllRequests to everything under the matched document', () => {
    const e = new RuleEngine()
    e.setRuleSet(set('ads', [block(1, { urlFilter: '||ads.example^' })], { priority: 1 }))
    e.setRuleSet(
      set(
        BUILTIN_RULE_SETS.siteExceptions,
        [
          {
            id: 1,
            action: { type: 'allowAllRequests' },
            condition: {
              requestDomains: ['trusted.example'],
              resourceTypes: ['main_frame', 'sub_frame']
            }
          }
        ],
        { source: 'builtin', priority: RULE_SET_PRIORITY.siteExceptions }
      )
    )
    const onTrusted = req('https://ads.example/x.js', {
      initiator: 'https://ads.example',
      documentUrl: 'https://www.trusted.example/page'
    })
    expect(e.decide(onTrusted)).toMatchObject({
      action: 'allow',
      matched: { setId: BUILTIN_RULE_SETS.siteExceptions, ruleId: 1 }
    })
    const elsewhere = req('https://ads.example/x.js', { documentUrl: 'https://other.example/' })
    expect(e.decide(elsewhere).action).toBe('block')
    // The navigation to the excepted site itself is allowed too, an unrelated one is not.
    expect(e.decide(req('https://trusted.example/', { type: 'main_frame' })).action).toBe('allow')
    e.setRuleSet(
      set('pages', [block(2, { urlFilter: '||trusted.example^', resourceTypes: ['main_frame'] })], {
        priority: 1
      })
    )
    expect(e.decide(req('https://trusted.example/', { type: 'main_frame' })).action).toBe('allow')
    expect(e.decide(req('https://ads.example/', { type: 'main_frame' })).action).toBe('block')
  })

  it('uses the global-off set as an allow-everything switch', () => {
    const e = new RuleEngine()
    e.setRuleSet(set('ads', [block(1, {})], { priority: 1 }))
    expect(e.decide(req('https://any/')).action).toBe('block')
    e.setRuleSet(
      set(BUILTIN_RULE_SETS.globalOff, [allow(1, {})], {
        source: 'builtin',
        priority: RULE_SET_PRIORITY.globalOff
      })
    )
    expect(e.decide(req('https://any/')).matched?.setId).toBe(BUILTIN_RULE_SETS.globalOff)
    e.setEnabled(BUILTIN_RULE_SETS.globalOff, false)
    expect(e.decide(req('https://any/')).action).toBe('block')
  })

  it('applies modifyHeaders unless an allow of equal or higher priority matched', () => {
    const e = new RuleEngine()
    e.setRuleSet(
      set('headers', [
        {
          id: 1,
          priority: 2,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'Sec-GPC', operation: 'set', value: '1' }],
            responseHeaders: [{ header: 'Set-Cookie', operation: 'remove' }]
          },
          condition: { urlFilter: '||h.example^' }
        },
        {
          id: 2,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'DNT', operation: 'set', value: '1' }]
          },
          condition: { urlFilter: '||h.example^' }
        },
        allow(3, { urlFilter: '||h.example/allowed' }, 1),
        allow(4, { urlFilter: '||h.example/very-allowed' }, 3)
      ])
    )
    const plain = e.decide(req('https://h.example/x'))
    expect(plain.action).toBe('modifyHeaders')
    expect(plain.requestHeaders).toEqual([
      { header: 'Sec-GPC', operation: 'set', value: '1' },
      { header: 'DNT', operation: 'set', value: '1' }
    ])
    expect(plain.responseHeaders).toEqual([{ header: 'Set-Cookie', operation: 'remove' }])
    expect(plain.matched).toEqual({ setId: 'headers', ruleId: 1 })
    // The priority-1 allow only suppresses the priority-1 header rule.
    const partly = e.decide(req('https://h.example/allowed'))
    expect(partly.action).toBe('modifyHeaders')
    expect(partly.requestHeaders).toEqual([{ header: 'Sec-GPC', operation: 'set', value: '1' }])
    expect(e.decide(req('https://h.example/very-allowed')).action).toBe('allow')
    // A block wins over header edits.
    e.setRuleSet(set('b', [block(1, { urlFilter: '||h.example/blocked' })]))
    expect(e.decide(req('https://h.example/blocked')).action).toBe('block')
  })
})

describe('RuleEngine text matcher', () => {
  function matcher(answer: (ctx: RequestContext) => TextMatch | null): { match: typeof answer } {
    return { match: answer }
  }

  it('takes filter-text matches at the filter-list priority', () => {
    const e = new RuleEngine()
    e.setTextMatcher(
      matcher((ctx) => (ctx.url.includes('ad') ? { action: 'block', filter: '/ad' } : null))
    )
    expect(e.decide(req('https://x/ad.js'))).toEqual({
      action: 'block',
      matched: { setId: TEXT_MATCH_SET_ID, filter: '/ad' }
    })
    expect(e.decide(req('https://x/fine.js')).action).toBe('allow')
    // A user allow (priority 10) beats the list.
    e.setRuleSet(
      set('user', [allow(1, { urlFilter: '||x^' })], {
        source: 'user',
        priority: RULE_SET_PRIORITY.user
      })
    )
    expect(e.decide(req('https://x/ad.js')).matched?.setId).toBe('user')
  })

  it('lets text exceptions win over same-band structured blocks and reports redirects', () => {
    const e = new RuleEngine()
    e.setRuleSet(
      set('list-rules', [block(1, { urlFilter: '||x^' })], {
        source: 'filter-list',
        priority: RULE_SET_PRIORITY.filterList
      })
    )
    e.setTextMatcher(matcher(() => ({ action: 'allow', filter: '@@||x^' })))
    expect(e.decide(req('https://x/')).action).toBe('allow')
    e.setTextMatcher(
      matcher(() => ({
        action: 'redirect',
        redirectUrl: 'data:text/plain,',
        filter: '||x^$redirect=empty'
      }))
    )
    e.removeRuleSet('list-rules')
    expect(e.decide(req('https://x/'))).toMatchObject({
      action: 'redirect',
      redirectUrl: 'data:text/plain,'
    })
    // A structured block from a higher band is not consulted against the matcher at all.
    let asked = 0
    e.setTextMatcher(
      matcher(() => {
        asked++
        return null
      })
    )
    e.setRuleSet(set('dnr', [block(1, { urlFilter: '||y^' })]))
    expect(e.decide(req('https://y/')).action).toBe('block')
    expect(asked).toBe(0)
  })
})

describe('RuleEngine bookkeeping', () => {
  it('lists, replaces, disables and removes sets and notifies subscribers', () => {
    const e = new RuleEngine()
    const changes: RuleSetChange[] = []
    const unsubscribe = e.subscribe((c) => changes.push(c))
    e.setRuleSet(
      set('a', [block(1, {})], {
        priority: 1,
        version: 'v1',
        attribution: { name: 'A', url: 'https://a', licence: 'MIT' }
      })
    )
    e.setRuleSet({
      id: 'text',
      source: 'filter-list',
      priority: 1,
      enabled: true,
      filterText: '||a^\n! comment\n##.ad\n||b^'
    })
    expect(e.listRuleSets().map((s) => s.id)).toEqual(['a', 'text'])
    expect(e.summary('text')).toMatchObject({ filterCount: 2, hasFilterText: true, ruleCount: 0 })
    expect(e.summary('a')).toMatchObject({
      ruleCount: 1,
      version: 'v1',
      attribution: { name: 'A' }
    })
    expect(e.enabledTextSets().map((s) => s.id)).toEqual(['text'])

    e.setEnabled('text', false)
    expect(e.enabledTextSets()).toEqual([])
    e.setEnabled('text', false)
    e.setMetadata('text', { version: '2', updatedAt: 42 })
    expect(e.summary('text')).toMatchObject({ version: '2', updatedAt: 42, enabled: false })

    e.setRuleSet(set('a', [], { priority: 1 }))
    expect(e.summary('a')?.ruleCount).toBe(0)
    e.removeRuleSet('a')
    e.removeRuleSet('a')
    expect(e.has('a')).toBe(false)
    expect(e.listRuleSets().map((s) => s.id)).toEqual(['text'])

    expect(changes.map((c) => `${c.kind}:${c.id}${c.persisted ? ':persisted' : ''}`)).toEqual([
      'set:a',
      'set:text',
      'set:text:persisted',
      'set:text:persisted',
      'set:a',
      'remove:a'
    ])
    expect(changes[1].set?.filterText).toContain('||a^')
    expect(changes[1].summary?.filterCount).toBe(2)
    unsubscribe()
    e.removeRuleSet('text')
    expect(changes.length).toBe(6)
  })

  it('registers persisted sets with their counts without needing the text', () => {
    const e = new RuleEngine()
    e.setRuleSet(
      { id: 'easylist', source: 'filter-list', priority: 1, enabled: true },
      { persisted: true, hasFilterText: true, filterCount: 1234 }
    )
    expect(e.summary('easylist')).toMatchObject({ hasFilterText: true, filterCount: 1234 })
    expect(e.rulesOf('easylist')).toEqual([])
  })

  it('keeps a failing listener from breaking the others', () => {
    const e = new RuleEngine()
    let seen = 0
    e.subscribe(() => {
      throw new Error('boom')
    })
    e.subscribe(() => seen++)
    e.setRuleSet(set('a', []))
    expect(seen).toBe(1)
  })
})

describe('resourceTypeFromElectron', () => {
  it('maps Electron names to declarativeNetRequest types', () => {
    expect(resourceTypeFromElectron('mainFrame')).toBe('main_frame')
    expect(resourceTypeFromElectron('subFrame')).toBe('sub_frame')
    expect(resourceTypeFromElectron('xhr')).toBe('xmlhttprequest')
    expect(resourceTypeFromElectron('cspReport')).toBe('csp_report')
    expect(resourceTypeFromElectron('webSocket')).toBe('websocket')
    expect(resourceTypeFromElectron('image')).toBe('image')
    expect(resourceTypeFromElectron('whatever')).toBe('other')
  })
})
