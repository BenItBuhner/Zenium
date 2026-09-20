import type { ShortcutAction } from '../shared/types'
import { pathToFileUrl } from '../shared/launchArgs'
import { BLANK_URL } from '../shared/url'
import type { Browser } from './browser'
import { selectionQuery } from './find'
import type { ZenWindow } from './window'

/** How long Ctrl+F waits for the page to report its selection before the bar opens without it. */
const SELECTION_GRACE_MS = 150

export type AnyAction =
  | ShortcutAction
  | 'settings.open'
  | 'theme.open'
  | 'history.open'
  | 'bookmarks.open'
  | 'downloads.open'
  | 'tab.freezeOthers'
  | 'tab.wakeAll'
  | 'tab.moveToNewWindow'
  | 'page.toggleMuteSite'
  | 'resources.trim'
  | 'resources.open'
  | 'passwords.open'
  | 'translate.open'

export interface ActionContext {
  /** Tab whose web contents produced the key event (null for the chrome). */
  sourceTabId: string | null
  /** Window the action applies to. */
  win: ZenWindow
}

/**
 * Executes keyboard-shortcut / Command Bar actions. Anything that needs UI (URL bar, panels)
 * is delegated to the renderer through events.
 */
export class Actions {
  constructor(private readonly browser: Browser) {}

