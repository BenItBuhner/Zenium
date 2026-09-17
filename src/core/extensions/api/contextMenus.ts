/**
 * `chrome.contextMenus`, the host-neutral part: Chrome's create / update validation, the per
 * extension item tree, which items apply to a right-click (`menu_manager.cc`,
 * `context_menu_matcher.cc`), the checkbox / radio state changes a click causes and the
 * `OnClickData` the extension receives. Hosts (Electron, Android) own the registry instance and
 * turn `menuItemsFor` into their native menu templates.
 */
import { compileMatchPattern, matchesAnyPattern } from './matchPattern'

export type MenuItemType = 'normal' | 'checkbox' | 'radio' | 'separator'

export type MenuContextType =
  | 'all'
  | 'page'
  | 'frame'
  | 'selection'
  | 'link'
  | 'editable'
  | 'image'
  | 'video'
  | 'audio'
  | 'launcher'
  | 'browser_action'
  | 'page_action'
  | 'action'

export type MenuItemId = string | number

export const MENU_CONTEXT_TYPES: readonly MenuContextType[] = [
  'all',
  'page',
  'frame',
  'selection',
  'link',
  'editable',
  'image',
  'video',
  'audio',
  'launcher',
  'browser_action',
  'page_action',
  'action'
]

/** Chrome's `ACTION_MENU_TOP_LEVEL_LIMIT`: top-level items shown in the toolbar button's menu. */
export const ACTION_MENU_TOP_LEVEL_LIMIT = 6

/** How many characters of the selection Chrome pastes into a `%s` title. */
const MAX_SELECTION_LENGTH = 100

// Chrome's messages (extensions/browser/api/context_menus/context_menus_api_helpers.cc).
export const ERROR_ID_REQUIRED =
  'Extensions using event pages or Service Workers must pass an id parameter to chrome.contextMenus.create'
export const ERROR_ONCLICK_DISALLOWED =
  'Extensions using event pages or Service Workers cannot pass an onclick parameter to chrome.contextMenus.create. Instead, use the chrome.contextMenus.onClicked event.'
export const ERROR_DUPLICATE_ID = 'Cannot create item with duplicate id *'
export const ERROR_CANNOT_FIND_ITEM = 'Cannot find menu item with id *'
export const ERROR_CHECKED =
  'Only items with type "radio" or "checkbox" can be checked or unchecked'
export const ERROR_TITLE_NEEDED = 'All menu items except for separators must have a title'
export const ERROR_PARENTS_MUST_BE_NORMAL = 'Parent items must have type "normal"'
export const ERROR_INVALID_URL_PATTERN = "Invalid url pattern '*'"
export const ERROR_OWN_PARENT = 'Cannot set an item to be its own parent'
export const ERROR_DESCENDANT_PARENT = 'Cannot set a descendant of an item to be its parent'
export const ERROR_INVALID_CONTEXT = 'Invalid value for contexts'
export const ERROR_INVALID_TYPE = 'Invalid value for type'
export const ERROR_TOO_MANY_ITEMS = 'An extension can create a maximum of 1000 menu items'

/** Chrome's per-extension item limit (`kMaxItemsPerExtension`). */
export const MAX_ITEMS_PER_EXTENSION = 1000

export function formatMenuError(template: string, arg: MenuItemId): string {
  return template.replace('*', String(arg))
}

export interface MenuItem {
  id: MenuItemId
  extensionId: string
  type: MenuItemType
  title: string
  checked: boolean
  contexts: Set<MenuContextType>
  visible: boolean
  enabled: boolean
  parentId: MenuItemId | null
  documentUrlPatterns: string[]
  targetUrlPatterns: string[]
  /** Child ids in creation order. */
  children: MenuItemId[]
}

/** `createProperties`, validated (but not yet placed in the tree). */
export interface MenuCreateProperties {
  id?: MenuItemId
  type: MenuItemType
  title?: string
  checked?: boolean
  contexts?: MenuContextType[]
  visible?: boolean
  enabled?: boolean
  parentId?: MenuItemId
  documentUrlPatterns?: string[]
  targetUrlPatterns?: string[]
}

