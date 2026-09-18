import type { WebContents } from 'electron'
import type { Rect, SidePanelInfo } from '../../../shared/types'
import type { ZenWindow } from '../../../core/window'
import {
  ERROR_NO_ACTIVE_WINDOW,
  ERROR_NO_PERMISSION,
  SidePanelError,
  SidePanelOptions,
  manifestPanelPath,
  noPanelForTab,
  noPanelForWindow,
  noTab,
  noWindow,
  normalizeGetOptions,
  normalizeOpenOptions,
  normalizePanelBehavior,
  normalizePanelOptions,
  type PanelBehavior,
  type PanelOptions
} from '../../../core/extensions/api/sidePanel'
import type { PanelView, PanelViewHost } from './sidePanelBridge'
import {
  ApiError,
  WINDOW_ID_CURRENT,
  extensionUrl,
  type ApiContext,
  type ApiHost,
  type LoadedExtension,
  type NamespaceHandlers
} from './types'

/** One window's side panel: the extension showing in it and the view that hosts its page. */
interface OpenPanel {
  extensionId: string
  win: ZenWindow
  view: PanelView
  /** The page loaded right now; null before the first load. */
  url: string | null
}

/**
 * `chrome.sidePanel`: Chrome's per-extension options (`setOptions` / `getOptions`, a default set
 * plus tab-specific ones, seeded from the manifest's `side_panel.default_path`), the toolbar
 * behaviour (`setPanelBehavior`: the action click opens the panel instead of the popup), and
 * `open`. Zenium has no side panel of its own, so this module also runs the panel: one view per
 * window, docked beside the page where the chrome lays the panel strip out (`UIState.sidePanel`
 * makes the strip appear, the layout report says where it is, and `place` follows). The page
 * shown follows the active tab: a tab with its own options gets its page, a tab where the panel
 * is disabled hides it, and it comes back with the next tab.
 *
 * Plain and functional under the styling hold; the design pass on the strip is deferred.
 */
export class SidePanelApi {
  private readonly options = new Map<string, SidePanelOptions>()
  private readonly panels = new Map<string, OpenPanel>()

  constructor(
    private readonly host: ApiHost,
    private readonly views: PanelViewHost
  ) {}

