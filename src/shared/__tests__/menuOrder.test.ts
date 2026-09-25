import { describe, expect, it } from 'vitest'
import {
  MENU_KEY_MAX,
  MENU_ORDER_MAX,
  applyMenuOrder,
  isDefaultMenuOrder,
  menuOrderOf,
  moveMenuItem,
  sanitizeMenuOrder
} from '../menuOrder'

interface Item {
  key?: string
  label: string
}

const item = (key: string | undefined, label = key ?? 'unkeyed'): Item =>
  key === undefined ? { label } : { key, label }
const keyOf = (i: Item): string | undefined => i.key
const keys = (items: Item[]): (string | undefined)[] => items.map(keyOf)

const DEFAULT: Item[] = [
  item('row.newTab'),
  item('row.newPrivateTab'),
  item('sep.1'),
  item('row.bookmarks'),
  item('row.history'),
  item('row.downloads'),
  item('sep.2'),
  item('row.settings'),
  item('row.exit')
]

describe('applyMenuOrder', () => {
  it('reads no saved order, or an empty one, as the default order', () => {
    expect(keys(applyMenuOrder(DEFAULT, keyOf, undefined))).toEqual(keys(DEFAULT))
    expect(keys(applyMenuOrder(DEFAULT, keyOf, []))).toEqual(keys(DEFAULT))
    expect(applyMenuOrder(DEFAULT, keyOf, undefined)).not.toBe(DEFAULT)
  })

  it('puts the named items in the saved order', () => {
    const saved = [
      'row.settings',
      'row.downloads',
      'row.newTab',
      'sep.2',
      'row.exit',
      'row.newPrivateTab',
      'sep.1',
      'row.bookmarks',
      'row.history'
    ]
    expect(keys(applyMenuOrder(DEFAULT, keyOf, saved))).toEqual(saved)
  })

  it('places an item the saved order never named after its default predecessor – the item it always followed – not at the end; a run of them keeps the default order; one with nothing before it leads', () => {
    // Saved while New Tab, History and Downloads were absent (Home on the bar, a row off its
    // condition): each returns beside the item it follows in the default order.
    const saved = [
      'row.settings',
      'row.newPrivateTab',
      'sep.1',
      'row.bookmarks',
      'sep.2',
      'row.exit'
    ]
    expect(keys(applyMenuOrder(DEFAULT, keyOf, saved))).toEqual([
      'row.newTab',
      'row.settings',
      'row.newPrivateTab',
      'sep.1',
      'row.bookmarks',
      'row.history',
      'row.downloads',
      'sep.2',
      'row.exit'
    ])
    // The predecessor itself absent from the build: the nearest one before it that is shown.
    const without = DEFAULT.filter((i) => i.key !== 'row.history')
    expect(keys(applyMenuOrder(without, keyOf, saved))).toEqual([
      'row.newTab',
      'row.settings',
      'row.newPrivateTab',
      'sep.1',
      'row.bookmarks',
      'row.downloads',
      'sep.2',
      'row.exit'
    ])
  })

  it('drops a key the build has no item for', () => {
    const saved = [
      'row.readAloud',
      'row.settings',
      'icon.forward',
      'row.newTab',
      'row.newPrivateTab',
      'sep.1',
      'row.bookmarks',
      'row.history',
      'row.downloads',
      'sep.2',
      'row.exit'
    ]
    const ordered = keys(applyMenuOrder(DEFAULT, keyOf, saved))
    expect(ordered.slice(0, 2)).toEqual(['row.settings', 'row.newTab'])
    expect(ordered).not.toContain('row.readAloud')
    expect(ordered).toHaveLength(DEFAULT.length)
  })

  it('names each item once however often the saved order repeats it', () => {
    const saved = ['row.exit', 'row.exit', 'row.newTab', 'row.exit']
    const ordered = keys(applyMenuOrder(DEFAULT, keyOf, saved))
    expect(ordered.slice(0, 2)).toEqual(['row.exit', 'row.newTab'])
    expect(ordered.filter((k) => k === 'row.exit')).toHaveLength(1)
    expect(ordered).toHaveLength(DEFAULT.length)
  })

  it('keeps an unkeyed item, which no order can name, beside its default predecessor', () => {
    const items = [item('row.a'), item(undefined, 'note'), item('row.b'), item('row.c')]
    expect(applyMenuOrder(items, keyOf, ['row.c', 'row.a', 'row.b']).map((i) => i.label)).toEqual([
      'row.c',
      'row.a',
      'note',
      'row.b'
    ])
  })

  it('lets two sections share one saved list, each taking the keys it has items for', () => {
    const row = [item('icon.forward'), item('icon.home'), item('icon.reload')]
    const saved = [
      'icon.reload',
      'row.settings',
      'icon.forward',
      'row.newTab',
      'row.newPrivateTab',
      'sep.1',
      'row.bookmarks',
      'row.history',
      'row.downloads',
      'sep.2',
      'row.exit'
    ]
    // Home was on the bar at the save: back after Forward, the glyph it follows.
    expect(keys(applyMenuOrder(row, keyOf, saved))).toEqual([
      'icon.reload',
      'icon.forward',
      'icon.home'
    ])
    expect(keys(applyMenuOrder(DEFAULT, keyOf, saved)).slice(0, 2)).toEqual([
      'row.settings',
      'row.newTab'
    ])
  })
})