/** `updateProperties`, validated: every field optional, `parentId` null detaches. */
export interface MenuUpdateProperties {
  type?: MenuItemType
  title?: string
  checked?: boolean
  contexts?: MenuContextType[]
  visible?: boolean
  enabled?: boolean
  parentId?: MenuItemId | null
  documentUrlPatterns?: string[]
  targetUrlPatterns?: string[]
}

export class MenuError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MenuError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isMenuItemId(value: unknown): value is MenuItemId {
  return (
    (typeof value === 'string' && value.length > 0) ||
    (typeof value === 'number' && Number.isInteger(value))
  )
}

function readType(raw: unknown): MenuItemType {
  if (raw === undefined) return 'normal'
  if (raw === 'normal' || raw === 'checkbox' || raw === 'radio' || raw === 'separator') return raw
  throw new MenuError(ERROR_INVALID_TYPE)
}

function readContexts(raw: unknown): MenuContextType[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length === 0) throw new MenuError(ERROR_INVALID_CONTEXT)
  const out: MenuContextType[] = []
  for (const value of raw) {
    if (!MENU_CONTEXT_TYPES.includes(value as MenuContextType))
      throw new MenuError(ERROR_INVALID_CONTEXT)
    out.push(value as MenuContextType)
  }
  return out
}

function readPatterns(raw: unknown, key: string): string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new MenuError(`Invalid value for ${key}`)
  const out: string[] = []
  for (const pattern of raw) {
    if (typeof pattern !== 'string' || !compileMatchPattern(pattern)) {
      throw new MenuError(formatMenuError(ERROR_INVALID_URL_PATTERN, String(pattern)))
    }
    out.push(pattern)
  }
  return out
}

function readBoolean(raw: unknown, key: string): boolean | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'boolean') throw new MenuError(`Invalid value for ${key}`)
  return raw
}

function readTitle(raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') throw new MenuError('Invalid value for title')
  return raw
}

/**
 * Validate `contextMenus.create`'s properties. `requiresId` is Chrome's rule for event pages
 * and service workers (MV3, or an MV2 manifest with `persistent: false`).
 */
export function normalizeCreateProperties(
  raw: unknown,
  options: { requiresId: boolean }
): MenuCreateProperties {
  if (!isRecord(raw)) throw new MenuError('Invalid createProperties')
  const out: MenuCreateProperties = { type: readType(raw.type) }
  if (raw.id !== undefined) {
    if (!isMenuItemId(raw.id)) throw new MenuError('Invalid value for id')
    out.id = raw.id
  } else if (options.requiresId) {
    throw new MenuError(ERROR_ID_REQUIRED)
  }
  // The shim replaces the function with `true` on the wire (functions cannot cross to the host).
  if ((raw.onclick === true || typeof raw.onclick === 'function') && options.requiresId) {
    throw new MenuError(ERROR_ONCLICK_DISALLOWED)
  }
  const title = readTitle(raw.title)
  if (title !== undefined) out.title = title
  if (out.type !== 'separator' && !title) throw new MenuError(ERROR_TITLE_NEEDED)
  const checked = readBoolean(raw.checked, 'checked')
  if (checked !== undefined) {
    if (out.type !== 'checkbox' && out.type !== 'radio') throw new MenuError(ERROR_CHECKED)
    out.checked = checked
  }
  const contexts = readContexts(raw.contexts)
  if (contexts) out.contexts = contexts
  const visible = readBoolean(raw.visible, 'visible')
  if (visible !== undefined) out.visible = visible
  const enabled = readBoolean(raw.enabled, 'enabled')
  if (enabled !== undefined) out.enabled = enabled
  if (raw.parentId !== undefined && raw.parentId !== null) {
    if (!isMenuItemId(raw.parentId)) throw new MenuError('Invalid value for parentId')
    out.parentId = raw.parentId
  }
  const documentUrlPatterns = readPatterns(raw.documentUrlPatterns, 'documentUrlPatterns')
  if (documentUrlPatterns) out.documentUrlPatterns = documentUrlPatterns
  const targetUrlPatterns = readPatterns(raw.targetUrlPatterns, 'targetUrlPatterns')
  if (targetUrlPatterns) out.targetUrlPatterns = targetUrlPatterns
  return out
}

