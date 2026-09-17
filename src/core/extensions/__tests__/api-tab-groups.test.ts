import { describe, expect, it } from 'vitest'
import type { Folder, Tab, TabSection } from '../../../shared/types'
import {
  createFolder,
  createSpace,
  createTabRecord,
  emptyModel,
  insertTabIntoSpace,
  moveTab,
  type Model
} from '../../model'
import type { ZenWindow } from '../../window'
import type { Sender } from '../../../main/platform/extensionApi/types'
import {
  ERROR_CROSS_WINDOW,
  ERROR_ESSENTIAL_TAB,
  ERROR_GROUP_PARAMS,
  ERROR_LOCAL_WINDOW,
  ERROR_MOVE_WINDOW,
  ERROR_NO_PERMISSION,
  ERROR_NO_TABS,
  TAB_GROUP_COLORS,
  TabGroupIds,
  diffTabGroups,
  groupNotFound,
  normalizeTabGroupMove,
  normalizeTabGroupQuery,
  normalizeTabGroupUpdate,
  normalizeTabsGroup,
  normalizeTabsUngroup,
  tabGroupFromFolder,
  tabGroupMatches,
  type ChromeTabGroup,
  type TabGroupSnapshot
} from '../api/tabGroups'
import { TAB_GROUP_NONE, WINDOW_ID_CURRENT } from '../api/tabs'
import { TabGroupsApi } from '../../../main/platform/extensionApi/tabGroups'
import type { ModelSnapshot } from '../../../main/platform/extensionApi/model'
import type {
  ApiContext,
  ApiHost,
  LoadedExtension
} from '../../../main/platform/extensionApi/types'

function folder(over: Partial<Folder> = {}): Folder {
  return { id: 'f1', spaceId: 'space-1', name: 'Work', icon: '📁', collapsed: false, ...over }
}

