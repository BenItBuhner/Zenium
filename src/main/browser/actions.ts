import { app, dialog } from 'electron'
import { join } from 'node:path'
import type { ShortcutAction } from '../../shared/types'
import { BLANK_URL } from '../../shared/url'
import { cycleSpace } from './model'
import type { Browser } from './browser'

export type AnyAction =
  | ShortcutAction
  | 'settings.open'
  | 'theme.open'
  | 'space.new'
  | 'history.open'
  | 'bookmarks.open'
  | 'downloads.open'
  | 'tab.freezeOthers'
  | 'tab.wakeAll'
  | 'resources.trim'
  | 'resources.open'

interface ActionContext {
  /** Tab whose web contents produced the key event (null for the chrome). */
  sourceTabId: string | null
}

/**
 * Executes keyboard-shortcut / Command Bar actions. Anything that needs UI (URL bar, panels)
 * is delegated to the renderer through events.
 */
export class Actions {
  constructor(private readonly browser: Browser) {}

  run(action: AnyAction, ctx: ActionContext = { sourceTabId: null }): void {
    const { tabs, state } = this.browser
    const active = tabs.activeTab
    const glance = state.glance
    // Shortcuts pressed while a Glance page is focused act on the glance page for navigation.
    const target =
      ctx.sourceTabId && glance?.tabId === ctx.sourceTabId ? tabs.tab(ctx.sourceTabId) : active

    switch (action) {
      // --- compact mode ---
      case 'compact.toggle':
        return this.browser.toggleCompactMode()
      case 'compact.toggleSidebar':
        return this.browser.toggleCompactSidebarPersistent()
      case 'sidebar.toggle':
        return this.browser.emit('sidebar.toggle', undefined)

      // --- spaces ---
      case 'space.next':
        return tabs.switchSpace(cycleSpace(state.model, 1).id)
      case 'space.prev':
        return tabs.switchSpace(cycleSpace(state.model, -1).id)
      case 'space.closeUnpinned':
        return tabs.closeUnpinned()
      case 'space.new':
        return this.browser.emit('space.new', undefined)

      // --- split view ---
      case 'split.grid':
        return tabs.toggleSplitLayout('grid')
      case 'split.vertical':
        return tabs.toggleSplitLayout('vertical')
      case 'split.horizontal':
        return tabs.toggleSplitLayout('horizontal')
      case 'split.unsplit':
        return tabs.unsplit()
      case 'split.newEmpty':
        return tabs.newEmptySplit()

      // --- tabs ---
      case 'tab.new':
        return this.browser.emit('urlbar.toggle', { mode: 'new-tab' })
      case 'tab.close':
        if (glance && ctx.sourceTabId === glance.tabId) return tabs.closeGlance()
        if (active) tabs.closeTab(active.id)
        return
      case 'tab.reopenClosed':
        return tabs.reopenClosed()
      case 'tab.duplicate':
        if (active) tabs.duplicate(active.id)
        return
      case 'tab.next':
        return tabs.cycleTab(1)
      case 'tab.prev':
        return tabs.cycleTab(-1)
      case 'tab.selectLast':
        return tabs.selectTabByIndex(-1)
      case 'tab.moveBackward':
        return tabs.moveActiveTabBy(-1)
      case 'tab.moveForward':
        return tabs.moveActiveTabBy(1)
      case 'tab.moveToStart':
        return tabs.moveActiveTabToEdge('start')
      case 'tab.moveToEnd':
        return tabs.moveActiveTabToEdge('end')
      case 'tab.togglePin':
        if (active) tabs.togglePin(active.id)
        return
      case 'tab.resetPinned':
        if (active) tabs.resetPinned(active.id)
        return
      case 'tab.copyUrl':
        if (target) tabs.copyUrl(target.id, false)
        return
      case 'tab.copyUrlMarkdown':
        if (target) tabs.copyUrl(target.id, true)
        return
      case 'glance.expand':
        return tabs.expandGlance()

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
        return this.browser.emit('overlay.open', { kind: 'settings', section: 'resources' })

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
        this.browser.emit('urlbar.toggle', { mode: 'edit', text: '' })
        return

      // --- url bar / find ---
      case 'urlbar.focus':
        return this.browser.emit('urlbar.toggle', { mode: 'edit' })
      case 'urlbar.search':
        return this.browser.emit('urlbar.toggle', { mode: 'search' })
      case 'find.open':
        if (target) this.browser.emit('find.open', { tabId: target.id })
        return
      case 'find.next':
        if (target) this.browser.emit('find.open', { tabId: target.id, again: 'next' })
        return
      case 'find.prev':
        if (target) this.browser.emit('find.open', { tabId: target.id, again: 'prev' })
        return

      // --- page operations ---
      case 'page.savePage':
        if (target) void this.savePage(target.id)
        return
      case 'page.print':
        if (target) tabs.webContents(target.id)?.print()
        return
      case 'page.viewSource':
        if (target && !target.url.startsWith('zen://'))
          tabs.createTab({ url: `view-source:${target.url}`, active: true, afterTabId: target.id })
        return
      case 'page.fullscreen':
        return this.browser.toggleFullscreen()
      case 'page.pip':
        if (target) void this.togglePictureInPicture(target.id)
        return
      case 'page.screenshot':
        if (target) void this.screenshot(target.id)
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
        return this.browser.emit('overlay.open', { kind: 'bookmarks' })
      case 'history.sidebar':
      case 'history.open':
        return this.browser.emit('overlay.open', { kind: 'history' })
      case 'downloads.open':
        return this.browser.emit('overlay.open', { kind: 'downloads' })
      case 'settings.open':
        return this.browser.emit('overlay.open', { kind: 'settings' })
      case 'theme.open':
        return this.browser.emit('theme.open', { spaceId: state.model.activeSpaceId })

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
        this.browser.window.win.webContents.openDevTools({ mode: 'detach' })
        return

      // --- window ---
      case 'window.close':
        this.browser.window.win.close()
        return
      case 'app.quit':
        app.quit()
        return

      // Unsupported in this build – listed so the shortcut table mirrors Zen.
      case 'window.new':
      case 'window.newUnsynced':
      case 'window.newPrivate':
      case 'page.readerMode':
      case 'addons.open':
        this.browser.toast('This feature is not available in this build yet.')
        return

      default: {
        const m = /^space\.switch(\d+)$/.exec(action)
        if (m) {
          const space = state.model.spaces[Number(m[1]) - 1]
          if (space) tabs.switchSpace(space.id)
          return
        }
        const t = /^tab\.select(\d)$/.exec(action)
        if (t) {
          tabs.selectTabByIndex(Number(t[1]) - 1)
          return
        }
        console.warn('[zen] unknown action', action)
      }
    }
  }

