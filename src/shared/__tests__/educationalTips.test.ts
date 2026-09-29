import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BROWSER_TIP_MAX_IMPRESSIONS,
  EDUCATIONAL_TIP_ANY_INTERVAL_MS,
  EDUCATIONAL_TIP_CARD_IDS,
  EDUCATIONAL_TIP_CARD_INTERVAL_MS,
  EDUCATIONAL_TIP_MAX_IMPRESSIONS,
  EDUCATIONAL_TIP_MODULE_NAME,
  QUICK_DELETE_TIP_REST_MS,
  TAB_GROUPS_TIP_TAB_COUNT,
  educationalTipCardButton,
  educationalTipCardDescription,
  educationalTipCardHolds,
  educationalTipCardMaxImpressions,
  educationalTipCardRested,
  educationalTipCardTitle,
  educationalTipCardWanted,
  educationalTipsRested,
  emptyEducationalTipMemory,
  interactEducationalTipCard,
  isEducationalTipCardId,
  noteBrowsingDataCleared,
  pickEducationalTipCard,
  sameEducationalTipMemory,
  sanitizeEducationalTipMemory,
  showEducationalTipCard,
  type EducationalTipCardId,
  type EducationalTipInputs,
  type EducationalTipMemory
} from '../educationalTips'

/*
 * Chrome's educational tip module as a pure machine (NTP-20): the four cards in the registry's
 * priority order, each card's rule over the state's signals, the shared cadence – a tip every
 * three days, a card every seven, ten impressions a card and three for the default browser, a
 * tapped card never again – and the memory the transitions write, sanitised from disk.
 */

const DAY = 24 * 3_600_000
const NOW = Date.UTC(2026, 8, 27, 12)

/** A phone every card's live signal holds on. */
const ALL: EducationalTipInputs = {
  customizedBackground: false,
  canRequestDefault: true,
  isDefault: false,
  defaultBrowserPromptUp: false,
  groups: 0,
  tabs: 12
}

/** A phone no card's live signal holds on – except Quick Delete's, which has none. */
const NONE: EducationalTipInputs = {
  customizedBackground: true,
  canRequestDefault: true,
  isDefault: true,
  defaultBrowserPromptUp: false,
  groups: 2,
  tabs: 3
}

/** The inputs with one card's signals alone holding (Quick Delete's rest set in the memory). */
function only(id: EducationalTipCardId): EducationalTipInputs {
  switch (id) {
    case 'ntp-theme':
      return { ...NONE, customizedBackground: false }
    case 'default-browser':
      return { ...NONE, isDefault: false }
    case 'tab-groups':
      return { ...NONE, groups: 0, tabs: 11 }
    case 'quick-delete':
      return NONE
  }
}

/** A memory on which Quick Delete rests: browsing data deleted yesterday. */
const QUIET: EducationalTipMemory = {
  ...emptyEducationalTipMemory(),
  browsingDataClearedAt: NOW - DAY
}

const withCard = (
  memory: EducationalTipMemory,
  id: EducationalTipCardId,
  card: Partial<EducationalTipMemory['cards'][EducationalTipCardId]>
): EducationalTipMemory => ({
  ...memory,
  cards: { ...memory.cards, [id]: { impressions: 0, shownAt: null, interacted: false, ...card } }
})

describe('the registry and the constants', () => {
  it('lists Chrome’s four cards in the registry’s priority order, with Chrome’s cadence', () => {
    expect(EDUCATIONAL_TIP_CARD_IDS).toEqual([
      'ntp-theme',
      'default-browser',
      'tab-groups',
      'quick-delete'
    ])
    for (const id of EDUCATIONAL_TIP_CARD_IDS) expect(isEducationalTipCardId(id)).toBe(true)
    expect(isEducationalTipCardId('history-sync')).toBe(false)
    expect(isEducationalTipCardId(3)).toBe(false)
    expect(EDUCATIONAL_TIP_ANY_INTERVAL_MS).toBe(3 * DAY)
    expect(EDUCATIONAL_TIP_CARD_INTERVAL_MS).toBe(7 * DAY)
    expect(EDUCATIONAL_TIP_MAX_IMPRESSIONS).toBe(10)
    expect(DEFAULT_BROWSER_TIP_MAX_IMPRESSIONS).toBe(3)
    expect(TAB_GROUPS_TIP_TAB_COUNT).toBe(10)
    expect(QUICK_DELETE_TIP_REST_MS).toBe(30 * DAY)
    expect(educationalTipCardMaxImpressions('default-browser')).toBe(3)
    for (const id of ['ntp-theme', 'tab-groups', 'quick-delete'] as const)
      expect(educationalTipCardMaxImpressions(id)).toBe(10)
  })
})