  readonly handlers: NamespaceHandlers = {
    setOptions: (ctx, options) => this.setOptions(ctx, options),
    getOptions: (ctx, options) => this.getOptions(ctx, options),
    setPanelBehavior: (ctx, behavior) => this.setPanelBehavior(ctx, behavior),
    getPanelBehavior: (ctx) => this.getPanelBehavior(ctx),
    open: (ctx, options) => this.open(ctx, options)
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  load(ext: LoadedExtension): void {
    const options = new SidePanelOptions(manifestPanelPath(ext.manifest))
    options.setBehavior({ openPanelOnActionClick: this.host.store.sidePanelOnActionClick(ext.id) })
    this.options.set(ext.id, options)
  }

  unload(extensionId: string): void {
    this.options.delete(extensionId)
    for (const panel of [...this.panels.values()]) {
      if (panel.extensionId === extensionId) this.close(panel.win)
    }
  }

  /** A tab is gone: so are its tab-specific options. */
  tabRemoved(tabId: number): void {
    for (const options of this.options.values()) options.tabRemoved(tabId)
  }

  private optionsFor(ext: LoadedExtension): SidePanelOptions {
    let options = this.options.get(ext.id)
    if (!options) {
      this.load(ext)
      options = this.options.get(ext.id)!
    }
    return options
  }

  private hasPermission(ext: LoadedExtension): boolean {
    return this.host.grants(ext.id).permissions.includes('sidePanel')
  }

  private requirePermission(ext: LoadedExtension): void {
    if (!this.hasPermission(ext)) throw new ApiError(ERROR_NO_PERMISSION)
  }

  // ---------------------------------------------------------------------------
  // Methods
  // ---------------------------------------------------------------------------

  private setOptions(ctx: ApiContext, raw: unknown): void {
    this.requirePermission(ctx.extension)
    const options = checked(() => normalizePanelOptions(raw))
    if (options.tabId !== undefined && !this.host.model.zenTab(options.tabId)) {
      throw new ApiError(noTab(options.tabId))
    }
    this.optionsFor(ctx.extension).setOptions(options)
    // The panel showing this extension may now show another page, or nothing, for its tab.
    this.refresh()
    this.host.commitUi()
  }

  private getOptions(ctx: ApiContext, raw: unknown): PanelOptions {
    this.requirePermission(ctx.extension)
    const tabId = checked(() => normalizeGetOptions(raw))
    if (tabId !== undefined && !this.host.model.zenTab(tabId)) throw new ApiError(noTab(tabId))
    return this.optionsFor(ctx.extension).getOptions(tabId)
  }

  private setPanelBehavior(ctx: ApiContext, raw: unknown): void {
    this.requirePermission(ctx.extension)
    const patch = checked(() => normalizePanelBehavior(raw))
    const options = this.optionsFor(ctx.extension)
    options.setBehavior(patch)
    this.host.store.setSidePanelOnActionClick(
      ctx.extensionId,
      options.behavior.openPanelOnActionClick
    )
  }

  private getPanelBehavior(ctx: ApiContext): PanelBehavior {
    this.requirePermission(ctx.extension)
    return { ...this.optionsFor(ctx.extension).behavior }
  }

  private open(ctx: ApiContext, raw: unknown): void {
    this.requirePermission(ctx.extension)
    const target = checked(() => normalizeOpenOptions(raw))
    let win: ZenWindow | undefined
    if (target.tabId !== undefined) {
      const tab = this.host.model.zenTab(target.tabId)
      win = tab ? this.host.model.windowOfTab(tab) : undefined
      if (!tab || !win) throw new ApiError(noTab(target.tabId))
      if (
        target.windowId !== undefined &&
        target.windowId !== WINDOW_ID_CURRENT &&
        this.host.model.windowIdOf(win) !== target.windowId
      ) {
        throw new ApiError(noWindow(target.windowId))
      }
      if (!this.optionsFor(ctx.extension).effective(target.tabId).path) {
        throw new ApiError(noPanelForTab(target.tabId))
      }
      // Chrome opens the panel on that tab; Zenium's panel belongs to the window, so the tab
      // comes to the front and the panel opens beside it.
      this.host.browser.tabs.activateTab(tab.id, win)
    } else {
      const windowId = target.windowId!
      win =
        windowId === WINDOW_ID_CURRENT
          ? (ctx.window ?? this.host.model.lastFocusedWindow())
          : this.host.model.zenWindow(windowId)
      if (!win) {
        throw new ApiError(
          windowId === WINDOW_ID_CURRENT ? ERROR_NO_ACTIVE_WINDOW : noWindow(windowId)
        )
      }
      if (!this.urlFor(ctx.extension, win)) throw new ApiError(noPanelForWindow(windowId))
    }
    this.show(ctx.extension, win)
  }

  // ---------------------------------------------------------------------------
  // What the panel shows
  // ---------------------------------------------------------------------------

  /** The page the extension's panel shows for the active tab of `win`, or null for none. */
  private urlFor(ext: LoadedExtension, win: ZenWindow): string | null {
    const active = this.host.browser.tabs.activeTabFor(win)
    const tabId = active ? this.host.model.chromeTabId(active) : undefined
    const { path } = this.optionsFor(ext).effective(tabId)
    return path ? extensionUrl(ext.id, path) : null
  }

  /** An extension whose toolbar click opens the panel (and has a panel to open in `win`). */
  opensOnActionClick(extensionId: string, win: ZenWindow): boolean {
    const ext = this.host.loaded(extensionId)
    if (!ext || !this.hasPermission(ext)) return false
    const options = this.optionsFor(ext)
    return options.behavior.openPanelOnActionClick && this.urlFor(ext, win) !== null
  }

  // ---------------------------------------------------------------------------
  // Browser-side: the panel per window
  // ---------------------------------------------------------------------------

  /** What `win` shows beside its page, for the chrome (`UIState.sidePanel`); null when nothing. */
  info(win: ZenWindow): SidePanelInfo | null {
    const panel = this.panels.get(win.id)
    if (!panel) return null
    const ext = this.host.loaded(panel.extensionId)
    if (!ext || !this.urlFor(ext, win)) return null
    const record = this.host.browser.extensions.list().find((info) => info.id === ext.id)
    return {
      extensionId: ext.id,
      name: record?.name || ext.extension.name,
      icon: record?.icon ?? null
    }
  }

  /** The extension showing in `win`'s panel, open or collapsed for the current tab. */
  showing(win: ZenWindow): string | null {
    return this.panels.get(win.id)?.extensionId ?? null
  }

  /** The chrome's toggle: open the extension's panel, or close it when it is the one showing. */
  toggle(extensionId: string, win: ZenWindow): void {
    if (this.panels.get(win.id)?.extensionId === extensionId) {
      this.close(win)
      return
    }
    const ext = this.host.loaded(extensionId)
    if (!ext || !this.hasPermission(ext) || !this.urlFor(ext, win)) return
    this.show(ext, win)
  }

  private show(ext: LoadedExtension, win: ZenWindow): void {
    const current = this.panels.get(win.id)
    if (current && current.extensionId !== ext.id) this.close(win)
    let panel = this.panels.get(win.id)
    if (!panel) {
      const view = this.views.create(win, ext, {
        openUrl: (url) => this.host.browser.tabs.createTab({ url, active: true }, win),
        gone: () => {
          if (this.panels.get(win.id)?.view === view) {
            this.panels.delete(win.id)
            this.host.commitUi()
          }
        }
      })
      if (!view) return
      panel = { extensionId: ext.id, win, view, url: null }
      this.panels.set(win.id, panel)
    }
    this.refreshPanel(panel, true)
    this.host.commitUi()
  }

  close(win: ZenWindow): void {
    const panel = this.panels.get(win.id)
    if (!panel) return
    this.panels.delete(win.id)
    panel.view.close()
    this.host.commitUi()
  }

  /** The chrome laid the panel strip out (or took it away): the view follows. */
  place(win: ZenWindow, rect: Rect | null): void {
    const panel = this.panels.get(win.id)
    if (!panel || panel.view.destroyed()) return
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      if (panel.view.visible()) panel.view.setVisible(false)
      return
    }
    panel.view.setBounds(rect)
    if (!panel.view.visible()) panel.view.setVisible(true)
  }

  /** Whether this WebContents is a side panel's page (the registry classifies its frames). */
  hosts(wc: WebContents): boolean {
    for (const panel of this.panels.values()) if (panel.view.hostsWebContents(wc)) return true
    return false
  }

  /** From the router's tick: the active tab may have changed, and with it the page to show. */
  refresh(): void {
    for (const panel of this.panels.values()) this.refreshPanel(panel, false)
  }

  private refreshPanel(panel: OpenPanel, focus: boolean): void {
    const ext = this.host.loaded(panel.extensionId)
    if (!ext || panel.view.destroyed()) return
    const url = this.urlFor(ext, panel.win)
    // No page for this tab: the strip collapses (the chrome sees `info` as null) and the view
    // hides with it; the last page stays loaded for when the tab that shows it comes back.
    if (!url) return
    if (panel.url !== url) {
      panel.url = url
      panel.view.loadURL(url)
    }
    if (focus) panel.view.focus()
  }
}

function checked<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof SidePanelError) throw new ApiError(error.message)
    throw error
  }
}
