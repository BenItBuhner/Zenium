import { describe, expect, it } from 'vitest'
import type { Folder, Space, Tab, UIState } from '@shared/types'
import { tabOrderOf } from '../selectors'

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
