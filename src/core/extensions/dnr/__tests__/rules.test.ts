import { describe, expect, test } from 'vitest'
import {
  actionTypePriority,
  compileRule,
  formatParseError,
  isValidHeaderName,
  parseRuleset,
  readRule,
  RULES_FILE_NOT_A_LIST,
  RuleSchemaError,
  type CompiledRule,
  type Rule,
  type RuleParseCode
} from '../rules'
import { isRuleSafe, MAX_NUMBER_OF_REGEX_RULES } from '../limits'
import { CHROME_EXAMPLE_RULES, EXTENSION_BASE_URL, EXTENSION_ID, blockRule, rule } from './fixtures'

const STATIC = { source: 'static' as const, extensionBaseUrl: EXTENSION_BASE_URL }
const DYNAMIC = { source: 'dynamic' as const, extensionBaseUrl: EXTENSION_BASE_URL }
const SESSION = { source: 'session' as const, extensionBaseUrl: EXTENSION_BASE_URL }

describe("Chrome's documented examples", () => {
  test('every example parses as a static ruleset with no warnings', () => {
    const result = parseRuleset(JSON.stringify(CHROME_EXAMPLE_RULES), { ...STATIC, rulesetId: 'r' })
    expect(result.rejected).toBe(false)
    expect(result.errors).toEqual([])
    expect(result.rules.map((r) => r.id)).toEqual(CHROME_EXAMPLE_RULES.map((r) => r.id))
    expect(result.compiled).toHaveLength(CHROME_EXAMPLE_RULES.length)
    expect(result.regexRuleCount).toBe(1)
  })

  test('every example is accepted as dynamic rules too', () => {
    const result = parseRuleset(CHROME_EXAMPLE_RULES, DYNAMIC)
    expect(result.rejected).toBe(false)
    expect(result.errors).toEqual([])
  })

  test('compiled rules carry the indexed shape Chrome derives', () => {
    const result = parseRuleset(CHROME_EXAMPLE_RULES, STATIC)
    const byId = new Map(result.compiled.map((c) => [c.id, c]))
    const block = byId.get(1)!
    expect(block.actionType).toBe('block')
    expect(block.initiatorDomains).toEqual(['foo.com'])
    expect(block.urlPatternType).toBe('substring')
    expect(block.urlPattern).toBe('abc')
    expect(block.isCaseSensitive).toBe(false)

    const extensionPath = byId.get(3)!
    expect(extensionPath.redirectUrl).toBe(`${EXTENSION_BASE_URL}a.jpg`)

    const transform = byId.get(4)!
    expect(transform.urlTransform).toEqual({ scheme: 'https', host: 'new.example.com' })

    const regex = byId.get(5)!
    expect(regex.urlPatternType).toBe('regexp')
    expect(regex.regexSubstitution).toBe('https://\\1.xyz.com/')

    const headers = byId.get(8)!
    expect(headers.requestHeadersToModify).toEqual([{ header: 'cookie', operation: 'remove' }])
    expect(headers.responseHeadersToModify).toEqual([{ header: 'set-cookie', operation: 'remove' }])

    const anchored = byId.get(9)!
    expect(anchored.anchorLeft).toBe('subdomain')
    expect(anchored.urlPattern).toBe('example.com/path')

    const caseSensitive = byId.get(11)!
    expect(caseSensitive.isCaseSensitive).toBe(true)
    expect(caseSensitive.requestDomains).toEqual(['tracker.example', 'stats.example'])
    expect(caseSensitive.excludedRequestDomains).toEqual(['good.stats.example'])
  })

  test('the default priority is 1 and action type order matches Chrome', () => {
    const result = parseRuleset([blockRule(1, 'abc')], STATIC)
    expect(result.compiled[0]!.priority).toBe(1)
    expect(actionTypePriority('allow')).toBeGreaterThan(actionTypePriority('allowAllRequests'))
    expect(actionTypePriority('allowAllRequests')).toBeGreaterThan(actionTypePriority('block'))
    expect(actionTypePriority('block')).toBeGreaterThan(actionTypePriority('upgradeScheme'))
    expect(actionTypePriority('upgradeScheme')).toBeGreaterThan(actionTypePriority('redirect'))
    expect(actionTypePriority('redirect')).toBeGreaterThan(actionTypePriority('modifyHeaders'))
  })

  test('deprecated domains keys become initiator domains', () => {
    const result = parseRuleset(
      [
        {
          id: 1,
          action: { type: 'block' },
          condition: { urlFilter: 'x', domains: ['a.com'], excludedDomains: ['b.a.com'] }
        }
      ],
      STATIC
    )
    expect(result.errors).toEqual([])
    expect(result.compiled[0]!.initiatorDomains).toEqual(['a.com'])
    expect(result.compiled[0]!.excludedInitiatorDomains).toEqual(['b.a.com'])
  })
})

