import { describe, expect, it } from 'vitest'
import type { BookmarkNode } from '../types'
import { BOOKMARKS_BAR_ID, BookmarkTree, createBookmarkRoots } from '../bookmarks'
import {
  bookmarksBarVisible,
  sortManagerRows,
  sortedByNameOrder,
  toggledBookmarksBarMode
} from '../bookmarkViews'
import { BLANK_URL } from '../url'

const NOW = 1_700_000_000_000

function url(id: string, index: number, title: string, href: string): BookmarkNode {
  return {
    id,
    parentId: BOOKMARKS_BAR_ID,
    index,
    type: 'url',
    title,
    url: href,
    dateAdded: NOW - index
  }
}

function folder(id: string, index: number, title: string): BookmarkNode {
  return { id, parentId: BOOKMARKS_BAR_ID, index, type: 'folder', title, dateAdded: NOW - index }
}

describe('bookmarks bar visibility', () => {
  it('follows the mode: always, never, or only on the new tab page', () => {
    expect(bookmarksBarVisible('always', 'https://example.com/')).toBe(true)
    expect(bookmarksBarVisible('never', BLANK_URL)).toBe(false)
    expect(bookmarksBarVisible('newtab', BLANK_URL)).toBe(true)
    expect(bookmarksBarVisible('newtab', 'zen://newtab')).toBe(true)
    expect(bookmarksBarVisible('newtab', null)).toBe(true)
    expect(bookmarksBarVisible('newtab', 'https://example.com/')).toBe(false)
  })

  it('Ctrl+Shift+B hides a visible bar and pins a hidden one', () => {
    expect(toggledBookmarksBarMode('always', 'https://example.com/')).toBe('never')
    expect(toggledBookmarksBarMode('never', 'https://example.com/')).toBe('always')
    expect(toggledBookmarksBarMode('newtab', 'https://example.com/')).toBe('always')
    expect(toggledBookmarksBarMode('newtab', BLANK_URL)).toBe('never')
  })
})

describe('manager sort orders', () => {
  const items = [
    url('z', 0, 'Zed', 'https://zed.example/'),
    folder('g', 1, 'Later folder'),
    url('a', 2, 'Alpha', 'https://alpha.example/'),
    folder('f', 3, 'Earlier folder'),
    url('m', 4, 'Mid', 'https://mid.example/')
  ]

  it('keeps the manual order as stored', () => {
    expect(sortManagerRows([...items].reverse(), 'manual').map((n) => n.id)).toEqual([
      'z',
      'g',
      'a',
      'f',
      'm'
    ])
  })

  it('sorts by name with folders first', () => {
    expect(sortManagerRows(items, 'name').map((n) => n.id)).toEqual(['f', 'g', 'a', 'm', 'z'])
  })

  it('sorts by URL with folders first in their manual order', () => {
    expect(sortManagerRows(items, 'url').map((n) => n.id)).toEqual(['g', 'f', 'a', 'm', 'z'])
  })

  it('shows the newest first when sorted by date added', () => {
    expect(sortManagerRows(items, 'dateAdded').map((n) => n.id)).toEqual(['g', 'f', 'z', 'a', 'm'])
  })

  it('leaves the given list untouched', () => {
    const before = items.map((n) => n.id)
    sortManagerRows(items, 'name')
    expect(items.map((n) => n.id)).toEqual(before)
  })
})

describe('sortedByNameOrder', () => {
  it('orders a folder folders first, then A to Z, and is silent once sorted', () => {
    const tree = new BookmarkTree([
      ...createBookmarkRoots(NOW),
      url('zeta', 0, 'zeta', 'https://z/'),
      folder('Folder', 1, 'Folder'),
      url('alpha', 2, 'alpha', 'https://a/')
    ])
    expect(sortedByNameOrder(tree, BOOKMARKS_BAR_ID)).toEqual(['Folder', 'alpha', 'zeta'])
    const sorted = new BookmarkTree([
      ...createBookmarkRoots(NOW),
      folder('Folder', 0, 'Folder'),
      url('alpha', 1, 'alpha', 'https://a/'),
      url('zeta', 2, 'zeta', 'https://z/')
    ])
    expect(sortedByNameOrder(sorted, BOOKMARKS_BAR_ID)).toBeNull()
  })

  it('refuses a missing node or a bookmark', () => {
    const tree = new BookmarkTree([
      ...createBookmarkRoots(NOW),
      url('alpha', 0, 'alpha', 'https://a/')
    ])
    expect(sortedByNameOrder(tree, 'missing')).toBeNull()
    expect(sortedByNameOrder(tree, 'alpha')).toBeNull()
  })
})
