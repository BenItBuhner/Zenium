import type {
  CommandArgs,
  CommandName,
  CommandResult,
  EventName,
  Events,
  Folder,
  KeyBinding,
  MediaState,
  Settings,
  Space,
  WindowKind
} from '../shared/types'
import { BrowserState, type PersistedWindow } from './state'
import { HistoryService } from './history'
import { BookmarkService } from './bookmarks'
import { DownloadService } from './downloads'
import { PermissionService } from './permissions'
import { TabManager } from './tabs'
import { ZenWindow } from './window'
import { Actions, type AnyAction } from './actions'
import { KeyboardHandler } from './keys'
import { Menus } from './menus'
import { SuggestionService } from './suggestions'
import { sanitizeResourceSettings } from './resources/switches'
import { AgentService } from './agent/service'
import { sanitizeAgentSettings } from './agent/settings'
import { BoostService } from './boosts'
import { ReaderService } from './reader'
import { LiveFolderService } from './livefolders'
import { ModService } from './mods'
import { NoExtensions, NoSync, NoopGovernor } from './hostDefaults'
import {
  activeSpace,
  createFolder,
  createLocalSpace,
  createSpace,
  cycleSpace,
  deleteFolder,
  getSpace,
  reorderContainer,
  reorderSpace
} from './model'
import { getDomain, inputToUrl } from '../shared/url'
import { buildSearchUrl, matchEngineKeyword } from '../shared/search'
import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID } from '../shared/types'
import { ONBOARDING_ESSENTIALS } from '../shared/defaults'
import { PRIVATE_THEME, resolveTheme, rgbToHex } from '../shared/theme'
import { newId } from '../shared/ids'
import type { ExtensionHost, Governor, PageMessage, Platform, SyncHost } from './platform'

type CommandHandlers = {
  [K in CommandName]: (
    args: CommandArgs<K>,
    win: ZenWindow
  ) => CommandResult<K> | Promise<CommandResult<K>>
}

const FOCUS_CHROME_EVENTS = new Set<EventName>([
  'urlbar.toggle',
  'overlay.open',
  'find.open',
  'theme.open',
  'space.new',
  'space.edit',
  'tab.startRename',
  'folder.startRename',
  'tab.editPinnedUrl',
  'tab.pickIcon',
  'menu.show'
])

/**
 * The browser: wires every service together and implements the command surface the chrome talks
 * to. Owns every window; the tab model is shared between them (Zen's window sync).
 *
 * Platform neutral – hosts plug in through `Platform` and call `handleCommand(win, …)` for the
 * chrome's commands, `handlePageMessage` for page-script messages and `keys.handle` for keys.
 */
export class Browser {
  readonly state: BrowserState
  readonly history: HistoryService
  readonly bookmarks: BookmarkService
  readonly downloads: DownloadService
  readonly permissions: PermissionService
  readonly tabs: TabManager
  readonly actions: Actions
  readonly keys: KeyboardHandler
  readonly menus: Menus
  readonly suggestions: SuggestionService
  readonly boosts: BoostService
  readonly reader: ReaderService
  readonly liveFolders: LiveFolderService
  readonly extensions: ExtensionHost
  readonly mods: ModService
  readonly sync: SyncHost
  readonly governor: Governor
  /** The MCP server AI agents connect to. */
  readonly agents: AgentService
  readonly windows = new Map<string, ZenWindow>()
  quitting = false
  private readonly handlers: CommandHandlers

  constructor(readonly platform: Platform) {
    this.state = new BrowserState(
      platform.io,
      platform.info.os,
      platform.capabilities,
      platform.info.version
    )
    this.state.liveWindows = () => this.allWindows()
    this.state.load()
    this.history = new HistoryService(platform.io)
    this.bookmarks = new BookmarkService(this.state)
    this.downloads = new DownloadService(platform.io, platform.downloads, () => {
      this.state.downloads = this.downloads.items
      this.state.commitVolatile()
    })
    this.state.downloads = this.downloads.items
    this.permissions = new PermissionService(platform.io, platform.dialogs)
    this.tabs = new TabManager(this)
    this.governor = platform.createGovernor?.(this) ?? new NoopGovernor(this)
    this.actions = new Actions(this)
    this.keys = new KeyboardHandler(this)
    this.menus = new Menus(this)
    this.suggestions = new SuggestionService(this)
    this.boosts = new BoostService(this)
    this.reader = new ReaderService(this)
    this.liveFolders = new LiveFolderService(this)
    this.extensions = platform.createExtensions?.(this) ?? new NoExtensions(this)
    this.mods = new ModService(this)
    this.sync = platform.createSync?.(this) ?? new NoSync(this)
    this.agents = new AgentService(this)
    this.state.extras = () => ({
      boosts: this.boosts.all(),
      zappingTabId: this.boosts.zappingTabId(),
      liveFolders: this.liveFolders.all(),
      extensions: this.extensions.list(),
      mods: this.mods.all(),
      sync: this.sync.status(),
      agents: this.agents.list(),
      agentServer: this.agents.serverStatus()
    })
    this.handlers = this.commandHandlers()
  }

  // ---------------------------------------------------------------------------
  // Windows
  // ---------------------------------------------------------------------------

  allWindows(): ZenWindow[] {
    return [...this.windows.values()].filter((w) => w.alive)
  }

