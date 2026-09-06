import { app, dialog, ipcMain, shell, type Session, type WebContents } from 'electron'
import type {
  CommandArgs,
  CommandName,
  CommandResult,
  EventName,
  Events,
  Folder,
  MediaState,
  Platform,
  Settings
} from '../../shared/types'
import { BrowserState } from './state'
import { SessionManager, buildUserAgent } from './sessions'
import { installZenProtocol } from './protocol'
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
import { createFolder, createSpace, deleteFolder, getSpace, reorderSpace } from './model'
import { inputToUrl } from '../../shared/url'
import { buildSearchUrl, matchEngineKeyword } from '../../shared/search'
import { DEFAULT_CONTAINER_ID } from '../../shared/types'
import { ONBOARDING_ESSENTIALS } from '../../shared/defaults'
import { newId } from '../../shared/ids'

type CommandHandlers = {
  [K in CommandName]: (args: CommandArgs<K>) => CommandResult<K> | Promise<CommandResult<K>>
}

const FOCUS_CHROME_EVENTS = new Set<EventName>([
  'urlbar.toggle',
  'overlay.open',
  'find.open',
  'theme.open',
  'space.new',
  'space.edit',
  'tab.startRename',
  'folder.startRename'
])

interface PageMessage {
  type: 'glance' | 'open-tab' | 'navigate'
  url: string
  x?: number
  y?: number
  background?: boolean
}

/**
 * The browser: wires every service together and implements the IPC command surface.
 */
export class Browser {
  readonly state: BrowserState
  readonly sessions: SessionManager
  readonly history: HistoryService
  readonly bookmarks: BookmarkService
  readonly downloads: DownloadService
  readonly permissions: PermissionService
  readonly tabs: TabManager
  readonly window: ZenWindow
  readonly actions: Actions
  readonly keys: KeyboardHandler
  readonly menus: Menus
  readonly suggestions: SuggestionService
  private unloadTimer: NodeJS.Timeout | null = null
  private quitting = false

  constructor(userDataDir: string) {
    const platform = process.platform as Platform
    this.state = new BrowserState(userDataDir, platform, app.getVersion())
    this.state.load()
    this.sessions = new SessionManager(buildUserAgent())
    this.history = new HistoryService(userDataDir)
    this.bookmarks = new BookmarkService(this.state)
    this.downloads = new DownloadService(
      userDataDir,
      () => this.state.settings.askWhereToSave,
      () => {
        this.state.downloads = this.downloads.items
        this.state.commitVolatile()
      }
    )
    this.state.downloads = this.downloads.items
    this.permissions = new PermissionService(userDataDir, () =>
      this.window?.win && !this.window.win.isDestroyed() ? this.window.win : null
    )
    this.tabs = new TabManager(this)
    this.window = new ZenWindow(this)
    this.actions = new Actions(this)
    this.keys = new KeyboardHandler(this)
    this.menus = new Menus(this)
    this.suggestions = new SuggestionService(this)

    this.sessions.configure((ses: Session) => {
      installZenProtocol(ses)
      this.permissions.attach(ses)
      this.downloads.attach(ses, (source) => this.onDownloadStarted(source))
      ses.setSpellCheckerLanguages(['en-US'])
    })
    this.sessions.get(DEFAULT_CONTAINER_ID)
  }

  /**
   * A navigation that turned into a download leaves its tab without a committed document (and
   * without a renderer to route shortcuts through). Like Chrome, close such a tab when it was
   * opened only for the download; otherwise just make sure the keyboard keeps working.
   */
  private onDownloadStarted(source: WebContents | undefined): void {
    // Firefox shows the downloads panel whenever a download begins. Let any tab switch paint
    // first so the panel can dim a snapshot of the page behind it.
    setTimeout(() => this.emit('overlay.open', { kind: 'downloads' }), 200)
    if (!source || source.isDestroyed()) return
    const tabId = this.tabs.tabIdForWebContents(source)
    const tab = tabId ? this.tabs.tab(tabId) : undefined
    if (!tab) return
    const hasDocument = source.getURL() !== '' && source.getURL() !== 'about:blank'
    if (hasDocument) return
    if (!tab.pinned && !tab.essential && !source.navigationHistory.canGoBack()) {
      this.tabs.closeTab(tab.id)
    } else {
      this.window?.focusChrome()
    }
  }