describe('ruleset level errors', () => {
  test('invalid JSON rejects the ruleset', () => {
    const result = parseRuleset('{not json', STATIC)
    expect(result.rejected).toBe(true)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.severity).toBe('error')
  })

  test('a non-list file rejects with Chrome message', () => {
    const result = parseRuleset('{}', STATIC)
    expect(result.rejected).toBe(true)
    expect(result.errors[0]!.message).toBe(RULES_FILE_NOT_A_LIST)
  })

  test('static ruleset over the indexing limit is rejected as a whole', () => {
    const rules = [blockRule(1, 'a'), blockRule(2, 'b'), blockRule(3, 'c')]
    const result = parseRuleset(rules, { ...STATIC, rulesetId: 'big', ruleLimit: 2 })
    expect(result.rejected).toBe(true)
    expect(result.errors[0]!.message).toContain('big')
  })

  test('regex rules beyond the limit are skipped with one warning', () => {
    const rules: Rule[] = []
    for (let id = 1; id <= MAX_NUMBER_OF_REGEX_RULES + 2; id++) {
      rules.push({ id, action: { type: 'block' }, condition: { regexFilter: `a${id}` } })
    }
    const result = parseRuleset(rules, STATIC)
    expect(result.rejected).toBe(false)
    expect(result.regexRuleCount).toBe(MAX_NUMBER_OF_REGEX_RULES)
    expect(result.compiled).toHaveLength(MAX_NUMBER_OF_REGEX_RULES)
    expect(result.errors.map((e) => e.code)).toEqual(['REGEX_RULE_COUNT_EXCEEDED'])
  })

  test('schema errors skip the rule in static rulesets and reject dynamic updates', () => {
    const rules = [{ id: 1, condition: { urlFilter: 'x' } }, blockRule(2, 'y')]
    const stat = parseRuleset(rules, STATIC)
    expect(stat.rejected).toBe(false)
    expect(stat.rules.map((r) => r.id)).toEqual([2])
    expect(stat.errors).toHaveLength(1)
    expect(stat.errors[0]!.severity).toBe('warning')
    expect(stat.errors[0]!.message).toMatch(/^Rule with id 1 couldn't be parsed\. Parse error: /)
    expect(stat.errors[0]!.message).toContain("'action' is required")

    const dyn = parseRuleset(rules, DYNAMIC)
    expect(dyn.rejected).toBe(true)
    expect(dyn.errors[0]!.message).toMatch(/^Error at index 0: /)
  })

  test('a rule without an id is reported by its 1-based index', () => {
    const result = parseRuleset([{ action: { type: 'block' }, condition: {} }], STATIC)
    expect(result.errors[0]!.message).toBe(
      "Rule with index 1 couldn't be parsed. Parse error: 'id' is required."
    )
  })

  test('duplicate ids skip the later static rule and reject dynamic updates', () => {
    const rules = [blockRule(1, 'a'), blockRule(1, 'b')]
    const stat = parseRuleset(rules, STATIC)
    expect(stat.rules).toHaveLength(1)
    expect(stat.errors[0]!.message).toBe('Rule with id 1 does not have a unique ID.')
    const dyn = parseRuleset(rules, DYNAMIC)
    expect(dyn.rejected).toBe(true)
    expect(dyn.errors[0]!.code).toBe('ERROR_DUPLICATE_IDS')
  })

  test('semantic errors are recorded per rule and the rest of the ruleset still indexes', () => {
    const rules = [blockRule(1, ''), blockRule(2, 'ok'), blockRule(0, 'zero')]
    const result = parseRuleset(rules, STATIC)
    expect(result.rejected).toBe(false)
    expect(result.rules.map((r) => r.id)).toEqual([2])
    expect(result.errors.map((e) => e.code)).toEqual([
      'ERROR_EMPTY_URL_FILTER',
      'ERROR_INVALID_RULE_ID'
    ])
  })
})

