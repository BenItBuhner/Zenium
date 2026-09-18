import type { Point, Rect } from '../shared/types'
import type { Browser } from './browser'
import type { ZenWindow } from './window'

interface DragSession {
  tabId: string
  source: ZenWindow
  /** The other window under the pointer, once it left the source window's sidebar. */
  target: ZenWindow | null
  /** The drop target the target window's chrome last reported under the pointer. */
  targetKey: string | null
}

/**
 * A sidebar tab drag as the core sees it: the window it started in, the other window the pointer
 * is over and what that window says lies under it. The source chrome keeps the pointer (its
 * document captured it on press), so a target chrome only learns about the drag from here
 * (`tab.dragOver`, with the pointer in its own coordinates) and answers with the drop target it
 * finds (`tab.dragTarget`). On release the tab moves into the target window or, with no window
 * under the pointer, tears off into a new window at that spot.
 */
export class TabDragController {
  private session: DragSession | null = null

  constructor(private readonly browser: Browser) {}

  /** Whether `tabId` is being dragged right now (the target chrome asks before it reports). */
  dragging(tabId: string): boolean {
    return this.session?.tabId === tabId
  }

  start(tabId: string, source: ZenWindow): void {
    if (this.session) this.clearTarget(this.session)
    this.session = { tabId, source, target: null, targetKey: null }
  }

  move(tabId: string, x: number, y: number, inSidebar: boolean, source: ZenWindow): void {
    const session = this.session
    if (!session || session.tabId !== tabId || session.source !== source) return
    const point = this.toScreen(source, x, y)
    const target = inSidebar || !point ? null : this.windowAt(point, tabId, source)
    if (target !== session.target) {
      this.clearTarget(session)
      session.target = target
    }
    if (!target || !point) return
    const local = this.toChrome(target, point)
    const tab = this.browser.tabs.tab(tabId)
    if (!local || !tab) return
    target.send('tab.dragOver', {
      tabId,
      title: tab.customTitle ?? tab.title,
      favicon: tab.favicon,
      x: local.x,
      y: local.y
    })
  }

  /** The hovered window found `key` (a `data-drop`) under the pointer, or nothing. */
  setTarget(tabId: string, key: string | null, win: ZenWindow): void {
    const session = this.session
    if (!session || session.tabId !== tabId || session.target !== win) return
    session.targetKey = key
  }

  end(tabId: string, x: number, y: number, outcome: 'release' | 'cancel', source: ZenWindow): void {
    const session = this.session
    if (!session || session.tabId !== tabId || session.source !== source) return
    this.session = null
    const { target, targetKey } = session
    this.clearTarget(session)
    if (outcome === 'cancel') return
    const point = this.toScreen(source, x, y)
    const tabs = this.browser.tabs
    if (target && point && this.windowAt(point, tabId, source) === target) {
      tabs.moveTabToWindow(tabId, target, targetKey, source)
      return
    }
    tabs.moveTabToNewWindow(tabId, point, source)
  }

  /** A window went away mid-drag: the drag ends with its source, or loses it as target. */
  onWindowClosed(win: ZenWindow): void {
    const session = this.session
    if (!session) return
    if (session.source === win) {
      this.session = null
      this.clearTarget(session)
    } else if (session.target === win) {
      session.target = null
      session.targetKey = null
    }
  }

  private clearTarget(session: DragSession): void {
    if (session.target?.alive) session.target.send('tab.dragOver', null)
    session.target = null
    session.targetKey = null
  }

  private toScreen(win: ZenWindow, x: number, y: number): Point | null {
    const bounds = win.alive ? win.host.contentBounds?.() : null
    return bounds ? { x: bounds.x + x, y: bounds.y + y } : null
  }

  private toChrome(win: ZenWindow, point: Point): Point | null {
    const bounds = win.alive ? win.host.contentBounds?.() : null
    return bounds ? { x: point.x - bounds.x, y: point.y - bounds.y } : null
  }

  /**
   * The window that would take the tab at a screen point. Hosts do not report the stacking
   * order: the source window has the pointer (the user pressed in it) and counts as topmost
   * wherever it is, and of the other windows under the point the most recently focused wins.
   */
  private windowAt(point: Point, tabId: string, source: ZenWindow): ZenWindow | null {
    const sourceBounds = source.alive ? source.host.contentBounds?.() : null
    if (sourceBounds && contains(sourceBounds, point)) return null
    const tab = this.browser.tabs.tab(tabId)
    if (!tab) return null
    return (
      this.browser
        .allWindows()
        .filter((w) => {
          if (!this.browser.tabs.canMoveToWindow(tab, w, source)) return false
          const bounds = w.host.contentBounds?.()
          return bounds !== null && bounds !== undefined && contains(bounds, point)
        })
        .sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)[0] ?? null
    )
  }
}

/** A sidebar drop target, as the chrome names it in a `data-drop` attribute. */
export type DropKey =
  | { kind: 'tab'; tabId: string; after: boolean }
  | { kind: 'section'; section: string; spaceId: string }
  | { kind: 'folder'; folderId: string }
  | { kind: 'space'; spaceId: string }
  | { kind: 'split'; side: string }
  | { kind: 'bookmark'; folderId: string; index: number | null }

/**
 * Parse a drop key. Ids may contain colons (a blank window's local space is `win:<windowId>`),
 * so only the kind and the fixed trailing part are split off; the id is whatever lies between.
 */
export function parseDropKey(key: string): DropKey | null {
  const at = key.indexOf(':')
  if (at === -1) return null
  const kind = key.slice(0, at)
  const rest = key.slice(at + 1)
  switch (kind) {
    case 'tab': {
      const last = rest.lastIndexOf(':')
      if (last === -1) return null
      const position = rest.slice(last + 1)
      if (position !== 'before' && position !== 'after') return null
      const tabId = rest.slice(0, last)
      return tabId ? { kind, tabId, after: position === 'after' } : null
    }
    case 'section': {
      const next = rest.indexOf(':')
      if (next === -1) return null
      const section = rest.slice(0, next)
      return section ? { kind, section, spaceId: rest.slice(next + 1) } : null
    }
    case 'folder':
      return rest ? { kind, folderId: rest } : null
    case 'space':
      return rest ? { kind, spaceId: rest } : null
    case 'split':
      return rest ? { kind, side: rest } : null
    case 'bookmark': {
      const last = rest.lastIndexOf(':')
      if (last === -1) return null
      const folderId = rest.slice(0, last)
      const index = rest.slice(last + 1)
      if (!folderId) return null
      if (index === '') return { kind, folderId, index: null }
      const n = Number(index)
      return Number.isInteger(n) && n >= 0 ? { kind, folderId, index: n } : null
    }
  }
  return null
}

export function contains(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  )
}