/** Validate `contextMenus.update`'s properties. */
export function normalizeUpdateProperties(raw: unknown): MenuUpdateProperties {
  if (!isRecord(raw)) throw new MenuError('Invalid updateProperties')
  const out: MenuUpdateProperties = {}
  if (raw.type !== undefined) out.type = readType(raw.type)
  const title = readTitle(raw.title)
  if (title !== undefined) out.title = title
  const checked = readBoolean(raw.checked, 'checked')
  if (checked !== undefined) out.checked = checked
  const contexts = readContexts(raw.contexts)
  if (contexts) out.contexts = contexts
  const visible = readBoolean(raw.visible, 'visible')
  if (visible !== undefined) out.visible = visible
  const enabled = readBoolean(raw.enabled, 'enabled')
  if (enabled !== undefined) out.enabled = enabled
  if (raw.parentId === null) out.parentId = null
  else if (raw.parentId !== undefined) {
    if (!isMenuItemId(raw.parentId)) throw new MenuError('Invalid value for parentId')
    out.parentId = raw.parentId
  }
  const documentUrlPatterns = readPatterns(raw.documentUrlPatterns, 'documentUrlPatterns')
  if (documentUrlPatterns) out.documentUrlPatterns = documentUrlPatterns
  const targetUrlPatterns = readPatterns(raw.targetUrlPatterns, 'targetUrlPatterns')
  if (targetUrlPatterns) out.targetUrlPatterns = targetUrlPatterns
  return out
}

/** Ids are compared by value; a numeric `1` and the string `'1'` are different items in Chrome. */
export function menuKey(id: MenuItemId): string {
  return typeof id === 'number' ? `n:${id}` : `s:${id}`
}

/** The right-click a menu is being built for, in Chrome's terms. */
export interface MenuClickContext {
  /** The top document's URL. */
  pageUrl: string
  /** The clicked frame's URL when it is a sub-frame; empty for the main frame. */
  frameUrl: string
  frameId: number
  linkUrl: string
  srcUrl: string
  mediaType: 'none' | 'image' | 'video' | 'audio'
  selectionText: string
  editable: boolean
}

/**
 * `OnClickData` as `contextMenus.onClicked` receives it. Optional fields are left out (not set
 * to `undefined`) so the object serialises like Chrome's.
 */
export interface MenuOnClickData {
  menuItemId: MenuItemId
  parentMenuItemId?: MenuItemId
  mediaType?: 'image' | 'video' | 'audio'
  linkUrl?: string
  srcUrl?: string
  pageUrl?: string
  frameUrl?: string
  frameId?: number
  selectionText?: string
  editable: boolean
  wasChecked?: boolean
  checked?: boolean
}

/** One entry of the menu a host shows: the item's state resolved for this click. */
export interface MenuEntry {
  item: MenuItem
  /** The title with `%s` replaced by the selection. */
  title: string
  children: MenuEntry[]
}

/**
 * The items an extension contributes to a right-click, top level first with children nested, in
 * creation order, keeping the items whose contexts and patterns match the click (Chrome's
 * `ContextMenuMatcher`). Parents whose children all fell out still show when they match.
 */
