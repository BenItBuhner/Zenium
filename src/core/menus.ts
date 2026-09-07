import type { Browser } from './browser'
import type { ZenWindow } from './window'
import type { MenuItemTemplate, MenuSource, PageContextParams } from './platform'
import { buildSearchUrl } from '../shared/search'
import { displayUrl, getDomain, isNavigableUrl } from '../shared/url'
import { DEFAULT_CONTAINER_ID } from '../shared/types'
import { spaceLabel } from '../shared/defaults'

type Template = MenuItemTemplate[]

/**
 * Context menus. Zen (Firefox) uses native-styled menus everywhere; the core builds the templates
 * and the host shows them – Electron as native popups (the only thing that can draw above the tab
 * views), Android inside the chrome as sheets / popovers.
 */
export class Menus {
  constructor(private readonly browser: Browser) {}

  private popup(template: Template, win: ZenWindow, source: MenuSource): void {
    const items = template.filter((item, i, arr) => {
      // Collapse duplicate / leading / trailing separators.
      if (item.type !== 'separator') return true
      const prev = arr[i - 1]
      return i > 0 && i < arr.length - 1 && prev?.type !== 'separator'
    })
    this.browser.platform.menus.popup(items, { source, win })
  }

  private containerSubmenu(onPick: (containerId: string) => void): Template {
    return this.browser.state.model.containers
      .filter((c) => c.id !== DEFAULT_CONTAINER_ID)
      .map((c) => ({ label: c.name, click: () => onPick(c.id) }))
  }

  private spaceSubmenu(exceptSpaceId: string | null, onPick: (spaceId: string) => void): Template {
    return this.browser.state.model.spaces
      .filter((s) => s.id !== exceptSpaceId)
      .map((s) => ({
        label: spaceLabel(s),
        click: () => onPick(s.id)
      }))
  }

  // ---------------------------------------------------------------------------
  // Page
  // ---------------------------------------------------------------------------

