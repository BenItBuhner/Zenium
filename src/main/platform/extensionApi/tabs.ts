import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Tab, TabSection } from '../../../shared/types'
import { BLANK_URL, isNavigableUrl } from '../../../shared/url'
import type { ZenWindow } from '../../../core/window'
import {
  type ChromeTab,
  type TabChangeInfo,
  type TabQueryInfo,
  detectTabMoves,
  tabChangeInfo,
  tabMatchesQuery
} from '../../../core/extensions/api/tabs'
import type { ModelSnapshot, TabSnapshot } from './model'
import {
  ApiError,
  WINDOW_ID_CURRENT,
  WINDOW_ID_NONE,
  extensionUrl,
  isInteger,
  isRecord,
  type ApiContext,
  type ApiHost,
  type LoadedExtension,
  type NamespaceHandlers
} from './types'

/** Chrome refuses these in `tabs.create` / `tabs.update`. */
const FORBIDDEN_URL = /^\s*(javascript|chrome|devtools|about):/i

/**
 * `chrome.tabs` over the Zenium tab model. Tab ids are WebContents ids (what the engine's native
 * `scripting` and `tabs.sendMessage` expect); events come from diffing model snapshots on every
 * state commit rather than from hooks in the tab manager.
 */
export class TabsApi {
  /** `insertCSS` keys per WebContents, so `removeCSS` can find them by their CSS again. */
  private readonly insertedCss = new Map<string, string>()

  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = {
    create: (ctx, props) => this.create(ctx, props),
    remove: (ctx, tabIds) => this.remove(ctx, tabIds),
    update: (ctx, tabId, props) => this.update(ctx, tabId, props),
    get: (ctx, tabId) => this.get(ctx, tabId),
    getCurrent: (ctx) => this.getCurrent(ctx),
    query: (ctx, info) => this.query(ctx, info),
    move: (ctx, tabIds, props) => this.move(ctx, tabIds, props),
    duplicate: (ctx, tabId) => this.duplicate(ctx, tabId),
    highlight: (ctx, info) => this.highlight(ctx, info),
    reload: (ctx, tabId, props) => this.reload(ctx, tabId, props),
    goBack: (ctx, tabId) => this.history(ctx, tabId, 'back'),
    goForward: (ctx, tabId) => this.history(ctx, tabId, 'forward'),
    discard: (ctx, tabId) => this.discard(ctx, tabId),
    detectLanguage: (ctx, tabId) => this.detectLanguage(ctx, tabId),
    captureVisibleTab: (ctx, windowId, options) => this.captureVisibleTab(ctx, windowId, options),
    insertCSS: (ctx, tabId, details) => this.insertCSS(ctx, tabId, details),
    removeCSS: (ctx, tabId, details) => this.removeCSS(ctx, tabId, details),
    getZoom: (ctx, tabId) => this.getZoom(ctx, tabId),
    setZoom: (ctx, tabId, factor) => this.setZoom(ctx, tabId, factor),
    getAllInWindow: (ctx, windowId) => this.getAllInWindow(ctx, windowId),
    getSelected: (ctx, windowId) => this.getSelected(ctx, windowId)
  }

  // ---------------------------------------------------------------------------
  // Lookup helpers
  // ---------------------------------------------------------------------------

  private get model(): ApiHost['model'] {
    return this.host.model
  }

  /** The window a call refers to: the caller's own, else the last focused one. */
  private currentWindow(ctx: ApiContext): ZenWindow | undefined {
    return ctx.window ?? this.model.lastFocusedWindow()
  }

  private currentWindowId(ctx: ApiContext): number {
    return this.model.currentWindowId(ctx.sender, ctx.window)
  }

  private resolveWindow(ctx: ApiContext, windowId: unknown): ZenWindow {
    if (windowId === undefined || windowId === WINDOW_ID_CURRENT) {
      const win = this.currentWindow(ctx)
      if (win) return win
      throw new ApiError('No current window')
    }
    if (!isInteger(windowId)) throw new ApiError('Invalid window id')
    const win = this.model.zenWindow(windowId)
    if (!win) throw new ApiError(`No window with id: ${windowId}.`)
    return win
  }

