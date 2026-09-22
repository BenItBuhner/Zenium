import type { Tab } from '@shared/types'
import {
  ERROR_NO_ACTIVE_WINDOW,
  ERROR_NO_PERMISSION,
  SIDE_PANEL_SIDES,
  SidePanelError,
  SidePanelOptions,
  manifestPanelPath,
  noPanelForTab,
  noPanelForWindow,
  noWindow,
  normalizeCloseOptions,
  normalizeGetOptions,
  normalizeOpenOptions,
  normalizePanelBehavior,
  normalizePanelOptions,
  type PanelBehavior,
  type PanelLayout,
  type PanelOpenedInfo,
  type PanelOptions
} from '@core/extensions/api/sidePanel'
import { extensionUrl } from '@core/extensions/runtime/plan'
import type { AttachedExtension } from './extensionApi'

/** Chrome's `windows.WINDOW_ID_CURRENT`; the phone's one window is `1` to every extension. */
const WINDOW_ID_CURRENT = -2
const WINDOW_ID = 1

/** What the side panel needs from the runtime: the tabs as the extension sees them, the sheet, events. */
export interface SidePanelHost {
  attached(id: string): AttachedExtension | undefined
  /** The tab a Chrome id names, as `ext` may see it; throws Chrome's "No tab with id" otherwise. */
  tabFor(ext: AttachedExtension, chromeTabId: unknown): Tab
  chromeIdFor(tabId: string): number
  activeTabFor(ext: AttachedExtension): Tab | undefined
  activateTab(tabId: string): void
  /** Put the panel document up in the runtime's sheet (`ext.popup.open` with `context: 'sidePanel'`). */
  showSheet(ext: AttachedExtension, url: string): void
  /** Take the sheet down when it shows the panel. */
  hideSheet(): void
  /** Raise `chrome.sidePanel.<name>` in the extension's listening endpoints (waking the background). */
  emit(extensionId: string, ns: string, name: string, args: unknown[]): void
  /** `setPanelBehavior({ openPanelOnActionClick })`, kept across sessions as the desktop keeps it. */
  behavior(id: string): boolean
  setBehavior(id: string, openPanelOnActionClick: boolean): void
}

/** The panel showing in the sheet right now. */
interface ShownPanel {
  extensionId: string
  url: string
  /** What `onOpened` announced for the page (`onClosed` repeats it). */
  info: PanelOpenedInfo
}

/**
 * `chrome.sidePanel` on the phone: Chrome's per-extension options (`setOptions` / `getOptions`,
 * a default set plus tab-specific ones, seeded from the manifest's `side_panel.default_path`),
 * the toolbar behaviour (`setPanelBehavior`: the action tap opens the panel instead of the
 * popup, as Chrome's `SidePanelService::OpenSidePanelOnIconClick` decides before the popup),
 * `open` and `close` with Chrome's checks and messages, and the surface itself: the phone has no
 * room beside the page, so the panel document is hosted in the runtime's sheet the way popups
 * and options pages are (`ExtensionPopup`, full height, titled with the extension's name). The
 * page shown is the one the options resolve to for the active tab; `onOpened` and `onClosed`
 * carry Chrome's `{ path, windowId, tabId? }` (the tab only for a tab-specific panel).
 *
 * The desktop's `SidePanelApi` docks a view per window and follows the active tab; the sheet is
 * modal, so nothing changes under it until it is dismissed, and a `setOptions` that takes the
 * page away while it shows closes the sheet (Chrome closes a panel disabled for its tab).
 */
export class AndroidSidePanel {
  private readonly options = new Map<string, SidePanelOptions>()
  private shown: ShownPanel | null = null

  constructor(private readonly host: SidePanelHost) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** The extension attached: its options start from the manifest, its behaviour from the store. */
  load(ext: AttachedExtension): void {
    const options = new SidePanelOptions(manifestPanelPath(ext.manifest.raw))
    options.setBehavior({ openPanelOnActionClick: this.host.behavior(ext.record.id) })
    this.options.set(ext.record.id, options)
  }

  /** The extension detached: its options go, and the sheet when it shows its panel. */
  forget(extensionId: string): void {
    this.options.delete(extensionId)
    if (this.shown?.extensionId === extensionId) this.host.hideSheet()
  }

