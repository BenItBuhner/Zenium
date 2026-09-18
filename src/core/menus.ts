import type { Browser } from './browser'
import type { ZenWindow } from './window'
import type {
  ChromeContextParams,
  MenuItemTemplate,
  MenuSource,
  PageContextParams,
  TabView
} from './platform'
import { buildSearchUrl } from '../shared/search'
import { copyConfirmation } from '../shared/clipboard'
import { bindingFor, toAccelerator } from '../shared/shortcuts'
import { displayUrl, getDomain, inputToUrl, isNavigableUrl } from '../shared/url'
import {
  DEFAULT_CONTAINER_ID,
  type BookmarkNode,
  type BookmarksBarMode,
  type Rect,
  type Settings,
  type Shortcut,
  type ShortcutAction,
  type Tab
} from '../shared/types'
import { ZOOM_CEILING, ZOOM_FLOOR, formatZoom, siteKey } from '../shared/pageControls'
import { spaceLabel } from '../shared/defaults'
import { bookmarkUrlCount, isBookmarkRoot } from '../shared/bookmarks'
import { applicationMenu, menuSignature, runFromMenuBar } from './menuBar'

type Template = MenuItemTemplate[]

/** How long state changes are batched before the menu bar is rebuilt from them. */
const APPLICATION_MENU_DEBOUNCE_MS = 80

/**
 * What the key table says about each item, filled in: the chord shown after the label of every
 * item that names an `action` (its primary binding, else its first alternative; nothing when the
 * action is unbound), and the click of items that name one but bring none. Pure: returns copies.
 */
export function withAccelerators(
  items: Template,
  shortcuts: Shortcut[],
  run: (action: ShortcutAction) => void
): Template {
  return items.map((item) => {
    const out: MenuItemTemplate = { ...item }
    const action = item.action
    if (action) {
      if (out.accelerator === undefined) {
        const accelerator = toAccelerator(bindingFor(shortcuts, action))
        if (accelerator) out.accelerator = accelerator
      }
      if (!out.click) out.click = () => run(action)
    }
    if (item.submenu) out.submenu = withAccelerators(item.submenu, shortcuts, run)
    return out
  })
}

/** Collapse duplicate, leading and trailing separators (items left out by capability leave gaps). */
export function tidySeparators(template: Template): Template {
  return template.filter((item, i, arr) => {
    if (item.type !== 'separator') return true
    const prev = arr[i - 1]
    return i > 0 && i < arr.length - 1 && prev?.type !== 'separator'
  })
}

/** Chrome clips the quoted selection in `Search … for "…"` at 50 characters. */
const SELECTION_LABEL_MAX = 50
/** Chrome lists at most five spelling suggestions. */
const SPELLING_SUGGESTIONS_MAX = 5

/**
 * Context menus. Zen (Firefox) uses native-styled menus everywhere; the core builds the templates
 * and the host shows them – Electron as native popups (the only thing that can draw above the tab
 * views), Android inside the chrome as sheets / popovers.
 */
export class Menus {
  constructor(private readonly browser: Browser) {}

  /** What the host's menu bar shows right now, so it is only rebuilt when that changes. */
  private applicationMenuSignature: string | null = null
  private applicationMenuTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Give hosts with a menu bar (macOS) the application menu: every item's chord from the active
   * key table, rebuilt only when what it shows changed. Hosts without one are never called.
   */
  syncApplicationMenu(): void {
    const host = this.browser.platform.menus
    if (!host.setApplicationMenu) return
    if (this.applicationMenuTimer) {
      clearTimeout(this.applicationMenuTimer)
      this.applicationMenuTimer = null
    }
    const template = withAccelerators(
      applicationMenu(this.browser),
      this.browser.state.shortcuts,
      (action) => runFromMenuBar(this.browser, action)
    )
    const signature = menuSignature(template)
    if (signature === this.applicationMenuSignature) return
    this.applicationMenuSignature = signature
    host.setApplicationMenu(template)
  }

  /** Rebuild the menu bar once the current burst of state changes is over. */
  scheduleApplicationMenu(): void {
    if (!this.browser.platform.menus.setApplicationMenu || this.applicationMenuTimer) return
    this.applicationMenuTimer = setTimeout(() => {
      this.applicationMenuTimer = null
      this.syncApplicationMenu()
    }, APPLICATION_MENU_DEBOUNCE_MS)
  }