describe('chrome.tabGroups shapes', () => {
  it('maps a folder onto Chrome group fields, grey when the folder has no colour', () => {
    expect(tabGroupFromFolder(folder(), 3, 7)).toEqual({
      id: 3,
      collapsed: false,
      color: 'grey',
      title: 'Work',
      windowId: 7,
      shared: false
    })
    expect(tabGroupFromFolder(folder({ color: 'cyan', collapsed: true }), 3, 7)).toMatchObject({
      color: 'cyan',
      collapsed: true
    })
  })

  it('hands out group ids per folder, stable and in order', () => {
    const ids = new TabGroupIds()
    expect(ids.idFor('a')).toBe(1)
    expect(ids.idFor('b')).toBe(2)
    expect(ids.idFor('a')).toBe(1)
    expect(ids.folderIdFor(2)).toBe('b')
    expect(ids.folderIdFor(9)).toBeUndefined()
  })

  it('applies query filters, the title as a glob and the current window', () => {
    const group: ChromeTabGroup = tabGroupFromFolder(folder({ color: 'red' }), 1, 7)
    expect(tabGroupMatches(group, {}, 7)).toBe(true)
    expect(tabGroupMatches(group, { color: 'red', collapsed: false }, 7)).toBe(true)
    expect(tabGroupMatches(group, { color: 'blue' }, 7)).toBe(false)
    expect(tabGroupMatches(group, { title: 'Wo*' }, 7)).toBe(true)
    expect(tabGroupMatches(group, { title: 'Home' }, 7)).toBe(false)
    expect(tabGroupMatches(group, { windowId: 7 }, 7)).toBe(true)
    expect(tabGroupMatches(group, { windowId: WINDOW_ID_CURRENT }, 7)).toBe(true)
    expect(tabGroupMatches(group, { windowId: WINDOW_ID_CURRENT }, 8)).toBe(false)
    expect(tabGroupMatches(group, { shared: true }, 7)).toBe(false)
  })

  it('checks the arguments of query, update, move, tabs.group and tabs.ungroup', () => {
    expect(normalizeTabGroupQuery(undefined)).toEqual({})
    expect(normalizeTabGroupQuery({ color: 'pink', title: 'x', windowId: 2 })).toEqual({
      color: 'pink',
      title: 'x',
      windowId: 2
    })
    expect(() => normalizeTabGroupQuery({ color: 'mauve' })).toThrow(/Value must be one of grey/)
    expect(() => normalizeTabGroupQuery({ windowId: 1.5 })).toThrow(/windowId/)
    expect(() => normalizeTabGroupQuery('x')).toThrow(/Expected 'object'/)
    expect(normalizeTabGroupUpdate({ title: 'T', collapsed: true, color: 'green' })).toEqual({
      title: 'T',
      collapsed: true,
      color: 'green'
    })
    expect(() => normalizeTabGroupUpdate({ collapsed: 'yes' })).toThrow(/collapsed/)
    expect(normalizeTabGroupMove({ index: -1 })).toEqual({ index: -1 })
    expect(normalizeTabGroupMove({ index: 2, windowId: 4 })).toEqual({ index: 2, windowId: 4 })
    expect(() => normalizeTabGroupMove({})).toThrow(/index/)
    expect(normalizeTabsGroup({ tabIds: 5 })).toEqual({ tabIds: [5] })
    expect(normalizeTabsGroup({ tabIds: [5, 6], groupId: 2 })).toEqual({
      tabIds: [5, 6],
      groupId: 2
    })
    expect(normalizeTabsGroup({ tabIds: [5], createProperties: { windowId: 3 } })).toEqual({
      tabIds: [5],
      createWindowId: 3
    })
    expect(() => normalizeTabsGroup({ tabIds: [] })).toThrow(ERROR_NO_TABS)
    expect(() => normalizeTabsGroup({})).toThrow(ERROR_NO_TABS)
    expect(() => normalizeTabsGroup({ tabIds: ['a'] })).toThrow(/tabIds/)
    expect(() => normalizeTabsGroup({ tabIds: [1], groupId: 2, createProperties: {} })).toThrow(
      ERROR_GROUP_PARAMS
    )
    expect(normalizeTabsUngroup(4)).toEqual([4])
    expect(normalizeTabsUngroup([4, 5])).toEqual([4, 5])
    expect(() => normalizeTabsUngroup([])).toThrow(ERROR_NO_TABS)
    expect(() => normalizeTabsUngroup('x')).toThrow(/integer/)
    expect(TAB_GROUP_COLORS).toHaveLength(9)
  })

  it('diffs folder snapshots into group events', () => {
    const snap = (
      id: number,
      over: Partial<Folder>,
      windowId: number,
      index: number
    ): [string, TabGroupSnapshot] => [
      over.id ?? 'f1',
      { group: tabGroupFromFolder(folder(over), id, windowId), index }
    ]
    const prev = new Map([snap(1, { id: 'a' }, 7, 2), snap(2, { id: 'b' }, 7, 5)])
    const next = new Map([snap(1, { id: 'a', name: 'Renamed' }, 7, 3), snap(3, { id: 'c' }, 7, 0)])
    const same = (): boolean => true
    const events = diffTabGroups(prev, next, same)
    expect(events.map((e) => [e.event, e.group.id])).toEqual([
      ['onRemoved', 2],
      ['onUpdated', 1],
      ['onMoved', 1],
      ['onCreated', 3]
    ])
    // A changed tab set (a creation shifted the index) is not a move.
    const shifted = diffTabGroups(
      prev,
      new Map([snap(1, { id: 'a' }, 7, 3), snap(2, { id: 'b' }, 7, 6)]),
      () => false
    )
    expect(shifted).toEqual([])
    // Another window: removed there, created here.
    const rehomed = diffTabGroups(
      prev,
      new Map([snap(1, { id: 'a' }, 8, 2), snap(2, { id: 'b' }, 7, 5)]),
      same
    )
    expect(rehomed.map((e) => [e.event, e.group.windowId])).toEqual([
      ['onRemoved', 7],
      ['onCreated', 8]
    ])
    // Empty folders (index -1) never move.
    const empty = diffTabGroups(
      new Map([snap(1, { id: 'a' }, 7, -1)]),
      new Map([snap(1, { id: 'a' }, 7, 4)]),
      same
    )
    expect(empty).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Host module over a fake tab model
// ---------------------------------------------------------------------------

interface Dispatched {
  extensionId: string
  event: string
  args: unknown[]
}

const EXT_A = 'a'.repeat(32)
const EXT_B = 'b'.repeat(32)
const WINDOW_ID = 7

interface Harness {
  api: TabGroupsApi
  model: Model
  out: Dispatched[]
  win: ZenWindow
  load: (id: string, perms: string[]) => void
  ctx: (id: string) => ApiContext
  addTab: (id: string, over?: Partial<Tab>) => Tab
  addFolder: (id: string, over?: Partial<Folder>) => Folder
  chromeId: (zenId: string) => number
  tick: () => void
  order: () => string[]
  created: Folder[]
}

function harness(): Harness {
  const model = emptyModel([{ id: 'default', name: 'Default', color: 'blue', icon: 'circle' }])
  const space = { ...createSpace('Space', ''), id: 'space-1' }
  model.spaces.push(space)
  model.activeSpaceId = space.id
  const win = {
    id: 'w1',
    kind: 'synced',
    localSpace: undefined,
    activeSpace: () => space,
    lastFocusedAt: 1,
    host: { isFocused: () => true }
  } as unknown as ZenWindow
  const ids = new TabGroupIds()
  const chromeIds = new Map<string, number>()
  let nextChromeId = 100
  const chromeId = (zenId: string): number => {
    let id = chromeIds.get(zenId)
    if (id === undefined) chromeIds.set(zenId, (id = nextChromeId++))
    return id
  }
  const groupIdOfTab = (tab: Tab): number =>
    !tab.folderId || tab.pinned || tab.essential || !model.folders[tab.folderId]
      ? TAB_GROUP_NONE
      : ids.idFor(tab.folderId)
  const tabsInWindow = (): Tab[] => [
    ...model.essentialTabIds.map((id) => model.tabs[id]),
    ...space.tabIds.map((id) => model.tabs[id])
  ]
  const apiModel = {
    groupIdFor: (folderId: string) => ids.idFor(folderId),
    folderForGroup: (groupId: number) => {
      const folderId = ids.folderIdFor(groupId)
      return folderId ? model.folders[folderId] : undefined
    },
    groupIdOfTab,
    tab: (zenId: string) => model.tabs[zenId],
    zenTab: (tabId: number) => {
      for (const [zenId, id] of chromeIds) if (id === tabId) return model.tabs[zenId]
      return undefined
    },
    windowIdOf: (w: ZenWindow) => (w === win ? WINDOW_ID : -1),
    zenWindow: (windowId: number) => (windowId === WINDOW_ID ? win : undefined),
    lastFocusedWindow: () => win,
    currentWindowId: () => WINDOW_ID,
    tabsInWindow,
    windowOfTab: () => win
  }
  const created: Folder[] = []
  const browser = {
    allWindows: () => [win],
    state: { model },
    createFolder(
      spaceId: string,
      name: string,
      icon: string,
      _w: ZenWindow,
      options: { rename?: boolean }
    ): Folder {
      expect(options.rename).toBe(false)
      const made = createFolder(model, spaceId, name, icon)
      created.push(made)
      return made
    },
    updateFolder(folderId: string, patch: Partial<Folder>): void {
      const f = model.folders[folderId]
      if (!f) return
      Object.assign(f, patch)
      if (patch.name !== undefined && !patch.name.trim()) f.name = 'Folder'
    },
    tabs: {
      moveTab(
        tabId: string,
        target: { spaceId?: string; section: TabSection; index: number }
      ): void {
        const tab = model.tabs[tabId]
        if (tab) moveTab(model, tab, target, 12)
      },
      moveToFolder(tabId: string, folderId: string | null): void {
        const tab = model.tabs[tabId]
        if (!tab || tab.essential || tab.pinned) return
        if (folderId && !model.folders[folderId]) return
        tab.folderId = folderId
      }
    }
  }
  const loaded = new Map<string, LoadedExtension>()
  const grants: Record<string, string[]> = {}
  const out: Dispatched[] = []
  const host = {
    browser,
    model: apiModel,
    allLoaded: () => [...loaded.values()],
    grants: (id: string) => ({ permissions: grants[id] ?? [], origins: [] }),
    broadcast(
      namespace: string,
      event: string,
      argsFor: (ext: LoadedExtension) => unknown[] | null
    ): void {
      for (const ext of loaded.values()) {
        const args = argsFor(ext)
        if (args) out.push({ extensionId: ext.id, event: `${namespace}.${event}`, args })
      }
    }
  }
  const api = new TabGroupsApi(host as unknown as ApiHost)
  const snapshot = (): ModelSnapshot =>
    ({
      tabs: new Map(),
      windows: new Map([[WINDOW_ID, { order: tabsInWindow().map((t) => t.id), active: null }]]),
      focused: WINDOW_ID
    }) as unknown as ModelSnapshot
  let last: ModelSnapshot | null = null
  const tick = (): void => {
    const next = snapshot()
    api.tick(last, next)
    last = next
  }
  const addTab = (id: string, over: Partial<Tab> = {}): Tab => {
    const tab = createTabRecord({
      id,
      spaceId: space.id,
      containerId: 'default',
      url: `https://${id}.example/`,
      ...over
    })
    model.tabs[id] = tab
    if (tab.essential) model.essentialTabIds.push(id)
    else insertTabIntoSpace(model, space, tab)
    return tab
  }
  const addFolder = (id: string, over: Partial<Folder> = {}): Folder => {
    const f = folder({ id, ...over })
    model.folders[id] = f
    return f
  }
  const load = (id: string, perms: string[]): void => {
    loaded.set(id, { id } as LoadedExtension)
    grants[id] = perms
  }
  const ctx = (id: string): ApiContext =>
    ({
      extensionId: id,
      extension: loaded.get(id),
      sender: { kind: 'worker' } as unknown as Sender,
      window: undefined
    }) as unknown as ApiContext
  return {
    api,
    model,
    out,
    win,
    load,
    ctx,
    addTab,
    addFolder,
    chromeId,
    tick,
    order: () => tabsInWindow().map((t) => t.id),
    created
  }
}

const call = async (
  api: TabGroupsApi,
  method: string,
  ctx: ApiContext,
  ...args: unknown[]
): Promise<unknown> => await api.handlers[method]!(ctx, ...args)

const callTabs = async (
  api: TabGroupsApi,
  method: string,
  ctx: ApiContext,
  ...args: unknown[]
): Promise<unknown> => await api.tabHandlers[method]!(ctx, ...args)

describe('chrome.tabGroups host', () => {
  it('requires the tabGroups permission for the tabGroups namespace only', async () => {
    const h = harness()
    h.load(EXT_A, ['tabs'])
    h.addTab('t1')
    await expect(call(h.api, 'query', h.ctx(EXT_A), {})).rejects.toThrow(ERROR_NO_PERMISSION)
    await expect(call(h.api, 'get', h.ctx(EXT_A), 1)).rejects.toThrow(ERROR_NO_PERMISSION)
    // tabs.group needs no extra permission, as in Chrome.
    const id = await callTabs(h.api, 'group', h.ctx(EXT_A), { tabIds: [h.chromeId('t1')] })
    expect(id).toBe(1)
  })

  it('lists folders as groups in the window of their first tab, empty ones in the current window', async () => {
    const h = harness()
    h.load(EXT_A, ['tabGroups'])
    h.addFolder('f-work', { name: 'Work', color: 'blue' })
    h.addFolder('f-empty', { name: 'Empty' })
    h.addTab('t1')
    h.addTab('t2', { folderId: 'f-work' })
    const groups = (await call(h.api, 'query', h.ctx(EXT_A), {})) as ChromeTabGroup[]
    expect(groups).toEqual([
      { id: 1, collapsed: false, color: 'blue', title: 'Work', windowId: WINDOW_ID, shared: false },
      { id: 2, collapsed: false, color: 'grey', title: 'Empty', windowId: WINDOW_ID, shared: false }
    ])
    expect(await call(h.api, 'query', h.ctx(EXT_A), { title: 'W*' })).toHaveLength(1)
    expect(await call(h.api, 'get', h.ctx(EXT_A), 2)).toMatchObject({ title: 'Empty' })
    await expect(call(h.api, 'get', h.ctx(EXT_A), 9)).rejects.toThrow(groupNotFound(9))
  })

  it('updates title, colour and collapsed state through the folder', async () => {
    const h = harness()
    h.load(EXT_A, ['tabGroups'])
    const f = h.addFolder('f1')
    h.addTab('t1', { folderId: 'f1' })
    // The baseline tick hands the folder its group id, as the router's does on the first load.
    h.tick()
    const updated = (await call(h.api, 'update', h.ctx(EXT_A), 1, {
      title: 'Research',
      color: 'purple',
      collapsed: true
    })) as ChromeTabGroup
    expect(updated).toMatchObject({ title: 'Research', color: 'purple', collapsed: true })
    expect(f).toMatchObject({ name: 'Research', color: 'purple', collapsed: true })
    // Zenium keeps folders named: an empty title becomes the model's default.
    const blank = (await call(h.api, 'update', h.ctx(EXT_A), 1, { title: '' })) as ChromeTabGroup
    expect(blank.title).toBe('Folder')
    await expect(call(h.api, 'update', h.ctx(EXT_A), 1, { color: 'teal' })).rejects.toThrow(
      /Value must be one of/
    )
  })

  it('groups tabs into a new folder, unpinning and re-homing them, and ungroups', async () => {
    const h = harness()
    h.load(EXT_A, ['tabGroups'])
    h.addTab('p1', { pinned: true })
    h.addTab('t1')
    h.addTab('t2')
    h.addTab('e1', { essential: true, spaceId: null })
    const id = (await callTabs(h.api, 'group', h.ctx(EXT_A), {
      tabIds: [h.chromeId('t2'), h.chromeId('p1')]
    })) as number
    expect(id).toBe(1)
    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({ name: 'New Folder', spaceId: 'space-1' })
    expect(h.model.tabs.t2.folderId).toBe(h.created[0].id)
    expect(h.model.tabs.p1.folderId).toBe(h.created[0].id)
    expect(h.model.tabs.p1.pinned).toBe(false)
    expect(h.model.tabs.t1.folderId).toBeNull()
    // Into the existing group by id.
    await callTabs(h.api, 'group', h.ctx(EXT_A), { tabIds: h.chromeId('t1'), groupId: 1 })
    expect(h.model.tabs.t1.folderId).toBe(h.created[0].id)
    await expect(
      callTabs(h.api, 'group', h.ctx(EXT_A), { tabIds: [h.chromeId('e1')] })
    ).rejects.toThrow(ERROR_ESSENTIAL_TAB)
    await expect(
      callTabs(h.api, 'group', h.ctx(EXT_A), { tabIds: [h.chromeId('t1')], groupId: 5 })
    ).rejects.toThrow(groupNotFound(5))
    await expect(
      callTabs(h.api, 'group', h.ctx(EXT_A), {
        tabIds: [h.chromeId('t1')],
        createProperties: { windowId: 99 }
      })
    ).rejects.toThrow(ERROR_CROSS_WINDOW)
    await expect(callTabs(h.api, 'group', h.ctx(EXT_A), { tabIds: [4242] })).rejects.toThrow(
      'No tab with id: 4242.'
    )
    await callTabs(h.api, 'ungroup', h.ctx(EXT_A), [h.chromeId('t1'), h.chromeId('t2')])
    expect(h.model.tabs.t1.folderId).toBeNull()
    expect(h.model.tabs.t2.folderId).toBeNull()
    expect(h.model.tabs.p1.folderId).toBe(h.created[0].id)
    // The folder stays (Zenium keeps empty folders; Chrome would drop the group).
    expect(h.model.folders[h.created[0].id]).toBeDefined()
  })

  it('refuses to make folders in a blank or private window', async () => {
    const h = harness()
    h.load(EXT_A, [])
    ;(h.win as unknown as { localSpace: object }).localSpace = { id: 'win:w1' }
    h.addTab('t1')
    await expect(
      callTabs(h.api, 'group', h.ctx(EXT_A), { tabIds: [h.chromeId('t1')] })
    ).rejects.toThrow(ERROR_LOCAL_WINDOW)
  })

  it('moves a group by placing its tabs one after another inside the space', async () => {
    const h = harness()
    h.load(EXT_A, ['tabGroups'])
    h.addFolder('f1')
    h.addTab('p1', { pinned: true })
    h.addTab('a')
    h.addTab('g1', { folderId: 'f1' })
    h.addTab('b')
    h.addTab('g2', { folderId: 'f1' })
    h.addTab('c')
    h.tick()
    expect(h.order()).toEqual(['p1', 'a', 'g1', 'b', 'g2', 'c'])
    await call(h.api, 'move', h.ctx(EXT_A), 1, { index: -1 })
    expect(h.order()).toEqual(['p1', 'a', 'b', 'c', 'g1', 'g2'])
    await call(h.api, 'move', h.ctx(EXT_A), 1, { index: 0 })
    // Clamped to the regular tabs of the space: after the pinned tab.
    expect(h.order()).toEqual(['p1', 'g1', 'g2', 'a', 'b', 'c'])
    await call(h.api, 'move', h.ctx(EXT_A), 1, { index: 2, windowId: WINDOW_ID })
    expect(h.order()).toEqual(['p1', 'a', 'g1', 'g2', 'b', 'c'])
    await expect(call(h.api, 'move', h.ctx(EXT_A), 1, { index: 0, windowId: 99 })).rejects.toThrow(
      ERROR_MOVE_WINDOW
    )
    await expect(call(h.api, 'move', h.ctx(EXT_A), 1, {})).rejects.toThrow(/index/)
  })

  it('fires onCreated, onUpdated, onMoved and onRemoved for holders from the tick', async () => {
    const h = harness()
    h.load(EXT_A, ['tabGroups'])
    h.load(EXT_B, ['tabs'])
    h.addTab('a')
    h.addTab('b')
    h.tick()
    expect(h.out).toEqual([])
    const id = (await callTabs(h.api, 'group', h.ctx(EXT_B), {
      tabIds: [h.chromeId('b')]
    })) as number
    h.tick()
    expect(h.out.map((o) => [o.extensionId, o.event, (o.args[0] as ChromeTabGroup).id])).toEqual([
      [EXT_A, 'tabGroups.onCreated', id]
    ])
    await call(h.api, 'update', h.ctx(EXT_A), id, { title: 'Later' })
    h.tick()
    expect(h.out.at(-1)).toMatchObject({ event: 'tabGroups.onUpdated', args: [{ title: 'Later' }] })
    await call(h.api, 'move', h.ctx(EXT_A), id, { index: 0 })
    h.tick()
    expect(h.out.at(-1)).toMatchObject({ event: 'tabGroups.onMoved' })
    expect(h.order()).toEqual(['b', 'a'])
    // A new tab shifting the group's index is not a move.
    h.addTab('c')
    h.tick()
    expect(h.out.at(-1)?.event).toBe('tabGroups.onMoved')
    delete h.model.folders[h.created[0].id]
    h.tick()
    expect(h.out.at(-1)).toMatchObject({ event: 'tabGroups.onRemoved', args: [{ id }] })
    // No holder loaded: nothing is fired, the baseline still moves.
    h.out.length = 0
    h.load(EXT_A, [])
    h.addFolder('quiet')
    h.tick()
    expect(h.out).toEqual([])
    h.api.reset()
  })
})