  run(action: AnyAction, ctx: ActionContext): void {
    const { tabs, state } = this.browser
    const win = ctx.win
    const active = tabs.activeTabFor(win)
    const glance = win.glance
    // Shortcuts pressed while a Glance page is focused act on the glance page for navigation.
    const target =
      ctx.sourceTabId && glance?.tabId === ctx.sourceTabId ? tabs.tab(ctx.sourceTabId) : active

    switch (action) {
      // --- compact mode ---
      case 'compact.toggle':
        return this.browser.toggleCompactMode(win)
      case 'compact.toggleSidebar':
        return this.browser.toggleCompactSidebarPersistent(win)
      case 'sidebar.toggle':
        return this.browser.emit('sidebar.toggle', undefined, win)

      // --- spaces ---
      case 'space.next':
        return this.browser.cycleSpaceIn(win, 1)
      case 'space.prev':
        return this.browser.cycleSpaceIn(win, -1)
      case 'space.closeUnpinned':
        return tabs.closeUnpinned(undefined, win)
      case 'space.new':
        if (win.localSpace) return
        return this.browser.emit('space.new', undefined, win)

      // --- split view ---
      case 'split.grid':
        return tabs.toggleSplitLayout('grid', win)
      case 'split.vertical':
        return tabs.toggleSplitLayout('vertical', win)
      case 'split.horizontal':
        return tabs.toggleSplitLayout('horizontal', win)
      case 'split.unsplit':
        return tabs.unsplit(undefined, undefined, win)
      case 'split.newEmpty':
        return tabs.newEmptySplit(win)

      // --- tabs ---
      case 'tab.new':
        return this.browser.openNewTab(win)
      case 'tab.close':
        if (glance && ctx.sourceTabId === glance.tabId) return tabs.closeGlance(win)
        if (active) void tabs.requestClose(active.id, false, win)
        return
      case 'tab.reopenClosed':
        return tabs.reopenClosed(win)
      case 'tab.duplicate':
        if (active) tabs.duplicate(active.id, win)
        return
      case 'tab.next':
        return tabs.cycleTab(1, win)
      case 'tab.prev':
        return tabs.cycleTab(-1, win)
      case 'tab.selectLast':
        return tabs.selectTabByIndex(-1, win)
      case 'tab.moveBackward':
        return tabs.moveActiveTabBy(-1, win)
      case 'tab.moveForward':
        return tabs.moveActiveTabBy(1, win)
      case 'tab.moveToStart':
        return tabs.moveActiveTabToEdge('start', win)
      case 'tab.moveToEnd':
        return tabs.moveActiveTabToEdge('end', win)
      case 'tab.togglePin':
        if (active) tabs.togglePin(active.id, win)
        return
      case 'tab.resetPinned':
        if (active) tabs.resetPinned(active.id, true, win)
        return
      case 'tab.copyUrl':
        if (target) tabs.copyUrl(target.id, false)
        return
      case 'tab.copyUrlMarkdown':
        if (target) tabs.copyUrl(target.id, true)
        return
      case 'tab.search':
        // Chrome's tab search: the chrome opens the popover from the sidebar's top row.
        return this.browser.emit('tabsearch.open', undefined, win)
      case 'glance.expand':
        return tabs.expandGlance(win)

      // --- resource governor ---
      case 'tab.freezeOthers':
        void this.browser.governor.freezeOthers()
        return
      case 'tab.wakeAll':
        void this.browser.governor.wakeAll()
        return
      case 'resources.trim':
        void this.browser.governor.trim()
        return
      case 'resources.open':
        this.browser.pages.open('settings', 'resources', win)
        return

      // --- navigation ---
      case 'nav.back':
        if (target) tabs.goBack(target.id)
        return
      case 'nav.forward':
        if (target) tabs.goForward(target.id)
        return
      case 'nav.reload':
        if (target) tabs.reload(target.id)
        return
      case 'nav.reloadSkipCache':
        if (target) tabs.reload(target.id, true)
        return
      case 'nav.stop':
        if (target) tabs.stop(target.id)
        return
      case 'nav.home': {
        const home = this.browser.newTab.homeUrl()
        if (active) tabs.navigate(active.id, home ?? BLANK_URL)
        if (home && active) {
          this.browser.state.afterBroadcast(() =>
            this.browser.emit('newtab.opened', { tabId: active.id }, win)
          )
        } else {
          this.browser.emit('urlbar.toggle', { mode: 'edit', text: '' }, win)
        }
        return
      }

      // --- url bar / find ---
      case 'urlbar.focus':
        return this.browser.emit('urlbar.toggle', { mode: 'edit' }, win)
      case 'urlbar.search':
        return this.browser.emit('urlbar.toggle', { mode: 'search' }, win)
      case 'urlbar.pasteAndGo':
        void this.browser.pasteAndGo(target?.id ?? null, false, win)
        return
      case 'urlbar.pasteAndSearch':
        void this.browser.pasteAndGo(target?.id ?? null, true, win)
        return
      case 'find.open':
        if (target) void this.openFind(target.id, win)
        return
      case 'find.next':
        if (target) this.openFindAgain(target.id, 'next', win)
        return
      case 'find.prev':
        if (target) this.openFindAgain(target.id, 'prev', win)
        return
      case 'find.useSelection':
        if (target) void this.useSelectionForFind(target.id, win)
        return

      // --- page operations ---
      case 'page.savePage':
        if (target) void this.savePage(target.id, win)
        return
      case 'page.openFile':
        void this.openFile(target?.id ?? null, win)
        return
      case 'page.emailLink':
        if (target && /^https?:/.test(target.url))
          this.browser.platform.shell.openExternal(
            `mailto:?subject=${encodeURIComponent(target.title || target.url)}&body=${encodeURIComponent(target.url)}`
          )
        return
      case 'page.print':
        if (target) tabs.view(target.id)?.print()
        return
      case 'page.viewSource':
        if (target && !target.url.startsWith('zen://'))
          tabs.createTab(
            { url: `view-source:${target.url}`, active: true, afterTabId: target.id },
            win
          )
        return
      case 'page.fullscreen':
        return this.browser.toggleFullscreen(win)
      case 'page.readerMode':
        if (target) this.browser.reader.toggle(target.id, win)
        return
      case 'translate.open':
        if (target) void this.browser.translate.open(target.id, win)
        return
      case 'page.pip':
        if (target) void this.togglePictureInPicture(target.id, win)
        return
      case 'page.screenshot':
        if (target) void this.screenshot(target.id, win)
        return
      case 'page.captureFullPage':
        if (target) void this.screenshot(target.id, win, { fullPage: true })
        return
      case 'page.toggleMute':
        if (target) tabs.toggleMute(target.id)
        return
      case 'page.toggleMuteSite':
        if (target) tabs.toggleMuteSite(target.id)
        return
      case 'tab.moveToNewWindow':
        if (active) tabs.moveTabToNewWindow(active.id, null, win)
        return
      case 'zoom.in':
        if (target) tabs.adjustZoom(target.id, 1)
        return
      case 'zoom.out':
        if (target) tabs.adjustZoom(target.id, -1)
        return
      case 'zoom.reset':
        if (target) tabs.resetZoom(target.id)
        return

      // --- history & bookmarks ---
      case 'bookmark.add':
        if (target) this.browser.starTab(target.id, win)
        return
      case 'bookmark.allTabs':
        return this.browser.bookmarkTabs(win)
      case 'bookmark.toggleBar':
        return this.browser.toggleBookmarksBar(win)
      case 'bookmark.sidebar':
      case 'bookmark.library':
      case 'bookmarks.open':
        return this.browser.emit('overlay.open', { kind: 'bookmarks' }, win)
      case 'history.sidebar':
      case 'history.open':
        return this.browser.emit('overlay.open', { kind: 'history' }, win)
      case 'downloads.open':
        return this.browser.emit('overlay.open', { kind: 'downloads' }, win)
      case 'settings.open':
        this.browser.pages.open('settings', undefined, win)
        return
      case 'addons.open':
        return this.browser.emit('overlay.open', { kind: 'addons' }, win)
      case 'passwords.open':
        if (!state.capabilities.passwords) return
        return this.browser.emit('overlay.open', { kind: 'passwords' }, win)
      case 'boost.new':
        if (target && /^https?:/.test(target.url))
          return this.browser.emit('overlay.open', { kind: 'boosts' }, win)
        return this.browser.toast('Boosts work on web pages only.', 'info', win)
      case 'theme.open':
        if (win.localSpace) return
        return this.browser.emit('theme.open', { spaceId: win.activeSpaceId }, win)

      // --- devtools ---
      case 'devtools.toggle':
        if (target) tabs.toggleDevtools(target.id)
        return
      case 'devtools.inspector':
        if (target) tabs.toggleDevtools(target.id, 'inspect')
        return
      case 'devtools.console':
        if (target) tabs.toggleDevtools(target.id, 'console')
        return
      case 'devtools.browserConsole':
        if (state.capabilities.devtools) win.host.openChromeDevTools()
        return

      // --- windows ---
      case 'window.new':
        this.browser.openWindow('synced', win)
        return
      case 'window.newUnsynced':
        this.browser.openWindow('unsynced', win)
        return
      case 'window.newPrivate':
        this.browser.openWindow('private', win)
        return
      case 'window.close':
        void this.browser.requestWindowClose(win)
        return
      case 'window.minimize':
        win.host.minimize()
        return
      case 'menu.app':
        // The renderer opens the menu from its button so Escape leaves the keyboard there.
        this.browser.emit('menu.app', undefined, win)
        return
      case 'app.quit':
        void this.browser.requestQuit()
        return

      default: {
        const m = /^space\.switch(\d+)$/.exec(action)
        if (m) {
          const space = state.model.spaces[Number(m[1]) - 1]
          if (space && !win.localSpace) tabs.switchSpace(space.id, win)
          return
        }
        const t = /^tab\.select(\d)$/.exec(action)
        if (t) {
          tabs.selectTabByIndex(Number(t[1]) - 1, win)
          return
        }
        console.warn('[zen] unknown action', action)
      }
    }
  }