  private popup(
    template: Template,
    win: ZenWindow,
    source: MenuSource,
    anchor?: { x?: number; y?: number; keyboard?: boolean }
  ): void {
    const items = withAccelerators(tidySeparators(template), this.browser.state.shortcuts, (a) =>
      this.browser.actions.run(a, { sourceTabId: null, win })
    )
    this.browser.platform.menus.popup(items, { source, win, ...anchor })
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

  /**
   * Chrome's page context menu: one group per thing under the pointer (link, image, media,
   * text field, selection; the page itself when none), then the extensions' items, then the
   * developer group. Groups are joined by separators, three at most.
   */
  showPageContextMenu(tabId: string, params: PageContextParams, win: ZenWindow): void {
    const { tabs, state } = this.browser
    const tab = tabs.tab(tabId)
    const view = tabs.view(tabId)
    if (!tab || !view) return
    const caps = state.capabilities
    // `javascript:` links run script rather than lead anywhere: Chrome shows no link items.
    const hasLink = Boolean(params.linkURL) && !/^javascript:/i.test(params.linkURL)
    const isImage = params.mediaType === 'image' && Boolean(params.srcURL)
    const isMedia =
      (params.mediaType === 'video' || params.mediaType === 'audio') && Boolean(params.srcURL)
    const selection = params.selectionText.trim()
    const plainPage = !hasLink && !isImage && !isMedia && !params.isEditable && !selection

    const groups: Template[] = []
    if (hasLink) {
      const [open, transfer] = this.linkGroups(tab, view, params, win)
      // Chrome keeps the link's open and copy items apart; when the link is not alone
      // (a linked image, a selection) the two fold into one group to stay within budget.
      if (isImage || isMedia || selection) groups.push([...open, ...transfer])
      else groups.push(open, transfer)
    }
    if (isImage) groups.push(this.imageGroup(tab, view, params, win))
    if (isMedia) groups.push(...this.mediaGroups(tab, view, params, win))
    if (params.isEditable) {
      if (params.misspelledWord) groups.push(this.spellingGroup(view, params))
      // Chrome searches a field's selected text too; the item closes the editing group. A
      // misspelled word is auto-selected on right-click, so skip the search there – its group is
      // the spelling suggestions, as in Chrome.
      const tail =
        selection && !params.misspelledWord ? this.selectionGroup(tab, selection, win).slice(1) : []
      groups.push(this.editGroup(params, { tail }))
    } else if (selection) {
      groups.push(this.selectionGroup(tab, selection, win))
    }
    if (plainPage) groups.push(this.navigationGroup(tab, view, win), this.pageGroup(tab, win))
    // Extension items sit where Chrome puts them: after the browser's own entries, before the
    // developer group.
    const extensionItems = this.browser.extensions.pageContextMenuItems(tabId, params, win)
    if (extensionItems.length > 0) groups.push(extensionItems)

    const developer: Template = []
    if (plainPage && params.frameId) developer.push(...this.frameItems(tab, view, params, win))
    developer.push(...this.boostsSubmenu(tabId, win))
    if (plainPage && caps.viewSource) {
      developer.push({
        label: 'View Page Source',
        enabled: !tab.url.startsWith('zen://'),
        action: 'page.viewSource',
        click: () => this.browser.actions.run('page.viewSource', { sourceTabId: tabId, win })
      })
    }
    if (caps.devtools) {
      developer.push({
        label: 'Inspect Element',
        action: 'devtools.inspector',
        click: () => this.inspectElement(view, params)
      })
    }
    groups.push(developer)
    this.popup(joinGroups(groups), win, 'page')
  }

  /**
   * A tile on the new tab page (right-click, its ⋮ button, Shift+F10): the site's open targets,
   * then edit (a custom shortcut only) and remove – the page carries the removal out itself so
   * its Undo toast follows, as for the Delete key. `x`, `y` are the page's CSS pixels; the host
   * places menus in the window's, so the page's rect in the window is added.
   */
  showNewTabTileMenu(
    tabId: string,
    tile: { id: string; url: string; title: string; x: number; y: number; keyboard: boolean },
    win: ZenWindow
  ): void {
    const { tabs, state } = this.browser
    const tab = tabs.tab(tabId)
    if (!tab || !isNavigableUrl(tile.url)) return
    const caps = state.capabilities
    const open: Template = [
      {
        label: 'Open in New Tab',
        click: () =>
          tabs.createTab(
            {
              url: tile.url,
              active: false,
              afterTabId: tab.id,
              containerId: tab.containerId,
              openerTabId: tab.id
            },
            win
          )
      }
    ]
    if (caps.windows) {
      open.push(
        {
          label: 'Open in New Window',
          click: () =>
            this.browser.openUrlInWindow(tile.url, win.isPrivate ? 'private' : 'synced', win)
        },
        {
          label: 'Open in New Private Window',
          click: () => this.browser.openUrlInWindow(tile.url, 'private', win)
        }
      )
    }
    const manage: Template = []
    if (state.settings.newTab.shortcuts === 'custom') {
      manage.push({
        label: 'Edit Shortcut',
        click: () => this.browser.newTab.openShortcutDialog(tabId, tile.id, win)
      })
    }
    manage.push({
      label: 'Remove',
      click: () => this.browser.newTab.removeTileFromPage(tabId, tile.id)
    })
    const rect = win.contentRect()
    const anchor = rect
      ? { x: rect.x + tile.x, y: rect.y + tile.y, keyboard: tile.keyboard }
      : { keyboard: tile.keyboard }
    this.popup(joinGroups([open, manage]), win, 'page', anchor)
  }

  /** Chrome's "Inspect": the inspector opens on the node under the click, not the document. */
  private inspectElement(view: TabView, params: PageContextParams): void {
    if (view.inspectElementAt) view.inspectElementAt(params.x, params.y)
    else view.openDevTools('inspect')
  }

  /** The link's open targets and its copy / save items, as two groups. */
  private linkGroups(
    tab: Tab,
    view: TabView,
    params: PageContextParams,
    win: ZenWindow
  ): [Template, Template] {
    const { tabs, state } = this.browser
    const caps = state.capabilities
    const url = params.linkURL
    const navigable = isNavigableUrl(url)
    const glanceAllowed = state.settings.glanceEnabled && !win.glance
    const open: Template = []
    // `mailto:` and `tel:` links have nowhere to open in a tab: only their copy items (Chrome).
    if (navigable) {
      open.push({
        label: 'Open Link in New Tab',
        click: () =>
          tabs.createTab(
            {
              url,
              active: false,
              afterTabId: tab.essential ? undefined : tab.id,
              containerId: tab.containerId,
              openerTabId: tab.id
            },
            win
          )
      })
      if (caps.windows) {
        open.push(
          {
            label: 'Open Link in New Window',
            click: () =>
              this.browser.openUrlInWindow(url, win.isPrivate ? 'private' : 'synced', win)
          },
          {
            label: 'Open Link in New Private Window',
            click: () => this.browser.openUrlInWindow(url, 'private', win)
          }
        )
      }
      open.push(
        {
          label: 'Open Link in Glance',
          enabled: glanceAllowed,
          click: () => tabs.openGlance(url, tab.id, 0.5, 0.5, win)
        },
        { label: 'Open Link in Split View', click: () => this.splitLink(tab.id, url, win) },
        {
          label: 'Open Link in New Container Tab',
          enabled: !win.isPrivate,
          submenu: this.containerSubmenu((cid) =>
            tabs.createTab({ url, active: true, containerId: cid }, win)
          )
        }
      )
    }
    const transfer: Template = []
    if (isDownloadable(url)) {
      transfer.push({
        label: 'Save Link As…',
        click: () => view.downloadURL(url, { saveAs: true })
      })
    }
    const copy = linkCopyItem(url)
    transfer.push({
      label: copy.label,
      click: () => this.browser.copyText(copy.text, copy.confirmation, win)
    })
    const linkText = params.linkText?.trim() ?? ''
    if (linkText && linkText !== url) {
      transfer.push({
        label: 'Copy Link Text',
        click: () => this.browser.copyText(linkText, 'Text copied', win)
      })
    }
    if (caps.share && navigable) {
      transfer.push({
        label: 'Share Link…',
        click: () => void this.browser.share({ url, tabId: tab.id }, win)
      })
    }
    return [open, transfer]
  }

  private imageGroup(tab: Tab, view: TabView, params: PageContextParams, win: ZenWindow): Template {
    const { tabs, state } = this.browser
    const src = params.srcURL
    return [
      {
        label: 'Open Image in New Tab',
        enabled: isNavigableUrl(src),
        click: () =>
          tabs.createTab(
            {
              url: src,
              active: false,
              afterTabId: tab.id,
              containerId: tab.containerId,
              openerTabId: tab.id
            },
            win
          )
      },
      {
        label: 'Save Image As…',
        enabled: isDownloadable(src),
        click: () => view.downloadURL(src, { saveAs: true })
      },
      {
        label: 'Copy Image',
        click: () => this.copyImage(src, tab.id, params.x, params.y, win)
      },
      {
        label: 'Copy Image Address',
        click: () => this.browser.copyText(src, 'Link copied', win)
      },
      ...(state.capabilities.share
        ? [
            {
              label: 'Share Image…',
              click: () => void this.browser.share({ imageUrl: src, tabId: tab.id }, win)
            }
          ]
        : [])
    ]
  }

  /**
   * A `<video>` / `<audio>`: its playback controls (Chrome's checkable Loop and Show Controls,
   * Play / Pause and Mute for good measure), then its save / copy / open items. The controls
   * act on the clicked element itself through the page, so a page with several players gets
   * the right one.
   */
  private mediaGroups(
    tab: Tab,
    view: TabView,
    params: PageContextParams,
    win: ZenWindow
  ): Template[] {
    const { tabs, state } = this.browser
    const src = params.srcURL
    const kind = params.mediaType === 'video' ? 'Video' : 'Audio'
    const flags = params.mediaFlags
    const act = (body: string): void => void this.runOnMedia(view, params, body)
    const controls: Template = []
    if (flags) {
      controls.push(
        {
          label: flags.isPaused ? 'Play' : 'Pause',
          enabled: !flags.inError,
          click: () => act(flags.isPaused ? 'el.play().catch(() => {})' : 'el.pause()')
        },
        {
          label: flags.isMuted ? 'Unmute' : 'Mute',
          enabled: flags.hasAudio,
          click: () => act(`el.muted = ${String(!flags.isMuted)}`)
        },
        {
          label: 'Loop',
          type: 'checkbox',
          checked: flags.isLooping,
          enabled: flags.canLoop,
          click: () => act(`el.loop = ${String(!flags.isLooping)}`)
        },
        {
          label: 'Show Controls',
          type: 'checkbox',
          checked: flags.isControlsVisible,
          enabled: flags.canToggleControls,
          click: () => act(`el.controls = ${String(!flags.isControlsVisible)}`)
        }
      )
    }
    if (params.mediaType === 'video' && state.capabilities.pictureInPicture) {
      const showing = flags?.isShowingPictureInPicture ?? false
      controls.push({
        label: showing ? 'Exit Picture-in-Picture' : 'Picture-in-Picture',
        enabled: !flags || showing || flags.canShowPictureInPicture,
        action: 'page.pip',
        click: () =>
          act(
            showing || !flags
              ? 'if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {}); else el.requestPictureInPicture().catch(() => {})'
              : 'el.requestPictureInPicture().catch(() => {})'
          )
      })
    }
    const transfer: Template = [
      {
        label: `Save ${kind} As…`,
        // Chrome greys the item for streams it cannot save (`blob:` MSE sources, live media).
        enabled: (flags?.canSave ?? true) && isDownloadable(src),
        click: () => view.downloadURL(src, { saveAs: true })
      },
      {
        label: `Copy ${kind} Address`,
        click: () => this.browser.copyText(src, 'Link copied', win)
      },
      {
        label: `Open ${kind} in New Tab`,
        enabled: isNavigableUrl(src),
        click: () =>
          tabs.createTab(
            { url: src, active: false, afterTabId: tab.id, containerId: tab.containerId },
            win
          )
      }
    ]
    return [controls, transfer]
  }

  /**
   * Run `body` against the clicked media element (`el`): matched by source first, then by the
   * click position (CSS pixels: the event's DIPs divided by the zoom factor), in the frame the
   * click landed in.
   */
  private runOnMedia(view: TabView, params: PageContextParams, body: string): Promise<unknown> {
    const zoom = view.getZoom() || 1
    const x = Math.round(params.x / zoom)
    const y = Math.round(params.y / zoom)
    const code = `(() => {
      const src = ${JSON.stringify(params.srcURL)};
      const all = [...document.querySelectorAll('video, audio')];
      let el = all.find((m) => m.currentSrc === src || m.src === src);
      if (!el) {
        const hit = document.elementFromPoint(${x}, ${y});
        el = hit && (hit.closest('video, audio') || all.find((m) => m.contains(hit)));
      }
      if (!el) {
        el = all.find((m) => {
          const r = m.getBoundingClientRect();
          return ${x} >= r.left && ${x} <= r.right && ${y} >= r.top && ${y} <= r.bottom;
        });
      }
      if (!el) return false;
      ${body};
      return true;
    })()`
    return view.executeJavaScript(code, params.frameId).catch(() => false)
  }

  /** Chrome's spelling group: up to five suggestions (or a greyed placeholder), Add to Dictionary. */
  private spellingGroup(view: TabView, params: PageContextParams): Template {
    const suggestions = params.dictionarySuggestions.slice(0, SPELLING_SUGGESTIONS_MAX)
    const items: Template = suggestions.map((suggestion) => ({
      label: suggestion,
      click: () => view.replaceMisspelling(suggestion)
    }))
    if (items.length === 0) items.push({ label: 'No Spelling Suggestions', enabled: false })
    items.push({
      label: 'Add to Dictionary',
      click: () => view.addWordToDictionary(params.misspelledWord)
    })
    return items
  }

  /**
   * Chrome's editing items, as one group: Undo / Redo, the clipboard trio with Paste as Plain
   * Text, Delete, Select All, then `tail` (a selection's search item) and the OS emoji picker
   * where the host has one (Windows, macOS). `afterPaste` is the omnibox's Paste and Go.
   */
  private editGroup(
    params: Pick<ChromeContextParams, 'editFlags'>,
    extra: { afterPaste?: Template; tail?: Template } = {}
  ): Template {
    const flags = params.editFlags
    const { app } = this.browser.platform
    return [
      { label: 'Undo', role: 'undo', enabled: flags.canUndo },
      { label: 'Redo', role: 'redo', enabled: flags.canRedo },
      { label: 'Cut', role: 'cut', enabled: flags.canCut },
      { label: 'Copy', role: 'copy', enabled: flags.canCopy },
      { label: 'Paste', role: 'paste', enabled: flags.canPaste },
      ...(extra.afterPaste ?? []),
      { label: 'Paste as Plain Text', role: 'pasteAndMatchStyle', enabled: flags.canPaste },
      { label: 'Delete', role: 'delete', enabled: flags.canDelete },
      { label: 'Select All', role: 'selectAll', enabled: flags.canSelectAll },
      ...(extra.tail ?? []),
      ...(app.showEmojiPanel
        ? [{ label: 'Emoji', click: () => this.browser.platform.app.showEmojiPanel?.() }]
        : [])
    ]
  }

  /**
   * Selected text: Copy, then either "Go to <url>" when the selection reads as an address or
   * `Search <engine> for "…"` (a new tab next to this one, like Chrome).
   */
  private selectionGroup(tab: Tab, selection: string, win: ZenWindow): Template {
    const { tabs, state } = this.browser
    const engine =
      state.searchEngines.find((e) => e.id === state.settings.searchEngineId) ??
      state.searchEngines[0]
    const open = (url: string): void =>
      void tabs.createTab(
        { url, active: true, afterTabId: tab.id, containerId: tab.containerId },
        win
      )
    const asUrl = selectionUrl(selection)
    const items: Template = [{ label: 'Copy', role: 'copy' }]
    if (asUrl) {
      items.push({
        label: `Go to ${clipLabel(displayUrl(asUrl), SELECTION_LABEL_MAX)}`,
        click: () => open(asUrl)
      })
    } else if (engine) {
      const short = clipLabel(selection, SELECTION_LABEL_MAX)
      items.push({
        label: `Search ${engine.name} for “${short}”`,
        click: () => open(buildSearchUrl(engine, selection))
      })
    }
    if (state.capabilities.share) {
      items.push({
        label: 'Share…',
        click: () => void this.browser.share({ text: selection, tabId: tab.id }, win)
      })
    }
    return items
  }

  /** Back, Forward, Reload / Stop – and the way out of fullscreen while the page is in it. */
  private navigationGroup(tab: Tab, view: TabView, win: ZenWindow): Template {
    const { tabs } = this.browser
    const items: Template = []
    if (win.htmlFullscreenTabId === tab.id) {
      items.push({
        label: 'Exit Full Screen',
        click: () => void view.executeJavaScript('document.exitFullscreen()').catch(() => null)
      })
    } else if (win.host.isFullScreen()) {
      items.push({
        label: 'Exit Full Screen',
        action: 'page.fullscreen',
        click: () => this.browser.toggleFullscreen(win)
      })
    }
    items.push(
      {
        label: 'Back',
        enabled: tab.canGoBack,
        action: 'nav.back',
        click: () => tabs.goBack(tab.id)
      },
      {
        label: 'Forward',
        enabled: tab.canGoForward,
        action: 'nav.forward',
        click: () => tabs.goForward(tab.id)
      },
      tab.loading
        ? { label: 'Stop', action: 'nav.stop', click: () => tabs.stop(tab.id) }
        : { label: 'Reload', action: 'nav.reload', click: () => tabs.reload(tab.id) }
    )
    return items
  }

  /** The page's own actions: bookmark, save, print, screenshot, Reader View. */
  private pageGroup(tab: Tab, win: ZenWindow): Template {
    const { state, reader } = this.browser
    const run = (action: 'page.savePage' | 'page.print' | 'page.screenshot'): void =>
      this.browser.actions.run(action, { sourceTabId: tab.id, win })
    const readerOpen = reader.isReaderUrl(tab.url)
    return [
      {
        label: tab.bookmarked ? 'Remove Bookmark' : 'Bookmark Page',
        action: 'bookmark.add',
        click: () => this.browser.toggleBookmark(tab.id, win)
      },
      { label: 'Save Page As…', action: 'page.savePage', click: () => run('page.savePage') },
      ...(state.capabilities.print
        ? [{ label: 'Print…', action: 'page.print' as const, click: () => run('page.print') }]
        : []),
      { label: 'Take Screenshot', action: 'page.screenshot', click: () => run('page.screenshot') },
      {
        label: readerOpen ? 'Exit Reader View' : 'Enter Reader View',
        enabled: readerOpen || reader.canRead(tab),
        action: 'page.readerMode',
        click: () => reader.toggle(tab.id, win)
      }
    ]
  }

  /** Chrome's frame items for a click inside a sub-frame: reload it, view its source. */
  private frameItems(tab: Tab, view: TabView, params: PageContextParams, win: ZenWindow): Template {
    const { tabs, state } = this.browser
    const frameId = params.frameId ?? 0
    const frameURL = params.frameURL ?? ''
    const items: Template = []
    if (view.reloadFrame) {
      items.push({ label: 'Reload Frame', click: () => view.reloadFrame?.(frameId) })
    }
    if (state.capabilities.viewSource && /^https?:/i.test(frameURL)) {
      items.push({
        label: 'View Frame Source',
        click: () =>
          tabs.createTab({ url: `view-source:${frameURL}`, active: true, afterTabId: tab.id }, win)
      })
    }
    return items
  }

  // ---------------------------------------------------------------------------
  // Chrome (URL bar, toolbar, chrome text fields)
  // ---------------------------------------------------------------------------

  /**
   * A right-click in the chrome document: the URL bar's field and pill get Chrome's omnibox menu
   * (Paste and Go / Paste and Search on top of the editing items), the reload button Chrome's
   * reload choices while the tab's DevTools are open, any other text field the editing items,
   * a selection elsewhere Copy. Plain chrome gets no menu, as in Chrome.
   */
  async showChromeContextMenu(params: ChromeContextParams, win: ZenWindow): Promise<void> {
    const { tabs, state } = this.browser
    const tab = params.tabId ? tabs.tab(params.tabId) : undefined
    if (params.target === 'reload') {
      if (!tab || !state.devtoolsOpenFor.has(tab.id)) return
      this.popup(this.reloadItems(tab), win, 'urlbar')
      return
    }
    if (params.target === 'urlbar' || params.target === 'urlpill') {
      const clipboard = (await this.browser.platform.clipboard.readText?.().catch(() => '')) ?? ''
      const pasted = clipboard.trim()
      const targetTabId = tab?.id ?? null
      // One item, as in Chrome's omnibox: it goes to an address and searches anything else.
      const isAddress = Boolean(pasted && inputToUrl(pasted))
      const pasteAndGo: MenuItemTemplate = {
        label: isAddress ? 'Paste and Go' : 'Paste and Search',
        enabled: pasted.length > 0,
        action: isAddress ? 'urlbar.pasteAndGo' : 'urlbar.pasteAndSearch',
        click: () => {
          // An open bar closes, as a submit does.
          this.browser.emit('urlbar.close', undefined, win)
          void this.browser.pasteAndGo(targetTabId, !isAddress, win)
        }
      }
      const groups: Template[] = []
      if (params.target === 'urlbar') {
        groups.push(this.editGroup(params, { afterPaste: [pasteAndGo] }))
      } else {
        // The pill is not a field: it copies the address and takes the clipboard.
        groups.push([
          {
            label: 'Copy',
            enabled: Boolean(tab && !tab.url.startsWith('zen://')),
            action: 'tab.copyUrl',
            click: () => tab && tabs.copyUrl(tab.id)
          },
          pasteAndGo
        ])
      }
      groups.push([
        this.fullUrlsItem(win),
        {
          label: 'Manage Search Engines…',
          click: () =>
            this.browser.emit('overlay.open', { kind: 'settings', section: 'search' }, win)
        }
      ])
      this.popup(joinGroups(groups), win, 'urlbar')
      return
    }
    if (params.isEditable) {
      this.popup(this.editGroup(params), win, 'urlbar')
      return
    }
    if (params.selectionText.trim()) this.popup([{ label: 'Copy', role: 'copy' }], win, 'urlbar')
  }

  /** Chrome's "Always show full URLs": the address pill's elision setting (`showFullUrls`). */
  private fullUrlsItem(win: ZenWindow): MenuItemTemplate {
    const shown = Boolean(this.browser.state.settings.showFullUrls)
    const patch: Partial<Settings> = { showFullUrls: !shown }
    return {
      label: 'Always Show Full URLs',
      type: 'checkbox',
      checked: shown,
      click: () => this.browser.handleCommand(win, 'settings.update', patch)
    }
  }

  /** Chrome's reload button menu (DevTools open): Normal Reload, Hard Reload, Empty Cache and Hard Reload. */
  private reloadItems(tab: Tab): Template {
    const { tabs } = this.browser
    const view = tabs.view(tab.id)
    return [
      { label: 'Normal Reload', action: 'nav.reload', click: () => tabs.reload(tab.id) },
      {
        label: 'Hard Reload',
        action: 'nav.reloadSkipCache',
        click: () => tabs.reload(tab.id, true)
      },
      {
        label: 'Empty Cache and Hard Reload',
        enabled: Boolean(view?.clearCache),
        click: () =>
          void view
            ?.clearCache?.()
            .catch(() => null)
            .then(() => tabs.reload(tab.id, true))
      }
    ]
  }

  // ---------------------------------------------------------------------------
  // Extension toolbar button
  // ---------------------------------------------------------------------------

  /**
   * The context menu of an extension's toolbar button: Chrome's layout of the extension's own
   * `contextMenus` items (`action` / `browser_action` contexts) above the browser's entries.
   */
  showExtensionActionMenu(id: string, win: ZenWindow, anchor?: { x: number; y: number }): void {
    const { extensions } = this.browser
    const info = extensions.list().find((entry) => entry.id === id)
    if (!info) return
    const template: Template = [{ label: info.name, enabled: false }, { type: 'separator' }]
    const own = extensions.actionContextMenuItems(id, win)
    if (own.length > 0) template.push(...own, { type: 'separator' })
    template.push(
      {
        label: 'Options',
        enabled: info.enabled && Boolean(info.optionsPage),
        click: () => extensions.openOptions(id, win)
      },
      { type: 'separator' },
      { label: 'Remove from Zenium', click: () => void extensions.remove(id) },
      {
        label: 'Manage Extensions',
        click: () => this.browser.actions.run('addons.open', { sourceTabId: null, win })
      }
    )
    this.popup(template, win, 'app', anchor)
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
    const copied =
      (await view.copyImageAt(x, y).catch(() => false)) ||
      (await this.browser.platform.clipboard.writeImageFromUrl(srcUrl))
    if (!copied) {
      this.browser.toast('Could not copy image', 'error', win)
      return
    }
    const { platform, capabilities } = this.browser.state
    const toast = copyConfirmation(platform, capabilities, 'Image copied')
    if (toast) this.browser.toast(toast, 'info', win)
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  showTabContextMenu(tabId: string, win: ZenWindow): void {
    const { tabs, state } = this.browser
    const tab = tabs.tab(tabId)
    if (!tab) return
    const m = state.model
    const caps = state.capabilities
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
    // The shortcuts act on the active tab: only its menu shows them.
    const key = (action: ShortcutAction): { action?: ShortcutAction } =>
      active?.id === tab.id ? { action } : {}
    const otherWindows = tabs.windowsForMove(tabId, win)

    const template: Template = [
      {
        label: 'New Tab Below',
        enabled: !tab.essential,
        click: () => this.browser.newTabAfter(tabId, win)
      },
      { type: 'separator' },
      {
        label: tab.discarded ? 'Load Tab' : 'Reload Tab',
        ...key('nav.reload'),
        click: () => tabs.reload(tabId)
      },
      {
        label: tab.muted ? 'Unmute Tab' : 'Mute Tab',
        ...key('page.toggleMute'),
        click: () => tabs.toggleMute(tabId)
      },
      {
        label: tabs.siteMuted(tab.url) ? 'Unmute Site' : 'Mute Site',
        enabled: Boolean(domain),
        click: () => tabs.toggleMuteSite(tabId)
      },
      { label: 'Duplicate Tab', ...key('tab.duplicate'), click: () => tabs.duplicate(tabId, win) },
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
        ? { label: 'Unpin Tab', ...key('tab.togglePin'), click: () => tabs.togglePin(tabId, win) }
        : {
            label: tab.pinned ? 'Unpin Tab' : 'Pin Tab',
            ...key('tab.togglePin'),
            click: () => tabs.togglePin(tabId, win)
          },
      ...(tab.pinned || tab.essential
        ? [
            {
              label: 'Reset Pinned Tab',
              ...key('tab.resetPinned'),
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
      ...(caps.windows
        ? [
            {
              label: 'Move Tab to New Window',
              click: () => void tabs.moveTabToNewWindow(tabId, null, win)
            },
            {
              label: 'Move to Window',
              enabled: otherWindows.length > 0,
              submenu: otherWindows.map((w) => ({
                label: this.windowLabel(w),
                click: () => void tabs.moveTabToWindow(tabId, w, null, win)
              }))
            }
          ]
        : []),
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
        ...key('bookmark.add'),
        enabled: !tab.url.startsWith('zen://'),
        click: () => this.browser.toggleBookmark(tabId, win)
      },
      {
        label: 'Bookmark All Tabs…',
        action: 'bookmark.allTabs',
        click: () => this.browser.bookmarkTabs(win)
      },
      {
        label: 'Share',
        submenu: [
          ...(caps.share
            ? [
                { label: 'Share…', click: () => this.browser.shareTab(tabId, win) },
                { type: 'separator' as const }
              ]
            : []),
          { label: 'Copy Link', ...key('tab.copyUrl'), click: () => tabs.copyUrl(tabId) },
          {
            label: 'Copy Link as Markdown',
            ...key('tab.copyUrlMarkdown'),
            click: () => tabs.copyUrl(tabId, true)
          },
          {
            label: 'Email Link…',
            ...key('page.emailLink'),
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
        ...key('tab.close'),
        click: () => void tabs.requestClose(tabId, false, win)
      },
      ...(tab.pinned || tab.essential
        ? [{ label: 'Remove Tab', click: () => void tabs.requestClose(tabId, true, win) }]
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
        {
          label: `Bookmark ${n} Tabs…`,
          click: () =>
            this.browser.bookmarkTabs(
              win,
              selected.map((t) => t.id)
            )
        },
        { type: 'separator' },
        {
          label: `Close ${n} Tabs`,
          click: () =>
            // One at a time, so a page that objects asks before the next one is touched.
            void (async () => {
              for (const t of selected) await tabs.requestClose(t.id, false, win)
            })()
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
        { label: 'New Tab', action: 'tab.new', click: () => this.browser.openNewTab(win) },
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
              {
                label: 'New Space…',
                action: 'space.new' as const,
                click: () => this.browser.emit('space.new', undefined, win)
              },
              { type: 'separator' as const }
            ]),
        {
          label: 'Clear Unpinned Tabs',
          ...(space.id === win.activeSpaceId ? { action: 'space.closeUnpinned' as const } : {}),
          enabled: space.tabIds.some((id) => !state.model.tabs[id]?.pinned),
          click: () => tabs.closeUnpinned(space.id, win)
        }
      ],
      win,
      'newtab'
    )
  }

  /** Long-press on a new tab page tile: open it elsewhere, pin it, or take it off the page. */
  showTopSiteContextMenu(url: string, title: string, win: ZenWindow): void {
    if (!isNavigableUrl(url)) return
    const { tabs, state, newTabPhone } = this.browser
    const pinned = state.settings.newTabPhone.pinned.some((p) => p.url === url)
    this.popup(
      [
        {
          label: 'Open in New Tab',
          click: () => tabs.createTab({ url, active: false }, win)
        },
        {
          label: 'Copy Link',
          click: () => this.browser.platform.clipboard.writeText(url)
        },
        { type: 'separator' },
        {
          label: pinned ? 'Unpin Shortcut' : 'Pin Shortcut',
          click: () => (pinned ? newTabPhone.unpin(url) : newTabPhone.pin(url, title))
        },
        { label: 'Remove', click: () => newTabPhone.remove(url) }
      ],
      win,
      'topsite'
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

  /** How a window is named in "Move to Window": its active tab, like Chrome's submenu. */
  private windowLabel(win: ZenWindow): string {
    const title = this.browser.tabs.activeTitleFor(win)?.trim()
    const label = title ? (title.length > 60 ? `${title.slice(0, 57)}…` : title) : 'Empty window'
    return win.isPrivate ? `${label} (Private)` : label
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

  // ---------------------------------------------------------------------------
  // Bookmarks (the manager's and the bar's item and background menus)
  // ---------------------------------------------------------------------------

  /**
   * Chrome's bookmark menus. `ids` are the selected nodes (empty when a folder's empty space was
   * clicked); `folderId` is the folder on screen – where pasted and new items go. The bar's menu
   * ("bar": chips, folder panels, the empty strip) adds the open-in-window targets, "Sort by
   * name", the "Show bookmarks bar" choice and a way into the manager.
   */
  showBookmarkContextMenu(
    ids: string[],
    folderId: string,
    anchor: { x: number; y: number },
    win: ZenWindow,
    surface: 'manager' | 'bar' = 'manager'
  ): void {
    const { bookmarks, state } = this.browser
    const windows = state.capabilities.windows
    const nodes = ids.map((id) => bookmarks.get(id)).filter((n): n is BookmarkNode => Boolean(n))
    const single = nodes.length === 1 ? nodes[0] : null
    const urls = bookmarkUrlCount(bookmarks.tree, ids)
    const editable = nodes.length > 0 && nodes.every((n) => !isBookmarkRoot(n.id))
    const bar = surface === 'bar'
    const template: Template = []
    if (single?.type === 'url') {
      template.push({
        label: 'Open in New Tab',
        click: () => this.browser.openBookmark(single.id, true, null, win)
      })
      if (windows) {
        template.push(
          {
            label: 'Open in New Window',
            click: () => this.browser.openBookmarksInWindow(ids, false, win)
          },
          {
            label: 'Open in New Private Window',
            enabled: !win.isPrivate,
            click: () => this.browser.openBookmarksInWindow(ids, true, win)
          }
        )
      }
    } else if (nodes.length) {
      template.push({
        label: `Open All (${urls})`,
        enabled: urls > 0,
        click: () => this.browser.openBookmarks(ids, win)
      })
      if (windows) {
        template.push(
          {
            label: `Open All (${urls}) in New Window`,
            enabled: urls > 0,
            click: () => this.browser.openBookmarksInWindow(ids, false, win)
          },
          {
            label: `Open All (${urls}) in New Private Window`,
            enabled: urls > 0 && !win.isPrivate,
            click: () => this.browser.openBookmarksInWindow(ids, true, win)
          }
        )
      }
    }
    if (nodes.length) {
      template.push(
        { type: 'separator' },
        {
          label: single?.type === 'url' ? 'Edit…' : 'Rename…',
          enabled: Boolean(single) && editable,
          click: () =>
            single &&
            this.browser.emit(
              'bookmark.edit',
              { id: single.id, parentId: single.parentId ?? folderId, type: single.type },
              win
            )
        },
        { type: 'separator' },
        { label: 'Cut', enabled: editable, click: () => this.browser.clipBookmarks(ids, 'cut') },
        { label: 'Copy', enabled: editable, click: () => this.browser.clipBookmarks(ids, 'copy') }
      )
      // Touch users have no drag and drop; the nested chooser moves the selection anywhere.
      if (!bar)
        template.push({ label: 'Move to', enabled: editable, submenu: this.moveToSubmenu(ids) })
    }
    // Pasting next to a chip lands right after it; on empty space it appends.
    const pasteIndex = bar && single && single.parentId === folderId ? single.index + 1 : undefined
    template.push({
      label: 'Paste',
      enabled: bookmarks.canPaste(),
      click: () => void bookmarks.paste(folderId, pasteIndex)
    })
    if (nodes.length) {
      template.push(
        { type: 'separator' },
        {
          label: nodes.length > 1 ? `Delete ${nodes.length} Items` : 'Delete',
          enabled: editable,
          click: () => void bookmarks.removeMany(ids)
        }
      )
    }
    template.push(
      { type: 'separator' },
      {
        label: bar ? 'Add Page…' : 'Add New Bookmark…',
        click: () =>
          this.browser.emit('bookmark.edit', { id: null, parentId: folderId, type: 'url' }, win)
      },
      {
        label: bar ? 'Add Folder…' : 'Add New Folder',
        click: () =>
          this.browser.emit('bookmark.edit', { id: null, parentId: folderId, type: 'folder' }, win)
      }
    )
    if (bar) {
      if (single?.type === 'folder') {
        template.push(
          { type: 'separator' },
          { label: 'Sort by Name', click: () => this.browser.sortBookmarkFolder(single.id) }
        )
      }
      template.push(
        { type: 'separator' },
        { label: 'Show Bookmarks Bar', submenu: this.bookmarksBarSubmenu(win) },
        {
          label: 'Bookmark Manager',
          click: () => this.browser.emit('overlay.open', { kind: 'bookmarks', folderId }, win)
        }
      )
    }
    this.popup(template, win, 'bookmark', anchor)
  }

  /**
   * The overflow menu of the bookmarks surface: what its header has no room for. Native popup
   * at the anchor on desktop, the menu sheet on phones.
   */
  showBookmarksMenu(anchor: { x: number; y: number }, win: ZenWindow): void {
    this.popup(
      [
        { label: 'Bookmark All Tabs…', click: () => this.browser.bookmarkTabs(win) },
        { type: 'separator' },
        { label: 'Import Bookmarks…', click: () => void this.browser.importBookmarks(win) },
        { label: 'Export Bookmarks…', click: () => void this.browser.exportBookmarks(win) }
      ],
      win,
      'bookmark',
      anchor
    )
  }

  /** Always / Only on the new tab page / Never, as radio rows (Edge's "Show favorites bar"). */
  private bookmarksBarSubmenu(win: ZenWindow): Template {
    const current = this.browser.state.settings.bookmarksBar
    const choices: Array<{ mode: BookmarksBarMode; label: string }> = [
      { mode: 'always', label: 'Always' },
      { mode: 'newtab', label: 'Only on New Tab Page' },
      { mode: 'never', label: 'Never' }
    ]
    return choices.map(({ mode, label }) => ({
      type: 'radio' as const,
      label,
      checked: current === mode,
      click: () => this.browser.setBookmarksBarMode(mode, win)
    }))
  }

  /** Every folder as a nested submenu ("Move Here" first), minus the selection's own subtrees. */
  private moveToSubmenu(ids: string[]): Template {
    const { bookmarks } = this.browser
    const excluded = new Set<string>()
    for (const id of ids) {
      const node = bookmarks.get(id)
      if (node?.type !== 'folder') continue
      excluded.add(id)
      for (const n of bookmarks.tree.descendants(id)) excluded.add(n.id)
    }
    const build = (folderId: string): Template => {
      const subfolders = bookmarks
        .getChildren(folderId)
        .filter((n) => n.type === 'folder' && !excluded.has(n.id))
      return [
        { label: 'Move Here', click: () => void bookmarks.move(ids, folderId) },
        ...(subfolders.length ? [{ type: 'separator' as const }] : []),
        ...subfolders.map((f) => ({ label: f.title, submenu: build(f.id) }))
      ]
    }
    return bookmarks.roots().map((root) => ({ label: root.title, submenu: build(root.id) }))
  }

  /** Firefox's "Recently Closed Tabs / Windows" as one submenu: newest first, ten at most. */
  private recentlyClosedSubmenu(win: ZenWindow): MenuItemTemplate {
    const { session } = this.browser
    const entries = session.summaries().slice(0, 10)
    if (entries.length === 0) return { label: 'Recently Closed', enabled: false, submenu: [] }
    const items: Template = entries.map((e, i) => ({
      label:
        e.kind === 'window'
          ? `Reopen Window – ${clipLabel(e.title, 40)} (${e.tabCount} ${e.tabCount === 1 ? 'tab' : 'tabs'})`
          : clipLabel(e.title || (e.url ? displayUrl(e.url) : 'Untitled'), 60),
      icon: e.favicon,
      // The newest entry is what the reopen shortcut brings back (Chrome shows it there too).
      ...(i === 0 ? { action: 'tab.reopenClosed' as const } : {}),
      click: () => session.restoreClosed(e.id, win)
    }))
    return {
      label: 'Recently Closed',
      submenu: [
        ...items,
        { type: 'separator' },
        { label: 'Restore All', click: () => session.restoreAll(win) },
        { label: 'Clear List', click: () => session.clearRecentlyClosed() }
      ]
    }
  }

  // ---------------------------------------------------------------------------
  // History page
  // ---------------------------------------------------------------------------

  /** Context menu of one visit on the history page. */
  showHistoryContextMenu(visitId: string, url: string, win: ZenWindow): void {
    const { tabs, history, state } = this.browser
    const caps = state.capabilities
    const host = getDomain(url)
    this.popup(
      [
        {
          label: 'Open in New Tab',
          click: () => tabs.createTab({ url, active: true }, win)
        },
        ...(caps.windows
          ? [
              {
                label: 'Open in New Window',
                click: () => this.browser.openUrlInWindow(url, 'synced', win)
              },
              {
                label: 'Open in New Private Window',
                click: () => this.browser.openUrlInWindow(url, 'private', win)
              }
            ]
          : []),
        { type: 'separator' },
        { label: 'Copy Link', click: () => this.browser.platform.clipboard.writeText(url) },
        { type: 'separator' },
        { label: 'Remove from History', click: () => history.deleteVisits([visitId]) },
        {
          label: 'Forget About This Page',
          click: () => history.deleteUrls([url])
        },
        { type: 'separator' },
        {
          label: 'More from This Site',
          enabled: Boolean(host),
          click: () =>
            this.browser.emit('overlay.open', { kind: 'history', section: `host:${host}` }, win)
        }
      ],
      win,
      'history'
    )
  }

  /**
   * The tab's back/forward stack, from a long press or right click on the back / forward
   * button: up to ten entries around the current one (forward entries on top, like Firefox),
   * the current entry checked, and "Show Full History". A menu rather than a chrome panel
   * because on desktop only native popups draw above the page views.
   */
  showNavigationMenu(tabId: string, win: ZenWindow): void {
    const { tabs, history } = this.browser
    const { entries, index } = tabs.navigationEntries(tabId)
    const window = navigationWindow(entries.length, index, NAVIGATION_MENU_MAX)
    const items: Template = []
    for (let i = window.end - 1; i >= window.start; i -= 1) {
      const entry = entries[i]
      const current = i === index
      items.push({
        label: clipLabel(entry.title || displayUrl(entry.url), 60),
        type: current ? 'checkbox' : 'normal',
        checked: current || undefined,
        icon: current ? null : history.faviconFor(entry.url),
        click: current ? undefined : () => tabs.goToIndex(tabId, i)
      })
    }
    this.popup(
      [
        ...items,
        { type: 'separator' },
        {
          label: 'Show Full History',
          click: () => this.browser.emit('overlay.open', { kind: 'history' }, win)
        }
      ],
      win,
      'history'
    )
  }

  /** Menu of a day heading on the history page. */
  showHistoryDayMenu(dayKey: string, count: number, win: ZenWindow): void {
    const { history } = this.browser
    this.popup(
      [
        {
          label: `Delete This Day (${count} ${count === 1 ? 'visit' : 'visits'})`,
          click: () => history.deleteDay(dayKey)
        }
      ],
      win,
      'history'
    )
  }

  /**
   * The "⋯" application menu in the toolbar (Firefox's hamburger menu). One list for every
   * layout: an item the host cannot do is left out (`caps`), and the phone layout – which has no
   * sidebar, window frame or keyboard to speak of – also drops the items that only act on those
   * (Chrome's phone menu has none of them either). The desktop menu is unchanged by this: its
   * host has every capability the items ask for.
   */
  showAppMenu(win: ZenWindow, options: { anchor?: Rect; keyboard: boolean }): void {
    const { state, tabs } = this.browser
    const caps = state.capabilities
    const active = tabs.activeTabFor(win)
    const local = Boolean(win.localSpace)
    const phone = win.formFactor === 'phone'
    /** Items the host must be able to act on; left out rather than greyed where it cannot. */
    const when = (able: boolean, ...items: Template): Template => (able ? items : [])
    /** Items of the sidebar layouts (desktop and tablet) only. */
    const desktop = (...items: Template): Template => (phone ? [] : items)
    // From its button the menu hangs off the button's bottom edge (Chrome, Firefox); from a
    // shortcut it also starts with its first item selected (design language v2 §9.22).
    const anchor = options.anchor
      ? { x: options.anchor.x, y: options.anchor.y + options.anchor.height }
      : undefined
    const { pageControls } = this.browser
    /** Where Reset Zoom goes: the default zoom for a web page, 100 percent for any other page. */
    const defaultZoom =
      active && pageControls.remembersZoom(active) ? pageControls.settings.zoom : 1
    /** The factor the user set (before the system font size), so Reset compares like with like. */
    const zoomSet = active
      ? pageControls.remembersZoom(active)
        ? pageControls.siteZoomOf(active)
        : active.zoom
      : 1
    this.popup(
      [
        { label: 'New Tab', action: 'tab.new', click: () => this.browser.openNewTab(win) },
        // Phone slot: "New Private Tab" goes here once Android has private tabs (Chrome: New
        // Incognito tab, second item).
        ...when(!local, {
          label: 'New Space…',
          action: 'space.new',
          click: () => this.browser.emit('space.new', undefined, win)
        }),
        { type: 'separator' },
        ...when(
          caps.windows,
          {
            label: 'New Window',
            action: 'window.new',
            click: () => this.browser.openWindow('synced', win)
          },
          {
            label: 'New Blank Window',
            action: 'window.newUnsynced',
            click: () => this.browser.openWindow('unsynced', win)
          },
          {
            label: 'New Private Window',
            action: 'window.newPrivate',
            click: () => this.browser.openWindow('private', win)
          }
        ),
        { type: 'separator' },
        {
          label: 'Bookmarks',
          submenu: [
            {
              label: active?.bookmarked ? 'Remove Bookmark' : 'Bookmark This Page',
              action: 'bookmark.add',
              enabled: Boolean(active && !active.url.startsWith('zen://')),
              click: () => active && this.browser.toggleBookmark(active.id, win)
            },
            {
              label: 'Bookmark All Tabs…',
              action: 'bookmark.allTabs',
              click: () => this.browser.bookmarkTabs(win)
            },
            { type: 'separator' },
            {
              label: 'Show Bookmarks',
              action: 'bookmark.sidebar',
              click: () => this.browser.emit('overlay.open', { kind: 'bookmarks' }, win)
            },
            ...desktop({ label: 'Show Bookmarks Bar', submenu: this.bookmarksBarSubmenu(win) }),
            { type: 'separator' },
            {
              label: 'Import Bookmarks…',
              click: () => void this.browser.importBookmarks(win)
            },
            {
              label: 'Export Bookmarks…',
              click: () => void this.browser.exportBookmarks(win)
            }
          ]
        },
        {
          label: 'History',
          action: 'history.sidebar',
          click: () => this.browser.emit('overlay.open', { kind: 'history' }, win)
        },
        // Phone slot: "Recent Tabs" (tabs open on other devices, from sync) goes here.
        ...desktop(this.recentlyClosedSubmenu(win)),
        {
          label: 'Downloads',
          action: 'downloads.open',
          click: () => this.browser.emit('overlay.open', { kind: 'downloads' }, win)
        },
        ...when(caps.extensions, {
          label: 'Add-ons and Themes',
          action: 'addons.open',
          click: () => this.browser.emit('overlay.open', { kind: 'addons' }, win)
        }),
        { type: 'separator' },
        ...desktop({
          label: 'Compact Mode',
          type: 'checkbox',
          action: 'compact.toggle',
          checked: win.compactEnabled,
          click: () => this.browser.toggleCompactMode(win)
        }),
        ...when(!local, {
          label: 'Change Theme…',
          click: () => this.browser.emit('theme.open', { spaceId: win.activeSpaceId }, win)
        }),
        // Chrome's zoom row (- / percentage / +): a native menu has no inline controls, so the
        // row is a submenu whose label carries the live percentage and whose Reset says where
        // it goes; the Fullscreen item below is the row's fullscreen glyph.
        {
          label: active ? `Zoom (${formatZoom(active.zoom)})` : 'Zoom',
          submenu: [
            {
              label: 'Zoom In',
              action: 'zoom.in',
              enabled: Boolean(active) && zoomSet < ZOOM_CEILING - 0.005,
              click: () => active && tabs.adjustZoom(active.id, 1)
            },
            {
              label: 'Zoom Out',
              action: 'zoom.out',
              enabled: Boolean(active) && zoomSet > ZOOM_FLOOR + 0.005,
              click: () => active && tabs.adjustZoom(active.id, -1)
            },
            {
              label: active ? `Reset Zoom (${formatZoom(defaultZoom)})` : 'Reset Zoom',
              action: 'zoom.reset',
              enabled: Boolean(active) && Math.abs(zoomSet - defaultZoom) >= 0.005,
              click: () => active && tabs.resetZoom(active.id)
            }
          ]
        },
        ...desktop({
          label: 'Fullscreen',
          type: 'checkbox',
          action: 'page.fullscreen',
          checked: win.host.isFullScreen(),
          click: () => this.browser.toggleFullscreen(win)
        }),
        { type: 'separator' },
        {
          label: 'Find in Page…',
          action: 'find.open',
          enabled: Boolean(active),
          click: () => this.browser.actions.run('find.open', { sourceTabId: null, win })
        },
        {
          label: 'Reader View',
          action: 'page.readerMode',
          enabled: Boolean(active) && this.browser.reader.canRead(active),
          click: () => active && this.browser.reader.toggle(active.id, win)
        },
        ...when(caps.share, {
          label: 'Share…',
          enabled: Boolean(active) && /^https?:/i.test(active!.url),
          click: () => active && this.browser.shareTab(active.id, win)
        }),
        ...when(caps.print, {
          label: 'Print…',
          action: 'page.print',
          enabled: Boolean(active),
          click: () =>
            active && this.browser.actions.run('page.print', { sourceTabId: active.id, win })
        }),
        {
          label: 'Save Page As…',
          action: 'page.savePage',
          enabled: Boolean(active),
          click: () =>
            active && this.browser.actions.run('page.savePage', { sourceTabId: active.id, win })
        },
        {
          label: 'Take Screenshot',
          action: 'page.screenshot',
          enabled: Boolean(active),
          click: () =>
            active && this.browser.actions.run('page.screenshot', { sourceTabId: active.id, win })
        },
        // Phone slot: "Add to Home Screen" (W1-7) goes here, ahead of the page controls.
        ...when(caps.pageControls, ...this.pageControlItems(active)),
        { type: 'separator' },
        ...when(caps.resourceGovernor, {
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
                this.browser.emit('overlay.open', { kind: 'settings', section: 'resources' }, win)
            }
          ]
        }),
        ...desktop({
          label: 'Keyboard Shortcuts',
          click: () => this.browser.emit('overlay.open', { kind: 'shortcuts' }, win)
        }),
        {
          label: 'Settings',
          action: 'settings.open',
          click: () => this.browser.emit('overlay.open', { kind: 'settings' }, win)
        },
        ...when(caps.devtools, {
          label: 'Developer Tools',
          action: 'devtools.toggle',
          enabled: Boolean(active),
          click: () => active && tabs.toggleDevtools(active.id)
        }),
        { type: 'separator' },
        { label: `About Zenium ${state.version}`, enabled: false },
        // An Android app is left, not quit: the system owns its lifetime.
        ...desktop({
          label: 'Quit',
          action: 'app.quit',
          click: () => this.browser.actions.run('app.quit', { sourceTabId: null, win })
        })
      ],
      win,
      'app',
      { ...anchor, keyboard: options.keyboard }
    )
  }

  /**
   * Chrome's page controls in the app menu, closing the page group as "Desktop site" does in
   * Chrome: "Desktop Site" is the per-site checkbox, and while sites are darkened "Dark Theme for
   * This Site" is its exception. Both act on the active tab's site, so they wait for a web page.
   */
  private pageControlItems(active: Tab | undefined): Template {
    const { pageControls } = this.browser
    const web = Boolean(active) && siteKey(active!.url) !== null
    const items: Template = [
      {
        label: 'Desktop Site',
        type: 'checkbox',
        enabled: web,
        checked: web && pageControls.isDesktop(active!),
        click: () =>
          active && pageControls.setDesktopSite(active.id, !pageControls.isDesktop(active))
      }
    ]
    if (pageControls.settings.darkenSites) {
      items.push({
        label: 'Dark Theme for This Site',
        type: 'checkbox',
        enabled: web,
        checked: web && pageControls.isDarkened(active!),
        click: () =>
          active && pageControls.setDarkenSite(active.id, !pageControls.isDarkened(active))
      })
    }
    return items
  }

  describe(url: string): string {
    return displayUrl(url)
  }
}

/** Menu labels have no room for long page titles. */
export function clipLabel(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** Groups joined by separators; empty groups vanish rather than leave a double rule. */
export function joinGroups(groups: MenuItemTemplate[][]): MenuItemTemplate[] {
  const out: MenuItemTemplate[] = []
  for (const group of groups) {
    if (group.length === 0) continue
    if (out.length > 0) out.push({ type: 'separator' })
    out.push(...group)
  }
  return out
}

/** URLs a "Save … As…" can fetch into a file (the engine downloads these schemes). */
export function isDownloadable(url: string): boolean {
  return /^(https?|ftp|file|blob|data):/i.test(url)
}

/**
 * Chrome's copy item of a link: the address itself, or for `mailto:` / `tel:` links the bare
 * address / number (what one would paste into a mail client or a dialler), without the scheme
 * and any `?subject=` tail.
 */
export function linkCopyItem(url: string): { label: string; text: string; confirmation: string } {
  const scheme = url.slice(0, url.indexOf(':')).toLowerCase()
  if (scheme === 'mailto' || scheme === 'tel') {
    const bare = url.slice(scheme.length + 1).split('?')[0] ?? ''
    let text = bare
    try {
      text = decodeURIComponent(bare)
    } catch {
      text = bare
    }
    return scheme === 'mailto'
      ? { label: 'Copy Email Address', text, confirmation: 'Email address copied' }
      : { label: 'Copy Phone Number', text, confirmation: 'Phone number copied' }
  }
  return { label: 'Copy Link Address', text: url, confirmation: 'Link copied' }
}

/**
 * Chrome's "Go to <url>": a selection that reads as a web address (the URL bar's own test,
 * so `example.com` counts and `weather tomorrow` does not) as the address it would open.
 */
export function selectionUrl(selection: string): string | null {
  const text = selection.trim()
  if (!text || text.length > 2048) return null
  const url = inputToUrl(text)
  return url && /^https?:/i.test(url) ? url : null
}

/** Entries the back/forward list shows at most. */
export const NAVIGATION_MENU_MAX = 10

/**
 * The `[start, end)` slice of a back/forward stack of `length` entries to list around `index`:
 * at most `max` entries, the current one kept in view, biased towards the back entries when
 * the stack is longer than the list (that is what the button is mostly used for).
 */
export function navigationWindow(
  length: number,
  index: number,
  max: number
): { start: number; end: number } {
  if (length <= max) return { start: 0, end: length }
  const current = Math.max(0, Math.min(index, length - 1))
  const forward = Math.min(length - 1 - current, Math.floor((max - 1) / 3))
  let start = current + forward - (max - 1)
  if (start < 0) start = 0
  const end = Math.min(length, start + max)
  return { start: Math.max(0, end - max), end }
}
