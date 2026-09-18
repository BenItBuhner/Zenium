import { describe, expect, it } from 'vitest'
import {
  BOOKMARKS_ROOT_ID,
  ERROR_CANNOT_SET_URL_OF_FOLDER,
  ERROR_FOLDER_NOT_EMPTY,
  ERROR_INVALID_ID,
  ERROR_INVALID_INDEX,
  ERROR_INVALID_MOVE_DESTINATION,
  ERROR_INVALID_PARAM,
  ERROR_INVALID_PARENT,
  ERROR_INVALID_URL,
  ERROR_MODIFY_SPECIAL,
  ERROR_NO_NODE,
  ERROR_NO_PARENT,
  chromeChildrenOf,
  chromeNodeFor,
  diffBookmarkTrees,
  normalizeIdList,
  normalizeRecentCount,
  normalizeSearchQuery,
  planCreate,
  planMove,
  planRemove,
  planUpdate,
  rootChromeNode,
  searchBookmarkNodes,
  toChromeNode
} from '../api/bookmarks'
import {
  BOOKMARKS_BAR_ID,
  BookmarkTree,
  MOBILE_BOOKMARKS_ID,
  OTHER_BOOKMARKS_ID,
  createBookmarkRoots,
  normalizeBookmarkNodes
} from '../../../shared/bookmarks'
import type { BookmarkNode } from '../../../shared/types'

const NOW = 1_700_000_000_000

interface Spec {
  id: string
  parentId: string
  url?: string
  title?: string
  index?: number
  dateAdded?: number
  favicon?: string
  dateGroupModified?: number
}

/** A normalised tree from terse node specs; `index` defaults to the order given per folder. */
function tree(specs: Spec[]): BookmarkTree {
  const perFolder = new Map<string, number>()
  const nodes: BookmarkNode[] = createBookmarkRoots(NOW)
  for (const spec of specs) {
    const next = perFolder.get(spec.parentId) ?? 0
    perFolder.set(spec.parentId, next + 1)
    const node: BookmarkNode = {
      id: spec.id,
      parentId: spec.parentId,
      index: spec.index ?? next,
      type: spec.url ? 'url' : 'folder',
      title: spec.title ?? spec.id,
      dateAdded: spec.dateAdded ?? NOW
    }
    if (spec.url) node.url = spec.url
    if (spec.favicon) node.favicon = spec.favicon
    if (spec.dateGroupModified) node.dateGroupModified = spec.dateGroupModified
    nodes.push(node)
  }
  return new BookmarkTree(normalizeBookmarkNodes(nodes, NOW))
}

const base = (): Spec[] => [
  { id: 'work', parentId: BOOKMARKS_BAR_ID, dateGroupModified: NOW + 5 },
  { id: 'a', parentId: 'work', url: 'https://a.example/' },
  { id: 'b', parentId: 'work', url: 'https://b.example/', title: 'Bee' },
  { id: 'c', parentId: OTHER_BOOKMARKS_ID, url: 'https://c.example/x?y' },
  { id: 'd', parentId: OTHER_BOOKMARKS_ID, url: 'https://d.example/' },
  { id: 'e', parentId: OTHER_BOOKMARKS_ID, url: 'https://e.example/' }
]

