import {
  Menu,
  clipboard,
  nativeImage,
  net,
  type ContextMenuParams,
  type MenuItemConstructorOptions
} from 'electron'
import type { Browser } from './browser'
import { buildSearchUrl } from '../../shared/search'
import { displayUrl, isNavigableUrl } from '../../shared/url'
import { DEFAULT_CONTAINER_ID } from '../../shared/types'

type Template = MenuItemConstructorOptions[]

/**
 * Native context menus. Zen (Firefox) uses native-styled menus everywhere, and native popups are
 * also the only thing that can draw above the tab views.
 */
export class Menus {
  constructor(private readonly browser: Browser) {}

  private popup(template: Template): void {
    const items = template.filter((item, i, arr) => {
      // Collapse duplicate / leading / trailing separators.
      if (item.type !== 'separator') return true
      const prev = arr[i - 1]
      return i > 0 && i < arr.length - 1 && prev?.type !== 'separator'
    })
    Menu.buildFromTemplate(items).popup({ window: this.browser.window.win })
  }

  private containerSubmenu(onPick: (containerId: string) => void): Template {
    return this.browser.state.model.containers
      .filter((c) => c.id !== DEFAULT_CONTAINER_ID)
      .map((c) => ({ label: c.name, click: () => onPick(c.id) }))
  }

  // ---------------------------------------------------------------------------
  // Page
  // ---------------------------------------------------------------------------