  private async savePage(tabId: string): Promise<void> {
    const tab = this.browser.tabs.tab(tabId)
    const wc = this.browser.tabs.webContents(tabId)
    if (!tab || !wc) return
    const safeName = (tab.title || 'page').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)
    const result = await dialog.showSaveDialog(this.browser.window.win, {
      title: 'Save Page As',
      defaultPath: join(app.getPath('downloads'), `${safeName}.html`),
      filters: [{ name: 'Web Page, complete', extensions: ['html', 'htm'] }]
    })
    if (result.canceled || !result.filePath) return
    try {
      await wc.savePage(result.filePath, 'HTMLComplete')
      this.browser.downloads.addCompleted(result.filePath, 'text/html')
      this.browser.toast('Page saved')
    } catch (error) {
      this.browser.toast(`Could not save page: ${(error as Error).message}`, 'error')
    }
  }

  private async screenshot(tabId: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filePath = join(app.getPath('downloads'), `Screenshot ${stamp}.png`)
    const ok = await this.browser.window.screenshotToFile(tabId, filePath)
    if (ok) {
      this.browser.downloads.addCompleted(filePath, 'image/png')
      this.browser.toast('Screenshot saved to Downloads')
    } else {
      this.browser.toast('Could not capture the page', 'error')
    }
  }

  private async togglePictureInPicture(tabId: string): Promise<void> {
    const wc = this.browser.tabs.webContents(tabId)
    if (!wc) return
    try {
      await wc.executeJavaScript(
        `(async () => {
          if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return true }
          const videos = [...document.querySelectorAll('video')].filter(v => v.readyState > 0 && !v.disablePictureInPicture)
          const video = videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0]
          if (!video) return false
          await video.requestPictureInPicture()
          return true
        })()`,
        true
      )
    } catch {
      this.browser.toast('No video available for Picture-in-Picture')
    }
  }
}
