import type { Folder, Tab } from '../../../shared/types'
import type { ZenWindow } from '../../../core/window'
import { TAB_GROUP_NONE } from '../../../core/extensions/api/tabs'
import {
  ERROR_CROSS_WINDOW,
  ERROR_ESSENTIAL_TAB,
  ERROR_LOCAL_WINDOW,
  ERROR_MOVE_WINDOW,
  ERROR_NO_PERMISSION,
  TabGroupsError,
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
} from '../../../core/extensions/api/tabGroups'
import type { ModelSnapshot } from './model'
import {
  ApiError,
  WINDOW_ID_CURRENT,
  isInteger,
  type ApiContext,
  type ApiHost,
  type LoadedExtension,
  type NamespaceHandlers
} from './types'

/** The folder a `tabs.group` call makes when no group is named, as Zenium's own gesture does. */
const NEW_FOLDER_NAME = 'New Folder'
const NEW_FOLDER_ICON = '📁'

/**
 * `chrome.tabGroups` over Zenium's folders (the tab model, owned by the tabs program): a folder
 * is a group, its name the title, its colour the group colour (the two palettes are the same),
 * its collapsed flag the group's. Group ids are handed out per folder by the model mapper; a
 * group's window is the one holding its first tab. `tabs.group` / `tabs.ungroup` move tabs into
 * and out of folders. Events come from diffing the folders on every tick.
 */
export class TabGroupsApi {
  private snapshot: Map<string, TabGroupSnapshot> | null = null
  /**
   * Folders made by `tabs.group`. A Chrome group ends with its last tab; a folder the user made
   * is theirs to keep, but one an extension created for a group goes when it empties, so the
   * sidebar is not left with the extension's "New Folder" shells.
   */
  private readonly created = new Set<string>()

  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = {
    get: (ctx, groupId) => this.get(ctx, groupId),
    query: (ctx, info) => this.query(ctx, info),
    update: (ctx, groupId, props) => this.update(ctx, groupId, props),
    move: (ctx, groupId, props) => this.move(ctx, groupId, props)
  }

  /** The `tabs` namespace's half: registered by the router under `tabs.group` / `tabs.ungroup`. */
  readonly tabHandlers: NamespaceHandlers = {
    group: (ctx, options) => this.group(ctx, options),
    ungroup: (ctx, tabIds) => this.ungroup(ctx, tabIds)
  }

  private get model(): ApiHost['model'] {
    return this.host.model
  }

  private requirePermission(ext: LoadedExtension): void {
    if (!hasTabGroups(this.host, ext)) throw new ApiError(ERROR_NO_PERMISSION)
  }

  // ---------------------------------------------------------------------------
  // Folders as groups
  // ---------------------------------------------------------------------------

  private folderById(groupId: unknown): Folder {
    if (!isInteger(groupId)) throw new ApiError('Invalid group id')
    const folder = this.model.folderForGroup(groupId)
    if (!folder) throw new ApiError(groupNotFound(groupId))
    return folder
  }

  /** Window (Chrome id) and index of the first tab of every folder that has one, live. */
  private liveOrders(): Array<[number, string[]]> {
    const orders: Array<[number, string[]]> = []
    for (const win of this.host.browser.allWindows()) {
      const windowId = this.model.windowIdOf(win)
      if (windowId < 0) continue
      orders.push([windowId, this.model.tabsInWindow(win).map((tab) => tab.id)])
    }
    return orders
  }

  /**
   * Every folder as a group snapshot. A folder holding tabs sits in the window of its first
   * tab; an empty one (Zenium keeps those, Chrome would not) is shown in a window looking at its
   * space, else the last focused window, and is left out when there is no window at all.
   */
  private snapshotFrom(
    orders: Iterable<[number, readonly string[]]>
  ): Map<string, TabGroupSnapshot> {
    const placed = new Map<string, { windowId: number; index: number }>()
    for (const [windowId, order] of orders) {
      order.forEach((zenId, index) => {
        const tab = this.model.tab(zenId)
        if (!tab || !tab.folderId || placed.has(tab.folderId)) return
        if (this.model.groupIdOfTab(tab) === TAB_GROUP_NONE) return
        placed.set(tab.folderId, { windowId, index })
      })
    }
    const out = new Map<string, TabGroupSnapshot>()
    for (const folder of Object.values(this.host.browser.state.model.folders)) {
      const position = placed.get(folder.id) ?? {
        windowId: this.fallbackWindowId(folder),
        index: -1
      }
      if (position.windowId < 0) continue
      out.set(folder.id, {
        group: tabGroupFromFolder(folder, this.model.groupIdFor(folder.id), position.windowId),
        index: position.index
      })
    }
    return out
  }