  showPageContextMenu(tabId: string, params: ContextMenuParams): void {
    const { tabs, state } = this.browser
    const tab = tabs.tab(tabId)
    const wc = tabs.webContents(tabId)
    if (!tab || !wc) return
    const engine =
      state.searchEngines.find((e) => e.id === state.settings.searchEngineId) ??
      state.searchEngines[0]
    const template: Template = []
    const hasLink = Boolean(params.linkURL) && isNavigableUrl(params.linkURL)
    const isImage = params.mediaType === 'image' && Boolean(params.srcURL)
    const isMedia =
      (params.mediaType === 'video' || params.mediaType === 'audio') && Boolean(params.srcURL)
    const selection = params.selectionText.trim()

    if (hasLink) {
      template.push(
        {
          label: 'Open Link in New Tab',
          click: () =>
            tabs.createTab({
              url: params.linkURL,
              active: false,
              afterTabId: tab.essential ? undefined : tab.id,
              containerId: tab.containerId
            })
        },
        {
          label: 'Open Link in Glance',
          enabled: state.settings.glanceEnabled && !state.glance,
          click: () => tabs.openGlance(params.linkURL, tabId, 0.5, 0.5)
        },
        {
          label: 'Split Link in New Tab',
          click: () => this.splitLink(tabId, params.linkURL)
        },
        {
          label: 'Open Link in New Container Tab',
          submenu: this.containerSubmenu((cid) =>
            tabs.createTab({ url: params.linkURL, active: true, containerId: cid })
          )
        },
        { type: 'separator' },
        { label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) },
        { label: 'Save Link As…', click: () => wc.downloadURL(params.linkURL) },
        { type: 'separator' }
      )
    }
    if (isImage) {
      template.push(
        {
          label: 'Open Image in New Tab',
          click: () =>
            tabs.createTab({
              url: params.srcURL,
              active: false,
              afterTabId: tab.id,
              containerId: tab.containerId
            })
        },
        {
          label: 'Copy Image',
          click: () => this.copyImage(params.srcURL, tabId, params.x, params.y)
        },
        { label: 'Copy Image Link', click: () => clipboard.writeText(params.srcURL) },
        { label: 'Save Image As…', click: () => wc.downloadURL(params.srcURL) },
        { type: 'separator' }
      )
    }
    if (isMedia) {
      template.push(
        {
          label: params.mediaType === 'video' ? 'Copy Video Link' : 'Copy Audio Link',
          click: () => clipboard.writeText(params.srcURL)
        },
        {
          label: params.mediaType === 'video' ? 'Save Video As…' : 'Save Audio As…',
          click: () => wc.downloadURL(params.srcURL)
        },
        { type: 'separator' }
      )
    }
    if (params.isEditable) {
      if (params.misspelledWord) {
        for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
          template.push({ label: suggestion, click: () => wc.replaceMisspelling(suggestion) })
        }
        template.push(
          {
            label: 'Add to Dictionary',
            click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord)
          },
          { type: 'separator' }
        )
      }
      template.push(
        { label: 'Undo', role: 'undo', enabled: params.editFlags.canUndo },
        { label: 'Redo', role: 'redo', enabled: params.editFlags.canRedo },
        { type: 'separator' },
        { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
        { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
        { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
        {
          label: 'Paste as Plain Text',
          role: 'pasteAndMatchStyle',
          enabled: params.editFlags.canPaste
        },
        { label: 'Delete', role: 'delete', enabled: params.editFlags.canDelete },
        { type: 'separator' },
        { label: 'Select All', role: 'selectAll', enabled: params.editFlags.canSelectAll },
        { type: 'separator' }
      )
    } else if (selection) {
      const short = selection.length > 30 ? `${selection.slice(0, 30)}…` : selection
      template.push(
        { label: 'Copy', role: 'copy' },
        {
          // Zen opens search-selection results in Glance.
          label: `Search ${engine.name} for “${short}”`,
          click: () => {
            const url = buildSearchUrl(engine, selection)
            if (state.settings.glanceEnabled && !state.glance) tabs.openGlance(url, tabId, 0.5, 0.5)
            else tabs.createTab({ url, active: true, afterTabId: tab.id })
          }
        },
        { type: 'separator' }
      )
    }
    if (!hasLink && !isImage && !isMedia && !params.isEditable && !selection) {
      template.push(
        { label: 'Back', enabled: tab.canGoBack, click: () => tabs.goBack(tabId) },
        { label: 'Forward', enabled: tab.canGoForward, click: () => tabs.goForward(tabId) },
        {
          label: tab.loading ? 'Stop' : 'Reload',
          click: () => (tab.loading ? tabs.stop(tabId) : tabs.reload(tabId))
        },
        { type: 'separator' },
        {
          label: tab.bookmarked ? 'Remove Bookmark' : 'Bookmark Page…',
          click: () => this.browser.toggleBookmark(tabId)
        },
        {
          label: 'Save Page As…',
          click: () => this.browser.actions.run('page.savePage', { sourceTabId: tabId })
        },
        {
          label: 'Take Screenshot',
          click: () => this.browser.actions.run('page.screenshot', { sourceTabId: tabId })
        },
        { type: 'separator' },
        { label: 'Select All', role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'View Page Source',
          enabled: !tab.url.startsWith('zen://'),
          click: () => this.browser.actions.run('page.viewSource', { sourceTabId: tabId })
        }
      )
    }
    template.push(
      { type: 'separator' },
      { label: 'Inspect Element', click: () => wc.inspectElement(params.x, params.y) }
    )
    this.popup(template)
  }

  private splitLink(parentTabId: string, url: string): void {
    const { tabs } = this.browser
    const parent = tabs.tab(parentTabId)
    if (!parent) return
    const tab = tabs.createTab({
      url,
      active: false,
      afterTabId: parent.id,
      containerId: parent.containerId
    })
    if (parent.splitGroupId) tabs.addToSplit(parent.splitGroupId, tab.id)
    else tabs.createSplit([parent.id, tab.id], 'vertical')
  }

  private async copyImage(srcUrl: string, tabId: string, x: number, y: number): Promise<void> {
    const wc = this.browser.tabs.webContents(tabId)
    if (!wc) return
    if (srcUrl.startsWith('data:')) {
      clipboard.writeImage(nativeImage.createFromDataURL(srcUrl))
      return
    }
    try {
      wc.copyImageAt(x, y)
    } catch {
      try {
        const res = await net.fetch(srcUrl)
        const buf = Buffer.from(await res.arrayBuffer())
        clipboard.writeImage(nativeImage.createFromBuffer(buf))
      } catch {
        this.browser.toast('Could not copy image', 'error')
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  showTabContextMenu(tabId: string): void {
    const { tabs, state } = this.browser
    const tab = tabs.tab(tabId)
    if (!tab) return
    const m = state.model
    const active = tabs.activeTab
    const space = tabs.activeSpace
    const otherSpaces = m.spaces.filter((s) => s.id !== (tab.spaceId ?? m.activeSpaceId))
    const folders = Object.values(m.folders).filter(
      (f) => f.spaceId === (tab.spaceId ?? m.activeSpaceId)
    )
    const canSplitWithActive = Boolean(active) && active!.id !== tab.id
    const pinnedChanged =
      (tab.pinned || tab.essential) && tab.pinnedUrl !== null && tab.url !== tab.pinnedUrl

    const template: Template = [
      {
        label: 'New Tab Below',
        enabled: !tab.essential,
        click: () => this.browser.newTabAfter(tabId)
      },
      { type: 'separator' },
      { label: tab.discarded ? 'Load Tab' : 'Reload Tab', click: () => tabs.reload(tabId) },
      { label: tab.muted ? 'Unmute Tab' : 'Mute Tab', click: () => tabs.toggleMute(tabId) },
      { label: 'Duplicate Tab', click: () => tabs.duplicate(tabId) },
      { label: 'Rename Tab…', click: () => this.browser.emit('tab.startRename', { tabId }) },
      { label: 'Change Icon…', enabled: false },
      { type: 'separator' },
      tab.essential
        ? { label: 'Remove from Essentials', click: () => tabs.toggleEssential(tabId) }
        : {
            label: 'Add to Essentials',
            enabled: m.essentialTabIds.length < state.settings.essentialsMax,
            click: () => tabs.toggleEssential(tabId)
          },
      tab.essential
        ? { label: 'Unpin Tab', click: () => tabs.togglePin(tabId) }
        : { label: tab.pinned ? 'Unpin Tab' : 'Pin Tab', click: () => tabs.togglePin(tabId) },
      ...(tab.pinned || tab.essential
        ? [
            {
              label: 'Reset Pinned Tab',
              enabled: pinnedChanged,
              click: () => tabs.resetPinned(tabId)
            },
            {
              label: 'Edit Pinned Tab (set current URL)',
              enabled: pinnedChanged,
              click: () => tabs.editPinnedUrl(tabId, tab.url)
            }
          ]
        : []),
      { type: 'separator' },
      {
        label: 'Split with Current Tab',
        enabled: canSplitWithActive,
        click: () => active && tabs.createSplit([active.id, tab.id], 'vertical')
      },
      ...(tab.splitGroupId
        ? [{ label: 'Un-split Tab', click: () => tabs.removeFromSplit(tabId, true) }]
        : []),
      {
        label: 'Move to Space',
        enabled: !tab.essential && otherSpaces.length > 0,
        submenu: otherSpaces.map((s) => ({
          label: `${s.icon ? `${s.icon} ` : ''}${s.name}`,
          click: () =>
            tabs.moveTab(tabId, {
              spaceId: s.id,
              section: tab.pinned ? 'pinned' : 'regular',
              index: Number.MAX_SAFE_INTEGER
            })
        }))
      },
      {
        label: 'Move to Folder',
        enabled: !tab.essential && !tab.pinned,
        submenu: [
          ...folders.map((f) => ({
            label: `${f.icon} ${f.name}`,
            type: 'checkbox' as const,
            checked: tab.folderId === f.id,
            click: () => tabs.moveToFolder(tabId, tab.folderId === f.id ? null : f.id)
          })),
          ...(folders.length ? [{ type: 'separator' as const }] : []),
          { label: 'New Folder…', click: () => this.browser.newFolderWithTab(space.id, tabId) },
          ...(tab.folderId
            ? [{ label: 'Remove from Folder', click: () => tabs.moveToFolder(tabId, null) }]
            : [])
        ]
      },
      {
        label: 'Open in New Container Tab',
        submenu: this.containerSubmenu((cid) =>
          tabs.createTab({ url: tab.url, active: true, containerId: cid })
        )
      },
      { type: 'separator' },
      {
        label: tab.bookmarked ? 'Remove Bookmark' : 'Bookmark Tab',
        click: () => this.browser.toggleBookmark(tabId)
      },
      { label: 'Copy URL', click: () => tabs.copyUrl(tabId) },
      {
        label: 'Unload Tab',
        enabled: !tab.discarded && active?.id !== tabId,
        click: () => tabs.discard(tabId)
      },
      { type: 'separator' },
      ...(!tab.essential
        ? [
            { label: 'Close Tabs Above', click: () => tabs.closeAbove(tabId) },
            { label: 'Close Tabs Below', click: () => tabs.closeBelow(tabId) },
            { label: 'Close Other Tabs', click: () => tabs.closeOthers(tabId) },
            { type: 'separator' as const }
          ]
        : []),
      {
        label: tab.pinned || tab.essential ? 'Close Tab (keep pinned)' : 'Close Tab',
        click: () => tabs.closeTab(tabId)
      },
      ...(tab.pinned || tab.essential
        ? [{ label: 'Remove Tab', click: () => tabs.closeTab(tabId, true) }]
        : [])
    ]
    this.popup(template)
  }

  showNewTabContextMenu(): void {
    const { tabs, state } = this.browser
    const space = tabs.activeSpace
    this.popup([
      { label: 'New Tab', click: () => this.browser.emit('urlbar.toggle', { mode: 'new-tab' }) },
      {
        label: 'New Tab in Container',
        submenu: [
          {
            label: 'No Container',
            click: () => tabs.createTab({ containerId: DEFAULT_CONTAINER_ID, active: true })
          },
          ...this.containerSubmenu((cid) => tabs.createTab({ containerId: cid, active: true }))
        ]
      },
      { type: 'separator' },
      { label: 'New Folder', click: () => this.browser.createFolder(space.id, 'New Folder', '📁') },
      { label: 'New Space…', click: () => this.browser.emit('space.new', undefined) },
      { type: 'separator' },
      {
        label: 'Clear Unpinned Tabs',
        enabled: space.tabIds.some((id) => !state.model.tabs[id]?.pinned),
        click: () => tabs.closeUnpinned(space.id)
      }
    ])
  }

  // ---------------------------------------------------------------------------
  // Spaces & folders
  // ---------------------------------------------------------------------------

  showSpaceContextMenu(spaceId: string): void {
    const { tabs, state } = this.browser
    const space = state.model.spaces.find((s) => s.id === spaceId)
    if (!space) return
    const idx = state.model.spaces.indexOf(space)
    this.popup([
      { label: 'Edit Space…', click: () => this.browser.emit('space.edit', { spaceId }) },
      { label: 'Change Theme…', click: () => this.browser.emit('theme.open', { spaceId }) },
      { type: 'separator' },
      {
        label: 'Move Left',
        enabled: idx > 0,
        click: () => this.browser.reorderSpace(spaceId, idx - 1)
      },
      {
        label: 'Move Right',
        enabled: idx < state.model.spaces.length - 1,
        click: () => this.browser.reorderSpace(spaceId, idx + 1)
      },
      { type: 'separator' },
      { label: 'Unload Space', click: () => tabs.unloadSpace(spaceId) },
      { label: 'Unload All Spaces Except Current', click: () => this.browser.unloadOtherSpaces() },
      { label: 'Close Unpinned Tabs', click: () => tabs.closeUnpinned(spaceId) },
      { type: 'separator' },
      {
        label: 'Space Routing Settings…',
        click: () => this.browser.emit('overlay.open', { kind: 'settings' })
      },
      { type: 'separator' },
      {
        label: 'Delete Space',
        enabled: state.model.spaces.length > 1,
        click: () => this.browser.deleteSpace(spaceId)
      }
    ])
  }

  showFolderContextMenu(folderId: string): void {
    const { state } = this.browser
    const folder = state.model.folders[folderId]
    if (!folder) return
    this.popup([
      {
        label: 'Rename Folder…',
        click: () => this.browser.emit('folder.startRename', { folderId })
      },
      {
        label: folder.collapsed ? 'Expand Folder' : 'Collapse Folder',
        click: () => this.browser.updateFolder(folderId, { collapsed: !folder.collapsed })
      },
      { type: 'separator' },
      { label: 'Unpack Folder', click: () => this.browser.deleteFolder(folderId, true) },
      { label: 'Delete Folder', click: () => this.browser.deleteFolder(folderId, false) }
    ])
  }

  /** The "⋯" application menu in the toolbar (Firefox's hamburger menu). */
  showAppMenu(): void {
    const { state, tabs } = this.browser
    const active = tabs.activeTab
    const cm = state.settings.compactMode
    this.popup([
      { label: 'New Tab', click: () => this.browser.emit('urlbar.toggle', { mode: 'new-tab' }) },
      { label: 'New Space…', click: () => this.browser.emit('space.new', undefined) },
      { type: 'separator' },
      { label: 'Bookmarks', click: () => this.browser.emit('overlay.open', { kind: 'bookmarks' }) },
      { label: 'History', click: () => this.browser.emit('overlay.open', { kind: 'history' }) },
      { label: 'Downloads', click: () => this.browser.emit('overlay.open', { kind: 'downloads' }) },
      { type: 'separator' },
      {
        label: 'Compact Mode',
        type: 'checkbox',
        checked: cm.enabled,
        click: () => this.browser.toggleCompactMode()
      },
      {
        label: 'Change Theme…',
        click: () => this.browser.emit('theme.open', { spaceId: state.model.activeSpaceId })
      },
      {
        label: 'Zoom',
        submenu: [
          {
            label: 'Zoom In',
            enabled: Boolean(active),
            click: () => active && tabs.adjustZoom(active.id, 1)
          },
          {
            label: 'Zoom Out',
            enabled: Boolean(active),
            click: () => active && tabs.adjustZoom(active.id, -1)
          },
          {
            label: 'Reset Zoom',
            enabled: Boolean(active),
            click: () => active && tabs.setZoom(active.id, 1)
          }
        ]
      },
      {
        label: 'Fullscreen',
        type: 'checkbox',
        checked: this.browser.window.win.isFullScreen(),
        click: () => this.browser.toggleFullscreen()
      },
      { type: 'separator' },
      {
        label: 'Find in Page…',
        enabled: Boolean(active),
        click: () => active && this.browser.emit('find.open', { tabId: active.id })
      },
      {
        label: 'Print…',
        enabled: Boolean(active),
        click: () => active && this.browser.actions.run('page.print', { sourceTabId: active.id })
      },
      {
        label: 'Save Page As…',
        enabled: Boolean(active),
        click: () => active && this.browser.actions.run('page.savePage', { sourceTabId: active.id })
      },
      {
        label: 'Take Screenshot',
        enabled: Boolean(active),
        click: () =>
          active && this.browser.actions.run('page.screenshot', { sourceTabId: active.id })
      },
      { type: 'separator' },
      {
        label: 'Keyboard Shortcuts',
        click: () => this.browser.emit('overlay.open', { kind: 'shortcuts' })
      },
      { label: 'Settings', click: () => this.browser.emit('overlay.open', { kind: 'settings' }) },
      {
        label: 'Developer Tools',
        enabled: Boolean(active),
        click: () => active && tabs.toggleDevtools(active.id)
      },
      { type: 'separator' },
      { label: `About Zen (Chromium) ${state.version}`, enabled: false },
      { label: 'Quit', click: () => this.browser.actions.run('app.quit') }
    ])
  }

  describe(url: string): string {
    return displayUrl(url)
  }
}