  showPageContextMenu(tabId: string, params: PageContextParams, win: ZenWindow): void {
    const { tabs, state } = this.browser
    const tab = tabs.tab(tabId)
    const view = tabs.view(tabId)
    if (!tab || !view) return
    const caps = state.capabilities
    const engine =
      state.searchEngines.find((e) => e.id === state.settings.searchEngineId) ??
      state.searchEngines[0]
    const template: Template = []
    const hasLink = Boolean(params.linkURL) && isNavigableUrl(params.linkURL)
    const isImage = params.mediaType === 'image' && Boolean(params.srcURL)
    const isMedia =
      (params.mediaType === 'video' || params.mediaType === 'audio') && Boolean(params.srcURL)
    const selection = params.selectionText.trim()
    const glanceAllowed = state.settings.glanceEnabled && !win.glance

    if (hasLink) {
      template.push(
        {
          label: 'Open Link in New Tab',
          click: () =>
            tabs.createTab(
              {
                url: params.linkURL,
                active: false,
                afterTabId: tab.essential ? undefined : tab.id,
                containerId: tab.containerId
              },
              win
            )
        },
        {
          label: 'Open Link in Glance',
          enabled: glanceAllowed,
          click: () => tabs.openGlance(params.linkURL, tabId, 0.5, 0.5, win)
        },
        {
          label: 'Split Link in New Tab',
          click: () => this.splitLink(tabId, params.linkURL, win)
        },
        {
          label: 'Open Link in New Container Tab',
          enabled: !win.isPrivate,
          submenu: this.containerSubmenu((cid) =>
            tabs.createTab({ url: params.linkURL, active: true, containerId: cid }, win)
          )
        },
        ...(caps.windows
          ? [
              {
                label: 'Open Link in New Private Window',
                click: () => {
                  const pw = this.browser.openWindow('private', win)
                  if (pw) tabs.createTab({ url: params.linkURL, active: true }, pw)
                }
              }
            ]
          : []),
        { type: 'separator' },
        {
          label: 'Copy Link',
          click: () => this.browser.platform.clipboard.writeText(params.linkURL)
        },
        { label: 'Save Link As…', click: () => view.downloadURL(params.linkURL) },
        { type: 'separator' }
      )
    }
    if (isImage) {
      template.push(
        {
          label: 'Open Image in New Tab',
          click: () =>
            tabs.createTab(
              {
                url: params.srcURL,
                active: false,
                afterTabId: tab.id,
                containerId: tab.containerId
              },
              win
            )
        },
        {
          label: 'Copy Image',
          click: () => this.copyImage(params.srcURL, tabId, params.x, params.y, win)
        },
        {
          label: 'Copy Image Link',
          click: () => this.browser.platform.clipboard.writeText(params.srcURL)
        },
        { label: 'Save Image As…', click: () => view.downloadURL(params.srcURL) },
        { type: 'separator' }
      )
    }
    if (isMedia) {
      template.push(
        {
          label: params.mediaType === 'video' ? 'Copy Video Link' : 'Copy Audio Link',
          click: () => this.browser.platform.clipboard.writeText(params.srcURL)
        },
        {
          label: params.mediaType === 'video' ? 'Save Video As…' : 'Save Audio As…',
          click: () => view.downloadURL(params.srcURL)
        },
        ...(params.mediaType === 'video'
          ? [
              {
                label: 'Picture-in-Picture',
                click: () => this.browser.actions.run('page.pip', { sourceTabId: tabId, win })
              }
            ]
          : []),
        { type: 'separator' }
      )
    }
    if (params.isEditable) {
      if (params.misspelledWord) {
        for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
          template.push({ label: suggestion, click: () => view.replaceMisspelling(suggestion) })
        }
        template.push(
          {
            label: 'Add to Dictionary',
            click: () => view.addWordToDictionary(params.misspelledWord)
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
            if (glanceAllowed) tabs.openGlance(url, tabId, 0.5, 0.5, win)
            else tabs.createTab({ url, active: true, afterTabId: tab.id }, win)
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
          click: () => this.browser.actions.run('page.savePage', { sourceTabId: tabId, win })
        },
        {
          label: 'Take Screenshot',
          click: () => this.browser.actions.run('page.screenshot', { sourceTabId: tabId, win })
        },
        {
          label: this.browser.reader.isReaderUrl(tab.url)
            ? 'Exit Reader View'
            : 'Enter Reader View',
          enabled: this.browser.reader.isReaderUrl(tab.url) || this.browser.reader.canRead(tab),
          click: () => this.browser.reader.toggle(tabId, win)
        },
        { type: 'separator' },
        { label: 'Select All', role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'View Page Source',
          enabled: !tab.url.startsWith('zen://'),
          click: () => this.browser.actions.run('page.viewSource', { sourceTabId: tabId, win })
        }
      )
    }
    template.push({ type: 'separator' }, ...this.boostsSubmenu(tabId, win), { type: 'separator' })
    if (caps.devtools)
      template.push({ label: 'Inspect Element', click: () => view.openDevTools('inspect') })
    this.popup(template, win, 'page')
  }

