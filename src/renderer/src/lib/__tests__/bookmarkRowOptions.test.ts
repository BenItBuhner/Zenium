import { describe, expect, it, vi } from 'vitest'
import type { BookmarkNode, Tab } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import {
  DISPLAY_ANNOUNCEMENTS,
  DISPLAY_LABELS,
  pictureTabFor,
  SORT_ORDER_ANNOUNCEMENTS,
  SORT_ORDER_LABELS,
  SORT_VIEW_MENU_TITLE,
  sortViewMenuItems
} from '../bookmarkRowOptions'
import { MENU_GAP } from '../ui'

const tab = (id: string, url: string, containerId = 'default'): Tab =>
  ({ id, url, containerId, spaceId: 's', title: id }) as unknown as Tab

const bookmark = (url?: string): BookmarkNode => ({
  id: 'b',
  parentId: '3',
  index: 0,
  type: url ? 'url' : 'folder',
  title: 'B',
  url,
  dateAdded: 1
})

describe("Chrome 152's words (android_chrome_strings.grd)", () => {
  it('names the submenu, the six orders, the two views and their announcements verbatim', () => {
    expect(SORT_VIEW_MENU_TITLE).toBe('Sort and view options')
    expect(SORT_ORDER_LABELS).toEqual({
      manual: 'Sort by manual order',
      newest: 'Sort by newest',
      oldest: 'Sort by oldest',
      'last-opened': 'Sort by last opened',
      'a-z': 'Sort by A to Z',
      'z-a': 'Sort by Z to A'
    })
    expect(SORT_ORDER_ANNOUNCEMENTS).toEqual({
      manual: 'Sorting by manual order',
      newest: 'Sorting by newest',
      oldest: 'Sorting by oldest',
      'last-opened': 'Sorting by last opened',
      'a-z': 'Sorting from A to Z',
      'z-a': 'Sorting from Z to A'
    })
    expect(DISPLAY_LABELS).toEqual({ visual: 'Visual view', compact: 'Compact view' })
    expect(DISPLAY_ANNOUNCEMENTS).toEqual({
      visual: 'Showing visual view',
      compact: 'Showing compact view'
    })
  })
})

describe('the menu’s rows', () => {
  it('lists the orders in Chrome’s menu order, a gap, then the views, the current ones checked as radio rows', () => {
    const items = sortViewMenuItems(
      { sortOrder: 'oldest', display: 'compact' },
      () => undefined,
      () => undefined
    )
    expect(items.map((i) => (i === MENU_GAP ? '-' : `${i.label}${i.checked ? ' *' : ''}`))).toEqual(
      [
        'Sort by manual order',
        'Sort by newest',
        'Sort by oldest *',
        'Sort by last opened',
        'Sort by A to Z',
        'Sort by Z to A',
        '-',
        'Visual view',
        'Compact view *'
      ]
    )
    expect(items.filter((i) => i !== MENU_GAP).every((i) => i.type === 'radio')).toBe(true)
  })

  it('a pick hands the new value on; a pick of the checked row hands nothing on', () => {
    const onSort = vi.fn()
    const onDisplay = vi.fn()
    const items = sortViewMenuItems({ sortOrder: 'manual', display: 'visual' }, onSort, onDisplay)
    const row = (label: string): { onSelect: () => void } =>
      items.find((i) => i !== MENU_GAP && i.label === label) as { onSelect: () => void }
    row('Sort by last opened').onSelect()
    row('Sort by manual order').onSelect()
    row('Compact view').onSelect()
    row('Visual view').onSelect()
    expect(onSort.mock.calls).toEqual([['last-opened']])
    expect(onDisplay.mock.calls).toEqual([['compact']])
  })
})

describe('the visual tile’s tab (pictureTabFor)', () => {
  it('finds an open tab on the same document, the fragment aside, and never a private tab', () => {
    const tabs = {
      p: tab('p', 'https://example.com/a#x', PRIVATE_CONTAINER_ID),
      other: tab('other', 'https://example.com/b'),
      t: tab('t', 'https://example.com/a#y')
    }
    expect(pictureTabFor(bookmark('https://example.com/a'), tabs)).toBe('t')
    expect(pictureTabFor(bookmark('https://example.com/a'), { p: tabs.p })).toBeNull()
    expect(pictureTabFor(bookmark('https://example.com/c'), tabs)).toBeNull()
  })

  it('answers null for a folder, a bookmark without an address, and a non-URL address that matches nothing', () => {
    const tabs = { t: tab('t', 'https://example.com/') }
    expect(pictureTabFor(bookmark(), tabs)).toBeNull()
    expect(pictureTabFor(bookmark('not a url'), tabs)).toBeNull()
    expect(pictureTabFor(bookmark('not a url'), { t: tab('t', 'not a url') })).toBe('t')
  })
})