export function menuEntriesFor(
  items: readonly MenuItem[],
  topLevel: readonly MenuItemId[],
  click: MenuClickContext
): MenuEntry[] {
  const byKey = new Map(items.map((item) => [menuKey(item.id), item]))
  const build = (id: MenuItemId): MenuEntry | null => {
    const item = byKey.get(menuKey(id))
    if (!item || !item.visible || !menuItemMatchesClick(item, click)) return null
    const children: MenuEntry[] = []
    for (const childId of item.children) {
      const child = build(childId)
      if (child) children.push(child)
    }
    return { item, title: substituteSelection(item.title, click.selectionText), children }
  }
  const out: MenuEntry[] = []
  for (const id of topLevel) {
    const entry = build(id)
    if (entry) out.push(entry)
  }
  return out
}

/** The items shown in an extension's toolbar-button menu (`action` / `browser_action` contexts). */
export function actionMenuEntriesFor(
  items: readonly MenuItem[],
  topLevel: readonly MenuItemId[],
  manifestVersion: 2 | 3
): MenuEntry[] {
  const byKey = new Map(items.map((item) => [menuKey(item.id), item]))
  const wanted: MenuContextType = manifestVersion === 3 ? 'action' : 'browser_action'
  const build = (id: MenuItemId, top: boolean): MenuEntry | null => {
    const item = byKey.get(menuKey(id))
    if (!item || !item.visible) return null
    if (top && !item.contexts.has('all') && !item.contexts.has(wanted)) {
      if (!(manifestVersion === 2 && item.contexts.has('page_action'))) return null
    }
    const children: MenuEntry[] = []
    for (const childId of item.children) {
      const child = build(childId, false)
      if (child) children.push(child)
    }
    return { item, title: item.title, children }
  }
  const out: MenuEntry[] = []
  for (const id of topLevel) {
    const entry = build(id, true)
    if (entry) out.push(entry)
    if (out.length >= ACTION_MENU_TOP_LEVEL_LIMIT) break
  }
  return out
}

/** `ExtensionContextAndPatternMatch` plus the document pattern check of `MenuItemMatchesParams`. */
export function menuItemMatchesClick(item: MenuItem, click: MenuClickContext): boolean {
  const documentUrl = click.frameUrl || click.pageUrl
  if (!patternsMatch(item.documentUrlPatterns, documentUrl)) return false
  const c = item.contexts
  const hasLink = click.linkUrl !== ''
  const hasSelection = click.selectionText !== ''
  const inSubframe = click.frameUrl !== ''
  if (c.has('all')) return true
  if (hasSelection && c.has('selection')) return true
  if (click.editable && c.has('editable')) return true
  if (inSubframe && c.has('frame')) return true
  if (hasLink && c.has('link') && patternsMatch(item.targetUrlPatterns, click.linkUrl)) return true
  if (
    click.mediaType === 'image' &&
    c.has('image') &&
    patternsMatch(item.targetUrlPatterns, click.srcUrl)
  )
    return true
  if (
    click.mediaType === 'video' &&
    c.has('video') &&
    patternsMatch(item.targetUrlPatterns, click.srcUrl)
  )
    return true
  if (
    click.mediaType === 'audio' &&
    c.has('audio') &&
    patternsMatch(item.targetUrlPatterns, click.srcUrl)
  )
    return true
  // `page` is the least specific context: only when nothing more specific applies.
  return !hasLink && !hasSelection && !click.editable && click.mediaType === 'none' && c.has('page')
}

function patternsMatch(patterns: readonly string[], url: string): boolean {
  if (patterns.length === 0) return true
  if (!url) return false
  return matchesAnyPattern(url, patterns)
}

/** Chrome's title substitution: `%s` becomes the (trimmed, shortened) selection. */
export function substituteSelection(title: string, selectionText: string): string {
  if (!title.includes('%s')) return title
  let selection = selectionText.replace(/\s+/g, ' ').trim()
  if (selection.length > MAX_SELECTION_LENGTH) {
    selection = `${selection.slice(0, MAX_SELECTION_LENGTH)}\u2026`
  }
  return title.replace(/%s/g, selection)
}

/**
 * The per-extension item store. Mutations validate against Chrome's rules; hosts persist nothing
 * (Chrome only keeps items across restarts for event pages, which recreate them on `onInstalled`
 * anyway; MV3 workers do the same).
 */