  private tabById(tabId: unknown): Tab {
    if (!isInteger(tabId)) throw new ApiError('Invalid tab id')
    const tab = this.model.zenTab(tabId)
    if (!tab) throw new ApiError(`No tab with id: ${tabId}.`)
    return tab
  }

  /** `tabId` given, or the active tab of the caller's window. */
  private tabOrActive(ctx: ApiContext, tabId: unknown): Tab {
    if (tabId !== undefined) return this.tabById(tabId)
    const win = this.currentWindow(ctx)
    const active = win ? this.host.browser.tabs.activeTabFor(win) : undefined
    if (!active) throw new ApiError('No active tab')
    return active
  }

  private chromeTab(ext: LoadedExtension, tab: Tab): ChromeTab {
    return this.model.chromeTab(tab, this.host.canSeeTab(ext, tab.url))
  }

  private windowOf(tab: Tab): ZenWindow {
    const win = this.model.windowOfTab(tab)
    if (!win) throw new ApiError('Tab has no window')
    return win
  }

  private normalizeUrl(ctx: ApiContext, url: unknown): string {
    if (typeof url !== 'string') throw new ApiError('Invalid url')
    if (FORBIDDEN_URL.test(url)) {
      if (/^about:blank$/i.test(url.trim())) return BLANK_URL
      throw new ApiError(`Invalid url: "${url}".`)
    }
    const full = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : extensionUrl(ctx.extensionId, url)
    if (!isNavigableUrl(full)) throw new ApiError(`Invalid url: "${url}".`)
    return full
  }

  // ---------------------------------------------------------------------------
  // Methods
  // ---------------------------------------------------------------------------

  private create(ctx: ApiContext, props: unknown): ChromeTab {
    const p = isRecord(props) ? props : {}
    const win = this.resolveWindow(ctx, p.windowId)
    const url = p.url === undefined ? undefined : this.normalizeUrl(ctx, p.url)
    const opener = p.openerTabId === undefined ? undefined : this.tabById(p.openerTabId)
    const active = p.active !== false && p.selected !== false
    const tab = this.host.browser.tabs.createTab(
      {
        url,
        active,
        pinned: p.pinned === true,
        afterTabId: opener && !opener.essential ? opener.id : undefined,
        containerId: opener?.containerId
      },
      win
    )
    if (opener) this.model.setOpener(tab.id, opener.id)
    if (isInteger(p.index)) this.moveToIndex(tab, win, p.index)
    return this.chromeTab(ctx.extension, tab)
  }

  private remove(_ctx: ApiContext, tabIds: unknown): void {
    const list = Array.isArray(tabIds) ? tabIds : [tabIds]
    for (const id of list) {
      if (!isInteger(id)) throw new ApiError('Invalid tab id')
      const popup = this.model.popupForTabId(id)
      if (popup) {
        popup.bw.close()
        continue
      }
      const tab = this.tabById(id)
      this.host.browser.tabs.closeTab(tab.id, true, this.model.windowOfTab(tab))
    }
  }

  private update(ctx: ApiContext, tabId: unknown, props: unknown): ChromeTab {
    const tab = this.tabOrActive(ctx, tabId)
    const p = isRecord(props) ? props : {}
    const tabs = this.host.browser.tabs
    const win = this.windowOf(tab)
    if (p.url !== undefined) tabs.navigate(tab.id, this.normalizeUrl(ctx, p.url))
    if (p.pinned !== undefined && Boolean(p.pinned) !== (tab.pinned || tab.essential)) {
      tabs.togglePin(tab.id, win)
    }
    if (p.muted !== undefined && Boolean(p.muted) !== tab.muted) tabs.toggleMute(tab.id)
    if (p.openerTabId !== undefined) {
      const opener = this.tabById(p.openerTabId)
      this.model.setOpener(tab.id, opener.id)
    }
    if (p.active === true || p.highlighted === true || p.selected === true) {
      tabs.activateTab(tab.id, win)
    }
    return this.chromeTab(ctx.extension, tab)
  }

