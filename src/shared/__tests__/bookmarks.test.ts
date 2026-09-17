import { describe, expect, it } from 'vitest'
import type { Bookmark, BookmarkNode } from '../types'
import {
  BOOKMARKS_BAR_ID,
  BOOKMARK_ROOT_IDS,
  BookmarkTree,
  MOBILE_BOOKMARKS_ID,
  OTHER_BOOKMARKS_ID,
  createBookmarkRoots,
  defaultBookmarkFolderId,
  isBookmarkRoot,
  migrateLegacyBookmarks,
  normalizeBookmarkNodes,
  recentBookmarks,
  recentFolders,
  searchBookmarks,
  sortBookmarkNodes,
  topLevelSelection
} from '../bookmarks'

const NOW = 1_700_000_000_000

function url(
  id: string,
  parentId: string,
  index: number,
  title: string,
  href = `https://${id}.example/`,
  extra: Partial<BookmarkNode> = {}
): BookmarkNode {
  return { id, parentId, index, type: 'url', title, url: href, dateAdded: NOW - index, ...extra }
}

function folder(
  id: string,
  parentId: string,
  index: number,
  title: string,
  extra: Partial<BookmarkNode> = {}
): BookmarkNode {
  return { id, parentId, index, type: 'folder', title, dateAdded: NOW - index, ...extra }
}

/** Bookmarks bar: [Work/{docs, mail}, news]; Other: [blog]; Mobile: []. */
function sample(): BookmarkNode[] {
  return [
    ...createBookmarkRoots(NOW),
    folder('work', BOOKMARKS_BAR_ID, 0, 'Work', { dateGroupModified: NOW - 10 }),
    url('docs', 'work', 0, 'Docs', 'https://docs.example/'),
    url('mail', 'work', 1, 'Mail', 'https://mail.example/'),
    url('news', BOOKMARKS_BAR_ID, 1, 'News', 'https://news.example/'),
    url('blog', OTHER_BOOKMARKS_ID, 0, 'Blog', 'https://blog.example/')
  ]
}

/** Every invariant the model promises, checked on a node list. */
function expectValidTree(nodes: BookmarkNode[]): void {
  const tree = new BookmarkTree(nodes)
  // Roots: present, pinned, in order.
  expect(tree.roots().map((r) => r.id)).toEqual([...BOOKMARK_ROOT_IDS])
  for (const root of tree.roots()) {
    expect(root.parentId).toBeNull()
    expect(root.type).toBe('folder')
  }
  // Every other node reaches a root through folders (no cycles, no orphans).
  for (const node of nodes) {
    if (isBookmarkRoot(node.id)) continue
    const path = tree.path(node.id)
    expect(path.length).toBeGreaterThan(0)
    expect(isBookmarkRoot(path[0].id)).toBe(true)
    for (const p of path) expect(p.type).toBe('folder')
  }
  // Contiguous indices per folder.
  for (const node of nodes) {
    if (node.type !== 'folder') continue
    expect(tree.children(node.id).map((c) => c.index)).toEqual(
      tree.children(node.id).map((_, i) => i)
    )
  }
  // Ids are unique.
  expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length)
}

describe('bookmark roots', () => {
  it('uses Chrome ids and titles for the three permanent roots', () => {
    const roots = createBookmarkRoots(NOW)
    expect(roots.map((r) => [r.id, r.title, r.index])).toEqual([
      ['1', 'Bookmarks bar', 0],
      ['2', 'Other bookmarks', 1],
      ['3', 'Mobile bookmarks', 2]
    ])
    expect(isBookmarkRoot('1')).toBe(true)
    expect(isBookmarkRoot('bm_x')).toBe(false)
    expect(isBookmarkRoot(null)).toBe(false)
  })

  it('files new bookmarks under Other bookmarks on desktop and Mobile bookmarks on Android', () => {
    expect(defaultBookmarkFolderId('linux')).toBe(OTHER_BOOKMARKS_ID)
    expect(defaultBookmarkFolderId('darwin')).toBe(OTHER_BOOKMARKS_ID)
    expect(defaultBookmarkFolderId('android')).toBe(MOBILE_BOOKMARKS_ID)
  })
})

