import { describe, expect, it } from 'vitest'
import {
  addTabToSplit,
  allSpaces,
  createFolder,
  createLocalSpace,
  createSpace,
  createSplitGroup,
  createTabRecord,
  cycleSpace,
  deleteFolder,
  dissolveSplitGroup,
  essentialsForSpace,
  getSpace,
  insertTabIntoSpace,
  moveTab,
  nextTabAfterClose,
  orderedTabsForSpace,
  pinnedTabs,
  regularTabs,
  removeTabFromLists,
  removeTabFromSplit,
  reorderContainer,
  reorderSpace,
  sectionIndexOf,
  type Model
} from '../model'
import { DEFAULT_CONTAINERS } from '../../../shared/defaults'
import type { Tab } from '../../../shared/types'

function makeModel(): Model {
  const space = createSpace('Default', '')
  return {
    tabs: {},
    essentialTabIds: [],
    spaces: [space],
    activeSpaceId: space.id,
    containers: structuredClone(DEFAULT_CONTAINERS),
    folders: {},
    splitGroups: {},
    localSpaces: {}
  }
}

function addTab(model: Model, url: string, opts: Partial<Tab> = {}): Tab {
  const space = model.spaces.find((s) => s.id === model.activeSpaceId)!
  const tab = createTabRecord({ spaceId: space.id, containerId: space.containerId, url, ...opts })
  model.tabs[tab.id] = tab
  insertTabIntoSpace(model, space, tab)
  return tab
}

describe('tab ordering', () => {
  it('keeps pinned tabs ahead of regular tabs regardless of insertion order', () => {
    const m = makeModel()
    const a = addTab(m, 'https://a.test')
    const p = addTab(m, 'https://p.test', { pinned: true })
    const b = addTab(m, 'https://b.test')
    const space = m.spaces[0]
    expect(space.tabIds).toEqual([p.id, a.id, b.id])
    expect(pinnedTabs(m, space).map((t) => t.id)).toEqual([p.id])
    expect(regularTabs(m, space).map((t) => t.id)).toEqual([a.id, b.id])
    expect(sectionIndexOf(m, b)).toBe(1)
  })

  it('inserts at a section-relative index', () => {
    const m = makeModel()
    const a = addTab(m, 'https://a.test')
    const b = addTab(m, 'https://b.test')
    const p = addTab(m, 'https://p.test', { pinned: true })
    const c = createTabRecord({
      spaceId: m.spaces[0].id,
      containerId: 'default',
      url: 'https://c.test'
    })
    m.tabs[c.id] = c
    insertTabIntoSpace(m, m.spaces[0], c, 1)
    expect(m.spaces[0].tabIds).toEqual([p.id, a.id, c.id, b.id])
  })

  it('pinned tabs default their pinnedUrl to the pinned URL', () => {
    const tab = createTabRecord({
      spaceId: 'x',
      containerId: 'default',
      url: 'https://p.test',
      pinned: true
    })
    expect(tab.pinnedUrl).toBe('https://p.test')
    const regular = createTabRecord({ spaceId: 'x', containerId: 'default', url: 'https://r.test' })
    expect(regular.pinnedUrl).toBeNull()
  })
})

describe('moveTab', () => {
  it('pins a regular tab and keeps it active', () => {
    const m = makeModel()
    const a = addTab(m, 'https://a.test')
    const b = addTab(m, 'https://b.test')
    m.spaces[0].activeTabId = b.id
    moveTab(m, b, { section: 'pinned', index: 0 }, 12)
    expect(b.pinned).toBe(true)
    expect(b.pinnedUrl).toBe('https://b.test')
    expect(m.spaces[0].tabIds).toEqual([b.id, a.id])
    expect(m.spaces[0].activeTabId).toBe(b.id)
  })

  it('promotes a tab to Essentials and respects the maximum', () => {
    const m = makeModel()
    const a = addTab(m, 'https://a.test')
    const b = addTab(m, 'https://b.test')
    moveTab(m, a, { section: 'essential', index: 0 }, 1)
    expect(a.essential).toBe(true)
    expect(a.spaceId).toBeNull()
    expect(m.essentialTabIds).toEqual([a.id])
    // Essentials are full → falls back to pinning.
    moveTab(m, b, { section: 'essential', index: 0 }, 1)
    expect(b.essential).toBe(false)
    expect(b.pinned).toBe(true)
    expect(essentialsForSpace(m, m.spaces[0], true)).toHaveLength(1)
  })

  it('moves a tab to another space and clears its folder', () => {
    const m = makeModel()
    const other = createSpace('Work', '💼')
    m.spaces.push(other)
    const folder = createFolder(m, m.spaces[0].id, 'Docs', '📁')
    const a = addTab(m, 'https://a.test', { folderId: folder.id })
    moveTab(m, a, { spaceId: other.id, section: 'regular', index: 0 }, 12)
    expect(a.spaceId).toBe(other.id)
    expect(a.folderId).toBeNull()
    expect(m.spaces[0].tabIds).toEqual([])
    expect(other.tabIds).toEqual([a.id])
  })

  it('unpins back to regular and clears pinnedUrl', () => {
    const m = makeModel()
    const p = addTab(m, 'https://p.test', { pinned: true })
    moveTab(m, p, { section: 'regular', index: 0 }, 12)
    expect(p.pinned).toBe(false)
    expect(p.pinnedUrl).toBeNull()
  })
})