describe('the cards’ rules', () => {
  it('the theme card holds while the page’s background is the default', () => {
    expect(educationalTipCardHolds('ntp-theme', ALL)).toBe(true)
    expect(educationalTipCardHolds('ntp-theme', { ...ALL, customizedBackground: true })).toBe(false)
  })

  it('the default-browser card holds while the host can ask, Zenium is known not to be the default and nothing else is asking', () => {
    expect(educationalTipCardHolds('default-browser', ALL)).toBe(true)
    expect(educationalTipCardHolds('default-browser', { ...ALL, isDefault: true })).toBe(false)
    expect(educationalTipCardHolds('default-browser', { ...ALL, isDefault: null })).toBe(false)
    expect(educationalTipCardHolds('default-browser', { ...ALL, canRequestDefault: false })).toBe(
      false
    )
    expect(
      educationalTipCardHolds('default-browser', { ...ALL, defaultBrowserPromptUp: true })
    ).toBe(false)
  })

  it('the tab-groups card holds while there is no group and more than ten tabs', () => {
    expect(educationalTipCardHolds('tab-groups', ALL)).toBe(true)
    expect(educationalTipCardHolds('tab-groups', { ...ALL, tabs: 11 })).toBe(true)
    expect(educationalTipCardHolds('tab-groups', { ...ALL, tabs: 10 })).toBe(false)
    expect(educationalTipCardHolds('tab-groups', { ...ALL, groups: 1 })).toBe(false)
  })

  it('the Quick Delete card has no live signal; its rule is the memory’s thirty days since a deletion', () => {
    expect(educationalTipCardHolds('quick-delete', ALL)).toBe(true)
    expect(educationalTipCardHolds('quick-delete', NONE)).toBe(true)
    const fresh = emptyEducationalTipMemory()
    expect(educationalTipCardWanted('quick-delete', NONE, fresh, NOW)).toBe(true)
    expect(educationalTipCardWanted('quick-delete', NONE, QUIET, NOW)).toBe(false)
    const rested = { ...fresh, browsingDataClearedAt: NOW - QUICK_DELETE_TIP_REST_MS }
    expect(educationalTipCardWanted('quick-delete', NONE, rested, NOW)).toBe(true)
    const almost = { ...fresh, browsingDataClearedAt: NOW - QUICK_DELETE_TIP_REST_MS + 1 }
    expect(educationalTipCardWanted('quick-delete', NONE, almost, NOW)).toBe(false)
    // The other cards' wants are their live signals alone.
    expect(educationalTipCardWanted('ntp-theme', ALL, QUIET, NOW)).toBe(true)
    expect(educationalTipCardWanted('ntp-theme', NONE, fresh, NOW)).toBe(false)
  })
})