  /** The window the user is interacting with (creates one when none is open, e.g. on macOS). */
  focusedWindow(): ZenWindow {
    const alive = this.allWindows()
    const focused = alive.find((w) => w.host.isFocused())
    if (focused) return focused
    const recent = [...alive].sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)[0]
    return recent ?? this.createWindow({ kind: 'synced' })
  }

  /** User-facing "new window" (capability gated – Android has exactly one window). */
  openWindow(kind: WindowKind, from?: ZenWindow): ZenWindow | null {
    if (!this.state.capabilities.windows) {
      this.toast('Multiple windows are not available on this device.', 'info', from)
      return null
    }
    return this.createWindow({ kind, from })
  }

  createWindow(opts: {
    kind: WindowKind
    from?: ZenWindow
    persisted?: PersistedWindow
  }): ZenWindow {
    const m = this.state.model
    const id = opts.persisted?.id ?? newId('window')
    const from = opts.from
    let localSpace: Space | null = null
    let activeSpaceId: string
    if (opts.kind === 'synced') {
      const fromSpace = from && !from.localSpace ? from.activeSpaceId : undefined
      activeSpaceId = opts.persisted?.activeSpaceId ?? fromSpace ?? m.activeSpaceId
      if (!getSpace(m, activeSpaceId)) activeSpaceId = activeSpace(m).id
    } else {
      // Zen: a blank window inherits the container (and look) of the space it was opened from.
      const origin = from && !from.localSpace ? from.activeSpace() : activeSpace(m)
      const isPrivate = opts.kind === 'private'
      localSpace = createLocalSpace(
        id,
        isPrivate ? 'Private' : 'Blank Window',
        isPrivate ? '🕶️' : '',
        isPrivate ? PRIVATE_CONTAINER_ID : origin.containerId,
        isPrivate ? PRIVATE_THEME : origin.theme
      )
      m.localSpaces[localSpace.id] = localSpace
      activeSpaceId = localSpace.id
    }
    const win = new ZenWindow(this, {
      id,
      kind: opts.kind,
      bounds: opts.persisted?.bounds ?? null,
      maximized: opts.persisted?.maximized ?? false,
      activeSpaceId,
      selection: opts.persisted?.selection ?? {},
      compact:
        opts.persisted?.compact ?? from?.compactEnabled ?? this.state.settings.compactMode.enabled,
      localSpace,
      cascadeFrom: from
    })
    this.windows.set(id, win)
    const theme = resolveTheme(win.activeSpace().theme, this.state.settings.colorScheme === 'dark')
    win.host = this.platform.windows.create(win, {
      bounds: win.initialBounds,
      maximized: win.initialMaximized,
      cascadeFrom: win.cascadeFrom,
      title: win.isPrivate ? 'Zen (Private Browsing)' : 'Zen',
      backgroundColor: rgbToHex(theme.averageColor)
    })
    this.governor.watchWindow(win)
    if (localSpace) {
      // Blank / private windows start with an empty tab and the URL bar open.
      const tab = this.tabs.createTab({ active: true, load: false }, win)
      win.select(localSpace, tab.id)
    }
    this.state.commit()
    return win
  }

  /** The chrome of `win` finished loading for the first time. */
  onChromeReady(win: ZenWindow): void {
    if (this.state.settings.onboardingDone) this.tabs.claimVisible(win)
    if (win.localSpace) setTimeout(() => this.emit('urlbar.toggle', { mode: 'new-tab' }, win), 150)
  }

  onWindowFocused(win: ZenWindow): void {
    if (this.state.settings.onboardingDone) this.tabs.claimVisible(win)
  }

  onWindowClosing(win: ZenWindow): void {
    this.tabs.releaseWindow(win, this.quitting)
  }

  onWindowClosed(win: ZenWindow): void {
    this.windows.delete(win.id)
    for (const w of this.allWindows()) w.selection.delete(win.localSpace?.id ?? '')
    if (win.isPrivate && !this.allWindows().some((w) => w.isPrivate))
      void this.platform.sessions.clearPrivate()
    if (this.allWindows().length === 0) {
      this.governor.stop()
      this.tabs.destroyAll()
      this.platform.app.lastWindowClosed()
      return
    }
    if (!this.quitting) this.state.commit()
  }

  /** Something (dock, launcher, intent) asked for a window while none is open. */
  ensureWindow(): ZenWindow {
    if (this.allWindows().length === 0) this.governor.start()
    return this.focusedWindow()
  }

  /**
   * A navigation that turned into a download leaves its tab without a committed document (and
   * without a renderer to route shortcuts through). Like Chrome, close such a tab when it was
   * opened only for the download; otherwise just make sure the keyboard keeps working.
   */
  onDownloadStarted(sourceTabId: string | null): void {
    // Firefox shows the downloads panel whenever a download begins. Let any tab switch paint
    // first so the panel can dim a snapshot of the page behind it.
    const win = sourceTabId ? this.tabs.windowFor(sourceTabId) : this.focusedWindow()
    setTimeout(() => this.emit('overlay.open', { kind: 'downloads' }, win), 200)
    const tab = this.tabs.tab(sourceTabId)
    const view = sourceTabId ? this.tabs.view(sourceTabId) : undefined
    if (!tab || !view) return
    if (view.hasDocument()) return
    if (!tab.pinned && !tab.essential && !view.canGoBack()) {
      this.tabs.closeTab(tab.id)
    } else {
      win.focusChrome()
    }
  }

  start(): void {
    if (this.state.settings.pinnedResetOnStartup) {
      for (const tab of Object.values(this.state.model.tabs)) {
        if ((tab.pinned || tab.essential) && tab.pinnedUrl) tab.url = tab.pinnedUrl
      }
    }
    this.state.subscribe(() => {
      for (const win of this.allWindows()) win.send('state', this.state.snapshot(win))
    })
    // Zen restores every synced window (and the space each one was in).
    const restore =
      this.state.settings.restoreSession && this.state.capabilities.windows
        ? this.state.restoredWindows
        : this.state.restoredWindows.slice(0, 1)
    if (restore.length === 0) this.createWindow({ kind: 'synced' })
    for (const persisted of restore) this.createWindow({ kind: 'synced', persisted })
    this.governor.start()
    this.liveFolders.start()
    void this.extensions.start()
    this.sync.start()
    this.agents.start()
    this.syncShortcuts()
    this.state.commit()
  }

  // ---------------------------------------------------------------------------
  // Helpers used across services
  // ---------------------------------------------------------------------------

  emit<K extends EventName>(
    name: K,
    payload: Events[K],
    win: ZenWindow = this.focusedWindow()
  ): void {
    // Events that open chrome UI need keyboard focus in the chrome, not in the page.
    if (FOCUS_CHROME_EVENTS.has(name)) win.focusChrome()
    win.send(name, payload)
  }

  toast(message: string, kind: 'info' | 'error' = 'info', win?: ZenWindow): void {
    this.emit('toast', { message, kind }, win)
  }

  /** A page's DOM is ready: inject its Boost and check whether Reader View applies. */
  onPageReady(tabId: string): void {
    this.boosts.apply(tabId)
    void this.reader.detect(tabId)
  }

  onNavigated(tabId: string): void {
    const tab = this.tabs.tab(tabId)
    if (tab) tab.readerable = false
    this.extensions.closePopup()
  }

  updateMedia(): void {
    const media: MediaState[] = []
    for (const [tabId, view] of this.tabs.allViews()) {
      if (!view.isDestroyed() && view.isCurrentlyAudible()) media.push({ tabId, playing: true })
    }
    const before = JSON.stringify(this.state.media)
    this.state.media = media
    if (before !== JSON.stringify(media)) this.state.commitVolatile()
  }

  /** Zen: compact mode is per window; the last toggle is remembered for the next start. */
  toggleCompactMode(win: ZenWindow): void {
    win.compactEnabled = !win.compactEnabled
    win.compactSidebarPersistent = false
    win.compactSidebarRevealed = false
    this.state.settings.compactMode.enabled = win.compactEnabled
    this.state.commit()
  }

  setCompactMode(win: ZenWindow, enabled: boolean): void {
    win.compactEnabled = enabled
    if (!enabled) {
      win.compactSidebarPersistent = false
      win.compactSidebarRevealed = false
    }
    this.state.settings.compactMode.enabled = enabled
    this.state.commit()
  }

  toggleCompactSidebarPersistent(win: ZenWindow): void {
    if (!win.compactEnabled) {
      win.compactEnabled = true
      win.compactSidebarPersistent = true
      this.state.settings.compactMode.enabled = true
    } else {
      win.compactSidebarPersistent = !win.compactSidebarPersistent
    }
    win.compactSidebarRevealed = win.compactSidebarPersistent
    this.state.commit()
  }

  toggleFullscreen(win: ZenWindow): void {
    win.host.setFullScreen(!win.host.isFullScreen())
  }

  toggleBookmark(tabId: string): void {
    const tab = this.tabs.tab(tabId)
    if (!tab || tab.url.startsWith('zen://')) return
    const added = this.bookmarks.toggle(tab.url, tab.customTitle ?? tab.title, tab.favicon)
    this.toast(added ? 'Bookmark added' : 'Bookmark removed', 'info', this.tabs.windowFor(tabId))
  }

  newTabAfter(tabId: string, win: ZenWindow = this.tabs.windowFor(tabId)): void {
    const tab = this.tabs.tab(tabId)
    if (!tab) return
    this.tabs.createTab(
      {
        active: true,
        afterTabId: tabId,
        containerId: tab.containerId,
        pinned: tab.pinned,
        folderId: tab.folderId
      },
      win
    )
    this.emit('urlbar.toggle', { mode: 'edit', text: '' }, win)
  }

  createFolder(spaceId: string, name: string, icon: string, win?: ZenWindow): Folder {
    const folder = createFolder(this.state.model, spaceId, name, icon)
    this.state.commit()
    this.emit('folder.startRename', { folderId: folder.id }, win)
    return folder
  }

  newFolderWithTab(spaceId: string, tabId: string, win?: ZenWindow): void {
    const folder = createFolder(this.state.model, spaceId, 'New Folder', '📁')
    this.tabs.moveToFolder(tabId, folder.id)
    this.state.commit()
    this.emit('folder.startRename', { folderId: folder.id }, win)
  }

  updateFolder(
    folderId: string,
    patch: Partial<Pick<Folder, 'name' | 'icon' | 'collapsed'>>
  ): void {
    const folder = this.state.model.folders[folderId]
    if (!folder) return
    Object.assign(folder, patch)
    if (patch.name !== undefined && !patch.name.trim()) folder.name = 'Folder'
    this.state.commit()
  }

  deleteFolder(folderId: string, unpack: boolean): void {
    this.liveFolders.onFolderDeleted(folderId)
    const closed = deleteFolder(this.state.model, folderId, unpack)
    for (const id of closed) this.tabs.closeTab(id, true)
    this.state.commit()
  }

  /** Delete a space without asking (sync applied a deletion made elsewhere). */
  removeSpace(spaceId: string): void {
    const m = this.state.model
    const space = getSpace(m, spaceId)
    if (!space || space.windowId || m.spaces.length <= 1) return
    for (const id of [...space.tabIds]) this.tabs.closeTab(id, true)
    for (const folder of Object.values(m.folders))
      if (folder.spaceId === spaceId) {
        this.liveFolders.onFolderDeleted(folder.id)
        delete m.folders[folder.id]
      }
    const idx = m.spaces.indexOf(space)
    m.spaces.splice(idx, 1)
    const fallback = m.spaces[Math.max(0, idx - 1)].id
    if (m.activeSpaceId === spaceId) m.activeSpaceId = fallback
    for (const w of this.allWindows()) {
      w.selection.delete(spaceId)
      if (w.activeSpaceId === spaceId) this.tabs.switchSpace(fallback, w)
    }
  }

  reorderSpace(spaceId: string, index: number): void {
    reorderSpace(this.state.model, spaceId, index)
    this.state.commit()
  }

  unloadOtherSpaces(win: ZenWindow): void {
    for (const space of this.state.model.spaces) {
      if (space.id !== win.activeSpaceId) this.tabs.unloadSpace(space.id)
    }
  }

  async deleteSpace(spaceId: string, win: ZenWindow): Promise<void> {
    const m = this.state.model
    const space = getSpace(m, spaceId)
    if (!space || space.windowId || m.spaces.length <= 1) return
    const count = space.tabIds.length
    if (count > 0) {
      const ok = await this.platform.dialogs.confirm(
        {
          message: `Delete “${space.name}”?`,
          detail: `${count} tab${count === 1 ? '' : 's'} in this space will be closed. Essentials are kept.`,
          okLabel: 'Delete Space',
          cancelLabel: 'Cancel',
          danger: true
        },
        win
      )
      if (!ok) return
      // The space may have gone away while the dialog was up.
      if (!getSpace(m, spaceId) || m.spaces.length <= 1) return
    }
    this.removeSpace(spaceId)
    this.state.commit()
  }

  /** Space Routing: pick the space configured for a URL's domain, if any. */
  routeSpaceFor(url: string): string | null {
    const routing = this.state.settings.spaceRouting
    try {
      const host = new URL(url).hostname.replace(/^www\./, '')
      for (const [domain, spaceId] of Object.entries(routing)) {
        if (host === domain || host.endsWith(`.${domain}`))
          return getSpace(this.state.model, spaceId) ? spaceId : null
      }
    } catch {
      return null
    }
    return null
  }

  /** Zen 1.21: "Add Route for Domain" – route a tab's domain to a space. */
  addRouteForTab(tabId: string, spaceId: string): void {
    const tab = this.tabs.tab(tabId)
    const space = getSpace(this.state.model, spaceId)
    if (!tab || !space || space.windowId) return
    const domain = getDomain(tab.url)
    if (!domain) return
    this.state.settings.spaceRouting = { ...this.state.settings.spaceRouting, [domain]: spaceId }
    this.state.commit()
    this.toast(`${domain} now opens in ${space.name}`, 'info', this.tabs.windowFor(tabId))
  }

  /** Open a URL from outside the browser (command line, Android intent, share sheet). */
  openExternalUrl(url: string, win: ZenWindow = this.ensureWindow()): void {
    const routed = win.localSpace ? null : this.routeSpaceFor(url)
    const tab = this.tabs.createTab({ url, active: true, spaceId: routed ?? undefined }, win)
    if (routed && routed !== win.activeSpaceId) this.tabs.switchSpace(routed, win, tab.id)
    win.host.show()
    win.host.focus()
  }

  shutdown(): void {
    if (this.quitting) return
    this.quitting = true
    void this.agents.stop()
    this.flushSync()
    this.state.freeze()
  }

  /** Persist everything now (mobile hosts call this when the app is backgrounded). */
  flushSync(): void {
    this.state.flushSync()
    this.history.flushSync()
    this.downloads.flushSync()
    this.boosts.flushSync()
    this.liveFolders.flushSync()
    this.extensions.flushSync()
    this.mods.flushSync()
    this.sync.flushSync()
  }

  private syncShortcuts(): void {
    const bindings: KeyBinding[] = []
    for (const s of this.state.shortcuts) {
      if (s.binding) bindings.push(s.binding)
      bindings.push(...s.extraBindings)
    }
    this.platform.views.setShortcuts?.(bindings)
  }

  // ---------------------------------------------------------------------------
  // URL bar submission
  // ---------------------------------------------------------------------------

  private submitUrlbar(
    input: string,
    newTab: boolean,
    tabId: string | null,
    background: boolean,
    win: ZenWindow
  ): void {
    const text = input.trim()
    if (!text) return
    const engines = this.state.searchEngines
    const keyword = matchEngineKeyword(text, engines)
    let url: string | null = null
    let upgradedFrom: string | undefined
    if (keyword) {
      url = buildSearchUrl(keyword.engine, keyword.query)
    } else {
      url = inputToUrl(text)
      if (url && url.startsWith('https://') && !/^[a-z][a-z0-9+.-]*:/i.test(text))
        upgradedFrom = text
      if (!url) {
        const engine =
          engines.find((e) => e.id === this.state.settings.searchEngineId) ?? engines[0]
        url = buildSearchUrl(engine, text)
      }
    }
    if (!url) return
    const routed = win.localSpace ? null : this.routeSpaceFor(url)
    const target = tabId ? this.tabs.tab(tabId) : undefined
    if (newTab || !target) {
      const tab = this.tabs.createTab(
        {
          url,
          active: !background,
          spaceId: routed ?? undefined,
          load: false
        },
        win
      )
      if (routed && routed !== win.activeSpaceId && !background)
        this.tabs.switchSpace(routed, win, tab.id)
      if (upgradedFrom) this.tabs.navigate(tab.id, url, { upgradedFrom })
      else this.tabs.navigate(tab.id, url)
      return
    }
    this.tabs.navigate(target.id, url, { upgradedFrom })
  }

  // ---------------------------------------------------------------------------
  // Command surface
  // ---------------------------------------------------------------------------

  /** Run a chrome command for `win`. Unknown names throw so misuse surfaces during development. */
  handleCommand(win: ZenWindow, name: string, args: unknown): unknown {
    const handler = (this.handlers as Record<string, (a: unknown, w: ZenWindow) => unknown>)[name]
    if (!handler) throw new Error(`Unknown command: ${name}`)
    return handler(args, win)
  }

  /** A page script asked for something (Glance, third-party link routing, media state, zap). */
  handlePageMessage(tabId: string, message: PageMessage): void {
    const tab = this.tabs.tab(tabId)
    if (!tab || !message || typeof message.type !== 'string') return
    if (message.type === 'zap') {
      if (typeof message.selector === 'string') this.boosts.onZapped(tabId, message.selector)
      return
    }
    if (message.type === 'media') {
      if (!this.tabs.view(tabId)) return
      tab.audible = Boolean(message.playing)
      this.governor.onMedia(tabId, Boolean(message.playing))
      this.state.commitVolatile()
      this.updateMedia()
      return
    }
    if (typeof message.url !== 'string' || !/^https?:\/\//i.test(message.url)) return
    const win = this.tabs.windowFor(tabId)
    switch (message.type) {
      case 'glance':
        this.tabs.openGlance(
          message.url,
          tabId,
          clamp01(message.x ?? 0.5),
          clamp01(message.y ?? 0.5),
          win
        )
        return
      case 'open-tab': {
        const routed = win.localSpace ? null : this.routeSpaceFor(message.url)
        this.tabs.createTab(
          {
            url: message.url,
            active: !message.background,
            afterTabId: tab.essential ? undefined : tabId,
            containerId: tab.containerId,
            spaceId: routed ?? undefined
          },
          win
        )
        return
      }
      case 'navigate':
        this.tabs.navigate(tabId, message.url)
        return
    }
  }

  private commandHandlers(): CommandHandlers {
    const { tabs, state, platform } = this
    return {
      'app.getState': (_a, win) => state.snapshot(win),
      'app.listSpaces': () =>
        state.model.spaces.map((s) => ({ id: s.id, name: s.name, icon: s.icon })),
      'app.openExternal': ({ url }) => {
        if (/^(https?|mailto):/.test(url)) platform.shell.openExternal(url)
      },
      'app.quit': () => platform.app.quit(),
      'layout.report': (report, win) => win.applyLayout(report),

      'tab.create': (opts, win) => tabs.createTab(opts, win).id,
      'tab.activate': ({ tabId }, win) => tabs.activateTab(tabId, win),
      'tab.close': ({ tabId, force }, win) => tabs.closeTab(tabId, force, win),
      'tab.closeOthers': ({ tabId }, win) => tabs.closeOthers(tabId, win),
      'tab.closeBelow': ({ tabId }, win) => tabs.closeBelow(tabId, win),
      'tab.closeAbove': ({ tabId }, win) => tabs.closeAbove(tabId, win),
      'tab.navigate': ({ tabId, input }, win) => this.submitUrlbar(input, false, tabId, false, win),
      'tab.back': ({ tabId }) => tabs.goBack(tabId),
      'tab.forward': ({ tabId }) => tabs.goForward(tabId),
      'tab.reload': ({ tabId, skipCache }) => tabs.reload(tabId, skipCache),
      'tab.stop': ({ tabId }) => tabs.stop(tabId),
      'tab.toggleMute': ({ tabId }) => tabs.toggleMute(tabId),
      'tab.togglePin': ({ tabId }, win) => tabs.togglePin(tabId, win),
      'tab.toggleEssential': ({ tabId }, win) => tabs.toggleEssential(tabId, win),
      'tab.resetPinned': ({ tabId }, win) => tabs.resetPinned(tabId, true, win),
      'tab.editPinnedUrl': ({ tabId, url }) => tabs.editPinnedUrl(tabId, url),
      'tab.rename': ({ tabId, title }) => tabs.rename(tabId, title),
      'tab.setIcon': ({ tabId, icon }) => tabs.setIcon(tabId, icon),
      'tab.addRoute': ({ tabId, spaceId }) => this.addRouteForTab(tabId, spaceId),
      'tab.altClick': ({ tabId }, win) => tabs.altClick(tabId, win),
      'tab.selectionContextMenu': ({ tabIds }, win) =>
        this.menus.showSelectionContextMenu(tabIds, win),
      'tab.duplicate': ({ tabId }, win) => void tabs.duplicate(tabId, win),
      'tab.unload': ({ tabId }) => tabs.discard(tabId),
      'tab.freeze': ({ tabId }) => this.governor.freezeTab(tabId),
      'tab.wake': ({ tabId }) => this.governor.wakeTab(tabId),
      'tab.move': ({ tabId, spaceId, section, index }, win) =>
        tabs.moveTab(tabId, { spaceId, section, index }, win),
      'tab.moveToSpace': ({ tabId, spaceId }, win) => {
        const tab = tabs.tab(tabId)
        if (tab)
          tabs.moveTab(
            tabId,
            {
              spaceId,
              section: tab.pinned ? 'pinned' : 'regular',
              index: Number.MAX_SAFE_INTEGER
            },
            win
          )
      },
      'tab.moveToFolder': ({ tabId, folderId }) => tabs.moveToFolder(tabId, folderId),
      'tab.reopenClosed': (_a, win) => tabs.reopenClosed(win),
      'tab.setZoom': ({ tabId, delta }) =>
        delta === null ? tabs.setZoom(tabId, 1) : tabs.adjustZoom(tabId, delta),
      'tab.contextMenu': ({ tabId }, win) => this.menus.showTabContextMenu(tabId, win),
      'tab.toggleDevtools': ({ tabId }) => tabs.toggleDevtools(tabId),
      'tab.copyUrl': ({ tabId, markdown }) => tabs.copyUrl(tabId, markdown),

      'space.create': ({ name, icon, containerId, theme }, win) => {
        const space = createSpace(
          name.trim() || 'New Space',
          icon,
          state.model.containers.some((c) => c.id === containerId)
            ? containerId
            : DEFAULT_CONTAINER_ID
        )
        space.theme = theme
        state.model.spaces.push(space)
        if (!win.localSpace) tabs.switchSpace(space.id, win)
        state.commit()
        return space.id
      },
      'space.update': ({ spaceId, patch }) => {
        const space = getSpace(state.model, spaceId)
        if (!space) return
        if (patch.name !== undefined) space.name = patch.name.trim() || space.name
        if (patch.icon !== undefined) space.icon = patch.icon
        if (patch.theme !== undefined) space.theme = patch.theme
        if (
          patch.containerId !== undefined &&
          !space.windowId &&
          state.model.containers.some((c) => c.id === patch.containerId)
        ) {
          space.containerId = patch.containerId
        }
        state.commit()
      },
      'space.delete': ({ spaceId }, win) => this.deleteSpace(spaceId, win),
      'space.activate': ({ spaceId }, win) => tabs.switchSpace(spaceId, win),
      'space.next': (_a, win) => this.actions.run('space.next', { sourceTabId: null, win }),
      'space.prev': (_a, win) => this.actions.run('space.prev', { sourceTabId: null, win }),
      'space.reorder': ({ spaceId, index }) => this.reorderSpace(spaceId, index),
      'space.unload': ({ spaceId }) => tabs.unloadSpace(spaceId),
      'space.unloadOthers': (_a, win) => this.unloadOtherSpaces(win),
      'space.togglePinnedCollapsed': ({ spaceId }) => {
        const space = getSpace(state.model, spaceId)
        if (!space) return
        space.pinnedCollapsed = !space.pinnedCollapsed
        state.commit()
      },
      'space.closeUnpinned': ({ spaceId }, win) => tabs.closeUnpinned(spaceId, win),
      'space.contextMenu': ({ spaceId }, win) => this.menus.showSpaceContextMenu(spaceId, win),

      'folder.create': ({ spaceId, name, icon }, win) =>
        this.createFolder(spaceId, name, icon, win).id,
      'folder.update': ({ folderId, patch }) => this.updateFolder(folderId, patch),
      'folder.delete': ({ folderId, unpack }) => this.deleteFolder(folderId, unpack),
      'folder.contextMenu': ({ folderId }, win) => this.menus.showFolderContextMenu(folderId, win),
      'newtab.contextMenu': (_a, win) => this.menus.showNewTabContextMenu(win),
      'app.menu': (_a, win) => this.menus.showAppMenu(win),
      'focus.content': (_a, win) => win.focusContent(),
      'focus.chrome': (_a, win) => win.focusChrome(),
      'media.toggle': ({ tabId }) => {
        const view = tabs.view(tabId)
        if (!view) return
        void view
          .executeJavaScript(
            `(() => { const m = [...document.querySelectorAll('video,audio')].find(e => !e.paused) || document.querySelector('video,audio'); if (!m) return false; if (m.paused) { m.play().catch(() => {}); } else { m.pause(); } return true })()`
          )
          .catch(() => undefined)
      },

      'split.create': ({ tabIds, layout }, win) => tabs.createSplit(tabIds, layout, win),
      'split.toggleLayout': ({ layout }, win) => tabs.toggleSplitLayout(layout, win),
      'split.setLayout': ({ groupId, layout }) => tabs.setSplitLayout(groupId, layout),
      'split.unsplit': ({ groupId, tabId }, win) => tabs.unsplit(groupId, tabId, win),
      'split.removeTab': ({ tabId, focus }, win) => tabs.removeFromSplit(tabId, focus, win),
      'split.resize': ({ groupId, sizes }) => tabs.resizeSplit(groupId, sizes),
      'split.newEmpty': (_a, win) => tabs.newEmptySplit(win),
      'split.addTab': ({ groupId, tabId }) => tabs.addToSplit(groupId, tabId),

      'glance.open': ({ url, parentTabId, originX, originY }, win) =>
        tabs.openGlance(url, parentTabId, originX, originY, win),
      'glance.close': (_a, win) => tabs.closeGlance(win),
      'glance.expand': (_a, win) => tabs.expandGlance(win),
      'glance.split': (_a, win) => tabs.splitGlance(win),

      'compact.toggle': (_a, win) => this.toggleCompactMode(win),
      'compact.setRevealed': ({ revealed }, win) => {
        if (win.compactSidebarRevealed === revealed) return
        win.compactSidebarRevealed = revealed
        state.commitVolatile()
      },
      'compact.toggleSidebarPersistent': (_a, win) => this.toggleCompactSidebarPersistent(win),
      'compact.setOptions': (patch) => {
        Object.assign(state.settings.compactMode, patch)
        state.commit()
      },

      'urlbar.suggest': ({ query, tabId }, win) => this.suggestions.suggest(query, tabId, win),
      'urlbar.submit': ({ input, newTab, tabId, background }, win) =>
        this.submitUrlbar(input, newTab, tabId, Boolean(background), win),
      'urlbar.runCommand': ({ action }, win) =>
        this.actions.run(action as AnyAction, { sourceTabId: null, win }),

      'overlay.snapshot': ({ tabId }, win) => win.snapshot(tabId),

      'resources.snapshot': () => this.governor.sample(),
      'resources.trim': () => this.governor.trim(),
      'resources.relaunch': () => this.governor.relaunch(),

      'settings.update': (patch, win) => this.updateSettings(patch, win),
      'shortcuts.update': ({ id, binding }) => {
        state.setShortcutOverride(id, binding)
        this.syncShortcuts()
        state.commit()
      },
      'shortcuts.reset': () => {
        state.resetShortcuts()
        this.syncShortcuts()
        state.commit()
      },
      'sidebar.setWidth': ({ width }) => {
        state.settings.sidebarWidth = Math.max(160, Math.min(520, Math.round(width)))
        state.commit()
      },
      'sidebar.toggleExpanded': () => {
        state.settings.sidebarExpanded = !state.settings.sidebarExpanded
        state.commit()
      },

      'history.search': ({ query, limit }) => this.history.search(query, limit),
      'history.recent': ({ limit }) => this.history.recent(limit),
      'history.delete': ({ url }) => this.history.delete(url),
      'history.clear': () => this.history.clear(),

      'bookmark.toggle': ({ tabId }) => this.toggleBookmark(tabId),
      'bookmark.remove': ({ id }) => this.bookmarks.remove(id),
      'bookmark.add': ({ url, title }) => void this.bookmarks.add(url, title),

      'download.pause': ({ id }) => this.downloads.pause(id),
      'download.resume': ({ id }) => this.downloads.resume(id),
      'download.cancel': ({ id }) => this.downloads.cancel(id),
      'download.showInFolder': ({ id }) => this.downloads.showInFolder(id),
      'download.open': ({ id }) => this.downloads.open(id),
      'download.remove': ({ id }) => {
        this.downloads.remove(id)
        state.downloads = this.downloads.items
        state.commitVolatile()
      },
      'download.clearCompleted': () => {
        this.downloads.clearCompleted()
        state.downloads = this.downloads.items
        state.commitVolatile()
      },

      'find.start': ({ tabId, text, forward, newSession }, win) => {
        const view = tabs.view(tabId)
        if (!view) return
        if (!text) {
          view.stopFind('clearSelection')
          win.findResult = null
          state.commitVolatile()
          return
        }
        view.findInPage(text, forward, newSession)
      },
      'find.stop': ({ tabId, keepSelection }, win) => {
        tabs.view(tabId)?.stopFind(keepSelection ? 'keepSelection' : 'clearSelection')
        win.findResult = null
        state.commitVolatile()
      },

      'container.create': ({ name, color, icon }) => {
        const id = newId('container')
        state.model.containers.push({ id, name: name.trim() || 'Container', color, icon })
        state.commit()
        return id
      },
      'container.update': ({ id, patch }) => {
        const c = state.model.containers.find((x) => x.id === id)
        if (!c || id === DEFAULT_CONTAINER_ID) return
        Object.assign(c, patch)
        state.commit()
      },
      'container.delete': ({ id }) => {
        if (id === DEFAULT_CONTAINER_ID) return
        state.model.containers = state.model.containers.filter((c) => c.id !== id)
        for (const space of state.model.spaces)
          if (space.containerId === id) space.containerId = DEFAULT_CONTAINER_ID
        for (const tab of Object.values(state.model.tabs))
          if (tab.containerId === id) tab.containerId = DEFAULT_CONTAINER_ID
        void platform.sessions.clearContainerData(id)
        state.commit()
      },
      'container.reorder': ({ id, index }) => {
        reorderContainer(state.model, id, index)
        state.commit()
      },

      'window.minimize': (_a, win) => win.host.minimize(),
      'window.toggleMaximize': (_a, win) =>
        win.host.isMaximized() ? win.host.unmaximize() : win.host.maximize(),
      'window.close': (_a, win) => win.host.close(),
      'window.toggleFullscreen': (_a, win) => this.toggleFullscreen(win),
      'window.new': (_a, win) => void this.openWindow('synced', win),
      'window.newUnsynced': (_a, win) => void this.openWindow('unsynced', win),
      'window.newPrivate': (_a, win) => void this.openWindow('private', win),
      'window.moveTabsToSpace': ({ spaceId }, win) => tabs.moveLocalTabsToSpace(win, spaceId),

      'page.screenshot': ({ tabId }, win) =>
        this.actions.run('page.screenshot', { sourceTabId: tabId, win }),
      'page.print': ({ tabId }, win) => this.actions.run('page.print', { sourceTabId: tabId, win }),
      'page.savePage': ({ tabId }, win) =>
        this.actions.run('page.savePage', { sourceTabId: tabId, win }),
      'page.viewSource': ({ tabId }, win) =>
        this.actions.run('page.viewSource', { sourceTabId: tabId, win }),
      'page.contextMenu': ({ tabId, linkURL, srcURL, x, y }, win) =>
        this.menus.showPageContextMenu(
          tabId,
          {
            x,
            y,
            linkURL,
            srcURL,
            mediaType: srcURL ? 'image' : 'none',
            selectionText: '',
            isEditable: false,
            misspelledWord: '',
            dictionarySuggestions: [],
            editFlags: {
              canUndo: false,
              canRedo: false,
              canCut: false,
              canCopy: false,
              canPaste: false,
              canDelete: false,
              canSelectAll: false
            }
          },
          win
        ),

      'menu.click': ({ menuId, itemId }) => platform.menus.activate?.(menuId, itemId),
      'menu.close': ({ menuId }) => platform.menus.dismiss?.(menuId),

      'boost.update': ({ domain, patch }) => this.boosts.update(domain, patch),
      'boost.remove': ({ domain }) => this.boosts.remove(domain),
      'boost.startZap': ({ tabId }) => this.boosts.startZap(tabId),
      'boost.stopZap': ({ tabId }) => this.boosts.stopZap(tabId),

      'reader.toggle': ({ tabId }, win) => this.reader.toggle(tabId, win),

      'liveFolder.save': ({ folderId, name, config }, win) => {
        let id = folderId
        if (!id || !state.model.folders[id]) {
          const space = win.activeSpace()
          if (space.windowId) return ''
          const folder = createFolder(state.model, space.id, name.trim() || 'Live Folder', '📡')
          id = folder.id
        } else if (name.trim()) {
          state.model.folders[id].name = name.trim()
        }
        this.liveFolders.save(id, config)
        state.commit()
        return id
      },
      'liveFolder.refresh': ({ folderId }) => void this.liveFolders.refresh(folderId, true),
      'liveFolder.remove': ({ folderId }) => this.liveFolders.remove(folderId),

      'extension.add': (_a, win) => this.extensions.addFromDialog(win),
      'extension.remove': ({ id }) => this.extensions.remove(id),
      'extension.setEnabled': ({ id, enabled }) => this.extensions.setEnabled(id, enabled),
      'extension.openPopup': ({ id, anchor }, win) => this.extensions.openPopup(id, anchor, win),
      'extension.closePopup': () => this.extensions.closePopup(),

      'mod.add': ({ name, css, source }) => this.mods.add(name, css, source ?? null).id,
      'mod.update': ({ id, patch }) => this.mods.update(id, patch),
      'mod.remove': ({ id }) => this.mods.remove(id),
      'mod.importFile': (_a, win) => this.mods.importFile(win),
      'mod.importUrl': ({ url }, win) => this.mods.importUrl(url, win),

      'sync.chooseFolder': (_a, win) => this.sync.chooseFolder(win),
      'sync.setup': (opts, win) => this.sync.setup(opts, win),
      'sync.setScope': (patch) => this.sync.setScope(patch),
      'sync.setDeviceName': ({ name }) => this.sync.setDeviceName(name),
      'sync.now': () => this.sync.syncNow(),
      'sync.confirmMerge': ({ merge }) => this.sync.confirmMerge(merge),
      'sync.disconnect': ({ wipeRemote }) => this.sync.disconnect(wipeRemote),

      'agent.disconnect': ({ id }) => this.agents.disconnect(id),
      'agent.setMode': ({ id, mode }) => this.agents.setMode(id, mode),
      'agent.releaseTab': ({ tabId }) => this.agents.releaseTab(tabId),
      'agent.forget': ({ name }) => this.agents.forget(name),
      'agent.regenerateToken': () => this.agents.regenerateToken(),

      'onboarding.complete': ({ searchEngineId, colorScheme, essentials }, win) => {
        if (state.searchEngines.some((e) => e.id === searchEngineId))
          state.settings.searchEngineId = searchEngineId
        state.settings.colorScheme = colorScheme
        state.settings.onboardingDone = true
        for (const url of essentials) {
          const known = ONBOARDING_ESSENTIALS.find((e) => e.url === url)
          if (!known) continue
          // Essentials chosen during onboarding stay unloaded until clicked (privacy).
          const tab = tabs.createTab(
            {
              url: known.url,
              essential: true,
              active: false,
              load: false
            },
            win
          )
          tab.title = known.title
        }
        state.commit()
        this.emit('urlbar.toggle', { mode: 'new-tab' }, win)
      }
    }
  }

  private updateSettings(patch: Partial<Settings>, win: ZenWindow): void {
    const s = this.state.settings
    const before = {
      glance: s.glanceEnabled,
      trigger: s.glanceTrigger,
      thirdParty: s.thirdPartyOnPinned,
      windowSync: s.windowSync,
      resources: JSON.stringify(s.resources),
      unload: `${s.unloadEnabled}:${s.unloadTimeoutMinutes}:${s.unloadExcludedDomains.join(',')}`,
      agents: JSON.stringify(s.agents)
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      if (key === 'compactMode' && value && typeof value === 'object') {
        const cm = value as Partial<Settings['compactMode']>
        if (cm.enabled !== undefined && cm.enabled !== win.compactEnabled)
          this.setCompactMode(win, cm.enabled)
        Object.assign(s.compactMode, cm)
      } else if (key === 'resources' && value && typeof value === 'object') {
        const incoming = value as Partial<Settings['resources']>
        s.resources = sanitizeResourceSettings({
          ...s.resources,
          ...incoming,
          process: { ...s.resources.process, ...(incoming.process ?? {}) }
        })
      } else if (key === 'agents' && value && typeof value === 'object') {
        s.agents = sanitizeAgentSettings({ ...s.agents, ...(value as Partial<Settings['agents']>) })
      } else {
        ;(s as unknown as Record<string, unknown>)[key] = value
      }
    }
    s.sidebarWidth = Math.max(160, Math.min(520, s.sidebarWidth))
    s.unloadTimeoutMinutes = Math.max(1, Math.min(24 * 60, Math.round(s.unloadTimeoutMinutes)))
    s.essentialsMax = Math.max(1, Math.min(24, Math.round(s.essentialsMax)))
    if (
      before.glance !== s.glanceEnabled ||
      before.trigger !== s.glanceTrigger ||
      before.thirdParty !== s.thirdPartyOnPinned
    ) {
      this.tabs.broadcastPageFlags()
    }
    if (before.windowSync !== s.windowSync) {
      // Leaving "pinned only" shares every tab again; entering it keeps existing tabs shared.
      if (s.windowSync !== 'pinned')
        for (const tab of Object.values(this.state.model.tabs))
          if (tab.spaceId && !this.state.model.localSpaces[tab.spaceId]) tab.windowId = null
    }
    if (
      before.resources !== JSON.stringify(s.resources) ||
      before.unload !==
        `${s.unloadEnabled}:${s.unloadTimeoutMinutes}:${s.unloadExcludedDomains.join(',')}`
    ) {
      this.governor.onSettingsChanged()
    }
    if (before.agents !== JSON.stringify(s.agents)) this.agents.onSettingsChanged()
    this.state.commit()
  }

  /** Cycle spaces relative to a window's current one. */
  cycleSpaceIn(win: ZenWindow, delta: number): void {
    if (win.localSpace) return
    this.tabs.switchSpace(cycleSpace(this.state.model, delta, win.activeSpaceId).id, win)
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5))
}
