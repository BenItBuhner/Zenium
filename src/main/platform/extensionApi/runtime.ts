import {
  contextTypeOf,
  documentOriginOf,
  matchesContextFilter,
  normalizeContextFilter,
  type ExtensionContext
} from '../../../core/extensions/api/runtimeContexts'
import { frameIdOf } from './frames'
import {
  ApiError,
  TAB_ID_NONE,
  WINDOW_ID_NONE,
  extensionUrl,
  validated,
  type ApiContext,
  type ApiHost,
  type NamespaceHandlers
} from './types'

/**
 * `chrome.runtime` members the engine lacks: the install / startup lifecycle events (Electron
 * fires neither), the options-page and uninstall-URL bookkeeping, and `getContexts` over the
 * context registry. Messaging, `getManifest`, `getURL`, `getPlatformInfo` and friends stay native.
 */
export class RuntimeApi {
  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = {
    openOptionsPage: (ctx) => this.openOptionsPage(ctx),
    setUninstallURL: (ctx, url) => this.setUninstallURL(ctx, url),
    getContexts: (ctx, filter) => this.getContexts(ctx, filter)
  }

  /**
   * Every live context of the extension – its documents (the registry knows each one that said
   * hello) and its MV3 worker – narrowed by Chrome's `ContextFilter`. Extensions never load in
   * private windows, so no context is incognito.
   */
  private getContexts(ctx: ApiContext, filter: unknown): ExtensionContext[] {
    const wanted = validated(() => normalizeContextFilter(filter))
    const out: ExtensionContext[] = []
    for (const frame of this.host.registry.framesOf(ctx.extensionId)) {
      const url = frame.frame.url || frame.url
      const context: ExtensionContext = {
        contextId: frame.contextId,
        contextType: contextTypeOf(frame.kind, url, ctx.extension.manifest),
        documentId: frame.documentId,
        documentUrl: url,
        frameId: frameIdOf(frame.frame),
        incognito: false,
        tabId: frame.tabId ?? TAB_ID_NONE,
        windowId: frame.windowId ?? WINDOW_ID_NONE
      }
      const origin = documentOriginOf(url)
      if (origin !== undefined) context.documentOrigin = origin
      out.push(context)
    }
    for (const worker of this.host.registry.workersOf(ctx.extensionId)) {
      out.push({
        contextId: worker.contextId,
        contextType: 'BACKGROUND',
        frameId: -1,
        incognito: false,
        tabId: TAB_ID_NONE,
        windowId: WINDOW_ID_NONE
      })
    }
    return out.filter((context) => matchesContextFilter(context, wanted))
  }

  /** The options page URL of an extension, or null when its manifest declares none. */
  optionsUrl(extensionId: string): string | null {
    const loaded = this.host.loaded(extensionId)
    if (!loaded) return null
    const page = loaded.manifest.options_ui?.page ?? loaded.manifest.options_page
    return page ? extensionUrl(extensionId, page) : null
  }

  private openOptionsPage(ctx: ApiContext): void {
    const url = this.optionsUrl(ctx.extensionId)
    if (!url) throw new ApiError('Could not create an options page.')
    const browser = this.host.browser
    const win = ctx.window ?? this.host.model.lastFocusedWindow() ?? browser.focusedWindow()
    // Chrome focuses an already open options page instead of opening a second one.
    const existing = this.host.model.allTabs().find((tab) => tab.url.split('#')[0] === url)
    if (existing) {
      const owner = this.host.model.windowOfTab(existing) ?? win
      browser.tabs.activateTab(existing.id, owner)
      owner.host.focus()
      return
    }
    browser.tabs.createTab({ url, active: true }, win)
    win.host.focus()
  }

  private setUninstallURL(ctx: ApiContext, url: unknown): void {
    if (typeof url !== 'string') throw new ApiError('Invalid url')
    if (url.length > 1023)
      throw new ApiError('The URL exceeds the maximum length of 1023 characters.')
    if (url !== '' && !/^https?:\/\//i.test(url)) {
      throw new ApiError('Invalid URL: "' + url + '". Only http and https URLs are allowed.')
    }
    this.host.store.setUninstallUrl(ctx.extensionId, url)
  }

  /**
   * An extension was loaded for the first time in this run: `onInstalled` when it is new or
   * changed version, `onStartup` for the ones that come up with the app. Both go to the
   * background context once its top-level script has registered its listeners (the shim
   * queues events that arrive before that).
   */
  lifecycle(extensionId: string, version: string, booting: boolean): void {
    const store = this.host.store
    const previous = store.installedVersion(extensionId)
    if (previous === undefined) {
      store.setInstalledVersion(extensionId, version)
      this.host.dispatch(extensionId, 'runtime', 'onInstalled', [{ reason: 'install' }], {
        wake: true
      })
      return
    }
    if (previous !== version) {
      store.setInstalledVersion(extensionId, version)
      this.host.dispatch(
        extensionId,
        'runtime',
        'onInstalled',
        [{ reason: 'update', previousVersion: previous }],
        { wake: true }
      )
    }
    if (booting) this.host.dispatch(extensionId, 'runtime', 'onStartup', [], { wake: true })
  }

  /** Open the uninstall survey URL the extension registered, if any (called on removal). */
  openUninstallUrl(extensionId: string): void {
    const url = this.host.store.uninstallUrl(extensionId)
    if (!url) return
    const win = this.host.model.lastFocusedWindow()
    this.host.browser.tabs.createTab({ url, active: true }, win)
  }
}
