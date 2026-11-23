import { describe, expect, it } from 'vitest'
import type { BookmarkNode } from '../types'
import { OTHER_BOOKMARKS_ID, createBookmarkRoots, foldReadingListIntoBookmarks } from '../bookmarks'

const NOW = 1_700_000_000_000

/**
 * Zen has no reading list: a profile that kept one (`state.json`'s legacy `readingList`) gets its
 * pages once, at load, as a "Reading List" bookmarks folder – oldest first, nothing dropped but
 * entries without an address.
 */
describe('foldReadingListIntoBookmarks', () => {
  const roots = (): BookmarkNode[] => [
    ...createBookmarkRoots(NOW),
    {
      id: 'bm_kept',
      parentId: OTHER_BOOKMARKS_ID,
      index: 0,
      type: 'url',
      title: 'Kept',
      url: 'https://kept.example/',
      dateAdded: NOW - 10
    }
  ]

  it('folds the entries into one folder at the end of the default folder, oldest first', () => {
    const out = foldReadingListIntoBookmarks(
      roots(),
      [
        { id: 'rl_b', url: 'https://b.example/', title: 'B', addedAt: 200, readAt: 300 },
        { id: 'rl_a', url: 'https://a.example/', title: '', addedAt: 100 },
        { id: 'rl_bad', title: 'No address' },
        null,
        'garbage'
      ],
      OTHER_BOOKMARKS_ID,
      NOW
    )
    const folder = out.find((n) => n.type === 'folder' && n.title === 'Reading List')!
    expect(folder).toMatchObject({ parentId: OTHER_BOOKMARKS_ID, index: 1 })
    const pages = out
      .filter((n) => n.parentId === folder.id)
      .sort((a, b) => a.index - b.index)
      .map((n) => ({ title: n.title, url: n.url, dateAdded: n.dateAdded }))
    expect(pages).toEqual([
      { title: 'https://a.example/', url: 'https://a.example/', dateAdded: 100 },
      { title: 'B', url: 'https://b.example/', dateAdded: 200 }
    ])
    // What was there stays where it was.
    expect(out.find((n) => n.id === 'bm_kept')).toMatchObject({ index: 0, title: 'Kept' })
    expect(new Set(out.map((n) => n.id)).size).toBe(out.length)
  })

  it('adds nothing when there is no list, an empty one, or something that is not a list', () => {
    for (const raw of [undefined, null, [], {}, 'x', [{ title: 'no url' }]]) {
      const out = foldReadingListIntoBookmarks(roots(), raw, OTHER_BOOKMARKS_ID, NOW)
      expect(out).toEqual(roots())
    }
  })
})
