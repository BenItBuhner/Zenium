import { describe, expect, it } from 'vitest'
import {
  EMPTY_CONTENT_RULES,
  blockedGuardsFor,
  contentAllowed,
  contentRuleFor,
  contentRuleSite,
  sanitizeContentRules,
  type ContentRules
} from '../contentRules'

const RULES: ContentRules = {
  ...EMPTY_CONTENT_RULES,
  images: { default: 'allow', sites: { 'https://blocked.example': 'deny' } },
  javascript: { default: 'deny', sites: { 'https://scripts.example': 'allow' } },
  sensors: { default: 'allow', sites: { 'https://still.example': 'deny' } },
  'payment-handler': { default: 'deny', sites: {} }
}

describe('contentRuleSite', () => {
  it('is the permission origin: scheme and host, a non-default port, file:// for local files', () => {
    expect(contentRuleSite('https://Example.com/a/b?c#d')).toBe('https://example.com')
    expect(contentRuleSite('https://example.com:443/')).toBe('https://example.com')
    expect(contentRuleSite('http://example.com:8080/x')).toBe('http://example.com:8080')
    expect(contentRuleSite('file:///home/me/page.html')).toBe('file://')
  })

  it('is null for pages without one', () => {
    expect(contentRuleSite('about:blank')).toBeNull()
    expect(contentRuleSite('data:text/html,hi')).toBeNull()
    expect(contentRuleSite('not a url')).toBeNull()
  })
})

describe('contentRuleFor / contentAllowed', () => {
  it("answers with the site's own decision, else the row's default", () => {
    expect(contentRuleFor(RULES, 'images', 'https://blocked.example/p')).toBe('deny')
    expect(contentRuleFor(RULES, 'images', 'https://other.example/')).toBe('allow')
    expect(contentAllowed(RULES, 'javascript', 'https://scripts.example/app')).toBe(true)
    expect(contentAllowed(RULES, 'javascript', 'https://other.example/')).toBe(false)
  })

  it('gives a page without a site the default alone', () => {
    expect(contentAllowed(RULES, 'javascript', 'about:blank')).toBe(false)
    expect(contentAllowed(RULES, 'images', 'zen://newtab')).toBe(true)
  })

  it('keys by origin, not by domain suffix', () => {
    expect(contentAllowed(RULES, 'images', 'https://sub.blocked.example/')).toBe(true)
    expect(contentAllowed(RULES, 'images', 'http://blocked.example/')).toBe(true)
  })
})

describe('blockedGuardsFor', () => {
  it('names the guarded rows a document is refused', () => {
    expect(blockedGuardsFor(RULES, 'https://still.example/')).toEqual([
      'sensors',
      'payment-handler'
    ])
    expect(blockedGuardsFor(RULES, 'https://other.example/')).toEqual(['payment-handler'])
    expect(blockedGuardsFor(EMPTY_CONTENT_RULES, 'https://other.example/')).toEqual([])
  })
})

describe('sanitizeContentRules', () => {
  it('reads a pushed document back and drops what is malformed', () => {
    const out = sanitizeContentRules({
      images: {
        default: 'deny',
        sites: { 'https://a.example': 'allow', 'https://b.example': 'maybe' }
      },
      javascript: 'nonsense',
      sensors: { default: 'ask', sites: null }
    })
    expect(out.images).toEqual({ default: 'deny', sites: { 'https://a.example': 'allow' } })
    expect(out.javascript).toEqual(EMPTY_CONTENT_RULES.javascript)
    expect(out.sensors).toEqual(EMPTY_CONTENT_RULES.sensors)
    expect(out['insecure-content'].default).toBe('deny')
  })

  it('gives the defaults for nothing at all', () => {
    expect(sanitizeContentRules(undefined)).toEqual(EMPTY_CONTENT_RULES)
  })
})
