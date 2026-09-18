/**
 * The `chrome.tabGroups` data model over Zenium's folders (`Folder` in the tab model): Chrome's
 * `TabGroup` shape, the `query` filters, the argument checks of `update` / `move` / `tabs.group`,
 * and the diff of two folder snapshots into `onCreated` / `onUpdated` / `onMoved` / `onRemoved`.
 * Pure; the host module maps folders to group ids and windows.
 */
import type { Folder, FolderColor } from '../../../shared/types'
import { globToRegExp } from './matchPattern'
import { TAB_GROUP_NONE, WINDOW_ID_CURRENT } from './tabs'

export const TAB_GROUP_ID_NONE = TAB_GROUP_NONE

/** Chrome's group palette is Zenium's folder palette, name for name. */
export type TabGroupColor = FolderColor
export const TAB_GROUP_COLORS: readonly TabGroupColor[] = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange'
]

export const ERROR_NO_PERMISSION = "The extension does not have the 'tabGroups' permission."
export const ERROR_NO_TABS = 'No tabs given.'
export const ERROR_GROUP_PARAMS = "Cannot specify 'createProperties' along with a 'groupId'."
export const ERROR_ESSENTIAL_TAB = 'Essential tabs cannot be grouped in Zenium.'
export const ERROR_CROSS_WINDOW = 'Tabs can only be grouped within their own window in Zenium.'
export const ERROR_LOCAL_WINDOW = 'Tabs of a blank or private window cannot be grouped in Zenium.'
export const ERROR_MOVE_WINDOW = 'Groups can only be moved within their own window in Zenium.'

export class TabGroupsError extends Error {}

export function groupNotFound(groupId: number): string {
  return `No group with id: ${groupId}.`
}

export interface ChromeTabGroup {
  id: number
  collapsed: boolean
  color: TabGroupColor
  title: string
  windowId: number
  /** Chrome 137's shared groups; Zenium's folders are local. */
  shared: boolean
}

/** Folder ids to group ids (integers handed out in order of first sight, stable after) and back. */
export class TabGroupIds {
  private readonly byFolder = new Map<string, number>()
  private readonly byGroup = new Map<number, string>()
  private next = 1

  idFor(folderId: string): number {
    let id = this.byFolder.get(folderId)
    if (id === undefined) {
      id = this.next++
      this.byFolder.set(folderId, id)
      this.byGroup.set(id, folderId)
    }
    return id
  }

  folderIdFor(groupId: number): string | undefined {
    return this.byGroup.get(groupId)
  }
}

export function tabGroupFromFolder(folder: Folder, id: number, windowId: number): ChromeTabGroup {
  return {
    id,
    collapsed: folder.collapsed,
    color: folder.color ?? 'grey',
    title: folder.name,
    windowId,
    shared: false
  }
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export interface TabGroupQuery {
  collapsed?: boolean
  color?: TabGroupColor
  shared?: boolean
  title?: string
  windowId?: number
}

function isColor(value: unknown): value is TabGroupColor {
  return typeof value === 'string' && (TAB_GROUP_COLORS as readonly string[]).includes(value)
}

function property(argument: number, name: string, expected: string): TabGroupsError {
  return new TabGroupsError(
    `Invalid value for argument ${argument}. Property '${name}': ${expected}`
  )
}

function record(raw: unknown, argument: number): Record<string, unknown> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw new TabGroupsError(`Invalid value for argument ${argument}. Expected 'object'.`)
  return raw as Record<string, unknown>
}

export function normalizeTabGroupQuery(raw: unknown): TabGroupQuery {
  const q = record(raw, 1)
  const out: TabGroupQuery = {}
  if (q.collapsed !== undefined) {
    if (typeof q.collapsed !== 'boolean') throw property(1, 'collapsed', "Expected 'boolean'.")
    out.collapsed = q.collapsed
  }
  if (q.shared !== undefined) {
    if (typeof q.shared !== 'boolean') throw property(1, 'shared', "Expected 'boolean'.")
    out.shared = q.shared
  }
  if (q.color !== undefined) {
    if (!isColor(q.color)) throw property(1, 'color', colorMessage())
    out.color = q.color
  }
  if (q.title !== undefined) {
    if (typeof q.title !== 'string') throw property(1, 'title', "Expected 'string'.")
    out.title = q.title
  }
  if (q.windowId !== undefined) {
    if (typeof q.windowId !== 'number' || !Number.isInteger(q.windowId))
      throw property(1, 'windowId', "Expected 'integer'.")
    out.windowId = q.windowId
  }
  return out
}

function colorMessage(): string {
  return `Value must be one of ${TAB_GROUP_COLORS.join(', ')}.`
}

/** Chrome's `tabGroups.query` semantics for one group (`title` is a glob, as in `tabs.query`). */
export function tabGroupMatches(
  group: ChromeTabGroup,
  q: TabGroupQuery,
  currentWindowId: number
): boolean {
  if (q.collapsed !== undefined && group.collapsed !== q.collapsed) return false
  if (q.shared !== undefined && group.shared !== q.shared) return false
  if (q.color !== undefined && group.color !== q.color) return false
  if (q.title !== undefined && !globToRegExp(q.title).test(group.title)) return false
  if (q.windowId !== undefined) {
    const wanted = q.windowId === WINDOW_ID_CURRENT ? currentWindowId : q.windowId
    if (group.windowId !== wanted) return false
  }
  return true
}