export class MenuRegistry {
  private readonly items = new Map<string, MenuItem>()
  private readonly topLevel: MenuItemId[] = []
  private nextGeneratedId = 1

  constructor(readonly extensionId: string) {}

  all(): MenuItem[] {
    return [...this.items.values()]
  }

  topLevelIds(): MenuItemId[] {
    return [...this.topLevel]
  }

  get(id: MenuItemId): MenuItem | undefined {
    return this.items.get(menuKey(id))
  }

  get size(): number {
    return this.items.size
  }

  /** Add an item; returns the item with its (given or generated) id. */
  create(props: MenuCreateProperties): MenuItem {
    if (this.items.size >= MAX_ITEMS_PER_EXTENSION) throw new MenuError(ERROR_TOO_MANY_ITEMS)
    const id = props.id ?? this.generateId()
    if (this.items.has(menuKey(id))) throw new MenuError(formatMenuError(ERROR_DUPLICATE_ID, id))
    let parent: MenuItem | null = null
    if (props.parentId !== undefined) {
      parent = this.require(props.parentId)
      if (parent.type !== 'normal') throw new MenuError(ERROR_PARENTS_MUST_BE_NORMAL)
    }
    const item: MenuItem = {
      id,
      extensionId: this.extensionId,
      type: props.type,
      title: props.title ?? '',
      checked: props.checked ?? false,
      contexts: new Set(props.contexts ?? ['page']),
      visible: props.visible ?? true,
      enabled: props.enabled ?? true,
      parentId: parent ? parent.id : null,
      documentUrlPatterns: props.documentUrlPatterns ?? [],
      targetUrlPatterns: props.targetUrlPatterns ?? [],
      children: []
    }
    this.items.set(menuKey(id), item)
    if (parent) parent.children.push(id)
    else this.topLevel.push(id)
    if (item.type === 'radio' && item.checked) this.uncheckOtherRadios(item)
    return item
  }

  update(id: MenuItemId, props: MenuUpdateProperties): MenuItem {
    const item = this.require(id)
    const type = props.type ?? item.type
    const checked = props.checked ?? item.checked
    if (props.checked !== undefined && type !== 'checkbox' && type !== 'radio') {
      throw new MenuError(ERROR_CHECKED)
    }
    if (type !== 'separator' && !(props.title ?? item.title))
      throw new MenuError(ERROR_TITLE_NEEDED)
    if (type !== 'normal' && item.children.length > 0)
      throw new MenuError(ERROR_PARENTS_MUST_BE_NORMAL)
    if (props.parentId !== undefined) this.reparent(item, props.parentId)
    item.type = type
    if (props.title !== undefined) item.title = props.title
    item.checked = type === 'checkbox' || type === 'radio' ? checked : false
    if (props.contexts) item.contexts = new Set(props.contexts)
    if (props.visible !== undefined) item.visible = props.visible
    if (props.enabled !== undefined) item.enabled = props.enabled
    if (props.documentUrlPatterns) item.documentUrlPatterns = props.documentUrlPatterns
    if (props.targetUrlPatterns) item.targetUrlPatterns = props.targetUrlPatterns
    if (item.type === 'radio' && item.checked) this.uncheckOtherRadios(item)
    return item
  }

  /** Remove an item and its descendants; returns the removed ids. */
  remove(id: MenuItemId): MenuItemId[] {
    const item = this.require(id)
    const removed: MenuItemId[] = []
    const drop = (target: MenuItem): void => {
      for (const childId of target.children) {
        const child = this.items.get(menuKey(childId))
        if (child) drop(child)
      }
      this.items.delete(menuKey(target.id))
      removed.push(target.id)
    }
    drop(item)
    this.detach(item)
    return removed
  }

  removeAll(): void {
    this.items.clear()
    this.topLevel.length = 0
  }

