import { describe, expect, it } from 'vitest'
import type { PhoneBarLayout } from '../types'
import {
  DEFAULT_PHONE_BAR,
  PHONE_BAR_ITEM_IDS,
  PHONE_BAR_MAX_ITEMS,
  PILL,
  addPhoneBarItem,
  defaultPhoneBar,
  isDefaultPhoneBar,
  layoutFromSequence,
  movePhoneBarItem,
  phoneBarAvailable,
  phoneBarCapacity,
  phoneBarCount,
  phoneBarItemEnabled,
  phoneBarItems,
  phoneBarLayoutsEqual,
  phoneBarSequence,
  pillWidth,
  removePhoneBarItem,
  sanitizePhoneBar,
  slotAtSequencePosition
} from '../phoneBar'
import { BLANK_URL } from '../url'

const tab = (over: Partial<Parameters<typeof phoneBarItemEnabled>[1]['tab']> = {}) => ({
  tab: {
    url: 'https://example.com/',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    bookmarked: false,
    ...over
  }
})

describe('defaults', () => {
  it("is today's bar: back · pill · new tab · tabs · menu", () => {
    expect(DEFAULT_PHONE_BAR).toEqual({ left: ['back'], right: ['new-tab', 'tabs', 'menu'] })
    expect(phoneBarSequence(DEFAULT_PHONE_BAR)).toEqual(['back', PILL, 'new-tab', 'tabs', 'menu'])
  })

  it('hands out a fresh copy every time', () => {
    const a = defaultPhoneBar()
    a.left.push('forward')
    expect(defaultPhoneBar().left).toEqual(['back'])
    expect(isDefaultPhoneBar(defaultPhoneBar())).toBe(true)
    expect(isDefaultPhoneBar(a)).toBe(false)
  })

  it('lists every catalogue item once', () => {
    expect(new Set(PHONE_BAR_ITEM_IDS).size).toBe(PHONE_BAR_ITEM_IDS.length)
    expect(phoneBarAvailable(DEFAULT_PHONE_BAR)).toEqual(
      PHONE_BAR_ITEM_IDS.filter((id) => !phoneBarItems(DEFAULT_PHONE_BAR).includes(id))
    )
    expect(phoneBarAvailable(DEFAULT_PHONE_BAR, ['back', 'forward'])).toEqual(['forward'])
  })
})

describe('sanitizePhoneBar (migration)', () => {
  it('falls back to the default for anything that is not a layout', () => {
    for (const raw of [undefined, null, 42, 'left', [], {}, { left: 'back', right: [] }]) {
      expect(sanitizePhoneBar(raw)).toEqual(DEFAULT_PHONE_BAR)
    }
  })

  it('drops ids this build does not know, silently', () => {
    expect(
      sanitizePhoneBar({ left: ['back', 'share', 7], right: ['qr', 'menu', null, 'voice'] })
    ).toEqual({ left: ['back'], right: ['menu'] })
  })

  it('drops repeats, keeping the first', () => {
    expect(sanitizePhoneBar({ left: ['back', 'back'], right: ['back', 'menu', 'menu'] })).toEqual(
      { left: ['back'], right: ['menu'] }
    )
  })

  it('keeps an empty side and an empty bar as they are', () => {
    expect(sanitizePhoneBar({ left: [], right: ['menu'] })).toEqual({ left: [], right: ['menu'] })
    expect(sanitizePhoneBar({ left: [], right: [] })).toEqual({ left: [], right: [] })
  })

  it('returns copies, never the input arrays', () => {
    const raw = { left: ['back'], right: ['menu'] }
    const out = sanitizePhoneBar(raw)
    expect(out.left).not.toBe(raw.left)
    expect(out.right).not.toBe(raw.right)
  })
})

