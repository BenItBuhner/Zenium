import { describe, expect, it } from 'vitest'
import type { Folder, Space, SplitGroup, Tab, UIState } from '@shared/types'
import { stripRows, tabOrderOf } from '../selectors'

function tab(id: string, patch: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: 's1',
    containerId: 'default',
    url: `https://${id}.example`,
    title: id,
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    progress: 0,
    canGoBack: false,
    canGoForward: false,
    audible: false,
    muted: false,
    discarded: false,
    frozen: false,
    cpuThrottle: 1,
    zoom: 1,
    splitGroupId: null,
    createdAt: 0,
    lastActiveAt: 0,
    errorCode: null,
    bookmarked: false,
    readerable: false,
    blockedCount: 0,
    openerTabId: null,
    fromIntent: false,
    webApp: null,
    ...patch
  }
}

const space: Space = {
  id: 's1',
  name: 'Work',
  icon: '',
  containerId: 'default',
  theme: null,
  tabIds: ['p1', 'r1', 'f1', 'r2', 'f2'],
  activeTabId: 'r1',
  pinnedCollapsed: false
}

const folder: Folder = {
  id: 'folder',
  spaceId: 's1',
  name: 'Reading',
  icon: '📚',
  collapsed: false
}

const tabs: Record<string, Tab> = {
  e1: tab('e1', { spaceId: null, essential: true }),
  e2: tab('e2', { spaceId: null, essential: true, containerId: 'work' }),
  p1: tab('p1', { pinned: true }),
  r1: tab('r1'),
  f1: tab('f1', { folderId: 'folder' }),
  r2: tab('r2'),
  f2: tab('f2', { folderId: 'folder' }),
  orphan: tab('orphan', { folderId: 'gone' })
}

const state = {
  tabs,
  essentialTabIds: ['e1', 'e2'],
  spaces: [space],
  activeSpaceId: 's1',
  folders: { folder },
  settings: { containerSpecificEssentials: false }
} as unknown as UIState

describe('tabOrderOf', () => {
  it('follows the sidebar: essentials, pinned, folder contents, loose tabs', () => {
    expect(tabOrderOf(state, space).map((t) => t.id)).toEqual([
      'e1',
      'e2',
      'p1',
      'f1',
      'f2',
      'r1',
      'r2'
    ])
  })

  it('honours container-specific essentials', () => {
    const scoped = {
      ...state,
      settings: { containerSpecificEssentials: true }
    } as unknown as UIState
    expect(tabOrderOf(scoped, space).map((t) => t.id)).toEqual(['e1', 'p1', 'f1', 'f2', 'r1', 'r2'])
  })

  it('treats tabs of a deleted folder as loose', () => {
    const withOrphan = {
      ...state,
      spaces: [{ ...space, tabIds: [...space.tabIds, 'orphan'] }]
    } as unknown as UIState
    const order = tabOrderOf(withOrphan, withOrphan.spaces[0]).map((t) => t.id)
    expect(order[order.length - 1]).toBe('orphan')
  })
})

/*
 * The split group's row (design language v2 §9.35): a list draws a split as one row in the slot
 * of its first pane, gathering the list's other panes into it in the split's order.
 */
describe('stripRows', () => {
  const group = (id: string, tabIds: string[]): SplitGroup => ({
    id,
    spaceId: 's1',
    tabIds,
    layout: 'vertical',
    sizes: tabIds.map(() => 1 / tabIds.length)
  })
  const rowsOf = (list: Tab[], groups: Record<string, SplitGroup>): string[] =>
    stripRows(list, groups).map((r) =>
      r.kind === 'tab' ? r.tab.id : `split(${r.anchor.id}: ${r.tabs.map((t) => t.id).join(' ')})`
    )

  it('folds the split into one row where its first pane is, the panes in the split’s order', () => {
    const list = [
      tab('a'),
      tab('b', { splitGroupId: 'g' }),
      tab('c', { splitGroupId: 'g' }),
      tab('d')
    ]
    expect(rowsOf(list, { g: group('g', ['c', 'b']) })).toEqual(['a', 'split(b: c b)', 'd'])
  })

  it('gathers panes that are not neighbours in the list', () => {
    const list = [
      tab('a', { splitGroupId: 'g' }),
      tab('x'),
      tab('b', { splitGroupId: 'g' }),
      tab('y')
    ]
    expect(rowsOf(list, { g: group('g', ['a', 'b']) })).toEqual(['split(a: a b)', 'x', 'y'])
  })

  it('draws a lone pane (its siblings in another list) and a tab of a gone split as plain rows', () => {
    const list = [tab('a', { splitGroupId: 'g' }), tab('b'), tab('c', { splitGroupId: 'gone' })]
    expect(rowsOf(list, { g: group('g', ['a', 'elsewhere']) })).toEqual(['a', 'b', 'c'])
  })

  it('keeps two splits apart, each in its own row', () => {
    const list = [
      tab('a', { splitGroupId: 'g1' }),
      tab('b', { splitGroupId: 'g2' }),
      tab('c', { splitGroupId: 'g1' }),
      tab('d', { splitGroupId: 'g2' })
    ]
    expect(rowsOf(list, { g1: group('g1', ['a', 'c']), g2: group('g2', ['d', 'b']) })).toEqual([
      'split(a: a c)',
      'split(b: d b)'
    ])
  })
})