  /** A tab is gone: so are its tab-specific options. */
  tabRemoved(chromeTabId: number): void {
    for (const options of this.options.values()) options.tabRemoved(chromeTabId)
  }

  private optionsFor(ext: AttachedExtension): SidePanelOptions {
    let options = this.options.get(ext.record.id)
    if (!options) {
      this.load(ext)
      options = this.options.get(ext.record.id)!
    }
    return options
  }

  private hasPermission(ext: AttachedExtension): boolean {
    return (
      ext.manifest.permissions.includes('sidePanel') ||
      ext.manifest.optionalPermissions.includes('sidePanel')
    )
  }

  private requirePermission(ext: AttachedExtension): void {
    if (!this.hasPermission(ext)) throw new Error(ERROR_NO_PERMISSION)
  }

  // ---------------------------------------------------------------------------
  // Routed calls
  // ---------------------------------------------------------------------------

  call(ext: AttachedExtension, method: string, args: unknown[]): unknown {
    switch (method) {
      case 'setOptions':
        return this.setOptions(ext, args[0])
      case 'getOptions':
        return this.getOptions(ext, args[0])
      case 'setPanelBehavior':
        return this.setPanelBehavior(ext, args[0])
      case 'getPanelBehavior':
        this.requirePermission(ext)
        return { ...this.optionsFor(ext).behavior } satisfies PanelBehavior
      case 'open':
        return this.open(ext, args[0])
      case 'close':
        return this.closePanel(ext, args[0])
      case 'getLayout':
        this.requirePermission(ext)
        return { side: SIDE_PANEL_SIDES.RIGHT } satisfies PanelLayout
    }
    throw new Error(`chrome.sidePanel.${method} is not implemented on Zenium for Android`)
  }

  private setOptions(ext: AttachedExtension, raw: unknown): void {
    this.requirePermission(ext)
    const options = checked(() => normalizePanelOptions(raw))
    if (options.tabId !== undefined) this.host.tabFor(ext, options.tabId)
    this.optionsFor(ext).setOptions(options)
    this.refresh(ext)
  }

  private getOptions(ext: AttachedExtension, raw: unknown): PanelOptions {
    this.requirePermission(ext)
    const tabId = checked(() => normalizeGetOptions(raw))
    if (tabId !== undefined) this.host.tabFor(ext, tabId)
    return this.optionsFor(ext).getOptions(tabId)
  }

  private setPanelBehavior(ext: AttachedExtension, raw: unknown): void {
    this.requirePermission(ext)
    const patch = checked(() => normalizePanelBehavior(raw))
    const options = this.optionsFor(ext)
    options.setBehavior(patch)
    this.host.setBehavior(ext.record.id, options.behavior.openPanelOnActionClick)
  }

  /**
   * `open({ tabId } | { windowId })`: Chrome's checks in its order – the tab (as the extension
   * sees it), a window named alongside it, then a panel to show – and the sheet. Chrome opens a
   * tab's panel in its window without switching to the tab; the sheet covers whatever the phone
   * shows, so the tab comes to the front and the panel opens over it.
   */
  private open(ext: AttachedExtension, raw: unknown): void {
    this.requirePermission(ext)
    const target = checked(() => normalizeOpenOptions(raw))
    if (target.tabId !== undefined) {
      const tab = this.host.tabFor(ext, target.tabId)
      if (
        target.windowId !== undefined &&
        target.windowId !== WINDOW_ID_CURRENT &&
        target.windowId !== WINDOW_ID
      )
        throw new Error(noWindow(target.windowId))
      const page = this.pageFor(ext, tab)
      if (!page) throw new Error(noPanelForTab(target.tabId))
      this.host.activateTab(tab.id)
      this.show(ext, page)
      return
    }
    const windowId = target.windowId!
    if (windowId !== WINDOW_ID_CURRENT && windowId !== WINDOW_ID)
      throw new Error(noWindow(windowId))
    const active = this.host.activeTabFor(ext)
    if (!active) throw new Error(ERROR_NO_ACTIVE_WINDOW)
    const page = this.pageFor(ext, active)
    if (!page) throw new Error(noPanelForWindow(windowId))
    this.show(ext, page)
  }