  /**
   * The user picked an item: checkboxes toggle, a radio item becomes the checked one of its
   * group (`MenuManager::RadioItemSelected`). Returns the state for `OnClickData`.
   */
  clicked(id: MenuItemId): { wasChecked: boolean; checked: boolean } | null {
    const item = this.get(id)
    if (!item) return null
    const wasChecked = item.checked
    if (item.type === 'checkbox') {
      item.checked = !wasChecked
    } else if (item.type === 'radio') {
      item.checked = true
      this.uncheckOtherRadios(item)
    }
    return { wasChecked, checked: item.checked }
  }

  private generateId(): number {
    while (this.items.has(menuKey(this.nextGeneratedId))) this.nextGeneratedId += 1
    return this.nextGeneratedId++
  }

  private require(id: MenuItemId): MenuItem {
    const item = this.items.get(menuKey(id))
    if (!item) throw new MenuError(formatMenuError(ERROR_CANNOT_FIND_ITEM, id))
    return item
  }

  private siblings(item: MenuItem): MenuItemId[] {
    if (item.parentId === null) return this.topLevel
    return this.items.get(menuKey(item.parentId))?.children ?? this.topLevel
  }

  private detach(item: MenuItem): void {
    const list = this.siblings(item)
    const index = list.findIndex((id) => menuKey(id) === menuKey(item.id))
    if (index >= 0) list.splice(index, 1)
  }

  private reparent(item: MenuItem, parentId: MenuItemId | null): void {
    if (parentId === null) {
      if (item.parentId === null) return
      this.detach(item)
      item.parentId = null
      this.topLevel.push(item.id)
      return
    }
    if (menuKey(parentId) === menuKey(item.id)) throw new MenuError(ERROR_OWN_PARENT)
    const parent = this.require(parentId)
    if (parent.type !== 'normal') throw new MenuError(ERROR_PARENTS_MUST_BE_NORMAL)
    for (let cursor: MenuItem | undefined = parent; cursor;) {
      if (cursor.parentId === null) break
      if (menuKey(cursor.parentId) === menuKey(item.id))
        throw new MenuError(ERROR_DESCENDANT_PARENT)
      cursor = this.items.get(menuKey(cursor.parentId))
    }
    if (item.parentId !== null && menuKey(item.parentId) === menuKey(parent.id)) return
    this.detach(item)
    item.parentId = parent.id
    parent.children.push(item.id)
  }

  /** A radio group is a run of consecutive radio items among the siblings. */
  private uncheckOtherRadios(item: MenuItem): void {
    const list = this.siblings(item)
    const index = list.findIndex((id) => menuKey(id) === menuKey(item.id))
    if (index < 0) return
    const walk = (step: number): void => {
      for (let i = index + step; i >= 0 && i < list.length; i += step) {
        const sibling = this.items.get(menuKey(list[i]))
        if (!sibling || sibling.type !== 'radio') break
        sibling.checked = false
      }
    }
    walk(-1)
    walk(1)
  }
}

/** Build `OnClickData` for a click on `item`. */
export function onClickData(
  item: MenuItem,
  click: MenuClickContext,
  checkState: { wasChecked: boolean; checked: boolean } | null
): MenuOnClickData {
  const info: MenuOnClickData = { menuItemId: item.id, editable: click.editable }
  if (item.parentId !== null) info.parentMenuItemId = item.parentId
  if (click.mediaType !== 'none') info.mediaType = click.mediaType
  if (click.linkUrl) info.linkUrl = click.linkUrl
  if (click.srcUrl) info.srcUrl = click.srcUrl
  if (click.pageUrl) info.pageUrl = click.pageUrl
  if (click.frameUrl) info.frameUrl = click.frameUrl
  info.frameId = click.frameId
  if (click.selectionText) info.selectionText = click.selectionText
  if (checkState && (item.type === 'checkbox' || item.type === 'radio')) {
    info.wasChecked = checkState.wasChecked
    info.checked = checkState.checked
  }
  return info
}