describe('BookmarkTree', () => {
  const tree = new BookmarkTree(sample())

  it('lists children in index order', () => {
    expect(tree.children(BOOKMARKS_BAR_ID).map((n) => n.id)).toEqual(['work', 'news'])
    expect(tree.children('work').map((n) => n.id)).toEqual(['docs', 'mail'])
    expect(tree.children('nope')).toEqual([])
  })

  it('builds getTree / getSubTree shapes with nested children', () => {
    const sub = tree.subTree('work')
    expect(sub?.children?.map((c) => c.id)).toEqual(['docs', 'mail'])
    expect(tree.subTree('docs')?.children).toBeUndefined()
    const full = tree.tree()
    expect(full.map((r) => r.id)).toEqual(['1', '2', '3'])
    expect(full[0].children?.[0].children?.length).toBe(2)
    expect(full[2].children).toEqual([])
  })

  it('walks paths and labels them', () => {
    expect(tree.path('mail').map((n) => n.id)).toEqual([BOOKMARKS_BAR_ID, 'work'])
    expect(tree.pathLabel('mail')).toBe('Bookmarks bar / Work')
    expect(tree.path(BOOKMARKS_BAR_ID)).toEqual([])
    expect(tree.isAncestor(BOOKMARKS_BAR_ID, 'mail')).toBe(true)
    expect(tree.isAncestor('work', 'blog')).toBe(false)
  })

  it('collects descendants and the URLs below a node', () => {
    expect(tree.descendants(BOOKMARKS_BAR_ID).map((n) => n.id)).toEqual([
      'work',
      'docs',
      'mail',
      'news'
    ])
    expect(tree.urlsUnder('work').map((n) => n.id)).toEqual(['docs', 'mail'])
    expect(tree.urlsUnder('news').map((n) => n.id)).toEqual(['news'])
    expect(tree.hasUrl('https://mail.example/')).toBe(true)
    expect(tree.byUrl('https://nope.example/')).toEqual([])
  })

  it('flattens in display order and counts without the roots', () => {
    expect(tree.flat().map((n) => n.id)).toEqual([
      '1',
      'work',
      'docs',
      'mail',
      'news',
      '2',
      'blog',
      '3'
    ])
    expect(tree.counts()).toEqual({ bookmarks: 4, folders: 1 })
  })
})

