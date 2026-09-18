import {
  BrowserWindow as ElectronBrowserWindow,
  webContents as electronWebContents,
  type BrowserWindow,
  type WebContents
} from 'electron'
import type { Folder, Tab } from '../../../shared/types'
import { PRIVATE_CONTAINER_ID } from '../../../shared/types'
import type { Browser } from '../../../core/browser'
import type { ZenWindow } from '../../../core/window'
import { essentialsForSpace, tabVisibleIn } from '../../../core/model'
import { TabGroupIds } from '../../../core/extensions/api/tabGroups'
import { type ChromeTab, TAB_GROUP_NONE } from '../../../core/extensions/api/tabs'
import { type ChromeWindow, windowStateFrom } from '../../../core/extensions/api/windows'
import type { ElectronTabView, ElectronTabViewHost } from '../views'
import type { ElectronWindow } from '../window'
import { WINDOW_ID_NONE, type Sender } from './types'

/** Synthetic ids for tabs without a page start here, far above any WebContents id. */
const SYNTHETIC_TAB_ID_BASE = 0x40000000

/**
 * An extension-created `windows.create({ type: 'popup' })` window: one bare `BrowserWindow`
 * showing one page, outside the Zenium tab model.
 */
export interface PopupWindow {
  bw: BrowserWindow
  extensionId: string
  incognito: boolean
}

export interface TabSnapshot {
  chrome: ChromeTab
  zenId: string
  /** BrowserWindow id (the tab's Chrome window). */
  windowId: number
  zoom: number
  url: string
}

/**
 * Maps the Zenium model onto Chrome's: tab ids are WebContents ids (what the engine's native
 * `scripting` / `tabs.sendMessage` use) with synthetic ids for pages that are not loaded, window
 * ids are `BrowserWindow` ids, and each shared tab is assigned to exactly one window.
 */
export class ApiModel {
  private readonly synthetic = new Map<string, number>()
  private readonly byChromeId = new Map<number, string>()
  private readonly assigned = new Map<string, string>()
  readonly popups = new Map<number, PopupWindow>()
  private nextSynthetic = SYNTHETIC_TAB_ID_BASE
  /** Folder ids to `chrome.tabGroups` ids and back. */
  private readonly groupIds = new TabGroupIds()

  constructor(
    private readonly browser: Browser,
    private readonly views: ElectronTabViewHost
  ) {}

  // ---------------------------------------------------------------------------
  // Windows
  // ---------------------------------------------------------------------------

  browserWindowOf(win: ZenWindow | undefined): BrowserWindow | null {
    const host = win?.host as ElectronWindow | undefined
    return host?.alive ? host.win : null
  }

  windowIdOf(win: ZenWindow): number {
    return this.browserWindowOf(win)?.id ?? -1
  }

  zenWindow(windowId: number): ZenWindow | undefined {
    return this.browser.allWindows().find((w) => this.windowIdOf(w) === windowId)
  }