describe('sanitizeMenuOrder', () => {
  it('reads anything but a list, and an empty list, as absent (the default; the Reset write)', () => {
    expect(sanitizeMenuOrder(undefined)).toBeUndefined()
    expect(sanitizeMenuOrder(null)).toBeUndefined()
    expect(sanitizeMenuOrder('row.settings')).toBeUndefined()
    expect(sanitizeMenuOrder({ 0: 'row.settings' })).toBeUndefined()
    expect(sanitizeMenuOrder([])).toBeUndefined()
    expect(sanitizeMenuOrder([1, null, ''])).toBeUndefined()
  })

  it('keeps unique non-empty strings in their order and nothing else', () => {
    expect(
      sanitizeMenuOrder(['row.settings', 3, 'row.newTab', '', 'row.settings', null, 'sep.1'])
    ).toEqual(['row.settings', 'row.newTab', 'sep.1'])
  })

  it('caps a runaway list', () => {
    const long = Array.from({ length: MENU_ORDER_MAX + 20 }, (_, i) => `row.${i}`)
    expect(sanitizeMenuOrder(long)).toHaveLength(MENU_ORDER_MAX)
  })

  it('drops a key longer than any of ours, keeping the rest', () => {
    const runaway = `row.${'x'.repeat(MENU_KEY_MAX)}`
    expect(sanitizeMenuOrder([runaway, 'row.settings'])).toEqual(['row.settings'])
    expect(sanitizeMenuOrder(['a'.repeat(MENU_KEY_MAX)])).toHaveLength(1)
    expect(sanitizeMenuOrder([runaway])).toBeUndefined()
  })
})

describe('isDefaultMenuOrder', () => {
  it('is true for no order, an empty order, and an order that changes nothing', () => {
    expect(isDefaultMenuOrder(DEFAULT, keyOf, undefined)).toBe(true)
    expect(isDefaultMenuOrder(DEFAULT, keyOf, [])).toBe(true)
    expect(isDefaultMenuOrder(DEFAULT, keyOf, ['row.newTab', 'row.newPrivateTab'])).toBe(true)
    expect(isDefaultMenuOrder(DEFAULT, keyOf, ['icon.forward', 'row.unknown'])).toBe(true)
  })

  it('is false once the order moves an item', () => {
    expect(isDefaultMenuOrder(DEFAULT, keyOf, ['row.settings', 'row.newTab'])).toBe(false)
  })
})

describe('menuOrderOf', () => {
  it('lists the keys in the items order, unkeyed items contributing none', () => {
    const items = [item('row.b'), item(undefined), item('row.a')]
    expect(menuOrderOf(items, keyOf)).toEqual(['row.b', 'row.a'])
  })

  it('round-trips through applyMenuOrder', () => {
    const shuffled = [7, 2, 0, 8, 5, 1, 6, 3, 4].map((i) => DEFAULT[i] as Item)
    const saved = menuOrderOf(shuffled, keyOf)
    expect(keys(applyMenuOrder(DEFAULT, keyOf, saved))).toEqual(saved)
  })
})

describe('moveMenuItem', () => {
  const list = ['a', 'b', 'c', 'd']

  it('moves an item up, down and to the start', () => {
    expect(moveMenuItem(list, 2, 1)).toEqual(['a', 'c', 'b', 'd'])
    expect(moveMenuItem(list, 1, 2)).toEqual(['a', 'c', 'b', 'd'])
    expect(moveMenuItem(list, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('leaves the list as it is for a move onto itself or out of range', () => {
    expect(moveMenuItem(list, 1, 1)).toEqual(list)
    expect(moveMenuItem(list, 0, -1)).toEqual(list)
    expect(moveMenuItem(list, 3, 4)).toEqual(list)
    expect(moveMenuItem(list, 4, 0)).toEqual(list)
    expect(moveMenuItem(list, 1, 1)).not.toBe(list)
  })
})
