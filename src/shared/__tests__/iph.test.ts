import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IPH_STATE,
  IPH_TAB_SWITCHER_AVAILABILITY_DAYS,
  iphAvailable,
  sanitizeIphState
} from '../iph'

const DAY = 24 * 60 * 60 * 1000

describe('the hint bubbles’ records (TB-19)', () => {
  it('a profile from before them, or anything that is no record, reads the defaults', () => {
    expect(sanitizeIphState(undefined)).toEqual(DEFAULT_IPH_STATE)
    expect(sanitizeIphState(null)).toEqual(DEFAULT_IPH_STATE)
    expect(sanitizeIphState('x')).toEqual(DEFAULT_IPH_STATE)
    expect(sanitizeIphState({ tabSwitcher: 7 })).toEqual(DEFAULT_IPH_STATE)
    // The defaults are fresh objects, never the shared constant.
    expect(sanitizeIphState(undefined)).not.toBe(DEFAULT_IPH_STATE)
  })

  it('keeps a valid record and coerces a broken one field by field', () => {
    const unseen = { availableAt: null, shown: false }
    expect(
      sanitizeIphState({ tabSwitcher: { availableAt: 1_700_000_000_000, shown: true } })
    ).toEqual({
      tabSwitcher: { availableAt: 1_700_000_000_000, shown: true },
      tabGroupsDragAndDrop: unseen
    })
    expect(
      sanitizeIphState({ tabSwitcher: { availableAt: 1_700_000_000_000.7, shown: 'yes' } })
    ).toEqual({
      tabSwitcher: { availableAt: 1_700_000_000_000, shown: false },
      tabGroupsDragAndDrop: unseen
    })
    for (const at of [0, -5, NaN, Infinity, '12', null]) {
      expect(sanitizeIphState({ tabSwitcher: { availableAt: at, shown: true } })).toEqual({
        tabSwitcher: { availableAt: null, shown: true },
        tabGroupsDragAndDrop: unseen
      })
    }
  })

  it('the overview’s drag-to-group record (Chrome’s IPH_TabGroupsDragAndDrop) is kept beside the Tabs button’s, each on its own', () => {
    // A profile written by #641's build has only the Tabs-button record: the new one reads unseen.
    expect(
      sanitizeIphState({ tabSwitcher: { availableAt: 1_700_000_000_000, shown: true } })
        .tabGroupsDragAndDrop
    ).toEqual({ availableAt: null, shown: false })
    expect(
      sanitizeIphState({
        tabSwitcher: { availableAt: null, shown: false },
        tabGroupsDragAndDrop: { availableAt: 1_700_000_000_000, shown: true }
      })
    ).toEqual({
      tabSwitcher: { availableAt: null, shown: false },
      tabGroupsDragAndDrop: { availableAt: 1_700_000_000_000, shown: true }
    })
    expect(
      sanitizeIphState({ tabGroupsDragAndDrop: { availableAt: 'soon', shown: 1 } })
        .tabGroupsDragAndDrop
    ).toEqual({ availableAt: null, shown: false })
    // Spending one record says nothing about the other.
    const spent = sanitizeIphState({ tabGroupsDragAndDrop: { availableAt: null, shown: true } })
    expect(spent.tabGroupsDragAndDrop.shown).toBe(true)
    expect(spent.tabSwitcher.shown).toBe(false)
  })

  it('a bubble is available 14 days after its stamp, as Chrome’s `availability >= 14`, never before the stamp', () => {
    const at = 1_700_000_000_000
    expect(IPH_TAB_SWITCHER_AVAILABILITY_DAYS).toBe(14)
    expect(iphAvailable({ availableAt: null, shown: false }, at + 400 * DAY)).toBe(false)
    expect(iphAvailable({ availableAt: at, shown: false }, at)).toBe(false)
    expect(iphAvailable({ availableAt: at, shown: false }, at + 14 * DAY - 1)).toBe(false)
    expect(iphAvailable({ availableAt: at, shown: false }, at + 14 * DAY)).toBe(true)
    expect(iphAvailable({ availableAt: at, shown: false }, at + 90 * DAY)).toBe(true)
    // A clock set back before the stamp reads as not yet available, not as due.
    expect(iphAvailable({ availableAt: at, shown: false }, at - 30 * DAY)).toBe(false)
    // The window is the caller's to widen for another bubble's config.
    expect(iphAvailable({ availableAt: at, shown: false }, at + 4 * DAY, 4)).toBe(true)
  })
})