describe('nextTabAfterClose', () => {
  it('prefers the next tab, then the previous one', () => {
    const m = makeModel()
    const a = addTab(m, 'https://a.test')
    const b = addTab(m, 'https://b.test')
    const c = addTab(m, 'https://c.test')
    expect(nextTabAfterClose(m, m.spaces[0], b.id, true)).toBe(c.id)
    expect(nextTabAfterClose(m, m.spaces[0], c.id, true)).toBe(b.id)
    expect(nextTabAfterClose(m, m.spaces[0], a.id, true)).toBe(b.id)
  })

  it("skips pinned and essential tabs for Zen's pinned-close behaviour", () => {
    const m = makeModel()
    const p = addTab(m, 'https://p.test', { pinned: true })
    const a = addTab(m, 'https://a.test')
    expect(nextTabAfterClose(m, m.spaces[0], p.id, true, true)).toBe(a.id)
    removeTabFromLists(m, a.id)
    expect(nextTabAfterClose(m, m.spaces[0], p.id, true, true)).toBeNull()
  })

  it('includes essentials in the cycling order before space tabs', () => {
    const m = makeModel()
    const a = addTab(m, 'https://a.test')
    const e = createTabRecord({
      spaceId: null,
      containerId: 'default',
      url: 'https://e.test',
      essential: true
    })
    m.tabs[e.id] = e
    m.essentialTabIds.push(e.id)
    expect(orderedTabsForSpace(m, m.spaces[0], true).map((t) => t.id)).toEqual([e.id, a.id])
  })
})