describe('the pick', () => {
  it('takes the first wanted card in priority order: theme, default browser, tab groups, Quick Delete', () => {
    const fresh = emptyEducationalTipMemory()
    expect(pickEducationalTipCard(ALL, fresh, NOW)).toBe('ntp-theme')
    expect(pickEducationalTipCard({ ...ALL, customizedBackground: true }, fresh, NOW)).toBe(
      'default-browser'
    )
    expect(
      pickEducationalTipCard({ ...ALL, customizedBackground: true, isDefault: true }, fresh, NOW)
    ).toBe('tab-groups')
    expect(
      pickEducationalTipCard(
        { ...ALL, customizedBackground: true, isDefault: true, groups: 1 },
        fresh,
        NOW
      )
    ).toBe('quick-delete')
    expect(pickEducationalTipCard(NONE, QUIET, NOW)).toBeNull()
    for (const id of EDUCATIONAL_TIP_CARD_IDS)
      expect(pickEducationalTipCard(only(id), id === 'quick-delete' ? fresh : QUIET, NOW)).toBe(id)
  })

  it('shows no tip within three days of the last, whichever card that was', () => {
    const shown = showEducationalTipCard(emptyEducationalTipMemory(), 'ntp-theme', NOW - DAY)
    expect(educationalTipsRested(shown, NOW)).toBe(false)
    expect(pickEducationalTipCard(ALL, shown, NOW)).toBeNull()
    expect(
      pickEducationalTipCard(ALL, shown, NOW - DAY + EDUCATIONAL_TIP_ANY_INTERVAL_MS - 1)
    ).toBe(null)
    expect(pickEducationalTipCard(ALL, shown, NOW - DAY + EDUCATIONAL_TIP_ANY_INTERVAL_MS)).toBe(
      'default-browser'
    )
  })

  it('shows a card at most once in seven days: the next card in order takes the slot meanwhile', () => {
    const themeShown = showEducationalTipCard(
      emptyEducationalTipMemory(),
      'ntp-theme',
      NOW - 4 * DAY
    )
    expect(educationalTipsRested(themeShown, NOW)).toBe(true)
    expect(educationalTipCardRested('ntp-theme', themeShown, NOW)).toBe(false)
    expect(pickEducationalTipCard(ALL, themeShown, NOW)).toBe('default-browser')
    expect(
      pickEducationalTipCard(
        only('ntp-theme'),
        { ...themeShown, browsingDataClearedAt: NOW - DAY },
        NOW
      )
    ).toBeNull()
    const week = NOW - 4 * DAY + EDUCATIONAL_TIP_CARD_INTERVAL_MS
    expect(educationalTipCardRested('ntp-theme', themeShown, week)).toBe(true)
    expect(pickEducationalTipCard(ALL, themeShown, week)).toBe('ntp-theme')
  })

  it('caps a card at ten impressions, the default-browser card at three', () => {
    const capped = withCard(QUIET, 'ntp-theme', { impressions: 10, shownAt: NOW - 30 * DAY })
    expect(educationalTipCardRested('ntp-theme', capped, NOW)).toBe(false)
    expect(pickEducationalTipCard(only('ntp-theme'), capped, NOW)).toBeNull()
    const nine = withCard(QUIET, 'ntp-theme', { impressions: 9, shownAt: NOW - 30 * DAY })
    expect(pickEducationalTipCard(only('ntp-theme'), nine, NOW)).toBe('ntp-theme')
    const three = withCard(QUIET, 'default-browser', { impressions: 3, shownAt: NOW - 30 * DAY })
    expect(pickEducationalTipCard(only('default-browser'), three, NOW)).toBeNull()
    const two = withCard(QUIET, 'default-browser', { impressions: 2, shownAt: NOW - 30 * DAY })
    expect(pickEducationalTipCard(only('default-browser'), two, NOW)).toBe('default-browser')
    // A capped card is skipped, not the slot: the next card takes it.
    expect(pickEducationalTipCard(ALL, capped, NOW)).toBe('default-browser')
  })

  it('a card acted on is never shown again, whatever the signals', () => {
    const tapped = interactEducationalTipCard(emptyEducationalTipMemory(), 'tab-groups')
    expect(tapped.cards['tab-groups']).toEqual({ impressions: 0, shownAt: null, interacted: true })
    expect(interactEducationalTipCard(tapped, 'tab-groups')).toBe(tapped)
    expect(educationalTipCardRested('tab-groups', tapped, NOW + 365 * DAY)).toBe(false)
    expect(
      pickEducationalTipCard(
        only('tab-groups'),
        { ...tapped, browsingDataClearedAt: NOW - DAY },
        NOW
      )
    ).toBeNull()
    expect(
      pickEducationalTipCard({ ...ALL, customizedBackground: true, isDefault: true }, tapped, NOW)
    ).toBe('quick-delete')
  })
})