  /** Zen 1.20: Boosts live in the page context menu (and the site control button). */
  private boostsSubmenu(tabId: string, win: ZenWindow): Template {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab || !/^https?:/.test(tab.url)) return []
    const boosts = this.browser.boosts
    const domain = getDomain(tab.url)
    const boost = boosts.get(domain)
    return [
      {
        label: 'Boosts',
        submenu: [
          {
            label: boost ? `Edit Boost for ${domain}…` : `New Boost for ${domain}…`,
            click: () => this.browser.emit('overlay.open', { kind: 'boosts' }, win)
          },
          { type: 'separator' },
          {
            label: 'Zap Element',
            click: () => boosts.startZap(tabId)
          },
          {
            label: 'Force Dark Mode',
            type: 'checkbox',
            checked: Boolean(boost?.darkMode),
            click: () => boosts.update(domain, { darkMode: !boost?.darkMode })
          },
          ...(boost
            ? [
                { type: 'separator' as const },
                {
                  label: boost.enabled ? 'Disable Boost' : 'Enable Boost',
                  click: () => boosts.update(domain, { enabled: !boost.enabled })
                },
                { label: 'Remove Boost', click: () => boosts.remove(domain) }
              ]
            : [])
        ]
      }
    ]
  }

  private splitLink(parentTabId: string, url: string, win: ZenWindow): void {
    const { tabs } = this.browser
    const parent = tabs.tab(parentTabId)
    if (!parent) return
    const tab = tabs.createTab(
      { url, active: false, afterTabId: parent.id, containerId: parent.containerId },
      win
    )
    if (parent.splitGroupId) tabs.addToSplit(parent.splitGroupId, tab.id)
    else tabs.createSplit([parent.id, tab.id], 'vertical', win)
  }

  private async copyImage(
    srcUrl: string,
    tabId: string,
    x: number,
    y: number,
    win: ZenWindow
  ): Promise<void> {
    const view = this.browser.tabs.view(tabId)
    if (!view) return
    const copied = await view.copyImageAt(x, y).catch(() => false)
    if (copied) return
    const ok = await this.browser.platform.clipboard.writeImageFromUrl(srcUrl)
    if (!ok) this.browser.toast('Could not copy image', 'error', win)
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  showTabContextMenu(tabId: string, win: ZenWindow): void {
    const { tabs, state } = this.browser
    const tab = tabs.tab(tabId)
    if (!tab) return
    const m = state.model
    const active = tabs.activeTabFor(win)
    const space = win.activeSpace()
    const local = Boolean(win.localSpace)
    const otherSpaces = m.spaces.filter((s) => s.id !== (tab.spaceId ?? win.activeSpaceId))
    const folders = Object.values(m.folders).filter(
      (f) => f.spaceId === (tab.spaceId ?? win.activeSpaceId)
    )
    const canSplitWithActive = Boolean(active) && active!.id !== tab.id
    const pinnedChanged =
      (tab.pinned || tab.essential) && tab.pinnedUrl !== null && tab.url !== tab.pinnedUrl
    const domain = getDomain(tab.url)

    const template: Template = [
      {
        label: 'New Tab Below',
        enabled: !tab.essential,
        click: () => this.browser.newTabAfter(tabId, win)
      },
      { type: 'separator' },
      { label: tab.discarded ? 'Load Tab' : 'Reload Tab', click: () => tabs.reload(tabId) },
      { label: tab.muted ? 'Unmute Tab' : 'Mute Tab', click: () => tabs.toggleMute(tabId) },
      { label: 'Duplicate Tab', click: () => tabs.duplicate(tabId, win) },
      { label: 'Rename Tab…', click: () => this.browser.emit('tab.startRename', { tabId }, win) },
      { label: 'Change Icon…', click: () => this.browser.emit('tab.pickIcon', { tabId }, win) },
      { type: 'separator' },
      ...(local
        ? []
        : [
            tab.essential
              ? { label: 'Remove from Essentials', click: () => tabs.toggleEssential(tabId, win) }
              : {
                  label: 'Add to Essentials',
                  enabled: m.essentialTabIds.length < state.settings.essentialsMax,
                  click: () => tabs.toggleEssential(tabId, win)
                }
          ]),
      tab.essential
        ? { label: 'Unpin Tab', click: () => tabs.togglePin(tabId, win) }
        : { label: tab.pinned ? 'Unpin Tab' : 'Pin Tab', click: () => tabs.togglePin(tabId, win) },
      ...(tab.pinned || tab.essential
        ? [
            {
              label: 'Reset Pinned Tab',
              enabled: pinnedChanged,
              click: () => tabs.resetPinned(tabId, true, win)
            },
            {
              label: 'Edit Pinned Tab…',
              click: () => this.browser.emit('tab.editPinnedUrl', { tabId }, win)
            }
          ]
        : []),
      { type: 'separator' },
      {
        label: 'Split with Current Tab',
        enabled: canSplitWithActive,
        click: () => active && tabs.createSplit([active.id, tab.id], 'vertical', win)
      },
      ...(tab.splitGroupId
        ? [{ label: 'Un-split Tab', click: () => tabs.removeFromSplit(tabId, true, win) }]
        : []),
      {
        label: local ? 'Move to Space…' : 'Move to Space',
        enabled: !tab.essential && otherSpaces.length > 0,
        submenu: otherSpaces.map((s) => ({
          label: spaceLabel(s),
          click: () =>
            tabs.moveTab(
              tabId,
              {
                spaceId: s.id,
                section: tab.pinned ? 'pinned' : 'regular',
                index: Number.MAX_SAFE_INTEGER
              },
              win
            )
        }))
      },
      ...(local
        ? []
        : [
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
                {
                  label: 'New Folder…',
                  click: () => this.browser.newFolderWithTab(space.id, tabId, win)
                },
                ...(tab.folderId
                  ? [{ label: 'Remove from Folder', click: () => tabs.moveToFolder(tabId, null) }]
                  : [])
              ]
            },
            {
              label: 'Add Route for Domain',
              enabled: Boolean(domain) && !state.settings.spaceRouting[domain],
              submenu: this.spaceSubmenu(null, (sid) => this.browser.addRouteForTab(tabId, sid))
            }
          ]),
      {
        label: 'Open in New Container Tab',
        enabled: !win.isPrivate,
        submenu: this.containerSubmenu((cid) =>
          tabs.createTab({ url: tab.url, active: true, containerId: cid }, win)
        )
      },
      { type: 'separator' },
      {
        label: tab.bookmarked ? 'Remove Bookmark' : 'Bookmark Tab',
        click: () => this.browser.toggleBookmark(tabId)
      },
      {
        label: 'Share',
        submenu: [
          { label: 'Copy Link', click: () => tabs.copyUrl(tabId) },
          { label: 'Copy Link as Markdown', click: () => tabs.copyUrl(tabId, true) },
          {
            label: 'Email Link…',
            click: () =>
              this.browser.platform.shell.openExternal(
                `mailto:?subject=${encodeURIComponent(tab.customTitle ?? tab.title)}&body=${encodeURIComponent(tab.url)}`
              )
          }
        ]
      },
      { type: 'separator' },
      tab.frozen || tab.cpuThrottle > 1
        ? {
            label: tab.frozen ? 'Wake Tab' : 'Remove CPU Throttling',
            click: () => void this.browser.governor.wakeTab(tabId)
          }
        : {
            label: 'Freeze Tab',
            enabled: !tab.discarded && tabs.windowsShowing(tabId).length === 0,
            click: () => void this.browser.governor.freezeTab(tabId)
          },
      {
        label: 'Unload Tab',
        enabled: !tab.discarded && active?.id !== tabId,
        click: () => tabs.discard(tabId)
      },
      { type: 'separator' },
      ...(!tab.essential
        ? [
            { label: 'Close Tabs Above', click: () => tabs.closeAbove(tabId, win) },
            { label: 'Close Tabs Below', click: () => tabs.closeBelow(tabId, win) },
            { label: 'Close Other Tabs', click: () => tabs.closeOthers(tabId, win) },
            { type: 'separator' as const }
          ]
        : []),
      {
        label: tab.pinned || tab.essential ? 'Close Tab (keep pinned)' : 'Close Tab',
        click: () => tabs.closeTab(tabId, false, win)
      },
      ...(tab.pinned || tab.essential
        ? [{ label: 'Remove Tab', click: () => tabs.closeTab(tabId, true, win) }]
        : [])
    ]
    this.popup(template, win, 'tab')
  }

  /** Zen: select several tabs (Ctrl / Shift+click) and act on all of them at once. */
  showSelectionContextMenu(tabIds: string[], win: ZenWindow): void {
    const { tabs, state } = this.browser
    const m = state.model
    const selected = tabIds
      .map((id) => tabs.tab(id))
      .filter((t): t is NonNullable<typeof t> => Boolean(t))
    if (selected.length < 2) return
    const n = selected.length
    const space = win.activeSpace()
    const local = Boolean(win.localSpace)
    const nonEssential = selected.filter((t) => !t.essential)
    const allPinned = nonEssential.length > 0 && nonEssential.every((t) => t.pinned)
    const folders = Object.values(m.folders).filter((f) => f.spaceId === space.id)
    this.popup(
      [
        {
          label: `Open ${n} Tabs in Split View`,
          enabled: n <= 4,
          click: () =>
            tabs.createSplit(
              selected.map((t) => t.id),
              n >= 3 ? 'grid' : 'vertical',
              win
            )
        },
        { type: 'separator' },
        {
          label: allPinned ? `Unpin ${n} Tabs` : `Pin ${n} Tabs`,
          enabled: nonEssential.length > 0,
          click: () => {
            for (const t of nonEssential) if (t.pinned === allPinned) tabs.togglePin(t.id, win)
          }
        },
        ...(local
          ? []
          : [
              {
                label: `Move ${n} Tabs to Space`,
                enabled: nonEssential.length > 0 && m.spaces.length > 1,
                submenu: this.spaceSubmenu(space.id, (sid) => {
                  for (const t of nonEssential)
                    tabs.moveTab(
                      t.id,
                      {
                        spaceId: sid,
                        section: t.pinned ? 'pinned' : 'regular',
                        index: Number.MAX_SAFE_INTEGER
                      },
                      win
                    )
                })
              },
              {
                label: `Add ${n} Tabs to Folder`,
                enabled: nonEssential.some((t) => !t.pinned),
                submenu: [
                  ...folders.map((f) => ({
                    label: `${f.icon} ${f.name}`,
                    click: () => {
                      for (const t of nonEssential) if (!t.pinned) tabs.moveToFolder(t.id, f.id)
                    }
                  })),
                  ...(folders.length ? [{ type: 'separator' as const }] : []),
                  {
                    label: 'New Folder…',
                    click: () => {
                      const folder = this.browser.createFolder(space.id, 'New Folder', '📁', win)
                      for (const t of nonEssential)
                        if (!t.pinned) tabs.moveToFolder(t.id, folder.id)
                    }
                  }
                ]
              }
            ]),
        {
          label: `Unload ${n} Tabs`,
          click: () => {
            for (const t of selected) if (!t.discarded) tabs.discard(t.id)
          }
        },
        { type: 'separator' },
        {
          label: `Close ${n} Tabs`,
          click: () => {
            for (const t of selected) tabs.closeTab(t.id, false, win)
          }
        }
      ],
      win,
      'selection'
    )
  }

  showNewTabContextMenu(win: ZenWindow): void {
    const { tabs, state } = this.browser
    const space = win.activeSpace()
    const local = Boolean(win.localSpace)
    this.popup(
      [
        {
          label: 'New Tab',
          click: () => this.browser.emit('urlbar.toggle', { mode: 'new-tab' }, win)
        },
        {
          label: 'New Tab in Container',
          enabled: !win.isPrivate,
          submenu: [
            {
              label: 'No Container',
              click: () => tabs.createTab({ containerId: DEFAULT_CONTAINER_ID, active: true }, win)
            },
            ...this.containerSubmenu((cid) =>
              tabs.createTab({ containerId: cid, active: true }, win)
            )
          ]
        },
        { type: 'separator' },
        ...(local
          ? []
          : [
              {
                label: 'New Folder',
                click: () => this.browser.createFolder(space.id, 'New Folder', '📁', win)
              },
              {
                label: 'New Live Folder…',
                click: () => this.browser.emit('overlay.open', { kind: 'live-folder' }, win)
              },
              { label: 'New Space…', click: () => this.browser.emit('space.new', undefined, win) },
              { type: 'separator' as const }
            ]),
        {
          label: 'Clear Unpinned Tabs',
          enabled: space.tabIds.some((id) => !state.model.tabs[id]?.pinned),
          click: () => tabs.closeUnpinned(space.id, win)
        }
      ],
      win,
      'newtab'
    )
  }

  // ---------------------------------------------------------------------------
  // Spaces & folders
  // ---------------------------------------------------------------------------

  showSpaceContextMenu(spaceId: string, win: ZenWindow): void {
    const { tabs, state } = this.browser
    const space = state.model.spaces.find((s) => s.id === spaceId)
    if (!space) return
    const idx = state.model.spaces.indexOf(space)
    this.popup(
      [
        { label: 'Edit Space…', click: () => this.browser.emit('space.edit', { spaceId }, win) },
        { label: 'Change Theme…', click: () => this.browser.emit('theme.open', { spaceId }, win) },
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
        { label: 'Open in New Window', click: () => this.openSpaceInNewWindow(spaceId, win) },
        { type: 'separator' },
        { label: 'Unload Space', click: () => tabs.unloadSpace(spaceId) },
        {
          label: 'Unload All Spaces Except Current',
          click: () => this.browser.unloadOtherSpaces(win)
        },
        { label: 'Freeze Other Tabs', click: () => void this.browser.governor.freezeOthers() },
        { label: 'Close Unpinned Tabs', click: () => tabs.closeUnpinned(spaceId, win) },
        { type: 'separator' },
        {
          label: 'Space Routing Settings…',
          click: () => this.browser.emit('overlay.open', { kind: 'settings' }, win)
        },
        { type: 'separator' },
        {
          label: 'Delete Space',
          enabled: state.model.spaces.length > 1,
          click: () => void this.browser.deleteSpace(spaceId, win)
        }
      ],
      win,
      'space'
    )
  }

  private openSpaceInNewWindow(spaceId: string, from: ZenWindow): void {
    const win = this.browser.openWindow('synced', from)
    if (win) this.browser.tabs.switchSpace(spaceId, win)
  }

  showFolderContextMenu(folderId: string, win: ZenWindow): void {
    const { state } = this.browser
    const folder = state.model.folders[folderId]
    if (!folder) return
    const live = this.browser.liveFolders.get(folderId)
    this.popup(
      [
        {
          label: 'Rename Folder…',
          click: () => this.browser.emit('folder.startRename', { folderId }, win)
        },
        {
          label: folder.collapsed ? 'Expand Folder' : 'Collapse Folder',
          click: () => this.browser.updateFolder(folderId, { collapsed: !folder.collapsed })
        },
        { type: 'separator' },
        ...((live
          ? [
              {
                label: 'Refresh Live Folder',
                click: () => void this.browser.liveFolders.refresh(folderId, true)
              },
              {
                label: 'Refresh Every',
                submenu: [15, 30, 60, 120, 240, 480].map((minutes) => ({
                  label:
                    minutes < 60
                      ? `${minutes} minutes`
                      : `${minutes / 60} hour${minutes > 60 ? 's' : ''}`,
                  type: 'radio' as const,
                  checked: live.intervalMinutes === minutes,
                  click: () => this.browser.liveFolders.setInterval(folderId, minutes)
                }))
              },
              {
                label: 'Live Folder Settings…',
                click: () =>
                  this.browser.emit('overlay.open', { kind: 'live-folder', folderId }, win)
              },
              {
                label: 'Stop Updating (make static)',
                click: () => this.browser.liveFolders.remove(folderId)
              }
            ]
          : [
              {
                label: 'Make Live Folder…',
                click: () =>
                  this.browser.emit('overlay.open', { kind: 'live-folder', folderId }, win)
              }
            ]) as Template),
        { type: 'separator' },
        { label: 'Unpack Folder', click: () => this.browser.deleteFolder(folderId, true) },
        { label: 'Delete Folder', click: () => this.browser.deleteFolder(folderId, false) }
      ],
      win,
      'folder'
    )
  }

  /** The "⋯" application menu in the toolbar (Firefox's hamburger menu). */
  showAppMenu(win: ZenWindow): void {
    const { state, tabs } = this.browser
    const caps = state.capabilities
    const active = tabs.activeTabFor(win)
    const local = Boolean(win.localSpace)
    this.popup(
      [
        {
          label: 'New Tab',
          click: () => this.browser.emit('urlbar.toggle', { mode: 'new-tab' }, win)
        },
        ...(local
          ? []
          : [{ label: 'New Space…', click: () => this.browser.emit('space.new', undefined, win) }]),
        { type: 'separator' },
        ...(caps.windows
          ? [
              { label: 'New Window', click: () => this.browser.openWindow('synced', win) },
              {
                label: 'New Blank Window',
                click: () => this.browser.openWindow('unsynced', win)
              },
              {
                label: 'New Private Window',
                click: () => this.browser.openWindow('private', win)
              }
            ]
          : []),
        { type: 'separator' },
        {
          label: 'Bookmarks',
          click: () => this.browser.emit('overlay.open', { kind: 'bookmarks' }, win)
        },
        {
          label: 'History',
          click: () => this.browser.emit('overlay.open', { kind: 'history' }, win)
        },
        {
          label: 'Downloads',
          click: () => this.browser.emit('overlay.open', { kind: 'downloads' }, win)
        },
        {
          label: 'Add-ons and Themes',
          click: () => this.browser.emit('overlay.open', { kind: 'addons' }, win)
        },
        { type: 'separator' },
        {
          label: 'Compact Mode',
          type: 'checkbox',
          checked: win.compactEnabled,
          click: () => this.browser.toggleCompactMode(win)
        },
        ...(local
          ? []
          : [
              {
                label: 'Change Theme…',
                click: () => this.browser.emit('theme.open', { spaceId: win.activeSpaceId }, win)
              }
            ]),
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
          checked: win.host.isFullScreen(),
          click: () => this.browser.toggleFullscreen(win)
        },
        { type: 'separator' },
        {
          label: 'Find in Page…',
          enabled: Boolean(active),
          click: () => active && this.browser.emit('find.open', { tabId: active.id }, win)
        },
        {
          label: 'Reader View',
          enabled: Boolean(active) && this.browser.reader.canRead(active),
          click: () => active && this.browser.reader.toggle(active.id, win)
        },
        {
          label: 'Print…',
          enabled: Boolean(active) && caps.print,
          click: () =>
            active && this.browser.actions.run('page.print', { sourceTabId: active.id, win })
        },
        {
          label: 'Save Page As…',
          enabled: Boolean(active),
          click: () =>
            active && this.browser.actions.run('page.savePage', { sourceTabId: active.id, win })
        },
        {
          label: 'Take Screenshot',
          enabled: Boolean(active),
          click: () =>
            active && this.browser.actions.run('page.screenshot', { sourceTabId: active.id, win })
        },
        { type: 'separator' },
        ...((caps.resourceGovernor
          ? [
              {
                label: 'Resources',
                submenu: [
                  {
                    label: `Memory ${Math.round(state.resources.memory.used)} MB · CPU ${Math.round(state.resources.cpu.used)}% · ${state.resources.loadedTabs} live, ${state.resources.frozenTabs} frozen`,
                    enabled: false
                  },
                  { type: 'separator' },
                  { label: 'Free Up Memory Now', click: () => void this.browser.governor.trim() },
                  {
                    label: 'Freeze Other Tabs',
                    click: () => void this.browser.governor.freezeOthers()
                  },
                  { label: 'Wake All Tabs', click: () => void this.browser.governor.wakeAll() },
                  { type: 'separator' },
                  {
                    label: 'Resource Settings…',
                    click: () =>
                      this.browser.emit(
                        'overlay.open',
                        { kind: 'settings', section: 'resources' },
                        win
                      )
                  }
                ]
              }
            ]
          : []) as Template),
        {
          label: 'Keyboard Shortcuts',
          click: () => this.browser.emit('overlay.open', { kind: 'shortcuts' }, win)
        },
        {
          label: 'Settings',
          click: () => this.browser.emit('overlay.open', { kind: 'settings' }, win)
        },
        ...(caps.devtools
          ? [
              {
                label: 'Developer Tools',
                enabled: Boolean(active),
                click: () => active && tabs.toggleDevtools(active.id)
              }
            ]
          : []),
        { type: 'separator' },
        { label: `About Zen (Chromium) ${state.version}`, enabled: false },
        {
          label: 'Quit',
          click: () => this.browser.actions.run('app.quit', { sourceTabId: null, win })
        }
      ],
      win,
      'app'
    )
  }

  describe(url: string): string {
    return displayUrl(url)
  }
}