  start(): void {
    this.registerIpc()
    if (this.state.settings.pinnedResetOnStartup) {
      for (const tab of Object.values(this.state.model.tabs)) {
        if ((tab.pinned || tab.essential) && tab.pinnedUrl) tab.url = tab.pinnedUrl
      }
    }
    this.window.create()
    this.state.subscribe((snapshot) => this.window.send('state', snapshot))
    this.window.win.webContents.on('did-finish-load', () => {
      this.window.send('state', this.state.snapshot())
    })
    if (this.state.settings.onboardingDone) {
      for (const id of this.tabs.visibleTabIds()) this.tabs.ensureLoaded(id)
    }
    this.unloadTimer = setInterval(() => this.tabs.unloadInactive(), 60_000)
    this.state.commit()
  }

  // ---------------------------------------------------------------------------
  // Helpers used across services
  // ---------------------------------------------------------------------------

  emit<K extends EventName>(name: K, payload: Events[K]): void {
    // Events that open chrome UI need keyboard focus in the chrome, not in the page.
    if (FOCUS_CHROME_EVENTS.has(name)) this.window.focusChrome()
    this.window.send(name, payload)
  }

  toast(message: string, kind: 'info' | 'error' = 'info'): void {
    this.emit('toast', { message, kind })
  }

  updateMedia(): void {
    const media: MediaState[] = []
    for (const [tabId] of this.tabs.allViews()) {
      const wc = this.tabs.webContents(tabId)
      if (wc && wc.isCurrentlyAudible()) media.push({ tabId, playing: true })
    }
    const before = JSON.stringify(this.state.media)
    this.state.media = media
    if (before !== JSON.stringify(media)) this.state.commitVolatile()
  }

  toggleCompactMode(): void {
    const cm = this.state.settings.compactMode
    cm.enabled = !cm.enabled
    cm.sidebarPersistent = false
    this.state.compactSidebarRevealed = false
    this.state.commit()
  }

  toggleCompactSidebarPersistent(): void {
    const cm = this.state.settings.compactMode
    if (!cm.enabled) {
      cm.enabled = true
      cm.sidebarPersistent = true
    } else {
      cm.sidebarPersistent = !cm.sidebarPersistent
    }
    this.state.compactSidebarRevealed = cm.sidebarPersistent
    this.state.commit()
  }

  toggleFullscreen(): void {
    const win = this.window.win
    win.setFullScreen(!win.isFullScreen())
  }

  toggleBookmark(tabId: string): void {
    const tab = this.tabs.tab(tabId)
    if (!tab || tab.url.startsWith('zen://')) return
    const added = this.bookmarks.toggle(tab.url, tab.customTitle ?? tab.title, tab.favicon)
    this.toast(added ? 'Bookmark added' : 'Bookmark removed')
  }

  newTabAfter(tabId: string): void {
    const tab = this.tabs.tab(tabId)
    if (!tab) return
    this.tabs.createTab({
      active: true,
      afterTabId: tabId,
      containerId: tab.containerId,
      pinned: tab.pinned,
      folderId: tab.folderId
    })
    this.emit('urlbar.toggle', { mode: 'edit', text: '' })
  }

  createFolder(spaceId: string, name: string, icon: string): Folder {
    const folder = createFolder(this.state.model, spaceId, name, icon)
    this.state.commit()
    this.emit('folder.startRename', { folderId: folder.id })
    return folder
  }

  newFolderWithTab(spaceId: string, tabId: string): void {
    const folder = createFolder(this.state.model, spaceId, 'New Folder', '📁')
    this.tabs.moveToFolder(tabId, folder.id)
    this.state.commit()
    this.emit('folder.startRename', { folderId: folder.id })
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
    const closed = deleteFolder(this.state.model, folderId, unpack)
    for (const id of closed) this.tabs.closeTab(id, true)
    this.state.commit()
  }

  reorderSpace(spaceId: string, index: number): void {
    reorderSpace(this.state.model, spaceId, index)
    this.state.commit()
  }

  unloadOtherSpaces(): void {
    for (const space of this.state.model.spaces) {
      if (space.id !== this.state.model.activeSpaceId) this.tabs.unloadSpace(space.id)
    }
  }