  /** Most recently focused window, the one the user is looking at when nothing has focus. */
  lastFocusedWindow(): ZenWindow | undefined {
    const alive = this.browser.allWindows()
    const focused = alive.find((w) => w.host.isFocused())
    if (focused) return focused
    return [...alive].sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)[0]
  }

  /**
   * Chrome's "current window" for a caller (`WINDOW_ID_CURRENT`, `tabs.query({currentWindow})`):
   * a popup window's own page, the window a document is anchored to or shown in, and for
   * background contexts – a worker or background page has no window – the last focused one.
   */
  currentWindowId(sender: Sender, window: ZenWindow | undefined): number {
    if (sender.kind === 'frame') {
      const popup = this.popupForTabId(sender.webContents.id)
      if (popup) return popup.bw.id
    }
    const win = window ?? this.lastFocusedWindow()
    return win ? this.windowIdOf(win) : WINDOW_ID_NONE
  }

  /** Chrome window ids of everything `windows.getAll` lists, Zenium windows and popups alike. */
  windowIds(): number[] {
    const ids = this.browser
      .allWindows()
      .map((w) => this.windowIdOf(w))
      .filter((id) => id >= 0)
    for (const [id, popup] of this.popups) if (!popup.bw.isDestroyed()) ids.push(id)
    return ids
  }

  windowTypeOf(windowId: number): 'normal' | 'popup' {
    return this.popups.has(windowId) ? 'popup' : 'normal'
  }

  /** A `chrome.windows.Window` for any id we hand out, or null when it is unknown. */
  chromeWindowById(
    windowId: number,
    populate: boolean,
    urls: (tab: Tab) => boolean
  ): ChromeWindow | null {
    const popup = this.popups.get(windowId)
    if (popup) return popup.bw.isDestroyed() ? null : this.chromePopupWindow(popup, populate)
    const win = this.zenWindow(windowId)
    return win ? this.chromeWindow(win, populate, urls) : null
  }

  /**
   * The Zenium window a WebContents belongs to: a tab page's owner, a view attached to a window
   * (the toolbar popup), or the window's own chrome.
   */
  zenWindowForWebContents(wc: WebContents): ZenWindow | undefined {
    const tabId = this.views.tabIdForWebContents(wc)
    if (tabId) {
      const tab = this.tab(tabId)
      if (tab) return this.windowOfTab(tab)
    }
    const owner = ElectronBrowserWindow.fromWebContents(wc)
    if (owner) {
      const win = this.browser.allWindows().find((w) => this.browserWindowOf(w) === owner)
      if (win) return win
    }
    return undefined
  }

  // --- opener bookkeeping (`tabs.create({ openerTabId })`, `tabs.duplicate`) -------------

  private readonly openers = new Map<string, string>()

  setOpener(zenId: string, openerZenId: string | undefined): void {
    if (openerZenId) this.openers.set(zenId, openerZenId)
    else this.openers.delete(zenId)
  }

  chromeWindow(win: ZenWindow, populate: boolean, urls: (tab: Tab) => boolean): ChromeWindow {
    const bw = this.browserWindowOf(win)
    const bounds = bw?.getBounds()
    const record: ChromeWindow = {
      id: bw?.id ?? -1,
      focused: bw?.isFocused() ?? false,
      top: bounds?.y,
      left: bounds?.x,
      width: bounds?.width,
      height: bounds?.height,
      incognito: win.isPrivate,
      type: 'normal',
      state: windowStateFrom({
        minimized: bw?.isMinimized() ?? false,
        fullscreen: bw?.isFullScreen() ?? false,
        maximized: bw?.isMaximized() ?? false
      }),
      alwaysOnTop: bw?.isAlwaysOnTop() ?? false
    }
    if (populate) record.tabs = this.tabsInWindow(win).map((t) => this.chromeTab(t, urls(t)))
    return record
  }

  chromePopupWindow(popup: PopupWindow, populate: boolean): ChromeWindow {
    const bw = popup.bw
    const bounds = bw.isDestroyed() ? undefined : bw.getBounds()
    const record: ChromeWindow = {
      id: bw.id,
      focused: !bw.isDestroyed() && bw.isFocused(),
      top: bounds?.y,
      left: bounds?.x,
      width: bounds?.width,
      height: bounds?.height,
      incognito: popup.incognito,
      type: 'popup',
      state: windowStateFrom({
        minimized: !bw.isDestroyed() && bw.isMinimized(),
        fullscreen: !bw.isDestroyed() && bw.isFullScreen(),
        maximized: !bw.isDestroyed() && bw.isMaximized()
      }),
      alwaysOnTop: !bw.isDestroyed() && bw.isAlwaysOnTop()
    }
    if (populate) {
      const tab = this.popupTab(popup)
      record.tabs = tab ? [tab] : []
    }
    return record
  }

  /** The single tab of an extension popup window. */
  popupTab(popup: PopupWindow): ChromeTab | null {
    if (popup.bw.isDestroyed()) return null
    const wc = popup.bw.webContents
    const bounds = popup.bw.getContentBounds()
    return {
      id: wc.id,
      index: 0,
      windowId: popup.bw.id,
      active: true,
      highlighted: true,
      selected: true,
      pinned: false,
      url: wc.getURL(),
      title: wc.getTitle(),
      status: wc.isLoading() ? 'loading' : 'complete',
      audible: wc.isCurrentlyAudible(),
      mutedInfo: { muted: wc.isAudioMuted() },
      discarded: false,
      frozen: false,
      autoDiscardable: false,
      incognito: popup.incognito,
      groupId: TAB_GROUP_NONE,
      width: bounds.width,
      height: bounds.height
    }
  }

  popupForTabId(tabId: number): PopupWindow | undefined {
    for (const popup of this.popups.values()) {
      if (!popup.bw.isDestroyed() && popup.bw.webContents.id === tabId) return popup
    }
    return undefined
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  /** Every tab of the model, in no particular order (Glance pages included – they are real pages). */
  allTabs(): Tab[] {
    return Object.values(this.browser.state.model.tabs)
  }

  tab(zenId: string): Tab | undefined {
    return this.browser.state.model.tabs[zenId]
  }

  webContentsOf(tab: Tab): WebContents | undefined {
    const view = this.browser.tabs.view(tab.id) as ElectronTabView | undefined
    const wc = view?.webContents
    return wc && !wc.isDestroyed() ? wc : undefined
  }

  chromeTabId(tab: Tab): number {
    const wc = this.webContentsOf(tab)
    if (wc) {
      this.byChromeId.set(wc.id, tab.id)
      return wc.id
    }
    let id = this.synthetic.get(tab.id)
    if (id === undefined) {
      id = this.nextSynthetic++
      this.synthetic.set(tab.id, id)
      this.byChromeId.set(id, tab.id)
    }
    return id
  }

  /** The Zenium tab behind a Chrome tab id (a WebContents id or a synthetic one). */
  zenTab(tabId: number): Tab | undefined {
    const zenId = this.byChromeId.get(tabId)
    if (zenId) {
      const tab = this.tab(zenId)
      if (tab && this.chromeTabId(tab) === tabId) return tab
    }
    const wc = electronWebContents.fromId(tabId)
    if (wc && !wc.isDestroyed()) {
      const owner = this.views.tabIdForWebContents(wc)
      const tab = owner ? this.tab(owner) : undefined
      if (tab) {
        this.byChromeId.set(tabId, tab.id)
        return tab
      }
    }
    return undefined
  }

  forgetTab(zenId: string): void {
    const synthetic = this.synthetic.get(zenId)
    if (synthetic !== undefined) this.byChromeId.delete(synthetic)
    this.synthetic.delete(zenId)
    this.assigned.delete(zenId)
    this.openers.delete(zenId)
    for (const [chromeId, owner] of this.byChromeId)
      if (owner === zenId) this.byChromeId.delete(chromeId)
  }

  // ---------------------------------------------------------------------------
  // Tab groups (Zenium folders)
  // ---------------------------------------------------------------------------

  /** The `chrome.tabGroups` id of a folder, allotted on first sight and stable from then on. */
  groupIdFor(folderId: string): number {
    return this.groupIds.idFor(folderId)
  }

  /** The folder behind a group id; undefined for an unknown id or a folder that is gone. */
  folderForGroup(groupId: number): Folder | undefined {
    const folderId = this.groupIds.folderIdFor(groupId)
    return folderId ? this.browser.state.model.folders[folderId] : undefined
  }

  /** The group a tab is in: its folder, for a regular tab whose folder still exists. */
  groupIdOfTab(tab: Tab): number {
    if (!tab.folderId || tab.pinned || tab.essential) return TAB_GROUP_NONE
    if (!this.browser.state.model.folders[tab.folderId]) return TAB_GROUP_NONE
    return this.groupIdFor(tab.folderId)
  }

  /**
   * The one window a tab belongs to: its own window for local tabs, else the window holding its
   * page, else the window it was last assigned to, else the last focused synced window.
   */
  windowOfTab(tab: Tab): ZenWindow | undefined {
    const windows = this.browser.allWindows()
    if (tab.windowId) {
      const own = windows.find((w) => w.id === tab.windowId)
      if (own) return this.remember(tab, own)
    }
    const owner = this.browser.tabs.ownerOf(tab.id)
    if (owner?.alive) return this.remember(tab, owner)
    const glanceHost = windows.find((w) => w.glance?.tabId === tab.id)
    if (glanceHost) return this.remember(tab, glanceHost)
    const cached = this.assigned.get(tab.id)
    const previous = cached
      ? windows.find((w) => w.id === cached && w.kind === 'synced')
      : undefined
    if (previous) return previous
    const synced = windows.filter((w) => w.kind === 'synced')
    const pick =
      synced.find((w) => w.host.isFocused()) ??
      [...synced].sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)[0] ??
      windows[0]
    return pick ? this.remember(tab, pick) : undefined
  }

  private remember(tab: Tab, win: ZenWindow): ZenWindow {
    this.assigned.set(tab.id, win.id)
    return win
  }

  /** The tabs of a window in Chrome index order: Essentials, then each space in sidebar order. */
  tabsInWindow(win: ZenWindow): Tab[] {
    const m = this.browser.state.model
    const out: Tab[] = []
    const seen = new Set<string>()
    const push = (tab: Tab | undefined): void => {
      if (!tab || seen.has(tab.id)) return
      if (this.windowOfTab(tab) !== win) return
      seen.add(tab.id)
      out.push(tab)
    }
    if (win.localSpace) {
      for (const id of win.localSpace.tabIds) push(m.tabs[id])
    } else {
      for (const tab of essentialsForSpace(m, win.activeSpace(), false)) push(tab)
      for (const space of m.spaces) {
        for (const id of space.tabIds) {
          const tab = m.tabs[id]
          if (tab && tabVisibleIn(tab, win.id)) push(tab)
        }
      }
    }
    if (win.glance) push(m.tabs[win.glance.tabId])
    return out
  }

  isActive(tab: Tab, win: ZenWindow): boolean {
    return win.selectedTabIn(win.activeSpace()) === tab.id
  }

  /** Window and index of a tab; `snapshot()` precomputes these for every tab at once. */
  placementOf(tab: Tab): { win: ZenWindow | undefined; index: number } {
    const win = this.windowOfTab(tab)
    const list = win ? this.tabsInWindow(win) : []
    return {
      win,
      index: Math.max(
        0,
        list.findIndex((t) => t.id === tab.id)
      )
    }
  }

  chromeTab(
    tab: Tab,
    urls: boolean,
    placement: { win: ZenWindow | undefined; index: number } = this.placementOf(tab)
  ): ChromeTab {
    const win = placement.win
    const active = win ? this.isActive(tab, win) : false
    const highlighted =
      active || (win ? this.browser.tabs.visibleTabIds(win).includes(tab.id) : false)
    const view = this.browser.tabs.view(tab.id) as ElectronTabView | undefined
    const bounds = view && !view.isDestroyed() ? view.view.getBounds() : undefined
    const record: ChromeTab = {
      id: this.chromeTabId(tab),
      index: placement.index,
      windowId: win ? this.windowIdOf(win) : -1,
      active,
      highlighted,
      selected: active,
      pinned: tab.pinned || tab.essential,
      status: tab.discarded ? 'unloaded' : tab.loading ? 'loading' : 'complete',
      audible: tab.audible,
      mutedInfo: tab.muted ? { muted: true, reason: 'user' } : { muted: false },
      discarded: tab.discarded,
      frozen: tab.frozen,
      autoDiscardable: true,
      incognito: tab.containerId === PRIVATE_CONTAINER_ID,
      groupId: this.groupIdOfTab(tab),
      lastAccessed: tab.lastActiveAt
    }
    if (bounds) {
      record.width = bounds.width
      record.height = bounds.height
    }
    const opener = this.openers.get(tab.id)
    const openerTab = opener ? this.tab(opener) : undefined
    if (openerTab) record.openerTabId = this.chromeTabId(openerTab)
    if (urls) {
      record.url = tab.url
      record.title = tab.customTitle ?? tab.title
      if (tab.favicon) record.favIconUrl = tab.favicon
    }
    return record
  }

  /** The `BrowserWindow` behind a Chrome window id (a Zenium window or an extension popup window). */
  browserWindowById(windowId: number): BrowserWindow | null {
    const popup = this.popups.get(windowId)
    if (popup) return popup.bw.isDestroyed() ? null : popup.bw
    const win = this.zenWindow(windowId)
    return win ? this.browserWindowOf(win) : null
  }

  /** Id of the focused window, `-1` when Zenium is in the background. */
  focusedWindowId(): number {
    for (const win of this.browser.allWindows()) {
      const bw = this.browserWindowOf(win)
      if (bw?.isFocused()) return bw.id
    }
    for (const [id, popup] of this.popups) {
      if (!popup.bw.isDestroyed() && popup.bw.isFocused()) return id
    }
    return -1
  }

  /** Everything the event differ compares between two ticks (tabs keyed by Zenium id). */
  snapshot(): ModelSnapshot {
    const placements = new Map<string, { win: ZenWindow | undefined; index: number }>()
    const windows = new Map<number, WindowSnapshot>()
    for (const win of this.browser.allWindows()) {
      const windowId = this.windowIdOf(win)
      if (windowId < 0) continue
      const tabs = this.tabsInWindow(win)
      tabs.forEach((tab, index) => placements.set(tab.id, { win, index }))
      const active = tabs.find((tab) => this.isActive(tab, win))
      windows.set(windowId, { order: tabs.map((tab) => tab.id), active: active?.id ?? null })
    }
    for (const [id, popup] of this.popups) {
      if (!popup.bw.isDestroyed()) windows.set(id, { order: [], active: null })
    }
    const tabs = new Map<string, TabSnapshot>()
    for (const tab of this.allTabs()) {
      const chrome = this.chromeTab(tab, true, placements.get(tab.id) ?? this.placementOf(tab))
      tabs.set(tab.id, {
        chrome,
        zenId: tab.id,
        windowId: chrome.windowId,
        zoom: tab.zoom,
        url: tab.url
      })
    }
    return { tabs, windows, focused: this.focusedWindowId() }
  }
}

export interface WindowSnapshot {
  /** Zenium tab ids in Chrome index order (empty for extension popup windows). */
  order: string[]
  active: string | null
}

export interface ModelSnapshot {
  tabs: Map<string, TabSnapshot>
  windows: Map<number, WindowSnapshot>
  /** Chrome id of the focused window, `-1` for none. */
  focused: number
}