describe('split groups', () => {
  it('creates groups of 2-4 tabs with equal sizes and links the tabs', () => {
    const m = makeModel()
    const tabs = [1, 2, 3, 4, 5].map((i) => addTab(m, `https://${i}.test`))
    const group = createSplitGroup(
      m,
      m.spaces[0].id,
      tabs.map((t) => t.id),
      'grid'
    )
    expect(group).not.toBeNull()
    expect(group!.tabIds).toHaveLength(4)
    expect(group!.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
    expect(m.tabs[tabs[0].id].splitGroupId).toBe(group!.id)
    expect(m.tabs[tabs[4].id].splitGroupId).toBeNull()
    expect(createSplitGroup(m, m.spaces[0].id, [tabs[4].id], 'vertical')).toBeNull()
  })

  it('dissolves when fewer than two tabs remain', () => {
    const m = makeModel()
    const a = addTab(m, 'https://a.test')
    const b = addTab(m, 'https://b.test')
    const group = createSplitGroup(m, m.spaces[0].id, [a.id, b.id], 'vertical')!
    removeTabFromSplit(m, a.id)
    expect(m.splitGroups[group.id]).toBeUndefined()
    expect(b.splitGroupId).toBeNull()
  })

  it('adds tabs up to the limit and dissolves explicitly', () => {
    const m = makeModel()
    const tabs = [1, 2, 3, 4, 5].map((i) => addTab(m, `https://${i}.test`))
    const group = createSplitGroup(m, m.spaces[0].id, [tabs[0].id, tabs[1].id], 'horizontal')!
    expect(addTabToSplit(m, group.id, tabs[2].id)).toBe(true)
    expect(addTabToSplit(m, group.id, tabs[3].id)).toBe(true)
    expect(addTabToSplit(m, group.id, tabs[4].id)).toBe(false)
    dissolveSplitGroup(m, group.id)
    expect(tabs.every((t) => m.tabs[t.id].splitGroupId === null)).toBe(true)
  })
})

describe('windows', () => {
  it('filters window-local tabs per window and never for pinned tabs', () => {
    const m = makeModel()
    const shared = addTab(m, 'https://shared.test')
    const local = addTab(m, 'https://local.test', { windowId: 'w1' })
    expect(regularTabs(m, m.spaces[0], 'w1').map((t) => t.id)).toEqual([shared.id, local.id])
    expect(regularTabs(m, m.spaces[0], 'w2').map((t) => t.id)).toEqual([shared.id])
    expect(regularTabs(m, m.spaces[0]).map((t) => t.id)).toEqual([shared.id, local.id])
    expect(nextTabAfterClose(m, m.spaces[0], shared.id, true, false, 'w2')).toBeNull()
    expect(nextTabAfterClose(m, m.spaces[0], shared.id, true, false, 'w1')).toBe(local.id)
    // Pinning a window-local tab shares it with every window.
    moveTab(m, local, { section: 'pinned', index: 0 }, 12)
    expect(local.windowId).toBeNull()
  })

  it('keeps blank-window spaces out of the space list and their tabs bound to the window', () => {
    const m = makeModel()
    const localSpace = createLocalSpace('w9', 'Blank Window', '', 'default', null)
    m.localSpaces[localSpace.id] = localSpace
    expect(getSpace(m, localSpace.id)).toBe(localSpace)
    expect(allSpaces(m)).toHaveLength(2)
    expect(m.spaces).toHaveLength(1)
    const tab = createTabRecord({
      spaceId: localSpace.id,
      containerId: 'default',
      url: 'https://b.test'
    })
    m.tabs[tab.id] = tab
    insertTabIntoSpace(m, localSpace, tab)
    expect(tab.windowId).toBe('w9')
    expect(essentialsForSpace(m, localSpace, true)).toEqual([])
    // Moving it back into a real space makes it shared again.
    moveTab(m, tab, { spaceId: m.spaces[0].id, section: 'regular', index: 0 }, 12)
    expect(tab.windowId).toBeNull()
    expect(tab.spaceId).toBe(m.spaces[0].id)
    expect(localSpace.tabIds).toEqual([])
  })

  it('cycles spaces relative to any window position and reorders containers', () => {
    const m = makeModel()
    const work = createSpace('Work', '💼')
    const play = createSpace('Play', '🎮')
    m.spaces.push(work, play)
    expect(cycleSpace(m, 1, work.id).id).toBe(play.id)
    expect(cycleSpace(m, 1, play.id).id).toBe(m.spaces[0].id)
    reorderContainer(m, 'shopping', 1)
    expect(m.containers.map((c) => c.id).slice(0, 3)).toEqual(['default', 'shopping', 'personal'])
    // "No Container" is pinned to the first slot.
    reorderContainer(m, 'default', 3)
    expect(m.containers[0].id).toBe('default')
  })
})

describe('spaces & folders', () => {
  it('cycles spaces with wrap-around and reorders them', () => {
    const m = makeModel()
    const work = createSpace('Work', '💼')
    const play = createSpace('Play', '🎮')
    m.spaces.push(work, play)
    expect(cycleSpace(m, 1).id).toBe(work.id)
    expect(cycleSpace(m, -1).id).toBe(play.id)
    reorderSpace(m, play.id, 0)
    expect(m.spaces.map((s) => s.name)).toEqual(['Play', 'Default', 'Work'])
  })

  it('unpacks or closes folder members on delete', () => {
    const m = makeModel()
    const folder = createFolder(m, m.spaces[0].id, 'Docs', '📁')
    const a = addTab(m, 'https://a.test', { folderId: folder.id })
    const b = addTab(m, 'https://b.test', { folderId: folder.id })
    expect(deleteFolder(m, folder.id, true)).toEqual([])
    expect(a.folderId).toBeNull()
    const folder2 = createFolder(m, m.spaces[0].id, 'More', '📂')
    b.folderId = folder2.id
    expect(deleteFolder(m, folder2.id, false)).toEqual([b.id])
    expect(m.folders[folder2.id]).toBeUndefined()
  })
})