describe('schema messages (json_schema_compiler wording)', () => {
  const expectSchema = (value: unknown, fragment: string): void => {
    let message = ''
    try {
      readRule(value, 'file')
    } catch (error) {
      expect(error).toBeInstanceOf(RuleSchemaError)
      message = (error as Error).message
    }
    expect(message).toContain(fragment)
  }

  test('missing required keys', () => {
    expectSchema({ id: 1, action: { type: 'block' } }, "'condition' is required")
    expectSchema({ id: 1, condition: {} }, "'action' is required")
    expectSchema({ id: 1, action: {}, condition: {} }, "'type' is required")
  })

  test('wrong types', () => {
    expectSchema({ id: '1', action: { type: 'block' }, condition: {} }, "'id': expected integer")
    expectSchema(
      { id: 1, action: { type: 'block' }, condition: { urlFilter: 5 } },
      "'urlFilter': expected string, got integer"
    )
    expectSchema(
      { id: 1, action: { type: 'block' }, condition: { resourceTypes: 'script' } },
      "'resourceTypes': expected list, got string"
    )
  })

  test('enum values', () => {
    expectSchema({ id: 1, action: { type: 'nope' }, condition: {} }, "'type': expected")
    expectSchema(
      { id: 1, action: { type: 'block' }, condition: { resourceTypes: ['scripts'] } },
      "unable to populate array 'resourceTypes'"
    )
  })
})