describe('node shape', () => {
  it('gives the permanent folders the root as parent and their folder type', () => {
    const t = tree([])
    const bar = toChromeNode(t.get(BOOKMARKS_BAR_ID)!, t, false)
    expect(bar).toEqual({
      id: '1',
      parentId: '0',
      index: 0,
      title: 'Bookmarks bar',
      dateAdded: NOW,
      syncing: false,
      folderType: 'bookmarks-bar'
    })
    expect(toChromeNode(t.get(OTHER_BOOKMARKS_ID)!, t, false).folderType).toBe('other')
    expect(toChromeNode(t.get(MOBILE_BOOKMARKS_ID)!, t, false)).toMatchObject({
      index: 2,
      folderType: 'mobile'
    })
  })

  it('shapes bookmarks with their URL and folders with dateGroupModified and children', () => {
    const t = tree(base())
    const a = t.get('a')!
    a.dateLastUsed = NOW + 9
    expect(toChromeNode(a, t, true)).toEqual({
      id: 'a',
      parentId: 'work',
      index: 0,
      title: 'a',
      url: 'https://a.example/',
      dateAdded: NOW,
      dateLastUsed: NOW + 9,
      syncing: false
    })
    const work = toChromeNode(t.get('work')!, t, true)
    expect(work.dateGroupModified).toBe(NOW + 5)
    expect(work).not.toHaveProperty('url')
    expect(work).not.toHaveProperty('folderType')
    expect(work.children?.map((c) => c.id)).toEqual(['a', 'b'])
    expect(work.children?.[0]).not.toHaveProperty('children')
  })

  it('synthesises the root 0 over the permanent folders', () => {
    const t = tree(base())
    const root = rootChromeNode(t, true)
    expect(root).toMatchObject({ id: '0', title: '', syncing: false })
    expect(root).not.toHaveProperty('parentId')
    expect(root).not.toHaveProperty('index')
    expect(root.children?.map((c) => c.id)).toEqual(['1', '2', '3'])
    expect(root.children?.[0].children?.[0].children?.map((c) => c.id)).toEqual(['a', 'b'])
    expect(chromeNodeFor(t, BOOKMARKS_ROOT_ID, false)).not.toHaveProperty('children')
    expect(chromeNodeFor(t, 'nope', false)).toBeNull()
    expect(chromeChildrenOf(t, BOOKMARKS_ROOT_ID).map((c) => c.id)).toEqual(['1', '2', '3'])
    expect(chromeChildrenOf(t, OTHER_BOOKMARKS_ID).map((c) => c.id)).toEqual(['c', 'd', 'e'])
    expect(chromeChildrenOf(t, 'a')).toEqual([])
  })
})