  /**
   * `close(options)`: a no-op when the extension's panel is not showing. With a `tabId`, Chrome
   * (145 and later) closes a tab-specific panel and refuses when only the global one shows on
   * that tab.
   */
  private closePanel(ext: AttachedExtension, raw: unknown): void {
    this.requirePermission(ext)
    const target = checked(() => normalizeCloseOptions(raw))
    if (target.tabId !== undefined) {
      this.host.tabFor(ext, target.tabId)
      if (
        target.windowId !== undefined &&
        target.windowId !== WINDOW_ID_CURRENT &&
        target.windowId !== WINDOW_ID
      )
        throw new Error(noWindow(target.windowId))
      if (this.shown?.extensionId !== ext.record.id) return
      if (!this.optionsFor(ext).effective(target.tabId).tabScoped)
        throw new Error(noPanelForTab(target.tabId))
    } else {
      const windowId = target.windowId!
      if (windowId !== WINDOW_ID_CURRENT && windowId !== WINDOW_ID)
        throw new Error(noWindow(windowId))
      if (this.shown?.extensionId !== ext.record.id) return
    }
    this.host.hideSheet()
  }

  // ---------------------------------------------------------------------------
  // What the panel shows
  // ---------------------------------------------------------------------------

  /**
   * The page the extension's panel shows for `tab`, with what `onOpened` says about it (the tab
   * only for a tab-specific panel, as in Chrome); null when the panel is off for the tab.
   */
  private pageFor(ext: AttachedExtension, tab: Tab): { url: string; info: PanelOpenedInfo } | null {
    const tabId = this.host.chromeIdFor(tab.id)
    const { path, tabScoped } = this.optionsFor(ext).effective(tabId)
    if (!path) return null
    const info: PanelOpenedInfo = { path, windowId: WINDOW_ID }
    if (tabScoped) info.tabId = tabId
    return { url: extensionUrl(ext.record.id, path), info }
  }

  /** An extension whose toolbar tap opens the panel (and has a panel to open on the active tab). */
  opensOnActionClick(ext: AttachedExtension): boolean {
    if (!this.hasPermission(ext)) return false
    const options = this.optionsFor(ext)
    if (!options.behavior.openPanelOnActionClick) return false
    const active = this.host.activeTabFor(ext)
    return active !== undefined && this.pageFor(ext, active) !== null
  }

  /** The toolbar tap with `openPanelOnActionClick`: the panel opens, or closes when it is up. */
  toggle(ext: AttachedExtension): void {
    if (this.shown?.extensionId === ext.record.id) {
      this.host.hideSheet()
      return
    }
    const active = this.host.activeTabFor(ext)
    const page = active ? this.pageFor(ext, active) : null
    if (page) this.show(ext, page)
  }

  /** The extension showing in the sheet, or null when the sheet shows no panel. */
  showing(): string | null {
    return this.shown?.extensionId ?? null
  }

  private show(ext: AttachedExtension, page: { url: string; info: PanelOpenedInfo }): void {
    const previous = this.shown
    if (previous && previous.url === page.url && previous.extensionId === ext.record.id) return
    // Another page (or another extension's panel) takes the sheet: the one leaving is closed.
    if (previous) this.announceClosed()
    this.shown = { extensionId: ext.record.id, url: page.url, info: page.info }
    this.host.showSheet(ext, page.url)
    // Chrome fires `onOpened` per panel entry shown, the tab-specific ones included.
    this.host.emit(ext.record.id, 'sidePanel', 'onOpened', [{ ...page.info }])
  }

  /** The sheet went (dismissed, replaced by a popup, the extension detached): `onClosed`. */
  sheetGone(): void {
    this.announceClosed()
  }

  private announceClosed(): void {
    const shown = this.shown
    if (!shown) return
    this.shown = null
    this.host.emit(shown.extensionId, 'sidePanel', 'onClosed', [{ ...shown.info }])
  }

  /** The options changed while the panel shows: another page, or none (the sheet closes). */
  private refresh(ext: AttachedExtension): void {
    if (this.shown?.extensionId !== ext.record.id) return
    const active = this.host.activeTabFor(ext)
    const page = active ? this.pageFor(ext, active) : null
    if (!page) {
      this.host.hideSheet()
      return
    }
    if (page.url !== this.shown.url) this.show(ext, page)
  }
}

function checked<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof SidePanelError) throw new Error(error.message)
    throw error
  }
}