  // --- find in page -----------------------------------------------------------------

  /**
   * Ctrl+F: the bar opens with a short selection from the page, else the last query (Chrome's
   * prepopulate order). Reading the selection asks the page, so the bar waits for its answer or
   * the grace period, whichever comes first.
   */
  private async openFind(tabId: string, win: ZenWindow): Promise<void> {
    const selection = await this.pageSelection(tabId)
    if (!win.alive) return
    const text = selection || this.browser.find.queryFor(tabId)
    this.browser.emit('find.open', { tabId, text }, win)
  }

  /** F3 / Ctrl+G with the bar open or closed: search on with the last query at once. */
  private openFindAgain(tabId: string, again: 'next' | 'prev', win: ZenWindow): void {
    const text = this.browser.find.queryFor(tabId)
    this.browser.emit('find.open', { tabId, text, again }, win)
  }

  /**
   * macOS "Use Selection for Find" (Cmd+E): the selection becomes the query Find Next searches
   * for, without the bar opening; an open bar takes the text over. Nothing selected: no change.
   */
  private async useSelectionForFind(tabId: string, win: ZenWindow): Promise<void> {
    const selection = await this.pageSelection(tabId)
    if (!selection || !win.alive) return
    this.browser.find.remember(tabId, selection)
    this.browser.emit('find.selection', { tabId, text: selection }, win)
  }