describe('argument checks', () => {
  it('normalizes id lists and recent counts', () => {
    expect(normalizeIdList('1')).toEqual(['1'])
    expect(normalizeIdList(['1', 'a'])).toEqual(['1', 'a'])
    expect(() => normalizeIdList([])).toThrow(ERROR_INVALID_ID)
    expect(() => normalizeIdList([1])).toThrow(ERROR_INVALID_ID)
    expect(() => normalizeIdList(7)).toThrow(ERROR_INVALID_ID)
    expect(normalizeRecentCount(3)).toBe(3)
    expect(() => normalizeRecentCount(0)).toThrow(ERROR_INVALID_PARAM)
    expect(() => normalizeRecentCount(1.5)).toThrow(ERROR_INVALID_PARAM)
  })

  it('create defaults to a folder under Other bookmarks and canonicalises URLs', () => {
    const t = tree(base())
    expect(planCreate(t, { title: 'F' })).toEqual({ parentId: OTHER_BOOKMARKS_ID, title: 'F' })
    expect(planCreate(t, { url: 'https://x.example' })).toEqual({
      parentId: OTHER_BOOKMARKS_ID,
      title: '',
      url: 'https://x.example/'
    })
    expect(planCreate(t, { parentId: 'work', index: 2, title: 'z', url: '' })).toEqual({
      parentId: 'work',
      index: 2,
      title: 'z'
    })
  })

  it('create refuses the root, missing and non-folder parents, bad indices and URLs', () => {
    const t = tree(base())
    expect(() => planCreate(t, { parentId: '0', title: 'x' })).toThrow(ERROR_MODIFY_SPECIAL)
    expect(() => planCreate(t, { parentId: 'nope' })).toThrow(ERROR_NO_PARENT)
    expect(() => planCreate(t, { parentId: 'a' })).toThrow(ERROR_INVALID_PARENT)
    expect(() => planCreate(t, { parentId: 'work', index: 3 })).toThrow(ERROR_INVALID_INDEX)
    expect(() => planCreate(t, { parentId: 'work', index: -1 })).toThrow(ERROR_INVALID_INDEX)
    expect(() => planCreate(t, { url: 'not a url' })).toThrow(ERROR_INVALID_URL)
    expect(() => planCreate(t, { title: 3 })).toThrow(/Invalid value for 'title'/)
    expect(() => planCreate(t, null)).toThrow(ERROR_INVALID_PARAM)
  })

  it('move converts Chrome indices to the model count and validates the destination', () => {
    const t = tree(base())
    // c d e: moving c to Chrome index 2 means "before e", which is model index 1.
    expect(planMove(t, 'c', { index: 2 })).toEqual({ parentId: OTHER_BOOKMARKS_ID, index: 1 })
    expect(planMove(t, 'e', { index: 0 })).toEqual({ parentId: OTHER_BOOKMARKS_ID, index: 0 })
    expect(planMove(t, 'c', { index: 3 })).toEqual({ parentId: OTHER_BOOKMARKS_ID, index: 2 })
    expect(planMove(t, 'c', {})).toEqual({ parentId: OTHER_BOOKMARKS_ID, index: 3 })
    expect(planMove(t, 'c', { parentId: 'work' })).toEqual({ parentId: 'work', index: 2 })
    expect(planMove(t, 'c', { parentId: 'work', index: 1 })).toEqual({ parentId: 'work', index: 1 })
    expect(() => planMove(t, 'c', { index: 4 })).toThrow(ERROR_INVALID_INDEX)
    expect(() => planMove(t, 'c', { parentId: 'work', index: 3 })).toThrow(ERROR_INVALID_INDEX)
    expect(() => planMove(t, 'work', { parentId: 'work' })).toThrow(ERROR_INVALID_MOVE_DESTINATION)
    expect(() => planMove(t, 'work', { parentId: 'a' })).toThrow(ERROR_INVALID_PARENT)
    expect(() => planMove(t, BOOKMARKS_BAR_ID, { parentId: 'work' })).toThrow(ERROR_MODIFY_SPECIAL)
    expect(() => planMove(t, 'a', { parentId: '0' })).toThrow(ERROR_MODIFY_SPECIAL)
    expect(() => planMove(t, 'nope', {})).toThrow(ERROR_NO_NODE)
    expect(() => planMove(t, 'a', { parentId: 'nope' })).toThrow(ERROR_NO_PARENT)
  })

  it('move refuses a folder into its own subtree', () => {
    const t = tree([...base(), { id: 'deep', parentId: 'work' }])
    expect(() => planMove(t, 'work', { parentId: 'deep' })).toThrow(ERROR_INVALID_MOVE_DESTINATION)
  })

  it('update takes a title for any node and a URL for bookmarks only', () => {
    const t = tree(base())
    expect(planUpdate(t, 'work', { title: 'Play' })).toEqual({ title: 'Play' })
    expect(planUpdate(t, 'a', { url: 'https://a.example/new' })).toEqual({
      url: 'https://a.example/new'
    })
    expect(planUpdate(t, 'a', {})).toEqual({})
    expect(() => planUpdate(t, 'work', { url: 'https://x/' })).toThrow(
      ERROR_CANNOT_SET_URL_OF_FOLDER
    )
    expect(() => planUpdate(t, 'a', { url: '' })).toThrow(ERROR_INVALID_URL)
    expect(() => planUpdate(t, OTHER_BOOKMARKS_ID, { title: 'x' })).toThrow(ERROR_MODIFY_SPECIAL)
    expect(() => planUpdate(t, '0', { title: 'x' })).toThrow(ERROR_MODIFY_SPECIAL)
    expect(() => planUpdate(t, 'nope', { title: 'x' })).toThrow(ERROR_NO_NODE)
  })

  it('remove refuses non-empty folders unless recursive, roots always', () => {
    const t = tree(base())
    expect(planRemove(t, 'a', false).id).toBe('a')
    expect(() => planRemove(t, 'work', false)).toThrow(ERROR_FOLDER_NOT_EMPTY)
    expect(planRemove(t, 'work', true).id).toBe('work')
    expect(() => planRemove(t, BOOKMARKS_BAR_ID, true)).toThrow(ERROR_MODIFY_SPECIAL)
    expect(() => planRemove(t, '0', true)).toThrow(ERROR_MODIFY_SPECIAL)
    expect(() => planRemove(t, 'nope', false)).toThrow(ERROR_NO_NODE)
  })
})