  private fallbackWindowId(folder: Folder): number {
    const windows = this.host.browser.allWindows().filter((w) => this.model.windowIdOf(w) >= 0)
    const showing = windows.find((w) => w.activeSpace().id === folder.spaceId)
    const win = showing ?? this.model.lastFocusedWindow()
    return win ? this.model.windowIdOf(win) : -1
  }

  private groupOf(folder: Folder): ChromeTabGroup {
    const found = this.snapshotFrom(this.liveOrders()).get(folder.id)
    if (found) return found.group
    return tabGroupFromFolder(folder, this.model.groupIdFor(folder.id), -1)
  }

  /** The folder's tabs in the Chrome order of their window (`win` when given). */
  private members(folder: Folder, win?: ZenWindow): Tab[] {
    const id = this.model.groupIdFor(folder.id)
    const inGroup = (tab: Tab): boolean => this.model.groupIdOfTab(tab) === id
    if (win) return this.model.tabsInWindow(win).filter(inGroup)
    const out: Tab[] = []
    for (const w of this.host.browser.allWindows()) {
      for (const tab of this.model.tabsInWindow(w)) if (inGroup(tab)) out.push(tab)
    }
    return out
  }

  // ---------------------------------------------------------------------------
  // chrome.tabGroups
  // ---------------------------------------------------------------------------

  private get(ctx: ApiContext, groupId: unknown): ChromeTabGroup {
    this.requirePermission(ctx.extension)
    return this.groupOf(this.folderById(groupId))
  }

  private query(ctx: ApiContext, raw: unknown): ChromeTabGroup[] {
    this.requirePermission(ctx.extension)
    const q = checked(() => normalizeTabGroupQuery(raw))
    const current = this.model.currentWindowId(ctx.sender, ctx.window)
    return [...this.snapshotFrom(this.liveOrders()).values()]
      .map((s) => s.group)
      .filter((group) => tabGroupMatches(group, q, current))
  }

  private update(ctx: ApiContext, groupId: unknown, raw: unknown): ChromeTabGroup {
    this.requirePermission(ctx.extension)
    const folder = this.folderById(groupId)
    const changes = checked(() => normalizeTabGroupUpdate(raw))
    const patch: Partial<Pick<Folder, 'name' | 'collapsed' | 'color'>> = {}
    if (changes.title !== undefined) patch.name = changes.title
    if (changes.collapsed !== undefined) patch.collapsed = changes.collapsed
    if (changes.color !== undefined) patch.color = changes.color
    if (Object.keys(patch).length > 0) this.host.browser.updateFolder(folder.id, patch)
    return this.groupOf(folder)
  }

  /**
   * Move a group to a Chrome index of its window: its tabs land there as one block, the first
   * at the index (`-1` for the end), as Chrome's tab strip does. The target is kept inside the
   * regular tabs of the folder's space, since a tab leaving its space leaves its folder too.
   * Empty folders and folders whose tabs are the whole of their space's regular section have
   * nothing to reorder.
   */
  private move(ctx: ApiContext, groupId: unknown, raw: unknown): ChromeTabGroup {
    this.requirePermission(ctx.extension)
    const folder = this.folderById(groupId)
    const target = checked(() => normalizeTabGroupMove(raw))
    const group = this.groupOf(folder)
    if (
      target.windowId !== undefined &&
      target.windowId !== WINDOW_ID_CURRENT &&
      target.windowId !== group.windowId
    ) {
      throw new ApiError(ERROR_MOVE_WINDOW)
    }
    const win = this.model.zenWindow(group.windowId)
    if (!win) return group
    const members = this.members(folder, win)
    if (members.length === 0) return group
    const memberIds = new Set(members.map((tab) => tab.id))
    const others = this.model.tabsInWindow(win).filter((tab) => !memberIds.has(tab.id))
    const inSpace = (tab: Tab): boolean =>
      !tab.essential && !tab.pinned && tab.spaceId === folder.spaceId
    const first = others.findIndex(inSpace)
    if (first < 0) return group
    let last = first
    while (last < others.length && inSpace(others[last])) last += 1
    const wanted = target.index < 0 ? others.length : target.index
    // How many of the space's other regular tabs come before the block.
    const sectionIndex = Math.max(first, Math.min(wanted, last)) - first
    const manager = this.host.browser.tabs
    const place = (tab: Tab, index: number): void =>
      manager.moveTab(tab.id, { spaceId: folder.spaceId, section: 'regular', index }, win)
    // Out of the way first, so a member still to be placed never shifts one already placed.
    for (const tab of members) place(tab, Number.MAX_SAFE_INTEGER)
    members.forEach((tab, i) => place(tab, sectionIndex + i))
    return this.groupOf(folder)
  }

