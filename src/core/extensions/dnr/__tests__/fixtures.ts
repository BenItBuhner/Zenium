/**
 * Rules from Chrome's declarativeNetRequest reference ("Rule examples") plus the shapes real
 * rulesets use, as raw JSON the way an extension ships them.
 */
import type { CompiledRule, Rule, RulesetSource } from '../rules'
import { compileRule } from '../rules'

export const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop'
export const EXTENSION_BASE_URL = `chrome-extension://${EXTENSION_ID}/`

/** Chrome's documented examples, one per rule feature. */
export const CHROME_EXAMPLE_RULES: Rule[] = [
  {
    id: 1,
    priority: 1,
    action: { type: 'block' },
    condition: { urlFilter: 'abc', initiatorDomains: ['foo.com'], resourceTypes: ['script'] }
  },
  {
    id: 2,
    priority: 1,
    action: { type: 'redirect', redirect: { url: 'https://example.com' } },
    condition: { urlFilter: 'abc', initiatorDomains: ['foo.com'], resourceTypes: ['script'] }
  },
  {
    id: 3,
    priority: 1,
    action: { type: 'redirect', redirect: { extensionPath: '/a.jpg' } },
    condition: { urlFilter: 'abc', initiatorDomains: ['foo.com'], resourceTypes: ['script'] }
  },
  {
    id: 4,
    priority: 1,
    action: {
      type: 'redirect',
      redirect: { transform: { scheme: 'https', host: 'new.example.com' } }
    },
    condition: { urlFilter: 'example.com', resourceTypes: ['script'] }
  },
  {
    id: 5,
    priority: 1,
    action: { type: 'redirect', redirect: { regexSubstitution: 'https://\\1.xyz.com/' } },
    condition: {
      regexFilter: '^https://www\\.(abc|def)\\.xyz\\.com/',
      resourceTypes: ['main_frame']
    }
  },
  {
    id: 6,
    priority: 1,
    action: { type: 'allow' },
    condition: { urlFilter: 'abc', initiatorDomains: ['foo.com'], resourceTypes: ['script'] }
  },
  {
    id: 7,
    priority: 1,
    action: { type: 'upgradeScheme' },
    condition: { urlFilter: 'example.com', resourceTypes: ['main_frame'] }
  },
  {
    id: 8,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'cookie', operation: 'remove' }],
      responseHeaders: [{ header: 'set-cookie', operation: 'remove' }]
    },
    condition: { urlFilter: 'abc', resourceTypes: ['main_frame', 'sub_frame'] }
  },
  {
    id: 9,
    priority: 1,
    action: { type: 'allowAllRequests' },
    condition: { urlFilter: '||example.com/path', resourceTypes: ['main_frame'] }
  },
  {
    id: 10,
    priority: 2,
    action: { type: 'block' },
    condition: {
      urlFilter: '||ads.example.com^',
      excludedInitiatorDomains: ['example.com'],
      domainType: 'thirdParty',
      requestMethods: ['post'],
      excludedResourceTypes: ['main_frame']
    }
  },
  {
    id: 11,
    action: { type: 'block' },
    condition: {
      requestDomains: ['tracker.example', 'stats.example'],
      excludedRequestDomains: ['good.stats.example'],
      isUrlFilterCaseSensitive: true,
      urlFilter: '/Pixel?'
    }
  },
  {
    id: 12,
    action: {
      type: 'redirect',
      redirect: {
        transform: {
          queryTransform: {
            removeParams: ['utm_source', 'utm_medium'],
            addOrReplaceParams: [{ key: 'ref', value: 'zenium' }]
          }
        }
      }
    },
    condition: { urlFilter: '||example.com', resourceTypes: ['main_frame'] }
  }
]

export function compileAll(
  rules: readonly Rule[],
  source: RulesetSource = 'static'
): CompiledRule[] {
  return rules.map((rule) => {
    const result = compileRule(rule, { source, extensionBaseUrl: EXTENSION_BASE_URL })
    if (!result.ok) throw new Error(`fixture rule ${rule.id}: ${result.message}`)
    return result.compiled
  })
}

export function blockRule(id: number, urlFilter: string, extra: Partial<Rule> = {}): Rule {
  return { id, action: { type: 'block' }, condition: { urlFilter }, ...extra }
}

export function rule(
  id: number,
  action: Rule['action'],
  condition: Rule['condition'],
  priority?: number
): Rule {
  const out: Rule = { id, action, condition }
  if (priority !== undefined) out.priority = priority
  return out
}