  deleteSpace(spaceId: string): void {
    const m = this.state.model
    const space = getSpace(m, spaceId)
    if (!space || m.spaces.length <= 1) return
    const count = space.tabIds.length
    if (count > 0) {
      const choice = dialog.showMessageBoxSync(this.window.win, {
        type: 'warning',
        buttons: ['Delete Space', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `Delete “${space.name}”?`,
        detail: `${count} tab${count === 1 ? '' : 's'} in this space will be closed. Essentials are kept.`,
        noLink: true
      })
      if (choice !== 0) return
    }
    for (const id of [...space.tabIds]) this.tabs.closeTab(id, true)
    for (const folder of Object.values(m.folders))
      if (folder.spaceId === spaceId) delete m.folders[folder.id]
    const idx = m.spaces.indexOf(space)
    m.spaces.splice(idx, 1)
    if (m.activeSpaceId === spaceId) this.tabs.switchSpace(m.spaces[Math.max(0, idx - 1)].id)
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

  onWindowClosed(): void {
    if (this.unloadTimer) clearInterval(this.unloadTimer)
    this.tabs.destroyAll()
    if (process.platform !== 'darwin') app.quit()
  }

  shutdown(): void {
    if (this.quitting) return
    this.quitting = true
    this.state.flushSync()
    this.history.flushSync()
    this.downloads.flushSync()
  }

  // ---------------------------------------------------------------------------
  // URL bar submission
  // ---------------------------------------------------------------------------

  private submitUrlbar(
    input: string,
    newTab: boolean,
    tabId: string | null,
    background = false
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
    const routed = this.routeSpaceFor(url)
    const target = tabId ? this.tabs.tab(tabId) : undefined
    if (newTab || !target) {
      const tab = this.tabs.createTab({
        url,
        active: !background,
        spaceId: routed ?? undefined,
        load: false
      })
      if (routed && routed !== this.state.model.activeSpaceId && !background)
        this.tabs.switchSpace(routed, tab.id)
      if (upgradedFrom) this.tabs.navigate(tab.id, url, { upgradedFrom })
      else this.tabs.navigate(tab.id, url)
      return
    }
    this.tabs.navigate(target.id, url, { upgradedFrom })
  }

  // ---------------------------------------------------------------------------
  // IPC
  // ---------------------------------------------------------------------------

  private registerIpc(): void {
    const handlers = this.commandHandlers()
    ipcMain.handle('zen:cmd', async (event, name: CommandName, args: unknown) => {
      if (event.sender !== this.window.win.webContents) throw new Error('Unauthorised sender')
      const handler = handlers[name] as ((a: unknown) => unknown) | undefined
      if (!handler) throw new Error(`Unknown command: ${name}`)
      return handler(args)
    })
    ipcMain.on('zen:page', (event, message: PageMessage) => {
      const tabId = this.tabs.tabIdForWebContents(event.sender)
      if (!tabId) return
      const tab = this.tabs.tab(tabId)
      if (!tab || typeof message?.url !== 'string' || !/^https?:\/\//i.test(message.url)) return
      switch (message.type) {
        case 'glance':
          this.tabs.openGlance(
            message.url,
            tabId,
            clamp01(message.x ?? 0.5),
            clamp01(message.y ?? 0.5)
          )
          return
        case 'open-tab': {
          const routed = this.routeSpaceFor(message.url)
          this.tabs.createTab({
            url: message.url,
            active: !message.background,
            afterTabId: tab.essential ? undefined : tabId,
            containerId: tab.containerId,
            spaceId: routed ?? undefined
          })
          return
        }
        case 'navigate':
          this.tabs.navigate(tabId, message.url)
          return
      }
    })
  }

  private commandHandlers(): CommandHandlers {
    const { tabs, state } = this
    return {
      'app.getState': () => state.snapshot(),
      'app.openExternal': ({ url }) => {
        if (/^(https?|mailto):/.test(url)) void shell.openExternal(url)
      },
      'app.quit': () => app.quit(),
      'layout.report': (report) => this.window.applyLayout(report),

      'tab.create': (opts) => tabs.createTab(opts).id,
      'tab.activate': ({ tabId }) => tabs.activateTab(tabId),
      'tab.close': ({ tabId, force }) => tabs.closeTab(tabId, force),
      'tab.closeOthers': ({ tabId }) => tabs.closeOthers(tabId),
      'tab.closeBelow': ({ tabId }) => tabs.closeBelow(tabId),
      'tab.closeAbove': ({ tabId }) => tabs.closeAbove(tabId),
      'tab.navigate': ({ tabId, input }) => this.submitUrlbar(input, false, tabId),
      'tab.back': ({ tabId }) => tabs.goBack(tabId),
      'tab.forward': ({ tabId }) => tabs.goForward(tabId),
      'tab.reload': ({ tabId, skipCache }) => tabs.reload(tabId, skipCache),
      'tab.stop': ({ tabId }) => tabs.stop(tabId),
      'tab.toggleMute': ({ tabId }) => tabs.toggleMute(tabId),
      'tab.togglePin': ({ tabId }) => tabs.togglePin(tabId),
      'tab.toggleEssential': ({ tabId }) => tabs.toggleEssential(tabId),
      'tab.resetPinned': ({ tabId }) => tabs.resetPinned(tabId),
      'tab.editPinnedUrl': ({ tabId, url }) => tabs.editPinnedUrl(tabId, url),
      'tab.rename': ({ tabId, title }) => tabs.rename(tabId, title),
      'tab.duplicate': ({ tabId }) => void tabs.duplicate(tabId),
      'tab.unload': ({ tabId }) => tabs.discard(tabId),
      'tab.move': ({ tabId, spaceId, section, index }) =>
        tabs.moveTab(tabId, { spaceId, section, index }),
      'tab.moveToSpace': ({ tabId, spaceId }) => {
        const tab = tabs.tab(tabId)
        if (tab)
          tabs.moveTab(tabId, {
            spaceId,
            section: tab.pinned ? 'pinned' : 'regular',
            index: Number.MAX_SAFE_INTEGER
          })
      },
      'tab.moveToFolder': ({ tabId, folderId }) => tabs.moveToFolder(tabId, folderId),
      'tab.reopenClosed': () => tabs.reopenClosed(),
      'tab.setZoom': ({ tabId, delta }) =>
        delta === null ? tabs.setZoom(tabId, 1) : tabs.adjustZoom(tabId, delta),
      'tab.contextMenu': ({ tabId }) => this.menus.showTabContextMenu(tabId),
      'tab.toggleDevtools': ({ tabId }) => tabs.toggleDevtools(tabId),
      'tab.copyUrl': ({ tabId, markdown }) => tabs.copyUrl(tabId, markdown),
      'tab.pickIcon': () => undefined,

      'space.create': ({ name, icon, containerId, theme }) => {
        const space = createSpace(
          name.trim() || 'New Space',
          icon,
          state.model.containers.some((c) => c.id === containerId)
            ? containerId
            : DEFAULT_CONTAINER_ID
        )
        space.theme = theme
        state.model.spaces.push(space)
        tabs.switchSpace(space.id)
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
          state.model.containers.some((c) => c.id === patch.containerId)
        ) {
          space.containerId = patch.containerId
        }
        state.commit()
      },
      'space.delete': ({ spaceId }) => this.deleteSpace(spaceId),
      'space.activate': ({ spaceId }) => tabs.switchSpace(spaceId),
      'space.next': () => this.actions.run('space.next'),
      'space.prev': () => this.actions.run('space.prev'),
      'space.reorder': ({ spaceId, index }) => this.reorderSpace(spaceId, index),
      'space.unload': ({ spaceId }) => tabs.unloadSpace(spaceId),
      'space.unloadOthers': () => this.unloadOtherSpaces(),
      'space.togglePinnedCollapsed': ({ spaceId }) => {
        const space = getSpace(state.model, spaceId)
        if (!space) return
        space.pinnedCollapsed = !space.pinnedCollapsed
        state.commit()
      },
      'space.closeUnpinned': ({ spaceId }) => tabs.closeUnpinned(spaceId),
      'space.contextMenu': ({ spaceId }) => this.menus.showSpaceContextMenu(spaceId),

      'folder.create': ({ spaceId, name, icon }) => this.createFolder(spaceId, name, icon).id,
      'folder.update': ({ folderId, patch }) => this.updateFolder(folderId, patch),
      'folder.delete': ({ folderId, unpack }) => this.deleteFolder(folderId, unpack),
      'folder.contextMenu': ({ folderId }) => this.menus.showFolderContextMenu(folderId),
      'newtab.contextMenu': () => this.menus.showNewTabContextMenu(),
      'app.menu': () => this.menus.showAppMenu(),
      'focus.content': () => this.window.focusContent(),
      'focus.chrome': () => this.window.focusChrome(),
      'media.toggle': ({ tabId }) => {
        const wc = tabs.webContents(tabId)
        if (!wc) return
        void wc
          .executeJavaScript(
            `(() => { const m = [...document.querySelectorAll('video,audio')].find(e => !e.paused) || document.querySelector('video,audio'); if (!m) return false; if (m.paused) { m.play().catch(() => {}); } else { m.pause(); } return true })()`,
            true
          )
          .catch(() => undefined)
      },

      'split.create': ({ tabIds, layout }) => tabs.createSplit(tabIds, layout),
      'split.toggleLayout': ({ layout }) => tabs.toggleSplitLayout(layout),
      'split.setLayout': ({ groupId, layout }) => tabs.setSplitLayout(groupId, layout),
      'split.unsplit': ({ groupId, tabId }) => tabs.unsplit(groupId, tabId),
      'split.removeTab': ({ tabId, focus }) => tabs.removeFromSplit(tabId, focus),
      'split.resize': ({ groupId, sizes }) => tabs.resizeSplit(groupId, sizes),
      'split.newEmpty': () => tabs.newEmptySplit(),
      'split.addTab': ({ groupId, tabId }) => tabs.addToSplit(groupId, tabId),

      'glance.open': ({ url, parentTabId, originX, originY }) =>
        tabs.openGlance(url, parentTabId, originX, originY),
      'glance.close': () => tabs.closeGlance(),
      'glance.expand': () => tabs.expandGlance(),
      'glance.split': () => tabs.splitGlance(),

      'compact.toggle': () => this.toggleCompactMode(),
      'compact.setRevealed': ({ revealed }) => {
        if (state.compactSidebarRevealed === revealed) return
        state.compactSidebarRevealed = revealed
        state.commitVolatile()
      },
      'compact.toggleSidebarPersistent': () => this.toggleCompactSidebarPersistent(),
      'compact.setOptions': (patch) => {
        Object.assign(state.settings.compactMode, patch)
        state.commit()
      },

      'urlbar.suggest': ({ query, tabId }) => this.suggestions.suggest(query, tabId),
      'urlbar.submit': ({ input, newTab, tabId, background }) =>
        this.submitUrlbar(input, newTab, tabId, background),
      'urlbar.runCommand': ({ action }) => this.actions.run(action as AnyAction),

      'overlay.snapshot': ({ tabId }) => this.window.snapshot(tabId),

      'settings.update': (patch) => this.updateSettings(patch),
      'shortcuts.update': ({ id, binding }) => {
        state.setShortcutOverride(id, binding)
        state.commit()
      },
      'shortcuts.reset': () => {
        state.resetShortcuts()
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

      'find.start': ({ tabId, text, forward, newSession }) => {
        const wc = tabs.webContents(tabId)
        if (!wc) return
        if (!text) {
          wc.stopFindInPage('clearSelection')
          state.findResult = null
          state.commitVolatile()
          return
        }
        // Electron: findNext=true begins a new session, false continues the current one.
        wc.findInPage(text, { forward, findNext: newSession })
      },
      'find.stop': ({ tabId, keepSelection }) => {
        tabs.webContents(tabId)?.stopFindInPage(keepSelection ? 'keepSelection' : 'clearSelection')
        state.findResult = null
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
        void this.sessions.clearContainerData(id)
        state.commit()
      },

      'window.minimize': () => this.window.win.minimize(),
      'window.toggleMaximize': () =>
        this.window.win.isMaximized() ? this.window.win.unmaximize() : this.window.win.maximize(),
      'window.close': () => this.window.win.close(),
      'window.toggleFullscreen': () => this.toggleFullscreen(),

      'page.screenshot': ({ tabId }) => this.actions.run('page.screenshot', { sourceTabId: tabId }),
      'page.print': ({ tabId }) => this.actions.run('page.print', { sourceTabId: tabId }),
      'page.savePage': ({ tabId }) => this.actions.run('page.savePage', { sourceTabId: tabId }),
      'page.viewSource': ({ tabId }) => this.actions.run('page.viewSource', { sourceTabId: tabId }),

      'onboarding.complete': ({ searchEngineId, colorScheme, essentials }) => {
        if (state.searchEngines.some((e) => e.id === searchEngineId))
          state.settings.searchEngineId = searchEngineId
        state.settings.colorScheme = colorScheme
        state.settings.onboardingDone = true
        for (const url of essentials) {
          const known = ONBOARDING_ESSENTIALS.find((e) => e.url === url)
          if (!known) continue
          // Essentials chosen during onboarding stay unloaded until clicked (privacy).
          const tab = tabs.createTab({
            url: known.url,
            essential: true,
            active: false,
            load: false
          })
          tab.title = known.title
        }
        state.commit()
        this.emit('urlbar.toggle', { mode: 'new-tab' })
      }
    }
  }

  private updateSettings(patch: Partial<Settings>): void {
    const s = this.state.settings
    const before = {
      glance: s.glanceEnabled,
      trigger: s.glanceTrigger,
      thirdParty: s.thirdPartyOnPinned
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      if (key === 'compactMode' && value && typeof value === 'object') {
        Object.assign(s.compactMode, value)
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
    this.state.commit()
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5))
}
