import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PRIORITY,
  PAGE_STATE_MATCHER,
  SET_ICON,
  SHOW_ACTION,
  actionsFor,
  checkRules,
  mintedRuleId,
  nextMintedCount,
  persistedRulesFrom,
  ruleForExtension,
  ruleHolds,
  selectRules,
  withoutRules,
  type PersistedRule
} from '../api/declarativeContent'

const OWNER = { hasAction: true, hasBookmarks: false }
const minter = (): (() => string) => {
  let n = 0
  return () => mintedRuleId(n++)
}
const show = { instanceType: SHOW_ACTION }
const on = (pageUrl: Record<string, unknown>): Record<string, unknown> => ({
  instanceType: PAGE_STATE_MATCHER,
  pageUrl
})

describe('declarativeContent rules (core)', () => {
  it('fills a rule in as Chrome does: a minted id, the default priority, the parts without their instanceType words; getRules puts the words back', () => {
    const [rule] = checkRules(
      [{ conditions: [on({ hostSuffix: 'instagram.com' })], actions: [show] }],
      [],
      minter(),
      OWNER
    )
    expect(rule).toEqual({
      id: '_0_',
      priority: DEFAULT_PRIORITY,
      conditions: [{ pageUrl: { hostSuffix: 'instagram.com' } }],
      actions: [SHOW_ACTION]
    })
    expect(ruleForExtension(rule!)).toEqual({
      id: '_0_',
      priority: 100,
      conditions: [{ instanceType: PAGE_STATE_MATCHER, pageUrl: { hostSuffix: 'instagram.com' } }],
      actions: [{ instanceType: SHOW_ACTION }]
    })
    // The extension's own id, priority and tags are kept; a SetIcon is kept as a word.
    const [own] = checkRules(
      [
        {
          id: 'mine',
          priority: 7,
          tags: ['a'],
          conditions: [on({ hostEquals: 'web.whatsapp.com' })],
          actions: [{ instanceType: SET_ICON, imageData: {} }]
        }
      ],
      [],
      minter(),
      OWNER
    )
    expect(own).toEqual({
      id: 'mine',
      priority: 7,
      tags: ['a'],
      conditions: [{ pageUrl: { hostEquals: 'web.whatsapp.com' } }],
      actions: [SET_ICON]
    })
  })

  it("refuses in Chrome's words, the whole call at the first fault", () => {
    const check = (rules: unknown, existing: PersistedRule[] = [], owner = OWNER): string => {
      try {
        checkRules(rules, existing, minter(), owner)
      } catch (error) {
        return (error as Error).message
      }
      return ''
    }
    const kept: PersistedRule = { id: '_0_', priority: 100, conditions: [], actions: [] }
    expect(check([{ id: '_0_', conditions: [], actions: [] }], [kept])).toBe(
      'Id _0_ was used multiple times.'
    )
    expect(
      check([
        { id: 'x', conditions: [], actions: [] },
        { id: 'x', conditions: [], actions: [] }
      ])
    ).toBe('Id x was used multiple times.')
    expect(check('rules')).toBe(
      "Error at parameter 'rules': Invalid type: expected array, found string."
    )
    expect(check([1])).toBe(
      "Error at parameter 'rules': Error at index 0: Invalid type: expected events.Rule, found number."
    )
    expect(check([{ conditions: [] }])).toBe(
      "Error at parameter 'rules': Error at index 0: Missing required property 'actions'."
    )
    expect(check([{ conditions: [], actions: [], priority: 1.5 }])).toBe(
      "Error at parameter 'rules': Error at index 0: Error at property 'priority': Invalid type: expected integer, found number."
    )
    expect(check([{ conditions: ['x'], actions: [show] }])).toBe(
      'A condition has to be a dictionary.'
    )
    expect(check([{ conditions: [{}], actions: [show] }])).toBe('A condition had no instanceType')
    expect(check([{ conditions: [show], actions: [show] }])).toBe(
      'Expected a condition of type declarativeContent.PageStateMatcher'
    )
    expect(
      check([{ conditions: [{ instanceType: PAGE_STATE_MATCHER, url: {} }], actions: [show] }])
    ).toBe("Unknown condition attribute 'url'")
    expect(check([{ conditions: [on({ schemes: 'https' })], actions: [show] }])).toBe(
      "Attribute 'pageUrl' has an invalid type"
    )
    expect(
      check([{ conditions: [{ instanceType: PAGE_STATE_MATCHER, css: 'video' }], actions: [show] }])
    ).toBe("Attribute 'css' has an invalid type")
    expect(
      check([
        { conditions: [{ instanceType: PAGE_STATE_MATCHER, isBookmarked: 'yes' }], actions: [show] }
      ])
    ).toBe("Attribute 'isBookmarked' has an invalid type")
    expect(
      check([
        { conditions: [{ instanceType: PAGE_STATE_MATCHER, isBookmarked: true }], actions: [show] }
      ])
    ).toBe("Property 'isBookmarked' requires 'bookmarks' permission")
    expect(
      check(
        [
          {
            conditions: [{ instanceType: PAGE_STATE_MATCHER, isBookmarked: true }],
            actions: [show]
          }
        ],
        [],
        { hasAction: true, hasBookmarks: true }
      )
    ).toBe('')
    expect(check([{ conditions: [], actions: ['show'] }])).toBe('An action has to be a dictionary.')
    expect(check([{ conditions: [], actions: [{}] }])).toBe('Action is missing instanceType')
    expect(
      check([{ conditions: [], actions: [{ instanceType: 'declarativeContent.Hide' }] }])
    ).toBe('An action has an invalid instanceType: declarativeContent.Hide')
    expect(
      check([{ conditions: [], actions: [show] }], [], { hasAction: false, hasBookmarks: false })
    ).toBe("Can't use declarativeContent.ShowAction without an action")
    expect(
      check([{ conditions: [], actions: [{ instanceType: SET_ICON }] }], [], {
        hasAction: false,
        hasBookmarks: false
      })
    ).toBe("Can't use declarativeContent.SetIcon without a page or browser action")
  })

  it('evaluates against a URL: any condition holds the rule, an empty matcher every page, css and isBookmarked never here; the shows come out as one set', () => {
    const rules = checkRules(
      [
        {
          id: 'sites',
          conditions: [on({ hostSuffix: 'instagram.com' }), on({ hostEquals: 'web.whatsapp.com' })],
          actions: [show]
        },
        {
          id: 'icon',
          conditions: [on({ schemes: ['https'] })],
          actions: [{ instanceType: SET_ICON }]
        },
        {
          id: 'css',
          conditions: [{ instanceType: PAGE_STATE_MATCHER, css: ['video'] }],
          actions: [show]
        },
        { id: 'none', conditions: [], actions: [show] }
      ],
      [],
      minter(),
      OWNER
    )
    expect(ruleHolds(rules[0]!, 'https://www.instagram.com/p/1')).toBe(true)
    expect(ruleHolds(rules[0]!, 'https://web.whatsapp.com/')).toBe(true)
    expect(ruleHolds(rules[0]!, 'https://example.com/')).toBe(false)
    expect(ruleHolds(rules[2]!, 'https://www.instagram.com/')).toBe(false)
    expect(ruleHolds(rules[3]!, 'https://www.instagram.com/')).toBe(false)
    expect([...actionsFor(rules, 'https://www.instagram.com/')]).toEqual([SHOW_ACTION, SET_ICON])
    expect([...actionsFor(rules, 'http://example.com/')]).toEqual([])
    const every = checkRules(
      [{ conditions: [{ instanceType: PAGE_STATE_MATCHER }], actions: [show] }],
      [],
      minter(),
      OWNER
    )
    expect(ruleHolds(every[0]!, 'http://anything.example/')).toBe(true)
  })

  it('selects, removes and mints: named ids or all, unknown ids ignored, minted ids past the kept ones', () => {
    const rules: PersistedRule[] = ['_0_', 'mine', '_3_'].map((id) => ({
      id,
      priority: 100,
      conditions: [],
      actions: []
    }))
    expect(selectRules(rules, undefined).map((r) => r.id)).toEqual(['_0_', 'mine', '_3_'])
    expect(selectRules(rules, ['mine', 'unknown']).map((r) => r.id)).toEqual(['mine'])
    expect(withoutRules(rules, ['_0_', 'unknown']).map((r) => r.id)).toEqual(['mine', '_3_'])
    expect(withoutRules(rules, undefined)).toEqual([])
    expect(nextMintedCount(rules)).toBe(4)
    expect(nextMintedCount([])).toBe(0)
    expect(mintedRuleId(4)).toBe('_4_')
  })

  it('reads stored rules back, dropping what lost its shape', () => {
    expect(persistedRulesFrom(null)).toEqual([])
    expect(
      persistedRulesFrom([
        {
          id: '_0_',
          priority: 100,
          conditions: [{ pageUrl: { hostSuffix: 'a' } }],
          actions: [SHOW_ACTION]
        },
        { id: 1, priority: 100, conditions: [], actions: [] },
        {
          id: 'x',
          priority: 100,
          conditions: [{ css: ['a', 2] }, 'bad'],
          actions: ['unknown', SET_ICON],
          tags: ['t', 3]
        }
      ])
    ).toEqual([
      {
        id: '_0_',
        priority: 100,
        conditions: [{ pageUrl: { hostSuffix: 'a' } }],
        actions: [SHOW_ACTION]
      },
      { id: 'x', priority: 100, conditions: [{ css: ['a'] }], actions: [SET_ICON], tags: ['t'] }
    ])
  })
})