describe('search', () => {
  it('normalizes string and object queries', () => {
    expect(normalizeSearchQuery('hello')).toEqual({ query: 'hello' })
    expect(normalizeSearchQuery({ url: 'https://a/', title: 't' })).toEqual({
      url: 'https://a/',
      title: 't'
    })
    expect(normalizeSearchQuery({})).toEqual({})
    expect(() => normalizeSearchQuery(4)).toThrow(ERROR_INVALID_PARAM)
    expect(() => normalizeSearchQuery({ url: 1 })).toThrow(/Invalid value for 'url'/)
  })

  it('narrows by words through the model, then exact title and canonical URL', () => {
    const t = tree(base())
    const words = (q: string): BookmarkNode[] =>
      t.all().filter((n) => n.title.toLowerCase().includes(q.toLowerCase()))
    expect(searchBookmarkNodes(t, { query: 'bee' }, words).map((n) => n.id)).toEqual(['b'])
    expect(searchBookmarkNodes(t, { query: '   ' }, words)).toEqual([])
    expect(
      searchBookmarkNodes(t, { url: 'https://c.example/x?y' }, words).map((n) => n.id)
    ).toEqual(['c'])
    expect(searchBookmarkNodes(t, { url: 'HTTPS://d.example' }, words).map((n) => n.id)).toEqual([
      'd'
    ])
    expect(searchBookmarkNodes(t, { url: 'garbage' }, words)).toEqual([])
    expect(searchBookmarkNodes(t, { title: 'Bee' }, words).map((n) => n.id)).toEqual(['b'])
    expect(searchBookmarkNodes(t, { title: 'bee' }, words)).toEqual([])
    expect(searchBookmarkNodes(t, { title: 'work' }, words).map((n) => n.id)).toEqual(['work'])
    expect(searchBookmarkNodes(t, { query: 'e', url: 'https://e.example/' }, words)).toHaveLength(1)
    // An empty object matches every node but the permanent folders, in tree order.
    expect(searchBookmarkNodes(t, {}, words).map((n) => n.id)).toEqual([
      'work',
      'a',
      'b',
      'c',
      'd',
      'e'
    ])
  })
})