describe('the transitions and the memory', () => {
  it('an impression counts once on the card and sets both clocks', () => {
    const once = showEducationalTipCard(emptyEducationalTipMemory(), 'quick-delete', NOW)
    expect(once).toEqual({
      cards: { 'quick-delete': { impressions: 1, shownAt: NOW, interacted: false } },
      shownAt: NOW,
      browsingDataClearedAt: null
    })
    const twice = showEducationalTipCard(once, 'quick-delete', NOW + 8 * DAY)
    expect(twice.cards['quick-delete']).toEqual({
      impressions: 2,
      shownAt: NOW + 8 * DAY,
      interacted: false
    })
    expect(twice.shownAt).toBe(NOW + 8 * DAY)
    // Another card's impression leaves the first card's record as it was.
    const other = showEducationalTipCard(twice, 'ntp-theme', NOW + 12 * DAY)
    expect(other.cards['quick-delete']).toEqual(twice.cards['quick-delete'])
    expect(other.cards['ntp-theme']).toEqual({
      impressions: 1,
      shownAt: NOW + 12 * DAY,
      interacted: false
    })
  })

  it('a deletion of browsing data stamps the memory; an earlier or equal time changes nothing', () => {
    const stamped = noteBrowsingDataCleared(emptyEducationalTipMemory(), NOW)
    expect(stamped.browsingDataClearedAt).toBe(NOW)
    expect(noteBrowsingDataCleared(stamped, NOW)).toBe(stamped)
    expect(noteBrowsingDataCleared(stamped, NOW - 1)).toBe(stamped)
    expect(noteBrowsingDataCleared(stamped, NOW + 1).browsingDataClearedAt).toBe(NOW + 1)
  })

  it('sanitises a record from disk: known cards, coerced fields, empty records dropped', () => {
    expect(sanitizeEducationalTipMemory(undefined)).toEqual(emptyEducationalTipMemory())
    expect(sanitizeEducationalTipMemory('tips')).toEqual(emptyEducationalTipMemory())
    expect(
      sanitizeEducationalTipMemory({
        cards: {
          'ntp-theme': { impressions: 2.7, shownAt: 5, interacted: 'yes' },
          'default-browser': { impressions: -1, shownAt: -5, interacted: false },
          'tab-groups': { impressions: 0, shownAt: null, interacted: true },
          'history-sync': { impressions: 4, shownAt: 9, interacted: false },
          'quick-delete': 'shown'
        },
        shownAt: 'now',
        browsingDataClearedAt: 12
      })
    ).toEqual({
      cards: {
        'ntp-theme': { impressions: 2, shownAt: 5, interacted: false },
        'tab-groups': { impressions: 0, shownAt: null, interacted: true }
      },
      shownAt: null,
      browsingDataClearedAt: 12
    })
  })

  it('compares two memories by value', () => {
    const a = showEducationalTipCard(emptyEducationalTipMemory(), 'ntp-theme', NOW)
    expect(sameEducationalTipMemory(a, structuredClone(a))).toBe(true)
    expect(sameEducationalTipMemory(a, emptyEducationalTipMemory())).toBe(false)
    expect(sameEducationalTipMemory(a, { ...a, shownAt: NOW + 1 })).toBe(false)
    expect(sameEducationalTipMemory(a, { ...a, browsingDataClearedAt: 1 })).toBe(false)
    expect(sameEducationalTipMemory(a, interactEducationalTipCard(a, 'ntp-theme'))).toBe(false)
    expect(sameEducationalTipMemory(a, withCard(a, 'quick-delete', { impressions: 1 }))).toBe(false)
  })
})

describe('the words', () => {
  it('are Chrome’s, with the product’s name and its British spelling, the design lead’s two folds on #695 (the default-browser button §9.29’s "Set as default"; the tab-groups sentence saying when, its button "Try it now" – no how is shown); one name for every tip', () => {
    expect(EDUCATIONAL_TIP_MODULE_NAME).toBe('Zenium tips')
    expect(educationalTipCardTitle('ntp-theme')).toBe('Customise your homepage')
    expect(educationalTipCardDescription('ntp-theme')).toBe(
      'Make Zenium your own with custom colours and images for your homepage'
    )
    expect(educationalTipCardButton('ntp-theme')).toBe('Try it now')
    expect(educationalTipCardTitle('default-browser')).toBe('Use Zenium by default')
    expect(educationalTipCardDescription('default-browser')).toBe(
      'You can use Zenium any time you tap links in messages, documents and other apps'
    )
    expect(educationalTipCardButton('default-browser')).toBe('Set as default')
    expect(educationalTipCardTitle('tab-groups')).toBe('Tidy up with tab groups')
    expect(educationalTipCardDescription('tab-groups')).toBe(
      'Create tab groups that save and update across your devices when sync is on'
    )
    expect(educationalTipCardButton('tab-groups')).toBe('Try it now')
    expect(educationalTipCardTitle('quick-delete')).toBe('Manage your browsing data')
    expect(educationalTipCardDescription('quick-delete')).toBe(
      'You can delete some or all of your history, cookies, site data and more'
    )
    expect(educationalTipCardButton('quick-delete')).toBe('Show me how')
    for (const id of EDUCATIONAL_TIP_CARD_IDS) {
      for (const text of [
        educationalTipCardTitle(id),
        educationalTipCardDescription(id),
        educationalTipCardButton(id)
      ]) {
        expect(text).not.toContain('Chrome')
        expect(text).not.toMatch(/customiz|color(s)?\b/i)
        // Sentence case (§9.1): the product's name is the one capital past the first.
        expect(text.replace(/Zenium/g, 'zenium')).toMatch(/^[A-Z][^A-Z]*$/)
      }
    }
  })
})
