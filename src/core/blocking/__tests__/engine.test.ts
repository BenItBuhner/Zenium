import { describe, expect, it } from 'vitest'
import { RuleEngine, TEXT_MATCH_SET_ID, resourceTypeFromElectron, type TextMatch } from '../engine'
import type { RequestContext, Rule, RuleSet, RuleSetChange } from '../rules'
import { BUILTIN_RULE_SETS, DNR_BAND_SIZE, RULE_SET_PRIORITY } from '../rules'
import { compileRule } from '../../extensions/dnr/rules'
import { routeDecision, type RuleSink } from '../../extensions/dnr/sink'
import { translateRuleset } from '../../extensions/dnr/translate'

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

  it('leaves non-unique hosts alone when the condition says so', () => {
    const e = new RuleEngine()
    e.setRuleSet(set('a', [block(1, { urlFilter: '|http://', excludedNonUniqueHosts: true })]))
    for (const url of [
      'http://localhost:3000/',
      'http://app.localhost/',
      'http://127.0.0.1/',
      'http://[::1]:8080/',
      'http://10.1.2.3/',
      'http://172.16.0.9/',
      'http://192.168.1.1/admin',
      'http://169.254.169.254/',
      'http://[fe80::1]/',
      'http://[fd00::1]/',
      'http://0.0.0.0/',
      'http://intranet/',
      'http://printer.local/',
      'http://nas.home.arpa/'
    ])
      expect(e.decide(req(url)).action, url).toBe('allow')
    for (const url of ['http://example.com/', 'http://8.8.8.8/', 'http://[2606:4700::1111]/'])
      expect(e.decide(req(url)).action, url).toBe('block')
    // Without the flag the same hosts match as any other.
    e.setRuleSet(set('a', [block(1, { urlFilter: '|http://' })]))
    expect(e.decide(req('http://192.168.1.1/admin')).action).toBe('block')
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
    // The Chrome tab id (the WebContents id on desktop) wins over the host's own tab id.
    expect(e.decide(req('https://a/tabbed', { tabId: 'tab-c9f1a2', chromeTabId: 7 })).action).toBe(
      'block'
    )
    expect(e.decide(req('https://a/tabbed', { tabId: 'tab-7', chromeTabId: 8 })).action).toBe(
      'allow'
    )
    expect(e.decide(req('https://a/untabbed', { tabId: 'tab-9', chromeTabId: 7 })).action).toBe(
      'allow'
    )

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

  it('matches topDomains against the top-level document, falling back to the initiator', () => {
    const e = new RuleEngine()
    e.setRuleSet(
      set('top', [
        // Privacy Badger's shape: a tracker is blocked everywhere but on its own site.
        block(1, { requestDomains: ['tracker.example'], excludedTopDomains: ['tracker.example'] }),
        block(2, { urlFilter: '/on-news', topDomains: ['news.example'] })
      ])
    )
    const tracker = 'https://cdn.tracker.example/p.js'
    expect(e.decide(req(tracker, { documentUrl: 'https://www.news.example/story' })).action).toBe(
      'block'
    )
    expect(e.decide(req(tracker, { documentUrl: 'https://www.tracker.example/' })).action).toBe(
      'allow'
    )
    // A frame of the tracker inside a news page: the top-level document decides, not the initiator.
    expect(
      e.decide(
        req(tracker, {
          initiator: 'https://embed.tracker.example/',
          documentUrl: 'https://www.news.example/story'
        })
      ).action
    ).toBe('block')
    expect(
      e.decide(
        req(tracker, {
          initiator: 'https://www.news.example/',
          documentUrl: 'https://www.tracker.example/'
        })
      ).action
    ).toBe('allow')
    // Without a top-level document the initiator stands in, as in Chrome.
    expect(e.decide(req(tracker, { initiator: 'https://www.tracker.example/' })).action).toBe(
      'allow'
    )
    expect(e.decide(req(tracker, { initiator: 'https://www.news.example/' })).action).toBe('block')
    // Nothing known about the page: an exclusion list has nothing to exclude.
    expect(e.decide(req(tracker)).action).toBe('block')
    // A main-frame navigation's top-level host is its own (Chrome's
    // `top_level_frame_or_initiator_host`): going to the tracker's own site is not blocked, even
    // when the navigation came from elsewhere.
    expect(
      e.decide(req('https://www.tracker.example/', { type: 'main_frame' })).action
    ).toBe('allow')
    expect(
      e.decide(
        req('https://www.tracker.example/', {
          type: 'main_frame',
          initiator: 'https://www.news.example/'
        })
      ).action
    ).toBe('allow')

    expect(
      e.decide(req('https://a/on-news', { documentUrl: 'https://news.example/' })).action
    ).toBe('block')
    expect(
      e.decide(req('https://a/on-news', { documentUrl: 'https://shop.example/' })).action
    ).toBe('allow')
    // A `topDomains` list needs a known top-level document (or initiator) to match at all.
    expect(e.decide(req('https://a/on-news')).action).toBe('allow')
    expect(e.decide(req('https://news.example/on-news', { type: 'main_frame' })).action).toBe(
      'block'
    )
    expect(e.decide(req('https://shop.example/on-news', { type: 'main_frame' })).action).toBe(
      'allow'
    )
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

  it("keeps extensions' declarativeNetRequest sets above the switch and the site exceptions", () => {
    const e = new RuleEngine()
    e.setRuleSet(
      set(BUILTIN_RULE_SETS.globalOff, [allow(1, {})], {
        source: 'builtin',
        priority: RULE_SET_PRIORITY.globalOff
      })
    )
    e.setRuleSet(
      set(
        BUILTIN_RULE_SETS.siteExceptions,
        [
          {
            id: 1,
            action: { type: 'allowAllRequests' },
            condition: { urlFilter: '|https://news.example/', resourceTypes: ['main_frame'] }
          }
        ],
        { source: 'builtin', priority: RULE_SET_PRIORITY.siteExceptions }
      )
    )
    // Zenium's own blocking is off and the site is excepted...
    e.setRuleSet(set('ads', [block(1, { urlFilter: '||ads.example^' })], { priority: 1 }))
    const ctx = req('https://ads.example/x.js', { documentUrl: 'https://news.example/story' })
    expect(e.decide(ctx).action).toBe('allow')
    // ...yet an extension's translated rule still blocks, and the newer extension wins.
    e.setRuleSet(
      set('dnr:older', [block(1, { urlFilter: '||ads.example^' })], {
        priority: RULE_SET_PRIORITY.dnr + 1
      })
    )
    expect(e.decide(ctx)).toMatchObject({ action: 'block', matched: { setId: 'dnr:older' } })
    e.setRuleSet(
      set('dnr:newer', [allow(1, { urlFilter: '||ads.example^' })], {
        priority: RULE_SET_PRIORITY.dnr + 2
      })
    )
    expect(e.decide(ctx)).toMatchObject({ action: 'allow', matched: { setId: 'dnr:newer' } })
  })

  it("is the declarativeNetRequest translator's sink: its sets land in the dnr band and decide", () => {
    const e = new RuleEngine()
    const sink: RuleSink = e
    const extensionId = 'a'.repeat(32)
    const compiled = compileRule(
      {
        id: 7,
        action: { type: 'block' },
        condition: { urlFilter: '||ads.example^', resourceTypes: ['script'] }
      },
      { source: 'static', extensionBaseUrl: `chrome-extension://${extensionId}/` }
    )
    if (!compiled.ok) throw new Error(compiled.message)
    const { set: translated } = translateRuleset(
      { extensionId, name: 'Example Blocker', installRank: 0, rulesets: [] },
      { source: 'static', rulesetId: 'ads', path: 'rules/ads.json', rules: [compiled.compiled] }
    )
    expect(translated.priority).toBe(RULE_SET_PRIORITY.dnr + DNR_BAND_SIZE - 1)
    sink.setRuleSet(translated)
    // Zenium's own switch is off, yet the extension's rule still decides...
    e.setRuleSet(
      set(BUILTIN_RULE_SETS.globalOff, [allow(1, {})], {
        source: 'builtin',
        priority: RULE_SET_PRIORITY.globalOff
      })
    )
    const decision = e.decide(req('https://ads.example/x.js'))
    expect(decision.action).toBe('block')
    // ...and the decision routes back to the extension and rule that made it.
    expect(routeDecision(decision)).toEqual({ extensionId, ruleId: 7, rulesetId: 'ads' })
    sink.removeRuleSet(translated.id)
    expect(e.decide(req('https://ads.example/x.js')).action).toBe('allow')
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

describe('RuleEngine headers-received stage', () => {
  // Stylus's usercss installer: redirect a `.user.css` document served as text (not HTML).
  const usercss: Rule = {
    id: 1,
    action: {
      type: 'redirect',
      redirect: { regexSubstitution: 'chrome-extension://stylus/install-usercss.html#\\0' }
    },
    condition: {
      regexFilter: '^.*\\.user\\.css$',
      resourceTypes: ['main_frame'],
      responseHeaders: [
        { header: 'content-type', values: ['text/*'], excludedValues: ['text/html*'] }
      ]
    }
  }
  const page = (url: string, headers?: Record<string, string[]>): RequestContext =>
    req(url, { type: 'main_frame', responseHeaders: headers })

  it('leaves header-conditioned rules to the headers-received stage and says so', () => {
    const e = new RuleEngine()
    e.setRuleSet(set('stylus', [usercss]))
    // Request stage: the rule's other conditions pass, so the host must ask again.
    const early = e.decide(page('https://a.example/theme.user.css'))
    expect(early).toEqual({ action: 'allow', needsHeaders: true })
    // A request the rule would never match needs no second round.
    expect(e.decide(page('https://a.example/index.html'))).toEqual({ action: 'allow' })
    expect(e.decide(req('https://a.example/theme.user.css')).needsHeaders).toBeUndefined()
    // Headers-received stage: the content type decides.
    const css = e.decide(page('https://a.example/theme.user.css', { 'Content-Type': ['text/css'] }))
    expect(css.action).toBe('redirect')
    expect(css.redirectUrl).toBe(
      'chrome-extension://stylus/install-usercss.html#https://a.example/theme.user.css'
    )
    expect(css.matched).toEqual({ setId: 'stylus', ruleId: 1 })
    expect(css.needsHeaders).toBeUndefined()
    expect(
      e.decide(
        page('https://a.example/theme.user.css', { 'content-type': ['text/html; charset=utf-8'] })
      ).action
    ).toBe('allow')
    expect(e.decide(page('https://a.example/theme.user.css', {})).action).toBe('allow')
  })

  it('lets a request-stage allow of equal or higher priority cap the header stage', () => {
    const e = new RuleEngine()
    e.setRuleSet(
      set('a', [
        {
          id: 1,
          priority: 2,
          action: { type: 'block' },
          condition: { urlFilter: '||ads.example^', responseHeaders: [{ header: 'x-ads' }] }
        },
        allow(2, { urlFilter: '||ads.example/allowed' }, 2),
        allow(3, { urlFilter: '||ads.example/weakly-allowed' }, 1)
      ])
    )
    const headers = { 'x-ads': ['1'] }
    expect(e.decide(req('https://ads.example/x.js', { responseHeaders: headers })).action).toBe(
      'block'
    )
    const allowed = e.decide(req('https://ads.example/allowed', { responseHeaders: headers }))
    expect(allowed.action).toBe('allow')
    expect(allowed.matched).toEqual({ setId: 'a', ruleId: 2 })
    // The allow already decided at the request stage, so no second round is needed either.
    expect(e.decide(req('https://ads.example/allowed')).needsHeaders).toBeUndefined()
    expect(
      e.decide(req('https://ads.example/weakly-allowed', { responseHeaders: headers })).action
    ).toBe('block')
  })

  it('merges the header edits of both stages and lets a header-stage block or allow cap them', () => {
    const e = new RuleEngine()
    e.setRuleSet(
      set('h', [
        {
          id: 1,
          priority: 3,
          action: {
            type: 'modifyHeaders',
            responseHeaders: [{ header: 'Set-Cookie', operation: 'remove' }]
          },
          condition: { urlFilter: '||h.example^' }
        },
        {
          id: 2,
          priority: 2,
          action: {
            type: 'modifyHeaders',
            responseHeaders: [{ header: 'X-Frame-Options', operation: 'remove' }]
          },
          condition: { urlFilter: '||h.example^', responseHeaders: [{ header: 'x-frame-options' }] }
        },
        {
          id: 3,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            responseHeaders: [{ header: 'X-Low', operation: 'set', value: '1' }]
          },
          condition: { urlFilter: '||h.example^' }
        },
        {
          id: 4,
          priority: 5,
          action: { type: 'block' },
          condition: {
            urlFilter: '||h.example/blocked',
            responseHeaders: [{ header: 'content-type', values: ['application/x-bad'] }]
          }
        },
        {
          id: 5,
          priority: 2,
          action: { type: 'allow' },
          condition: { urlFilter: '||h.example/late-allow', responseHeaders: [{ header: 'x-ok' }] }
        }
      ])
    )
    const early = e.decide(req('https://h.example/page'))
    expect(early.action).toBe('modifyHeaders')
    expect(early.needsHeaders).toBe(true)
    expect(early.responseHeaders).toEqual([
      { header: 'Set-Cookie', operation: 'remove' },
      { header: 'X-Low', operation: 'set', value: '1' }
    ])
    // With the headers in, the header-stage edit slots in by priority.
    const late = e.decide(
      req('https://h.example/page', { responseHeaders: { 'X-Frame-Options': ['DENY'] } })
    )
    expect(late.action).toBe('modifyHeaders')
    expect(late.responseHeaders).toEqual([
      { header: 'Set-Cookie', operation: 'remove' },
      { header: 'X-Frame-Options', operation: 'remove' },
      { header: 'X-Low', operation: 'set', value: '1' }
    ])
    expect(late.matched).toEqual({ setId: 'h', ruleId: 1 })
    expect(late.needsHeaders).toBeUndefined()
    // Without the header the header-stage rule drops out again.
    expect(
      e.decide(req('https://h.example/page', { responseHeaders: {} })).responseHeaders
    ).toEqual(early.responseHeaders)
    // A header-stage block wins over every header edit.
    expect(
      e.decide(
        req('https://h.example/blocked', {
          responseHeaders: { 'content-type': ['application/x-bad'] }
        })
      ).action
    ).toBe('block')
    // A header-stage allow (priority 2) keeps the request stage's edits of equal or higher
    // priority and drops the lower ones, as Chrome's RulesetManager does.
    const capped = e.decide(
      req('https://h.example/late-allow', {
        responseHeaders: { 'x-ok': ['1'], 'x-frame-options': ['DENY'] }
      })
    )
    expect(capped.action).toBe('modifyHeaders')
    expect(capped.responseHeaders).toEqual([{ header: 'Set-Cookie', operation: 'remove' }])
  })

  it('lets a header-conditioned rule edit the response only', () => {
    // Chrome refuses such a rule's `requestHeaders` at parse
    // (ERROR_RESPONSE_HEADER_RULE_CANNOT_MODIFY_REQUEST_HEADERS); a set written by hand gets the
    // same treatment: the request is out by the time the rule decides.
    const e = new RuleEngine()
    e.setRuleSet(
      set('r', [
        {
          id: 1,
          priority: 2,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'Cookie', operation: 'remove' }],
            responseHeaders: [{ header: 'Set-Cookie', operation: 'remove' }]
          },
          condition: { urlFilter: '||r.example^', responseHeaders: [{ header: 'set-cookie' }] }
        },
        {
          id: 2,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'X-Early', operation: 'set', value: '1' }]
          },
          condition: { urlFilter: '||r.example^' }
        }
      ])
    )
    const early = e.decide(req('https://r.example/'))
    expect(early.requestHeaders).toEqual([{ header: 'X-Early', operation: 'set', value: '1' }])
    expect(early.needsHeaders).toBe(true)
    const late = e.decide(
      req('https://r.example/', { responseHeaders: { 'Set-Cookie': ['a=1'] } })
    )
    expect(late.action).toBe('modifyHeaders')
    expect(late.responseHeaders).toEqual([{ header: 'Set-Cookie', operation: 'remove' }])
    expect(late.requestHeaders).toEqual([{ header: 'X-Early', operation: 'set', value: '1' }])
  })

  it('keeps allowAllRequests document exceptions out of the header stage', () => {
    const e = new RuleEngine()
    e.setRuleSet(
      set('x', [
        block(1, { urlFilter: '||ads.example^', responseHeaders: [{ header: 'x-ads' }] }, 1),
        {
          id: 2,
          priority: 2,
          action: { type: 'allowAllRequests' },
          condition: { urlFilter: '||trusted.example^', resourceTypes: ['main_frame'] }
        }
      ])
    )
    const under = req('https://ads.example/x.js', {
      documentUrl: 'https://trusted.example/',
      responseHeaders: { 'x-ads': ['1'] }
    })
    // The document exception (request stage) still shields sub-resources...
    expect(e.decide(under).action).toBe('allow')
    // ...and a header-conditioned allowAllRequests only ever matches the frame request itself.
    e.setRuleSet(
      set('y', [
        {
          id: 1,
          priority: 3,
          action: { type: 'allowAllRequests' },
          condition: {
            urlFilter: '||other.example^',
            resourceTypes: ['main_frame'],
            responseHeaders: [{ header: 'x-trust' }]
          }
        },
        block(2, { urlFilter: '||other.example/blocked.js' }, 1)
      ])
    )
    expect(
      e.decide(req('https://other.example/blocked.js', { documentUrl: 'https://other.example/' }))
        .action
    ).toBe('block')
    expect(
      e.decide(
        req('https://other.example/', { type: 'main_frame', responseHeaders: { 'x-trust': ['1'] } })
      ).action
    ).toBe('allow')
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

describe('RuleEngine partition scope', () => {
  const ad = (partition?: string): RequestContext =>
    req(
      'https://ads.example/x.js',
      partition ? { partition, isPrivate: partition === 'private' } : {}
    )

  it('applies a scoped set only to requests from a listed partition', () => {
    const e = new RuleEngine()
    e.setRuleSet(
      set('ext:a:static:one', [block(1, { urlFilter: '||ads.example^' })], {
        priority: RULE_SET_PRIORITY.dnr,
        partitions: ['default', 'work']
      })
    )
    expect(e.decide(ad('default')).action).toBe('block')
    expect(e.decide(ad('work')).action).toBe('block')
    expect(e.decide(ad('private')).action).toBe('allow')
    // A scoped set needs to know where the request runs; unknown means not listed.
    expect(e.decide(ad()).action).toBe('allow')
    expect(e.summary('ext:a:static:one')?.partitions).toEqual(['default', 'work'])
  })

  it('leaves unscoped sets applying everywhere, private windows included', () => {
    const e = new RuleEngine()
    e.setRuleSet(
      set('easylist', [block(1, { urlFilter: '||ads.example^' })], {
        source: 'filter-list',
        priority: RULE_SET_PRIORITY.filterList
      })
    )
    expect(e.decide(ad('default')).action).toBe('block')
    expect(e.decide(ad('private')).action).toBe('block')
    expect(e.decide(ad()).action).toBe('block')
    expect(e.summary('easylist')?.partitions).toBeUndefined()
  })

  it('re-scopes a set in place, notifying subscribers as a persisted change', () => {
    const e = new RuleEngine()
    const changes: RuleSetChange[] = []
    e.subscribe((c) => changes.push(c))
    e.setRuleSet(
      set('ext:a:_dynamic', [block(1, { urlFilter: '||ads.example^' })], {
        priority: RULE_SET_PRIORITY.dnr,
        partitions: ['default']
      })
    )
    expect(e.decide(ad('private')).action).toBe('allow')

    e.setPartitions('ext:a:_dynamic', ['default', 'private'])
    expect(e.decide(ad('private')).action).toBe('block')
    e.setPartitions('ext:a:_dynamic', ['default', 'private'])
    e.setPartitions('ext:a:_dynamic', undefined)
    expect(e.decide(ad()).action).toBe('block')
    expect(e.summary('ext:a:_dynamic')?.partitions).toBeUndefined()
    e.setPartitions('ext:a:_dynamic', [])
    expect(e.decide(ad('default')).action).toBe('allow')
    e.setPartitions('missing', ['default'])

    expect(changes.map((c) => `${c.kind}:${c.persisted ? 'persisted' : 'new'}`)).toEqual([
      'set:new',
      'set:persisted',
      'set:persisted',
      'set:persisted'
    ])
    expect(changes[1].set?.partitions).toEqual(['default', 'private'])
    expect(changes[1].summary?.partitions).toEqual(['default', 'private'])
    expect(changes[2].set?.partitions).toBeUndefined()
    expect(changes[3].set?.partitions).toEqual([])
  })

  it('lets a scoped extension set stay out of a private request the lists still block', () => {
    const e = new RuleEngine()
    e.setRuleSet(
      set('easylist', [block(1, { urlFilter: '||tracker.example^' })], {
        source: 'filter-list',
        priority: RULE_SET_PRIORITY.filterList
      })
    )
    e.setRuleSet(
      set('ext:a:static:one', [block(1, { urlFilter: '||ads.example^' })], {
        priority: RULE_SET_PRIORITY.dnr,
        partitions: ['default']
      })
    )
    const tracker = req('https://tracker.example/t.js', { partition: 'private', isPrivate: true })
    expect(e.decide(tracker)).toMatchObject({ action: 'block', matched: { setId: 'easylist' } })
    expect(e.decide(ad('private')).action).toBe('allow')
    expect(e.decide(ad('default'))).toMatchObject({
      action: 'block',
      matched: { setId: 'ext:a:static:one' }
    })
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