  private get(ctx: ApiContext, tabId: unknown): ChromeTab {
    if (isInteger(tabId)) {
      const popup = this.model.popupForTabId(tabId)
      if (popup) {
        const record = this.model.popupTab(popup)
        if (record) return record
      }
    }
    return this.chromeTab(ctx.extension, this.tabById(tabId))
  }

  private getCurrent(ctx: ApiContext): ChromeTab | undefined {
    if (ctx.sender.kind !== 'frame') return undefined
    const wc = ctx.sender.webContents
    if (ctx.tabId) {
      const tab = this.model.tab(ctx.tabId)
      if (tab) return this.chromeTab(ctx.extension, tab)
    }
    const popup = this.model.popupForTabId(wc.id)
    return popup ? (this.model.popupTab(popup) ?? undefined) : undefined
  }

  /** Every tab an extension may see, Zenium tabs first, then the pages of extension popup windows. */
  private allChromeTabs(): ChromeTab[] {
    const snapshot = this.model.snapshot()
    const out: ChromeTab[] = []
    for (const [, windowSnapshot] of snapshot.windows) {
      for (const zenId of windowSnapshot.order) {
        const tab = snapshot.tabs.get(zenId)
        if (tab) out.push(tab.chrome)
      }
    }
    for (const popup of this.model.popups.values()) {
      const tab = this.model.popupTab(popup)
      if (tab) out.push(tab)
    }
    return out
  }

  private query(ctx: ApiContext, info: unknown): ChromeTab[] {
    const q = (isRecord(info) ? info : {}) as TabQueryInfo
    const lastFocused = this.model.lastFocusedWindow()
    const queryContext = {
      currentWindowId: this.currentWindowId(ctx),
      lastFocusedWindowId: lastFocused ? this.model.windowIdOf(lastFocused) : WINDOW_ID_NONE,
      windowTypeOf: (windowId: number) => this.model.windowTypeOf(windowId)
    }
    return this.allChromeTabs()
      .filter((tab) => tabMatchesQuery(tab, q, queryContext))
      .map((tab) => this.visibleTab(ctx.extension, tab))
  }

  private move(ctx: ApiContext, tabIds: unknown, props: unknown): ChromeTab | ChromeTab[] {
    const p = isRecord(props) ? props : {}
    if (!isInteger(p.index)) throw new ApiError('Invalid value for index')
    const list = Array.isArray(tabIds) ? tabIds : [tabIds]
    const moved: ChromeTab[] = []
    let index = p.index
    for (const id of list) {
      const tab = this.tabById(id)
      const own = this.windowOf(tab)
      const target =
        p.windowId === undefined || p.windowId === WINDOW_ID_CURRENT
          ? own
          : this.resolveWindow(ctx, p.windowId)
      if (target !== own) {
        throw new ApiError('Tabs can only be moved within their own window in Zenium.')
      }
      this.moveToIndex(tab, own, index)
      if (index >= 0) index += 1
      moved.push(this.chromeTab(ctx.extension, tab))
    }
    return Array.isArray(tabIds) ? moved : moved[0]
  }

  /**
   * Put a tab at a Chrome index of its window: Chrome indices run across Essentials, pinned and
   * regular tabs; the neighbour at the target index decides the space and section.
   */
  private moveToIndex(tab: Tab, win: ZenWindow, index: number): void {
    const others = this.model.tabsInWindow(win).filter((t) => t.id !== tab.id)
    const at = index < 0 || index > others.length ? others.length : index
    const before = others.slice(0, at)
    const neighbour = others[at] ?? others[at - 1]
    let section: TabSection
    let spaceId: string | undefined
    if (tab.essential) {
      section = 'essential'
    } else if (tab.pinned) {
      section = 'pinned'
      spaceId = tab.spaceId ?? undefined
    } else {
      section = 'regular'
      spaceId =
        (neighbour && !neighbour.essential ? neighbour.spaceId : null) ?? tab.spaceId ?? undefined
    }
    const sectionIndex = before.filter((t) => {
      if (section === 'essential') return t.essential
      if (t.essential || (t.spaceId ?? undefined) !== spaceId) return false
      return section === 'pinned' ? t.pinned : !t.pinned
    }).length
    this.host.browser.tabs.moveTab(tab.id, { spaceId, section, index: sectionIndex }, win)
  }