describe('semantic errors, one per Chrome ParseResult', () => {
  const cases: [string, Rule, RuleParseCode, 'static' | 'dynamic' | 'session'][] = [
    ['id below 1', blockRule(0, 'a'), 'ERROR_INVALID_RULE_ID', 'static'],
    [
      'priority below 1',
      blockRule(1, 'a', { priority: 0 }),
      'ERROR_INVALID_RULE_PRIORITY',
      'static'
    ],
    ['empty urlFilter', blockRule(1, ''), 'ERROR_EMPTY_URL_FILTER', 'static'],
    ['non-ascii urlFilter', blockRule(1, 'caf\u00e9'), 'ERROR_NON_ASCII_URL_FILTER', 'static'],
    [
      'urlFilter and regexFilter',
      rule(1, { type: 'block' }, { urlFilter: 'a', regexFilter: 'b' }),
      'ERROR_MULTIPLE_FILTERS_SPECIFIED',
      'static'
    ],
    [
      'empty regexFilter',
      rule(1, { type: 'block' }, { regexFilter: '' }),
      'ERROR_EMPTY_REGEX_FILTER',
      'static'
    ],
    [
      'invalid regexFilter',
      rule(1, { type: 'block' }, { regexFilter: '(' }),
      'ERROR_INVALID_REGEX_FILTER',
      'static'
    ],
    [
      'regexFilter over 2 KB',
      rule(1, { type: 'block' }, { regexFilter: '.{100,}.{100,}.{100,}' }),
      'ERROR_REGEX_TOO_LARGE',
      'static'
    ],
    [
      'empty resourceTypes',
      rule(1, { type: 'block' }, { urlFilter: 'a', resourceTypes: [] }),
      'ERROR_EMPTY_RESOURCE_TYPES_LIST',
      'static'
    ],
    [
      'resource type included and excluded',
      rule(
        1,
        { type: 'block' },
        { urlFilter: 'a', resourceTypes: ['script'], excludedResourceTypes: ['script'] }
      ),
      'ERROR_RESOURCE_TYPE_DUPLICATED',
      'static'
    ],
    [
      'every resource type excluded',
      rule(
        1,
        { type: 'block' },
        {
          urlFilter: 'a',
          excludedResourceTypes: [
            'main_frame',
            'sub_frame',
            'stylesheet',
            'script',
            'image',
            'font',
            'object',
            'xmlhttprequest',
            'ping',
            'csp_report',
            'media',
            'websocket',
            'webtransport',
            'webbundle',
            'other'
          ]
        }
      ),
      'ERROR_NO_APPLICABLE_RESOURCE_TYPES',
      'static'
    ],
    [
      'empty requestMethods',
      rule(1, { type: 'block' }, { urlFilter: 'a', requestMethods: [] }),
      'ERROR_EMPTY_REQUEST_METHODS_LIST',
      'static'
    ],
    [
      'request method included and excluded',
      rule(
        1,
        { type: 'block' },
        { urlFilter: 'a', requestMethods: ['get'], excludedRequestMethods: ['get'] }
      ),
      'ERROR_REQUEST_METHOD_DUPLICATED',
      'static'
    ],
    [
      'empty initiatorDomains',
      rule(1, { type: 'block' }, { urlFilter: 'a', initiatorDomains: [] }),
      'ERROR_EMPTY_INITIATOR_DOMAINS_LIST',
      'static'
    ],
    [
      'empty requestDomains',
      rule(1, { type: 'block' }, { urlFilter: 'a', requestDomains: [] }),
      'ERROR_EMPTY_REQUEST_DOMAINS_LIST',
      'static'
    ],
    [
      'domains and initiatorDomains together',
      rule(
        1,
        { type: 'block' },
        { urlFilter: 'a', domains: ['a.com'], initiatorDomains: ['b.com'] }
      ),
      'ERROR_DOMAINS_AND_INITIATOR_DOMAINS_BOTH_SPECIFIED',
      'static'
    ],
    [
      'non-ascii initiator domain',
      rule(1, { type: 'block' }, { urlFilter: 'a', initiatorDomains: ['b\u00fccher.de'] }),
      'ERROR_NON_ASCII_INITIATOR_DOMAIN',
      'static'
    ],
    [
      'non-ascii request domain',
      rule(1, { type: 'block' }, { urlFilter: 'a', excludedRequestDomains: ['b\u00fccher.de'] }),
      'ERROR_NON_ASCII_EXCLUDED_REQUEST_DOMAIN',
      'static'
    ],
    [
      'redirect without redirect key',
      rule(1, { type: 'redirect' }, { urlFilter: 'a' }),
      'ERROR_INVALID_REDIRECT',
      'static'
    ],
    [
      'redirect with an invalid url',
      rule(1, { type: 'redirect', redirect: { url: 'not a url' } }, { urlFilter: 'a' }),
      'ERROR_INVALID_REDIRECT_URL',
      'static'
    ],
    [
      'redirect to javascript',
      rule(1, { type: 'redirect', redirect: { url: 'javascript:alert(1)' } }, { urlFilter: 'a' }),
      'ERROR_JAVASCRIPT_REDIRECT',
      'static'
    ],
    [
      'extensionPath without leading slash',
      rule(1, { type: 'redirect', redirect: { extensionPath: 'a.js' } }, { urlFilter: 'a' }),
      'ERROR_INVALID_EXTENSION_PATH',
      'static'
    ],
    [
      'transform scheme outside the allow list',
      rule(
        1,
        { type: 'redirect', redirect: { transform: { scheme: 'javascript' } } },
        { urlFilter: 'a' }
      ),
      'ERROR_INVALID_TRANSFORM_SCHEME',
      'static'
    ],
    [
      'transform port not numeric',
      rule(1, { type: 'redirect', redirect: { transform: { port: 'abc' } } }, { urlFilter: 'a' }),
      'ERROR_INVALID_TRANSFORM_PORT',
      'static'
    ],
    [
      'transform query without ?',
      rule(1, { type: 'redirect', redirect: { transform: { query: 'a=b' } } }, { urlFilter: 'a' }),
      'ERROR_INVALID_TRANSFORM_QUERY',
      'static'
    ],
    [
      'transform fragment without #',
      rule(
        1,
        { type: 'redirect', redirect: { transform: { fragment: 'top' } } },
        { urlFilter: 'a' }
      ),
      'ERROR_INVALID_TRANSFORM_FRAGMENT',
      'static'
    ],
    [
      'transform query and queryTransform',
      rule(
        1,
        {
          type: 'redirect',
          redirect: { transform: { query: '?a=b', queryTransform: { removeParams: ['x'] } } }
        },
        { urlFilter: 'a' }
      ),
      'ERROR_QUERY_AND_TRANSFORM_BOTH_SPECIFIED',
      'static'
    ],
    [
      'regexSubstitution without regexFilter',
      rule(
        1,
        { type: 'redirect', redirect: { regexSubstitution: 'https://x/' } },
        { urlFilter: 'a' }
      ),
      'ERROR_REGEX_SUBSTITUTION_WITHOUT_FILTER',
      'static'
    ],
    [
      'regexSubstitution referencing a missing group',
      rule(
        1,
        { type: 'redirect', redirect: { regexSubstitution: 'https://\\3/' } },
        { regexFilter: '^(a)(b)' }
      ),
      'ERROR_INVALID_REGEX_SUBSTITUTION',
      'static'
    ],
    [
      'modifyHeaders without headers',
      rule(1, { type: 'modifyHeaders' }, { urlFilter: 'a' }),
      'ERROR_NO_HEADERS_TO_MODIFY_SPECIFIED',
      'static'
    ],
    [
      'modifyHeaders with an empty list',
      rule(1, { type: 'modifyHeaders', requestHeaders: [] }, { urlFilter: 'a' }),
      'ERROR_EMPTY_MODIFY_REQUEST_HEADERS_LIST',
      'static'
    ],
    [
      'modifyHeaders with an invalid header name',
      rule(
        1,
        { type: 'modifyHeaders', requestHeaders: [{ header: 'bad header', operation: 'remove' }] },
        { urlFilter: 'a' }
      ),
      'ERROR_INVALID_HEADER_TO_MODIFY_NAME',
      'static'
    ],
    [
      'set without a value',
      rule(
        1,
        { type: 'modifyHeaders', requestHeaders: [{ header: 'x-a', operation: 'set' }] },
        { urlFilter: 'a' }
      ),
      'ERROR_HEADER_VALUE_NOT_SPECIFIED',
      'static'
    ],
    [
      'remove with a value',
      rule(
        1,
        {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'x-a', operation: 'remove', value: 'v' }]
        },
        { urlFilter: 'a' }
      ),
      'ERROR_HEADER_VALUE_PRESENT',
      'static'
    ],
    [
      'append to a single-value request header',
      rule(
        1,
        {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'authorization', operation: 'append', value: 'v' }]
        },
        { urlFilter: 'a' }
      ),
      'ERROR_APPEND_INVALID_REQUEST_HEADER',
      'static'
    ],
    [
      'allowAllRequests on a script',
      rule(1, { type: 'allowAllRequests' }, { urlFilter: 'a', resourceTypes: ['script'] }),
      'ERROR_INVALID_ALLOW_ALL_REQUESTS_RESOURCE_TYPE',
      'static'
    ],
    [
      'allowAllRequests without resource types',
      rule(1, { type: 'allowAllRequests' }, { urlFilter: 'a' }),
      'ERROR_INVALID_ALLOW_ALL_REQUESTS_RESOURCE_TYPE',
      'static'
    ],
    [
      'tabIds on a static rule',
      rule(1, { type: 'block' }, { urlFilter: 'a', tabIds: [1] }),
      'ERROR_TAB_IDS_ON_NON_SESSION_RULE',
      'static'
    ],
    [
      'tabIds on a dynamic rule',
      rule(1, { type: 'block' }, { urlFilter: 'a', tabIds: [1] }),
      'ERROR_TAB_IDS_ON_NON_SESSION_RULE',
      'dynamic'
    ],
    [
      'empty tabIds',
      rule(1, { type: 'block' }, { urlFilter: 'a', tabIds: [] }),
      'ERROR_EMPTY_TAB_IDS_LIST',
      'session'
    ],
    [
      'tab id included and excluded',
      rule(1, { type: 'block' }, { urlFilter: 'a', tabIds: [1], excludedTabIds: [1] }),
      'ERROR_TAB_ID_DUPLICATED',
      'session'
    ],
    [
      'empty responseHeaders condition',
      rule(1, { type: 'block' }, { urlFilter: 'a', responseHeaders: [] }),
      'ERROR_EMPTY_RESPONSE_HEADER_MATCHING_LIST',
      'static'
    ],
    [
      'invalid response header name',
      rule(1, { type: 'block' }, { urlFilter: 'a', responseHeaders: [{ header: 'bad header' }] }),
      'ERROR_INVALID_MATCHING_RESPONSE_HEADER_NAME',
      'static'
    ]
  ]

  test.each(cases)('%s', (_name, input, code, source) => {
    const result = compileRule(input, { source, extensionBaseUrl: EXTENSION_BASE_URL })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe(code)
    expect(result.message).toBe(formatParseError(code, input.id))
    expect(result.message).toMatch(new RegExp(`^Rule with id ${input.id} `))
  })

  test('session rules may use tabIds', () => {
    const result = compileRule(
      rule(1, { type: 'block' }, { urlFilter: 'a', tabIds: [3, 4] }),
      SESSION
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect([...result.compiled.tabIds]).toEqual([3, 4])
  })

  test('a valid rule for any dynamic update compiles with the extension origin', () => {
    const result = compileRule(
      rule(1, { type: 'redirect', redirect: { extensionPath: '/x/y.js' } }, { urlFilter: 'a' }),
      DYNAMIC
    )
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.compiled.redirectUrl).toBe(`chrome-extension://${EXTENSION_ID}/x/y.js`)
  })
})