describe('phoneBarCapacity', () => {
  it('fits five items beside the pill at 360 px and six from 392 px', () => {
    expect(phoneBarCapacity(360)).toBe(5)
    expect(phoneBarCapacity(375)).toBe(5)
    expect(phoneBarCapacity(391)).toBe(5)
    expect(phoneBarCapacity(392)).toBe(6)
    expect(phoneBarCapacity(412)).toBe(6)
  })

  it('never exceeds the maximum, however wide the bar', () => {
    expect(phoneBarCapacity(600)).toBe(PHONE_BAR_MAX_ITEMS)
    expect(phoneBarCapacity(1200)).toBe(PHONE_BAR_MAX_ITEMS)
  })

  it('shrinks on narrow screens and never goes negative', () => {
    expect(phoneBarCapacity(320)).toBe(4)
    expect(phoneBarCapacity(100)).toBe(0)
  })

  it('leaves the pill its minimum at capacity', () => {
    for (const width of [320, 360, 392, 412]) {
      expect(pillWidth(width, phoneBarCapacity(width))).toBeGreaterThanOrEqual(88)
      expect(pillWidth(width, phoneBarCapacity(width) + 1)).toBeLessThan(88)
    }
    expect(pillWidth(360, 4)).toBe(360 - 16 - 4 * 48)
  })
})

describe('edits', () => {
  const bar: PhoneBarLayout = { left: ['back', 'forward'], right: ['new-tab', 'tabs', 'menu'] }

  it('removes from either side and ignores an item that is not there', () => {
    expect(removePhoneBarItem(bar, 'forward')).toEqual({
      left: ['back'],
      right: ['new-tab', 'tabs', 'menu']
    })
    expect(removePhoneBarItem(bar, 'tabs')).toEqual({
      left: ['back', 'forward'],
      right: ['new-tab', 'menu']
    })
    expect(removePhoneBarItem(bar, 'home')).toEqual(bar)
    expect(removePhoneBarItem(bar, 'home')).not.toBe(bar)
  })

  it('adds at the end of the right side by default, or at a slot', () => {
    expect(addPhoneBarItem(bar, 'home')).toEqual({
      left: ['back', 'forward'],
      right: ['new-tab', 'tabs', 'menu', 'home']
    })
    expect(addPhoneBarItem(bar, 'home', { side: 'left', index: 0 })).toEqual({
      left: ['home', 'back', 'forward'],
      right: ['new-tab', 'tabs', 'menu']
    })
    expect(addPhoneBarItem(bar, 'home', { side: 'right', index: 1 })).toEqual({
      left: ['back', 'forward'],
      right: ['new-tab', 'home', 'tabs', 'menu']
    })
  })

  it('clamps the slot index to the side', () => {
    expect(addPhoneBarItem(bar, 'home', { side: 'left', index: 99 }).left).toEqual([
      'back',
      'forward',
      'home'
    ])
    expect(addPhoneBarItem(bar, 'home', { side: 'right', index: -5 }).right).toEqual([
      'home',
      'new-tab',
      'tabs',
      'menu'
    ])
  })

  it('refuses a new item once the bar is at capacity, but still moves existing ones', () => {
    const full = addPhoneBarItem(bar, 'home')
    expect(phoneBarCount(full)).toBe(6)
    expect(addPhoneBarItem(full, 'history', { side: 'left', index: 0 }, 6)).toBe(full)
    expect(addPhoneBarItem(bar, 'home', undefined, 5)).toBe(bar)
    expect(addPhoneBarItem(full, 'menu', { side: 'left', index: 0 }, 6)).toEqual({
      left: ['menu', 'back', 'forward'],
      right: ['new-tab', 'tabs', 'home']
    })
  })

  it('ignores an unknown id', () => {
    expect(addPhoneBarItem(bar, 'share' as never)).toBe(bar)
  })

  it('moves an item across the pill and within a side', () => {
    expect(movePhoneBarItem(bar, 'menu', { side: 'left', index: 0 })).toEqual({
      left: ['menu', 'back', 'forward'],
      right: ['new-tab', 'tabs']
    })
    expect(movePhoneBarItem(bar, 'back', { side: 'left', index: 1 })).toEqual({
      left: ['forward', 'back'],
      right: ['new-tab', 'tabs', 'menu']
    })
    expect(movePhoneBarItem(bar, 'home', { side: 'left', index: 0 })).toBe(bar)
  })

  it('round-trips through the sequence with the pill as a marker', () => {
    const sequence = phoneBarSequence(bar)
    expect(sequence).toEqual(['back', 'forward', PILL, 'new-tab', 'tabs', 'menu'])
    expect(layoutFromSequence(sequence)).toEqual(bar)
    expect(layoutFromSequence(['back', 'menu'])).toEqual({ left: ['back', 'menu'], right: [] })
    expect(layoutFromSequence([PILL, 'menu'])).toEqual({ left: [], right: ['menu'] })
  })

  it('maps a drop position in the sequence to a slot on a side', () => {
    // Positions: 0 back 1 forward 2 [pill] 3 new-tab 4 tabs 5 menu 6
    expect(slotAtSequencePosition(bar, 0)).toEqual({ side: 'left', index: 0 })
    expect(slotAtSequencePosition(bar, 2)).toEqual({ side: 'left', index: 2 })
    expect(slotAtSequencePosition(bar, 3)).toEqual({ side: 'right', index: 0 })
    expect(slotAtSequencePosition(bar, 6)).toEqual({ side: 'right', index: 3 })
    expect(slotAtSequencePosition(bar, 99)).toEqual({ side: 'right', index: 3 })
    expect(slotAtSequencePosition(bar, -4)).toEqual({ side: 'left', index: 0 })
  })

  it('compares layouts by content', () => {
    expect(phoneBarLayoutsEqual(bar, { ...bar, left: [...bar.left] })).toBe(true)
    expect(phoneBarLayoutsEqual(bar, { left: ['forward', 'back'], right: bar.right })).toBe(false)
    expect(phoneBarLayoutsEqual(bar, { left: bar.left, right: [] })).toBe(false)
  })
})

