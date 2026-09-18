import { describe, expect, it } from 'vitest'
import type { BookmarkNode } from '@shared/types'
import {
  BOOKMARKS_BAR_ID,
  BookmarkTree,
  createBookmarkRoots,
  MOBILE_BOOKMARKS_ID,
  OTHER_BOOKMARKS_ID
} from '@shared/bookmarks'
import {
  deletableIds,
  folderCountLabel,
  folderRows,
  folderTitle,
  initialFolderStack,
  pruneFolderStack,
  topLevelRoots
} from '../bookmarkList'

const NOW = 1_700_000_000_000

function url(id: string, parentId: string, index: number, title = id): BookmarkNode {
  return { id, parentId, index, type: 'url', title, url: `https://${id}.example/`, dateAdded: NOW }
}
function folder(id: string, parentId: string, index: number, title = id): BookmarkNode {
  return { id, parentId, index, type: 'folder', title, dateAdded: NOW }
}

/** Mobile bookmarks: a folder "Work" (with one page) after two pages; Other bookmarks: one page. */
function sampleTree(): BookmarkTree {
  return new BookmarkTree([
    ...createBookmarkRoots(NOW),
    url('news', MOBILE_BOOKMARKS_ID, 0, 'News'),
    url('mail', MOBILE_BOOKMARKS_ID, 1, 'Mail'),
    folder('work', MOBILE_BOOKMARKS_ID, 2, 'Work'),
    url('jira', 'work', 0, 'Jira'),
    url('docs', OTHER_BOOKMARKS_ID, 0, 'Docs')
  ])
}

describe('topLevelRoots', () => {
  it('lists the default root first and the others only when they hold something', () => {
    const tree = sampleTree()
    expect(topLevelRoots(tree, 'android').map((r) => r.id)).toEqual([
      MOBILE_BOOKMARKS_ID,
      OTHER_BOOKMARKS_ID
    ])
    expect(topLevelRoots(tree, 'linux').map((r) => r.id)).toEqual([
      OTHER_BOOKMARKS_ID,
      MOBILE_BOOKMARKS_ID
    ])
  })

  it('shows only the default root on an empty profile', () => {
    const tree = new BookmarkTree(createBookmarkRoots(NOW))
    expect(topLevelRoots(tree, 'android').map((r) => r.id)).toEqual([MOBILE_BOOKMARKS_ID])
  })
})

describe('initialFolderStack', () => {
  it('opens at the top level when more than one root has content', () => {
    expect(initialFolderStack(sampleTree(), 'android', null)).toEqual([null])
  })

  it('opens straight inside the default root when it is the only one', () => {
    const tree = new BookmarkTree([
      ...createBookmarkRoots(NOW),
      url('news', MOBILE_BOOKMARKS_ID, 0)
    ])
    expect(initialFolderStack(tree, 'android', null)).toEqual([MOBILE_BOOKMARKS_ID])
  })

  it('a requested folder opens with its ancestors underneath so back walks up', () => {
    expect(initialFolderStack(sampleTree(), 'android', 'work')).toEqual([
      null,
      MOBILE_BOOKMARKS_ID,
      'work'
    ])
  })

  it('does not list the only root twice when the request is inside it', () => {
    const tree = new BookmarkTree([
      ...createBookmarkRoots(NOW),
      folder('work', MOBILE_BOOKMARKS_ID, 0),
      url('jira', 'work', 0)
    ])
    expect(initialFolderStack(tree, 'android', 'work')).toEqual([MOBILE_BOOKMARKS_ID, 'work'])
  })

  it('ignores a request for a page or an unknown id', () => {
    expect(initialFolderStack(sampleTree(), 'android', 'news')).toEqual([null])
    expect(initialFolderStack(sampleTree(), 'android', 'nope')).toEqual([null])
  })
})

describe('folderRows', () => {
  it('lists folders before pages, each in manual order', () => {
    expect(folderRows(sampleTree(), MOBILE_BOOKMARKS_ID, 'android').map((n) => n.id)).toEqual([
      'work',
      'news',
      'mail'
    ])
  })

  it('the top level is the roots', () => {
    expect(folderRows(sampleTree(), null, 'android').map((n) => n.id)).toEqual([
      MOBILE_BOOKMARKS_ID,
      OTHER_BOOKMARKS_ID
    ])
  })

  it('an empty folder has no rows', () => {
    expect(folderRows(sampleTree(), BOOKMARKS_BAR_ID, 'android')).toEqual([])
  })
})

describe('labels', () => {
  it('titles the stack positions', () => {
    const tree = sampleTree()
    expect(folderTitle(tree, null)).toBe('Bookmarks')
    expect(folderTitle(tree, 'work')).toBe('Work')
    expect(folderTitle(tree, MOBILE_BOOKMARKS_ID)).toBe('Mobile bookmarks')
    expect(folderTitle(tree, 'gone')).toBe('Bookmarks')
  })

  it('counts items', () => {
    expect(folderCountLabel(0)).toBe('Empty')
    expect(folderCountLabel(1)).toBe('1 item')
    expect(folderCountLabel(3)).toBe('3 items')
  })
})

describe('deletableIds', () => {
  it('drops roots and unknown ids', () => {
    expect(deletableIds(sampleTree(), [MOBILE_BOOKMARKS_ID, 'news', 'nope', 'work'])).toEqual([
      'news',
      'work'
    ])
  })
})

describe('pruneFolderStack', () => {
  it('leaves a valid stack alone', () => {
    const stack = [null, MOBILE_BOOKMARKS_ID, 'work']
    expect(pruneFolderStack(sampleTree(), stack)).toBe(stack)
  })

  it('unwinds to the deepest folder that still exists', () => {
    const tree = sampleTree()
    expect(pruneFolderStack(tree, [null, MOBILE_BOOKMARKS_ID, 'deleted'])).toEqual([
      null,
      MOBILE_BOOKMARKS_ID
    ])
    expect(pruneFolderStack(tree, ['deleted'])).toEqual([null])
  })
})