  /** The page's selection as a find query ('' when there is none, it is a passage, or the page does not answer). */
  private async pageSelection(tabId: string): Promise<string> {
    const view = this.browser.tabs.view(tabId)
    if (!view || view.isDestroyed()) return ''
    const raw = await Promise.race([
      view.executeJavaScript('String(window.getSelection())').catch(() => ''),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), SELECTION_GRACE_MS))
    ])
    return selectionQuery(raw)
  }

  private async savePage(tabId: string, win: ZenWindow): Promise<void> {
    const tab = this.browser.tabs.tab(tabId)
    const view = this.browser.tabs.view(tabId)
    if (!tab || !view) return
    const safeName = (tab.title || 'page').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)
    try {
      const path = await view.savePage(`${safeName}.html`)
      if (!path) return
      this.browser.downloads.addCompleted(path, 'text/html', {
        containerId: tab.containerId,
        private: win.isPrivate
      })
      this.browser.toast('Page saved', 'info', win)
    } catch (error) {
      this.browser.toast(`Could not save page: ${(error as Error).message}`, 'error', win)
    }
  }

  /** Chrome's Ctrl+O: a local file opens in the current tab (a new one where there is none). */
  private async openFile(tabId: string | null, win: ZenWindow): Promise<void> {
    const pick = this.browser.platform.dialogs.pickFiles
    if (!pick) return
    const paths = await pick({ title: 'Open File' }, win)
    if (paths.length === 0) return
    const [first, ...rest] = paths.map((path) => pathToFileUrl(path))
    const tab = tabId ? this.browser.tabs.tab(tabId) : undefined
    if (tab && !tab.pinned && !tab.essential) this.browser.tabs.navigate(tab.id, first)
    else this.browser.tabs.createTab({ url: first, active: true }, win)
    for (const url of rest) this.browser.tabs.createTab({ url, active: false }, win)
  }

  /**
   * "Take Screenshot" saves the visible area; "Capture Full Page" (Edge's) the whole document
   * beyond the viewport, which the host paints through its capture path (CDP's
   * `captureBeyondViewport` on Electron, the WebView drawn strip by strip on Android) and cuts
   * at its texture limit rather than fails. Either lands in Downloads as a PNG.
   */
  private async screenshot(
    tabId: string,
    win: ZenWindow,
    options: { fullPage?: boolean } = {}
  ): Promise<void> {
    const tab = this.browser.tabs.tab(tabId)
    const view = this.browser.tabs.view(tabId)
    if (!view) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const path = await view.screenshot(`Screenshot ${stamp}.png`, options)
    if (path) {
      this.browser.downloads.addCompleted(path, 'image/png', {
        containerId: tab?.containerId,
        private: win.isPrivate
      })
      this.browser.toast('Screenshot saved to Downloads', 'info', win)
    } else {
      this.browser.toast('Could not capture the page', 'error', win)
    }
  }

  private async togglePictureInPicture(tabId: string, win: ZenWindow): Promise<void> {
    const view = this.browser.tabs.view(tabId)
    if (!view) return
    if (!this.browser.state.capabilities.pictureInPicture) {
      this.browser.toast('Picture-in-Picture is not available on this device.', 'info', win)
      return
    }
    // A host whose window itself goes into PiP (Android): the OS shows the page's video.
    if (this.browser.platform.mediaSession?.enterPictureInPicture) {
      if (!(await this.browser.mediaSession.enterPictureInPicture(tabId)))
        this.browser.toast('No video available for Picture-in-Picture', 'info', win)
      return
    }
    try {
      await view.executeJavaScript(
        `(async () => {
          if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return true }
          const videos = [...document.querySelectorAll('video')].filter(v => v.readyState > 0 && !v.disablePictureInPicture)
          const video = videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0]
          if (!video) return false
          await video.requestPictureInPicture()
          return true
        })()`
      )
    } catch {
      this.browser.toast('No video available for Picture-in-Picture', 'info', win)
    }
  }
}