describe('normalizeBookmarkNodes', () => {
  it('is a no-op on a valid tree and returns display order', () => {
    const nodes = normalizeBookmarkNodes(sample(), NOW)
    expectValidTree(nodes)
    expect(nodes.map((n) => n.id)).toEqual(['1', 'work', 'docs', 'mail', 'news', '2', 'blog', '3'])
    expect(normalizeBookmarkNodes(nodes, NOW + 5)).toEqual(nodes)
  })

  it('recreates missing roots and pins them: roots cannot be moved, renamed or turned into URLs', () => {
    const nodes = normalizeBookmarkNodes(
      [
        {
          id: '1',
          parentId: '2',
          index: 7,
          type: 'url',
          title: 'Hacked',
          url: 'https://x/',
          dateAdded: 1
        },
        url('a', OTHER_BOOKMARKS_ID, 0, 'A')
      ],
      NOW
    )
    expectValidTree(nodes)
    const tree = new BookmarkTree(nodes)
    const bar = tree.get('1')!
    expect(bar.parentId).toBeNull()
    expect(bar.type).toBe('folder')
    expect(bar.title).toBe('Bookmarks bar')
    expect(bar.url).toBeUndefined()
    expect(tree.get('3')?.dateAdded).toBe(NOW)
  })

  it('re-homes orphans, nodes under URL parents and cycle members to the fallback folder', () => {
    const nodes = normalizeBookmarkNodes(
      [
        ...createBookmarkRoots(NOW),
        url('orphan', 'gone', 0, 'Orphan'),
        url('leaf', BOOKMARKS_BAR_ID, 0, 'Leaf'),
        url('underLeaf', 'leaf', 0, 'Under a bookmark'),
        folder('loopA', 'loopB', 0, 'Loop A'),
        folder('loopB', 'loopA', 0, 'Loop B'),
        url('inLoop', 'loopA', 0, 'Inside the loop')
      ],
      NOW,
      MOBILE_BOOKMARKS_ID
    )
    expectValidTree(nodes)
    const tree = new BookmarkTree(nodes)
    expect(tree.get('orphan')?.parentId).toBe(MOBILE_BOOKMARKS_ID)
    expect(tree.get('underLeaf')?.parentId).toBe(MOBILE_BOOKMARKS_ID)
    // The cycle is broken by re-homing its members; the bookmark inside keeps its parent.
    expect(tree.get('loopA')?.parentId).toBe(MOBILE_BOOKMARKS_ID)
    expect(tree.get('loopB')?.parentId).toBe(MOBILE_BOOKMARKS_ID)
    expect(tree.get('inLoop')?.parentId).toBe('loopA')
  })

  it('makes indices contiguous keeping the stored order; collisions resolve by date, then id', () => {
    const raw = [
      ...createBookmarkRoots(NOW),
      url('c', OTHER_BOOKMARKS_ID, 9, 'C'),
      url('a', OTHER_BOOKMARKS_ID, 2, 'A'),
      url('b', OTHER_BOOKMARKS_ID, 2, 'B', undefined, { dateAdded: NOW - 10 }),
      url('e', OTHER_BOOKMARKS_ID, 2, 'E', undefined, { dateAdded: NOW - 2 }),
      url('d', OTHER_BOOKMARKS_ID, Number.NaN, 'D')
    ]
    const nodes = normalizeBookmarkNodes(raw, NOW)
    expectValidTree(nodes)
    // b is the oldest of the three at index 2; a and e share a date, so their ids decide.
    expect(new BookmarkTree(nodes).children(OTHER_BOOKMARKS_ID).map((n) => n.id)).toEqual([
      'b',
      'a',
      'e',
      'c',
      'd'
    ])
    // The same records in another arrival order produce the same tree (devices converge).
    const reversed = normalizeBookmarkNodes(structuredClone(raw).reverse(), NOW)
    expect(reversed.map((n) => n.id)).toEqual(nodes.map((n) => n.id))
  })

  it('drops garbage: duplicates, URL nodes without a URL, non-objects', () => {
    const nodes = normalizeBookmarkNodes(
      [
        null,
        'x',
        { id: 'noUrl', parentId: OTHER_BOOKMARKS_ID, index: 0, type: 'url', title: 'No URL' },
        url('dup', OTHER_BOOKMARKS_ID, 0, 'First'),
        url('dup', OTHER_BOOKMARKS_ID, 1, 'Second'),
        { id: 'inferred', parentId: OTHER_BOOKMARKS_ID, index: 2, url: 'https://i/', dateAdded: 5 }
      ],
      NOW
    )
    expectValidTree(nodes)
    const tree = new BookmarkTree(nodes)
    expect(tree.get('noUrl')).toBeNull()
    expect(tree.get('dup')?.title).toBe('First')
    expect(tree.get('inferred')).toMatchObject({ type: 'url', title: 'https://i/', dateAdded: 5 })
  })
})

describe('migrateLegacyBookmarks', () => {
  const legacy: Bookmark[] = [
    {
      id: 'l3',
      url: 'https://three/',
      title: 'Three',
      favicon: 'data:image/png;base64,AAA',
      createdAt: 3000
    },
    { id: 'l2', url: 'https://two/', title: 'Two', favicon: null, createdAt: 2000 },
    { id: 'l1', url: 'https://one/', title: '', favicon: null, createdAt: 1000 }
  ]

  it('puts every legacy bookmark under the target root, in stored order, keeping ids and dates', () => {
    const nodes = migrateLegacyBookmarks(legacy, OTHER_BOOKMARKS_ID, NOW)
    expectValidTree(nodes)
    const tree = new BookmarkTree(nodes)
    const other = tree.children(OTHER_BOOKMARKS_ID)
    expect(other.map((n) => n.id)).toEqual(['l3', 'l2', 'l1'])
    expect(other.map((n) => n.dateAdded)).toEqual([3000, 2000, 1000])
    expect(other[0]).toMatchObject({
      type: 'url',
      url: 'https://three/',
      favicon: 'data:image/png;base64,AAA'
    })
    expect(other[1].favicon).toBeUndefined()
    expect(other[2].title).toBe('https://one/')
    expect(tree.children(BOOKMARKS_BAR_ID)).toEqual([])
    expect(tree.children(MOBILE_BOOKMARKS_ID)).toEqual([])
  })

  it('targets Mobile bookmarks on Android', () => {
    const tree = new BookmarkTree(migrateLegacyBookmarks(legacy, MOBILE_BOOKMARKS_ID, NOW))
    expect(tree.children(MOBILE_BOOKMARKS_ID).length).toBe(3)
    expect(tree.children(OTHER_BOOKMARKS_ID)).toEqual([])
  })

  it('is idempotent: normalizing the migrated tree changes nothing', () => {
    const once = migrateLegacyBookmarks(legacy, OTHER_BOOKMARKS_ID, NOW)
    expect(normalizeBookmarkNodes(once, NOW + 1000)).toEqual(once)
  })

  it('skips broken entries and invents ids where they are missing', () => {
    const nodes = migrateLegacyBookmarks(
      [
        { id: '', url: 'https://a/', title: 'A', favicon: null, createdAt: 1 },
        { id: 'b', url: '', title: 'B', favicon: null, createdAt: 2 },
        null as unknown as Bookmark
      ],
      OTHER_BOOKMARKS_ID,
      NOW
    )
    const other = new BookmarkTree(nodes).children(OTHER_BOOKMARKS_ID)
    expect(other.length).toBe(1)
    expect(other[0].id).toBe('bm_0')
  })
})