describe('diffBookmarkTrees', () => {
  it('reports nothing for identical trees or metadata-only changes', () => {
    const before = tree(base())
    expect(diffBookmarkTrees(before, tree(base()))).toEqual([])
    const specs = base()
    specs[1].favicon = 'data:image/png;base64,AA=='
    expect(diffBookmarkTrees(before, tree(specs))).toEqual([])
  })

  it('fires onCreated once for a new node and no moves for the shifted siblings', () => {
    const before = tree(base())
    const after = tree([
      ...base().slice(0, 3),
      { id: 'new', parentId: OTHER_BOOKMARKS_ID, url: 'https://n.example/' },
      ...base().slice(3)
    ])
    const events = diffBookmarkTrees(before, after)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      event: 'onCreated',
      args: [
        'new',
        {
          id: 'new',
          parentId: '2',
          index: 0,
          title: 'new',
          url: 'https://n.example/',
          dateAdded: NOW,
          syncing: false
        }
      ]
    })
  })

  it('brackets a batch of new nodes with the import events, parents first', () => {
    const before = tree(base())
    const after = tree([
      ...base(),
      { id: 'imported', parentId: BOOKMARKS_BAR_ID },
      { id: 'i1', parentId: 'imported', url: 'https://i1.example/' },
      { id: 'i2', parentId: 'imported', url: 'https://i2.example/' }
    ])
    const events = diffBookmarkTrees(before, after)
    expect(events.map((e) => e.event)).toEqual([
      'onImportBegan',
      'onCreated',
      'onCreated',
      'onCreated',
      'onImportEnded'
    ])
    expect(events.slice(1, 4).map((e) => e.args[0])).toEqual(['imported', 'i1', 'i2'])
  })

  it('reports a removed subtree once, with the children it had', () => {
    const before = tree(base())
    const after = tree(base().slice(3))
    const events = diffBookmarkTrees(before, after)
    expect(events).toHaveLength(1)
    const [id, info] = events[0].args as [
      string,
      { parentId: string; index: number; node: unknown }
    ]
    expect(events[0].event).toBe('onRemoved')
    expect(id).toBe('work')
    expect(info.parentId).toBe('1')
    expect(info.index).toBe(0)
    expect(info.node).toMatchObject({
      id: 'work',
      children: [{ id: 'a' }, { id: 'b' }]
    })
  })

  it('reports title and URL edits as onChanged', () => {
    const before = tree(base())
    const specs = base()
    specs[0].title = 'Play'
    specs[2].url = 'https://b.example/2'
    const events = diffBookmarkTrees(before, tree(specs))
    expect(events).toEqual([
      { event: 'onChanged', args: ['work', { title: 'Play' }] },
      { event: 'onChanged', args: ['b', { title: 'Bee', url: 'https://b.example/2' }] }
    ])
  })

  it('reports one onMoved for a node moved inside its folder', () => {
    const before = tree(base())
    // c d e -> d e c
    const after = tree([
      ...base().slice(0, 3),
      { id: 'd', parentId: OTHER_BOOKMARKS_ID, url: 'https://d.example/' },
      { id: 'e', parentId: OTHER_BOOKMARKS_ID, url: 'https://e.example/' },
      { id: 'c', parentId: OTHER_BOOKMARKS_ID, url: 'https://c.example/x?y' }
    ])
    expect(diffBookmarkTrees(before, after)).toEqual([
      { event: 'onMoved', args: ['c', { parentId: '2', index: 2, oldParentId: '2', oldIndex: 0 }] }
    ])
  })

  it('reports a move between folders with both positions', () => {
    const before = tree(base())
    const after = tree([
      { id: 'work', parentId: BOOKMARKS_BAR_ID, dateGroupModified: NOW + 5 },
      { id: 'c', parentId: 'work', url: 'https://c.example/x?y' },
      { id: 'a', parentId: 'work', url: 'https://a.example/' },
      { id: 'b', parentId: 'work', url: 'https://b.example/', title: 'Bee' },
      { id: 'd', parentId: OTHER_BOOKMARKS_ID, url: 'https://d.example/' },
      { id: 'e', parentId: OTHER_BOOKMARKS_ID, url: 'https://e.example/' }
    ])
    expect(diffBookmarkTrees(before, after)).toEqual([
      {
        event: 'onMoved',
        args: ['c', { parentId: 'work', index: 0, oldParentId: '2', oldIndex: 0 }]
      }
    ])
  })

  it('reports a wholesale rearrangement as onChildrenReordered', () => {
    const before = tree(base())
    // c d e -> e c d is one move; c d e -> e d c rearranges two of three.
    const after = tree([
      ...base().slice(0, 3),
      { id: 'e', parentId: OTHER_BOOKMARKS_ID, url: 'https://e.example/' },
      { id: 'd', parentId: OTHER_BOOKMARKS_ID, url: 'https://d.example/' },
      { id: 'c', parentId: OTHER_BOOKMARKS_ID, url: 'https://c.example/x?y' }
    ])
    expect(diffBookmarkTrees(before, after)).toEqual([
      { event: 'onChildrenReordered', args: ['2', { childIds: ['e', 'd', 'c'] }] }
    ])
  })

  it('orders mixed commits removed, created, moved, changed', () => {
    const before = tree(base())
    const after = tree([
      { id: 'work', parentId: BOOKMARKS_BAR_ID, title: 'Renamed' },
      { id: 'b', parentId: 'work', url: 'https://b.example/', title: 'Bee' },
      { id: 'a', parentId: 'work', url: 'https://a.example/' },
      { id: 'c', parentId: OTHER_BOOKMARKS_ID, url: 'https://c.example/x?y' },
      { id: 'f', parentId: OTHER_BOOKMARKS_ID, url: 'https://f.example/' },
      { id: 'e', parentId: OTHER_BOOKMARKS_ID, url: 'https://e.example/' }
    ])
    const events = diffBookmarkTrees(before, after)
    expect(events.map((e) => `${e.event}:${e.args[0] ?? ''}`)).toEqual([
      'onRemoved:d',
      'onCreated:f',
      'onMoved:b',
      'onChanged:work'
    ])
  })
})