  // ---------------------------------------------------------------------------
  // chrome.tabs.group / ungroup
  // ---------------------------------------------------------------------------

  private tabById(tabId: number): Tab {
    const tab = this.model.zenTab(tabId)
    if (!tab) throw new ApiError(`No tab with id: ${tabId}.`)
    return tab
  }

  private group(_ctx: ApiContext, raw: unknown): number {
    const options = checked(() => normalizeTabsGroup(raw))
    const tabs = options.tabIds.map((id) => this.tabById(id))
    if (tabs.some((tab) => tab.essential)) throw new ApiError(ERROR_ESSENTIAL_TAB)
    const windows = tabs.map((tab) => this.model.windowOfTab(tab))
    const win = windows[0]
    if (!win || windows.some((w) => w !== win)) throw new ApiError(ERROR_CROSS_WINDOW)
    let folder: Folder
    if (options.groupId !== undefined) {
      folder = this.folderById(options.groupId)
      const groupWindow = this.groupOf(folder).windowId
      if (groupWindow >= 0 && groupWindow !== this.model.windowIdOf(win))
        throw new ApiError(ERROR_CROSS_WINDOW)
    } else {
      if (
        options.createWindowId !== undefined &&
        options.createWindowId !== WINDOW_ID_CURRENT &&
        options.createWindowId !== this.model.windowIdOf(win)
      ) {
        throw new ApiError(ERROR_CROSS_WINDOW)
      }
      // A blank or private window's space is never persisted; a folder in it would be orphaned.
      if (win.localSpace) throw new ApiError(ERROR_LOCAL_WINDOW)
      const spaceId = tabs[0].spaceId ?? win.activeSpace().id
      folder = this.host.browser.createFolder(spaceId, NEW_FOLDER_NAME, NEW_FOLDER_ICON, win, {
        rename: false
      })
      this.created.add(folder.id)
    }
    const { tabs: manager } = this.host.browser
    for (const tab of tabs) {
      // A folder lives in one space and holds regular tabs: a pinned tab is unpinned (as Chrome
      // does when grouping one) and a tab of another space joins the folder's.
      if (tab.spaceId !== folder.spaceId || tab.pinned) {
        manager.moveTab(
          tab.id,
          { spaceId: folder.spaceId, section: 'regular', index: Number.MAX_SAFE_INTEGER },
          win
        )
      }
      manager.moveToFolder(tab.id, folder.id)
    }
    return this.model.groupIdFor(folder.id)
  }

  private ungroup(_ctx: ApiContext, raw: unknown): void {
    const ids = checked(() => normalizeTabsUngroup(raw))
    const tabs = ids.map((id) => this.tabById(id))
    for (const tab of tabs) {
      if (tab.folderId) this.host.browser.tabs.moveToFolder(tab.id, null)
    }
    this.dropEmptied()
  }

  /** Extension-made folders with no tab left (ungrouped, closed or moved away) are removed. */
  private dropEmptied(): void {
    const model = this.host.browser.state.model
    for (const folderId of this.created) {
      if (!model.folders[folderId]) {
        this.created.delete(folderId)
        continue
      }
      if (Object.values(model.tabs).some((tab) => tab.folderId === folderId)) continue
      this.created.delete(folderId)
      this.host.browser.deleteFolder(folderId, true)
    }
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  /** Called from the router's tick with the tab snapshots it just compared. */
  tick(prev: ModelSnapshot | null, next: ModelSnapshot): void {
    // Tabs closed or moved out from under an extension's group: the folder goes on this tick,
    // and the next one reports `onRemoved`.
    if (this.created.size > 0) this.dropEmptied()
    const orders: Array<[number, readonly string[]]> = []
    for (const [windowId, win] of next.windows) orders.push([windowId, win.order])
    const current = this.snapshotFrom(orders)
    const previous = this.snapshot
    this.snapshot = current
    if (!previous || !prev) return
    if (!this.host.allLoaded().some((ext) => hasTabGroups(this.host, ext))) return
    const sameTabSet = (windowId: number): boolean => {
      const before = prev.windows.get(windowId)?.order
      const after = next.windows.get(windowId)?.order
      if (!before || !after || before.length !== after.length) return false
      const known = new Set(before)
      return after.every((id) => known.has(id))
    }
    for (const change of diffTabGroups(previous, current, sameTabSet)) {
      this.host.broadcast('tabGroups', change.event, (ext) =>
        hasTabGroups(this.host, ext) ? [change.group] : null
      )
    }
  }

  reset(): void {
    this.snapshot = null
  }
}

function hasTabGroups(host: ApiHost, ext: LoadedExtension): boolean {
  return host.grants(ext.id).permissions.includes('tabGroups')
}

function checked<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof TabGroupsError) throw new ApiError(error.message)
    throw error
  }
}
