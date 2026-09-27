import { describe, expect, it } from 'vitest'
import type { BookmarkNode } from '../types'
import { BOOKMARKS_BAR_ID } from '../bookmarks'
import {
  BOOKMARK_ROW_DISPLAYS,
  BOOKMARK_ROW_SORT_ORDERS,
  sanitizeBookmarkRowDisplay,
  sanitizeBookmarkRowSortOrder,
  sortBookmarkRows
} from '../bookmarkRows'
import { DEFAULT_SETTINGS } from '../defaults'

const NOW = 1_700_000_000_000

function page(
  id: string,
  index: number,
  title: string,
  extra: Partial<Pick<BookmarkNode, 'dateAdded' | 'dateLastUsed'>> = {}
): BookmarkNode {
  return {
    id,
    parentId: BOOKMARKS_BAR_ID,
    index,
    type: 'url',
    title,
    url: `https://${id}.example/`,
    dateAdded: NOW,
    ...extra
  }
}

function folder(id: string, index: number, title: string, dateAdded = NOW): BookmarkNode {
  return { id, parentId: BOOKMARKS_BAR_ID, index, type: 'folder', title, dateAdded }
}

const ids = (nodes: readonly BookmarkNode[]): string[] => nodes.map((n) => n.id)

// A folder's rows as the model holds them: folders first, then bookmarks, in stored order.
const rows: BookmarkNode[] = [
  folder('f-work', 0, 'Work', NOW - 5000),
  folder('f-arts', 1, 'arts', NOW - 1000),
  page('p-zebra', 2, 'Zebra facts', { dateAdded: NOW - 3000, dateLastUsed: NOW - 100 }),
  page('p-apple', 3, 'apple pie', { dateAdded: NOW - 1000 }),
  page('p-mango', 4, 'Mango', { dateAdded: NOW - 2000, dateLastUsed: NOW - 50 })
]

describe("Chrome's bookmark row orders (ImprovedBookmarkQueryHandler.sortByStoredPref)", () => {
  it('manual keeps the rows as they came and hands back a copy', () => {
    const shuffled = [rows[3]!, rows[0]!, rows[4]!, rows[2]!, rows[1]!]
    const out = sortBookmarkRows(shuffled, 'manual')
    expect(ids(out)).toEqual(['p-apple', 'f-work', 'p-mango', 'p-zebra', 'f-arts'])
    expect(out).not.toBe(shuffled)
  })

  it('newest and oldest order by dateAdded, folders first', () => {
    expect(ids(sortBookmarkRows(rows, 'newest'))).toEqual([
      'f-arts',
      'f-work',
      'p-apple',
      'p-mango',
      'p-zebra'
    ])
    expect(ids(sortBookmarkRows(rows, 'oldest'))).toEqual([
      'f-work',
      'f-arts',
      'p-zebra',
      'p-mango',
      'p-apple'
    ])
  })

  it('A to Z and Z to A collate titles without regard to case, folders first', () => {
    expect(ids(sortBookmarkRows(rows, 'a-z'))).toEqual([
      'f-arts',
      'f-work',
      'p-apple',
      'p-mango',
      'p-zebra'
    ])
    expect(ids(sortBookmarkRows(rows, 'z-a'))).toEqual([
      'f-work',
      'f-arts',
      'p-zebra',
      'p-mango',
      'p-apple'
    ])
  })

  it('last opened puts the most recently opened first and the never-opened (0) last', () => {
    expect(ids(sortBookmarkRows(rows, 'last-opened'))).toEqual([
      'f-arts',
      'f-work',
      'p-mango',
      'p-zebra',
      'p-apple'
    ])
  })

  it('ties fall back to the id so equal keys come out the same each time', () => {
    const tied = [
      page('b', 0, 'Same', { dateAdded: NOW }),
      page('a', 1, 'same', { dateAdded: NOW }),
      page('c', 2, 'SAME', { dateAdded: NOW })
    ]
    for (const order of BOOKMARK_ROW_SORT_ORDERS) {
      if (order === 'manual') continue
      expect(ids(sortBookmarkRows(tied, order))).toEqual(['a', 'b', 'c'])
      expect(ids(sortBookmarkRows([...tied].reverse(), order))).toEqual(['a', 'b', 'c'])
    }
  })

  it('does not mutate its input', () => {
    const before = ids(rows)
    sortBookmarkRows(rows, 'z-a')
    expect(ids(rows)).toEqual(before)
  })
})

describe("the two prefs (Chrome's BookmarkUiPrefs)", () => {
  it("read the defaults for a profile from before them or a value that is none of Chrome's – manual order, and compact (the stated deviation from Chrome's VISUAL, v2 §9.29)", () => {
    expect(sanitizeBookmarkRowSortOrder(undefined)).toBe('manual')
    expect(sanitizeBookmarkRowSortOrder('by-colour')).toBe('manual')
    expect(sanitizeBookmarkRowSortOrder(3)).toBe('manual')
    expect(sanitizeBookmarkRowDisplay(undefined)).toBe('compact')
    expect(sanitizeBookmarkRowDisplay('list')).toBe('compact')
    expect(sanitizeBookmarkRowDisplay(null)).toBe('compact')
  })

  it('keep every one of the stored values', () => {
    for (const order of BOOKMARK_ROW_SORT_ORDERS) {
      expect(sanitizeBookmarkRowSortOrder(order)).toBe(order)
    }
    for (const display of BOOKMARK_ROW_DISPLAYS) {
      expect(sanitizeBookmarkRowDisplay(display)).toBe(display)
    }
  })

  it('are the defaults in DEFAULT_SETTINGS (device-local: see records.test.ts)', () => {
    expect(DEFAULT_SETTINGS.bookmarkRowSortOrder).toBe('manual')
    expect(DEFAULT_SETTINGS.bookmarkRowDisplay).toBe('compact')
  })
})