  private duplicate(ctx: ApiContext, tabId: unknown): ChromeTab | undefined {
    const tab = this.tabById(tabId)
    const copy = this.host.browser.tabs.duplicate(tab.id, this.windowOf(tab))
    if (!copy) return undefined
    this.model.setOpener(copy.id, tab.id)
    return this.chromeTab(ctx.extension, copy)
  }

  private highlight(ctx: ApiContext, info: unknown): unknown {
    const p = isRecord(info) ? info : {}
    const win = this.resolveWindow(ctx, p.windowId)
    const indices = Array.isArray(p.tabs) ? p.tabs : [p.tabs]
    const first = indices.find((i) => isInteger(i))
    if (first === undefined) throw new ApiError('No highlighted tab')
    const tab = this.model.tabsInWindow(win)[first as number]
    if (!tab) throw new ApiError(`No tab at index: ${String(first)}.`)
    this.host.browser.tabs.activateTab(tab.id, win)
    return this.model.chromeWindow(win, true, (t) => this.host.canSeeTab(ctx.extension, t.url))
  }

  private reload(ctx: ApiContext, tabId: unknown, props: unknown): void {
    const tab = this.tabOrActive(ctx, tabId)
    const bypassCache = isRecord(props) && props.bypassCache === true
    this.host.browser.tabs.reload(tab.id, bypassCache)
  }

  private history(ctx: ApiContext, tabId: unknown, direction: 'back' | 'forward'): void {
    const tab = this.tabOrActive(ctx, tabId)
    const tabs = this.host.browser.tabs
    if (direction === 'back') {
      if (!tab.canGoBack) throw new ApiError('Cannot find a next page in history.')
      tabs.goBack(tab.id)
    } else {
      if (!tab.canGoForward) throw new ApiError('Cannot find a next page in history.')
      tabs.goForward(tab.id)
    }
  }