describe('phoneBarItemEnabled', () => {
  it('back and forward follow the tab history', () => {
    expect(phoneBarItemEnabled('back', tab())).toBe(false)
    expect(phoneBarItemEnabled('back', tab({ canGoBack: true }))).toBe(true)
    expect(phoneBarItemEnabled('forward', tab())).toBe(false)
    expect(phoneBarItemEnabled('forward', tab({ canGoForward: true }))).toBe(true)
    expect(phoneBarItemEnabled('back', { tab: null })).toBe(false)
  })

  it('reload and find need a page', () => {
    expect(phoneBarItemEnabled('reload', tab())).toBe(true)
    expect(phoneBarItemEnabled('reload', tab({ loading: true }))).toBe(true)
    expect(phoneBarItemEnabled('reload', tab({ url: BLANK_URL }))).toBe(false)
    expect(phoneBarItemEnabled('reload', tab({ url: '' }))).toBe(false)
    expect(phoneBarItemEnabled('find', { tab: null })).toBe(false)
    expect(phoneBarItemEnabled('find', tab())).toBe(true)
  })

  it('bookmarking needs a web page', () => {
    expect(phoneBarItemEnabled('bookmark', tab())).toBe(true)
    expect(phoneBarItemEnabled('bookmark', tab({ url: 'http://a.test/' }))).toBe(true)
    expect(phoneBarItemEnabled('bookmark', tab({ url: BLANK_URL }))).toBe(false)
    expect(phoneBarItemEnabled('bookmark', tab({ url: 'file:///x' }))).toBe(false)
  })

  it('everything else is always available', () => {
    for (const id of PHONE_BAR_ITEM_IDS) {
      if (['back', 'forward', 'reload', 'find', 'bookmark'].includes(id)) continue
      expect(phoneBarItemEnabled(id, { tab: null })).toBe(true)
    }
  })
})