export interface TabGroupUpdate {
  collapsed?: boolean
  color?: TabGroupColor
  title?: string
}

export function normalizeTabGroupUpdate(raw: unknown): TabGroupUpdate {
  const u = record(raw, 2)
  const out: TabGroupUpdate = {}
  if (u.collapsed !== undefined) {
    if (typeof u.collapsed !== 'boolean') throw property(2, 'collapsed', "Expected 'boolean'.")
    out.collapsed = u.collapsed
  }
  if (u.color !== undefined) {
    if (!isColor(u.color)) throw property(2, 'color', colorMessage())
    out.color = u.color
  }
  if (u.title !== undefined) {
    if (typeof u.title !== 'string') throw property(2, 'title', "Expected 'string'.")
    out.title = u.title
  }
  return out
}

export interface TabGroupMove {
  index: number
  windowId?: number
}

export function normalizeTabGroupMove(raw: unknown): TabGroupMove {
  const m = record(raw, 2)
  if (typeof m.index !== 'number' || !Number.isInteger(m.index))
    throw property(2, 'index', "Expected 'integer'.")
  const out: TabGroupMove = { index: m.index }
  if (m.windowId !== undefined) {
    if (typeof m.windowId !== 'number' || !Number.isInteger(m.windowId))
      throw property(2, 'windowId', "Expected 'integer'.")
    out.windowId = m.windowId
  }
  return out
}

export interface TabsGroupOptions {
  tabIds: number[]
  groupId?: number
  createWindowId?: number
}

/** `tabs.group(options)`: one or more tab ids, into an existing group or a new one. */
export function normalizeTabsGroup(raw: unknown): TabsGroupOptions {
  const o = record(raw, 1)
  const ids = Array.isArray(o.tabIds) ? o.tabIds : o.tabIds === undefined ? [] : [o.tabIds]
  if (ids.length === 0) throw new TabGroupsError(ERROR_NO_TABS)
  for (const id of ids) {
    if (typeof id !== 'number' || !Number.isInteger(id))
      throw property(1, 'tabIds', "Expected 'integer'.")
  }
  const out: TabsGroupOptions = { tabIds: ids as number[] }
  if (o.groupId !== undefined) {
    if (typeof o.groupId !== 'number' || !Number.isInteger(o.groupId))
      throw property(1, 'groupId', "Expected 'integer'.")
    if (o.createProperties !== undefined) throw new TabGroupsError(ERROR_GROUP_PARAMS)
    out.groupId = o.groupId
  }
  if (o.createProperties !== undefined) {
    const create = record(o.createProperties, 1)
    if (create.windowId !== undefined) {
      if (typeof create.windowId !== 'number' || !Number.isInteger(create.windowId))
        throw property(1, 'createProperties.windowId', "Expected 'integer'.")
      out.createWindowId = create.windowId
    }
  }
  return out
}

/** `tabs.ungroup(tabIds)`: one id or a list. */
export function normalizeTabsUngroup(raw: unknown): number[] {
  const ids = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  if (ids.length === 0) throw new TabGroupsError(ERROR_NO_TABS)
  for (const id of ids) {
    if (typeof id !== 'number' || !Number.isInteger(id))
      throw new TabGroupsError("Invalid value for argument 1. Expected 'integer'.")
  }
  return ids as number[]
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface TabGroupSnapshot {
  group: ChromeTabGroup
  /** Chrome index of the group's first tab in its window; -1 for a folder with no tabs. */
  index: number
}

export type TabGroupEvent =
  | { event: 'onCreated'; group: ChromeTabGroup }
  | { event: 'onUpdated'; group: ChromeTabGroup }
  | { event: 'onMoved'; group: ChromeTabGroup }
  | { event: 'onRemoved'; group: ChromeTabGroup }

/**
 * Two snapshots of the folders (keyed by folder id) into Chrome's group events. `onUpdated` is
 * for the visual data (title, colour, collapsed); `onMoved` for a group whose first tab sits at
 * another index of the same window while that window's tab set is unchanged (a creation or a
 * removal elsewhere shifts indices without moving anything, as Chrome sees it).
 */
export function diffTabGroups(
  prev: ReadonlyMap<string, TabGroupSnapshot>,
  next: ReadonlyMap<string, TabGroupSnapshot>,
  sameTabSet: (windowId: number) => boolean
): TabGroupEvent[] {
  const events: TabGroupEvent[] = []
  for (const [folderId, before] of prev) {
    if (!next.has(folderId)) events.push({ event: 'onRemoved', group: before.group })
  }
  for (const [folderId, after] of next) {
    const before = prev.get(folderId)
    if (!before) {
      events.push({ event: 'onCreated', group: after.group })
      continue
    }
    const a = before.group
    const b = after.group
    if (a.windowId !== b.windowId) {
      // Reassigned to another window: Chrome reports that as a removal and a creation.
      events.push({ event: 'onRemoved', group: a }, { event: 'onCreated', group: b })
      continue
    }
    if (a.title !== b.title || a.color !== b.color || a.collapsed !== b.collapsed)
      events.push({ event: 'onUpdated', group: b })
    if (
      before.index !== after.index &&
      before.index >= 0 &&
      after.index >= 0 &&
      sameTabSet(b.windowId)
    )
      events.push({ event: 'onMoved', group: b })
  }
  return events
}