describe('urlFilter anchors', () => {
  const compiled = (urlFilter: string): CompiledRule => {
    const result = compileRule(blockRule(1, urlFilter), STATIC)
    if (!result.ok) throw new Error(result.message)
    return result.compiled
  }

  test('|| anchors to a subdomain, | to the boundary', () => {
    expect(compiled('||example.com^')).toMatchObject({
      anchorLeft: 'subdomain',
      anchorRight: 'none',
      urlPattern: 'example.com^'
    })
    expect(compiled('|https://a.com/')).toMatchObject({
      anchorLeft: 'boundary',
      anchorRight: 'none'
    })
    expect(compiled('a.com/x.js|')).toMatchObject({ anchorLeft: 'none', anchorRight: 'boundary' })
    expect(compiled('|http://a|')).toMatchObject({
      anchorLeft: 'boundary',
      anchorRight: 'boundary'
    })
  })

  test('patterns are lower-cased unless case sensitive', () => {
    expect(compiled('ABC/Def').urlPattern).toBe('abc/def')
    const cs = compileRule(
      rule(1, { type: 'block' }, { urlFilter: 'ABC', isUrlFilterCaseSensitive: true }),
      STATIC
    )
    if (cs.ok) expect(cs.compiled.urlPattern).toBe('ABC')
  })

  test('a lone wildcard means every URL', () => {
    expect(compiled('*')).toMatchObject({ urlPatternType: 'wildcarded' })
  })
})

describe('helpers', () => {
  test('isValidHeaderName follows HTTP token rules', () => {
    expect(isValidHeaderName('X-Custom_Header')).toBe(true)
    expect(isValidHeaderName('content-type')).toBe(true)
    expect(isValidHeaderName('')).toBe(false)
    expect(isValidHeaderName('bad header')).toBe(false)
    expect(isValidHeaderName('a:b')).toBe(false)
  })

  test('isRuleSafe: block, allow, allowAllRequests and upgradeScheme are safe', () => {
    expect(isRuleSafe(blockRule(1, 'a'))).toBe(true)
    expect(isRuleSafe(rule(1, { type: 'allow' }, {}))).toBe(true)
    expect(isRuleSafe(rule(1, { type: 'upgradeScheme' }, {}))).toBe(true)
    expect(isRuleSafe(rule(1, { type: 'redirect', redirect: { url: 'https://x/' } }, {}))).toBe(
      false
    )
    expect(
      isRuleSafe(
        rule(
          1,
          { type: 'modifyHeaders', requestHeaders: [{ header: 'a', operation: 'remove' }] },
          {}
        )
      )
    ).toBe(false)
  })
})