  private discard(ctx: ApiContext, tabId: unknown): ChromeTab | undefined {
    let tab: Tab | undefined
    if (tabId === undefined) {
      // Chrome picks the least important tab; the oldest hidden loaded one is ours.
      const visible = this.host.browser.tabs.allVisibleTabIds()
      tab = this.model
        .allTabs()
        .filter((t) => !t.discarded && !visible.has(t.id))
        .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0]
      if (!tab) return undefined
    } else {
      tab = this.tabById(tabId)
      if (tab.discarded)
        throw new ApiError(`Cannot discard tab with id: ${tabId}. It is already discarded.`)
      if (this.host.browser.tabs.allVisibleTabIds().has(tab.id)) {
        throw new ApiError(`Cannot discard tab with id: ${tabId}. It is currently visible.`)
      }
    }
    this.host.browser.tabs.discard(tab.id)
    return this.chromeTab(ctx.extension, tab)
  }

  private async detectLanguage(ctx: ApiContext, tabId: unknown): Promise<string> {
    const tab = this.tabOrActive(ctx, tabId)
    const wc = this.model.webContentsOf(tab)
    if (!wc) return 'und'
    try {
      const lang = await wc.executeJavaScript(
        '(document.documentElement.lang || navigator.language || "und")',
        true
      )
      const primary = String(lang).split(/[-_]/)[0].toLowerCase()
      return /^[a-z]{2,3}$/.test(primary) ? primary : 'und'
    } catch {
      return 'und'
    }
  }

  private async captureVisibleTab(
    ctx: ApiContext,
    windowId: unknown,
    options: unknown
  ): Promise<string> {
    const win = this.resolveWindow(ctx, windowId)
    const active = this.host.browser.tabs.activeTabFor(win)
    const wc = active ? this.model.webContentsOf(active) : undefined
    if (!wc) throw new ApiError('Failed to capture tab: the active tab has no page.')
    const o = isRecord(options) ? options : {}
    const image = await wc.capturePage()
    if (image.isEmpty()) throw new ApiError('Failed to capture tab: view is invisible.')
    if (o.format === 'png') return image.toDataURL()
    const quality = isInteger(o.quality) ? Math.max(0, Math.min(100, o.quality)) : 90
    return `data:image/jpeg;base64,${image.toJPEG(quality).toString('base64')}`
  }

  private cssOf(ctx: ApiContext, details: unknown): string {
    if (!isRecord(details)) throw new ApiError('Invalid details')
    if (typeof details.code === 'string') return details.code
    if (typeof details.file === 'string') {
      try {
        return readFileSync(join(ctx.extension.path, details.file.replace(/^\/+/, '')), 'utf8')
      } catch {
        throw new ApiError(`Could not load file: '${details.file}'.`)
      }
    }
    throw new ApiError('No source code or file specified.')
  }

  private async insertCSS(ctx: ApiContext, tabId: unknown, details: unknown): Promise<void> {
    const tab = this.tabOrActive(ctx, tabId)
    const css = this.cssOf(ctx, details)
    const wc = this.model.webContentsOf(tab)
    if (!wc) throw new ApiError('The tab has no page to insert CSS into.')
    const origin = isRecord(details) && details.cssOrigin === 'user' ? 'user' : 'author'
    const key = await wc.insertCSS(css, { cssOrigin: origin })
    this.insertedCss.set(`${wc.id}\u0000${css}`, key)
  }

  private async removeCSS(ctx: ApiContext, tabId: unknown, details: unknown): Promise<void> {
    const tab = this.tabOrActive(ctx, tabId)
    const css = this.cssOf(ctx, details)
    const wc = this.model.webContentsOf(tab)
    if (!wc) return
    const mapKey = `${wc.id}\u0000${css}`
    const key = this.insertedCss.get(mapKey)
    if (!key) return
    this.insertedCss.delete(mapKey)
    await wc.removeInsertedCSS(key)
  }

  private getZoom(ctx: ApiContext, tabId: unknown): number {
    const tab = this.tabOrActive(ctx, tabId)
    return this.model.webContentsOf(tab)?.getZoomFactor() ?? tab.zoom
  }

  private setZoom(ctx: ApiContext, tabId: unknown, factor: unknown): void {
    const tab = this.tabOrActive(ctx, tabId)
    if (typeof factor !== 'number' || !Number.isFinite(factor))
      throw new ApiError('Invalid zoom factor')
    this.host.browser.tabs.setZoom(tab.id, factor === 0 ? 1 : factor)
  }

  private getAllInWindow(ctx: ApiContext, windowId: unknown): ChromeTab[] {
    const win = this.resolveWindow(ctx, windowId)
    return this.model.tabsInWindow(win).map((tab) => this.chromeTab(ctx.extension, tab))
  }

  private getSelected(ctx: ApiContext, windowId: unknown): ChromeTab | undefined {
    const win = this.resolveWindow(ctx, windowId)
    const active = this.host.browser.tabs.activeTabFor(win)
    return active ? this.chromeTab(ctx.extension, active) : undefined
  }

  // ---------------------------------------------------------------------------
  // Events (from snapshot diffs)
  // ---------------------------------------------------------------------------

  /** Strip what an extension without `tabs` / host permission for the URL may not see. */
  private visibleTab(ext: LoadedExtension, tab: ChromeTab): ChromeTab {
    if (this.host.canSeeTab(ext, tab.url ?? '')) return tab
    const rest: ChromeTab = { ...tab }
    delete rest.url
    delete rest.pendingUrl
    delete rest.title
    delete rest.favIconUrl
    return rest
  }

  private visibleChange(
    ext: LoadedExtension,
    info: TabChangeInfo,
    url: string
  ): TabChangeInfo | null {
    if (this.host.canSeeTab(ext, url)) return info
    const rest: TabChangeInfo = { ...info }
    delete rest.url
    delete rest.title
    delete rest.favIconUrl
    return Object.keys(rest).length > 0 ? rest : null
  }

  diff(prev: ModelSnapshot, next: ModelSnapshot): void {
    for (const [zenId, after] of next.tabs) {
      if (prev.tabs.has(zenId)) continue
      this.host.broadcast('tabs', 'onCreated', (ext) => [this.visibleTab(ext, after.chrome)])
    }
    for (const [zenId, before] of prev.tabs) {
      if (next.tabs.has(zenId)) continue
      const isWindowClosing = before.windowId >= 0 && !next.windows.has(before.windowId)
      this.host.broadcast('tabs', 'onRemoved', () => [
        before.chrome.id,
        { windowId: before.windowId, isWindowClosing }
      ])
      this.host.model.forgetTab(zenId)
    }
    for (const [zenId, after] of next.tabs) {
      const before = prev.tabs.get(zenId)
      if (!before) continue
      this.diffTab(before, after)
    }
    for (const [windowId, after] of next.windows) {
      const before = prev.windows.get(windowId)
      if (!before) continue
      if (after.active !== null && after.active !== before.active) {
        const tab = next.tabs.get(after.active)
        if (tab) this.activated(tab.chrome.id, windowId)
      }
      for (const move of detectTabMoves(before.order, after.order)) {
        const tab = next.tabs.get(move.tabId)
        if (!tab) continue
        this.host.broadcast('tabs', 'onMoved', () => [
          tab.chrome.id,
          { windowId, fromIndex: move.fromIndex, toIndex: move.toIndex }
        ])
      }
    }
  }

  private diffTab(before: TabSnapshot, after: TabSnapshot): void {
    if (before.chrome.id !== after.chrome.id) {
      // The page was created or dropped: Chrome hands out a new id and reports a replacement.
      this.host.broadcast('tabs', 'onReplaced', () => [after.chrome.id, before.chrome.id])
    }
    if (before.windowId !== after.windowId && before.windowId >= 0 && after.windowId >= 0) {
      this.host.broadcast('tabs', 'onDetached', () => [
        after.chrome.id,
        { oldWindowId: before.windowId, oldPosition: before.chrome.index }
      ])
      this.host.broadcast('tabs', 'onAttached', () => [
        after.chrome.id,
        { newWindowId: after.windowId, newPosition: after.chrome.index }
      ])
    }
    const info = tabChangeInfo(before.chrome, after.chrome)
    if (info) {
      this.host.broadcast('tabs', 'onUpdated', (ext) => {
        const change = this.visibleChange(ext, info, after.url)
        return change ? [after.chrome.id, change, this.visibleTab(ext, after.chrome)] : null
      })
    }
    if (before.zoom !== after.zoom) {
      this.host.broadcast('tabs', 'onZoomChange', () => [
        {
          tabId: after.chrome.id,
          oldZoomFactor: before.zoom,
          newZoomFactor: after.zoom,
          zoomSettings: { mode: 'automatic', scope: 'per-origin', defaultZoomFactor: 1 }
        }
      ])
    }
  }

  private activated(tabId: number, windowId: number): void {
    this.host.broadcast('tabs', 'onActivated', () => [{ tabId, windowId }])
    this.host.broadcast('tabs', 'onHighlighted', () => [{ tabIds: [tabId], windowId }])
    // The deprecated MV2 spellings still have users.
    this.host.broadcast('tabs', 'onActiveChanged', () => [tabId, { windowId }])
    this.host.broadcast('tabs', 'onSelectionChanged', () => [tabId, { windowId }])
    this.host.broadcast('tabs', 'onHighlightChanged', () => [{ tabIds: [tabId], windowId }])
  }
}