describe('sorting, searching and recency', () => {
  const tree = new BookmarkTree(sample())

  it('sorts manually by index, and otherwise folders first', () => {
    const bar = tree.children(BOOKMARKS_BAR_ID)
    expect(sortBookmarkNodes([...bar].reverse(), 'manual').map((n) => n.id)).toEqual([
      'work',
      'news'
    ])
    const mixed = [
      url('z', '2', 0, 'zeta'),
      folder('f', '2', 1, 'Folder'),
      url('a', '2', 2, 'Alpha'),
      url('n10', '2', 3, 'Item 10'),
      url('n2', '2', 4, 'Item 2')
    ]
    expect(sortBookmarkNodes(mixed, 'name').map((n) => n.id)).toEqual(['f', 'a', 'n2', 'n10', 'z'])
    expect(sortBookmarkNodes(mixed, 'dateAdded', true).map((n) => n.id)).toEqual([
      'f',
      'z',
      'a',
      'n10',
      'n2'
    ])
  })

  it('sorts numerically-aware by name', () => {
    const items = [url('b', '2', 0, 'Item 10'), url('a', '2', 1, 'Item 2')]
    expect(sortBookmarkNodes(items, 'name').map((n) => n.title)).toEqual(['Item 2', 'Item 10'])
  })

  it('searches titles, URLs and folder paths across every folder, best match first', () => {
    expect(searchBookmarks(tree, 'ma').map((n) => n.id)).toEqual(['mail'])
    // Path match: "work" finds the folder and everything inside it.
    expect(
      searchBookmarks(tree, 'work')
        .map((n) => n.id)
        .sort()
    ).toEqual(['docs', 'mail', 'work'])
    // Multi-term: every term must match somewhere.
    expect(searchBookmarks(tree, 'work docs').map((n) => n.id)).toEqual(['docs'])
    expect(searchBookmarks(tree, 'work nothing')).toEqual([])
    expect(searchBookmarks(tree, '   ')).toEqual([])
    expect(searchBookmarks(tree, 'example', 2).length).toBe(2)
    expect(searchBookmarks(tree, 'example', Infinity, 'url').every((n) => n.type === 'url')).toBe(
      true
    )
  })

  it('ranks a title prefix above a title substring above a URL-only hit', () => {
    const t = new BookmarkTree([
      ...createBookmarkRoots(NOW),
      url('u', '2', 0, 'Something else', 'https://news.example/'),
      url('s', '2', 1, 'Daily news'),
      url('p', '2', 2, 'News today')
    ])
    expect(searchBookmarks(t, 'news').map((n) => n.id)).toEqual(['p', 's', 'u'])
  })

  it('never returns the roots', () => {
    expect(searchBookmarks(tree, 'bookmarks')).toEqual([])
  })

  it('lists recent bookmarks newest first and recent folders by last change, roots first among ties', () => {
    expect(recentBookmarks(tree, 2).map((n) => n.id)).toEqual(['docs', 'blog'])
    expect(recentFolders(tree, 2).map((n) => n.id)).toEqual(['work', BOOKMARKS_BAR_ID])
  })

  it('keeps only the topmost nodes of a selection', () => {
    expect(topLevelSelection(tree, ['mail', 'work', 'docs', 'blog', 'ghost'])).toEqual([
      'work',
      'blog'
    ])
  })
})
