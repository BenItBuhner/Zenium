import type { ShortcutAction } from '../shared/types'
import { BLANK_URL } from '../shared/url'
import type { Browser } from './browser'
import type { ZenWindow } from './window'

export type AnyAction =
  | ShortcutAction
  | 'settings.open'
  | 'theme.open'
  | 'history.open'
  | 'bookmarks.open'
  | 'downloads.open'
  | 'tab.freezeOthers'
  | 'tab.wakeAll'
  | 'resources.trim'
  | 'resources.open'

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
        return this.browser.emit('urlbar.toggle', { mode: 'new-tab' }, win)
      case 'tab.close':
        if (glance && ctx.sourceTabId === glance.tabId) return tabs.closeGlance(win)
        if (active) tabs.closeTab(active.id, false, win)
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
        return this.browser.emit('overlay.open', { kind: 'settings', section: 'resources' }, win)

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
      case 'nav.home':
        if (active) tabs.navigate(active.id, BLANK_URL)
        this.browser.emit('urlbar.toggle', { mode: 'edit', text: '' }, win)
        return

      // --- url bar / find ---
      case 'urlbar.focus':
        return this.browser.emit('urlbar.toggle', { mode: 'edit' }, win)
      case 'urlbar.search':
        return this.browser.emit('urlbar.toggle', { mode: 'search' }, win)
      case 'find.open':
        if (target) this.browser.emit('find.open', { tabId: target.id }, win)
        return
      case 'find.next':
        if (target) this.browser.emit('find.open', { tabId: target.id, again: 'next' }, win)
        return
      case 'find.prev':
        if (target) this.browser.emit('find.open', { tabId: target.id, again: 'prev' }, win)
        return

      // --- page operations ---
      case 'page.savePage':
        if (target) void this.savePage(target.id, win)
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
      case 'page.pip':
        if (target) void this.togglePictureInPicture(target.id, win)
        return
      case 'page.screenshot':
        if (target) void this.screenshot(target.id, win)
        return
      case 'page.toggleMute':
        if (target) tabs.toggleMute(target.id)
        return
      case 'zoom.in':
        if (target) tabs.adjustZoom(target.id, 1)
        return
      case 'zoom.out':
        if (target) tabs.adjustZoom(target.id, -1)
        return
      case 'zoom.reset':
        if (target) tabs.setZoom(target.id, 1)
        return

      // --- history & bookmarks ---
      case 'bookmark.add':
        if (target) this.browser.toggleBookmark(target.id)
        return
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
        return this.browser.emit('overlay.open', { kind: 'settings' }, win)
      case 'addons.open':
        return this.browser.emit('overlay.open', { kind: 'addons' }, win)
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
        win.host.close()
        return
      case 'app.quit':
        this.browser.platform.app.quit()
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

  private async savePage(tabId: string, win: ZenWindow): Promise<void> {
    const tab = this.browser.tabs.tab(tabId)
    const view = this.browser.tabs.view(tabId)
    if (!tab || !view) return
    const safeName = (tab.title || 'page').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)
    try {
      const path = await view.savePage(`${safeName}.html`)
      if (!path) return
      this.browser.downloads.addCompleted(path, 'text/html')
      this.browser.toast('Page saved', 'info', win)
    } catch (error) {
      this.browser.toast(`Could not save page: ${(error as Error).message}`, 'error', win)
    }
  }

  private async screenshot(tabId: string, win: ZenWindow): Promise<void> {
    const view = this.browser.tabs.view(tabId)
    if (!view) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const path = await view.screenshot(`Screenshot ${stamp}.png`)
    if (path) {
      this.browser.downloads.addCompleted(path, 'image/png')
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
