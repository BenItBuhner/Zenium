import type { Browser } from './browser'
import { surfaceMounted, type ZenWindow } from './window'
import type {
  ChromeContextParams,
  MenuItemTemplate,
  MenuSource,
  PageContextParams,
  TabView
} from './platform'
import { buildSearchUrl } from '../shared/search'
import { copyConfirmation } from '../shared/clipboard'
import { internalPageOf } from '../shared/internalPages'
import { bindingFor, formatChord, toAccelerator } from '../shared/shortcuts'
import {
  BLANK_URL,
  NEW_TAB_URL,
  displayUrl,
  getDomain,
  inputToUrl,
  isNavigableUrl,
  isWebPageUrl
} from '../shared/url'
import {
  DEFAULT_CONTAINER_ID,
  type AppWindowInfo,
  type BookmarkNode,
  type BookmarksBarMode,
  type DownloadDeleteFileResult,
  type Folder,
  type MenuAnchor,
  type MenuItemDescriptor,
  type NavigationDirection,
  type NavigationSnapshotEntry,
  type PhoneBarItemId,
  type Platform as PlatformOs,
  type Rect,
  type Settings,
  type Shortcut,
  type ShortcutAction,
  type SyncRemoteTab,
  type Tab
} from '../shared/types'
import { ZOOM_CEILING, ZOOM_FLOOR, formatZoom, siteKey } from '../shared/pageControls'
import { phoneBarHas } from '../shared/phoneBar'
import { FOLDER_COLOR_NAMES, FOLDER_COLOR_ORDER, spaceLabel } from '../shared/defaults'
import { bookmarkUrlCount, isBookmarkRoot } from '../shared/bookmarks'
import { fileExtension, resolveDownloadSettings } from '../shared/downloads'
import { canRetryDownload, deleteFileToast, displayName } from '../shared/downloadsShell'
import { languageName, sortedByName } from '../shared/languageNames'
import { orderMediaEntries } from '../shared/mediaHub'
import { serialiseMenu } from './rendererMenus'
import { dictionaryFor } from '../shared/spellcheck'
import { installMenuLabel, openAppMenuLabel } from '../shared/webApp'
import { isInFlight, isQuarantined } from './downloads'
import { mayAutoOpen } from './downloads/danger'
import {
  applicationMenu,
  HELP_URL,
  ISSUES_URL,
  menuSignature,
  runFromMenuBar,
  splitViewSubmenu
} from './menuBar'
import { isSendableUrl } from './sync/sendTab'
import {
  folderTabs,
  isPrivateFolder,
  isSavedFolder,
  regularFolderTabs,
  tabVisibleIn
} from './model'

type Template = MenuItemTemplate[]

/** Where a selection action was invoked from: the page context menu or the host's floating toolbar. */
type SelectionSurface = 'menu' | 'toolbar'

/** One thing to do with selected text; see `Menus.selectionActions`. */
interface SelectionAction {
  /** Stable name a toolbar host hands back (`runSelectionAction`). */
  id: string
  /** The context menu's label (Chrome's wording: `Search Google for "…"`). */
  label: string
  /** The floating toolbar's title: short, Title Case. */
  title: string
  /** Whether the page context menu lists it. */
  menu: boolean
  /** Whether the floating toolbar lists it (on hosts that have one). */
  toolbar: boolean
  run(surface: SelectionSurface): void
}

/** Where the selection was asked about, for the actions that place something. */
interface SelectionPlaces {
  /**
   * Where the context menu's click landed, in CSS pixels of the page view; absent for a text
   * field's selection and for the toolbar.
   */
  at?: { x: number; y: number }
  /** Where the selection sits in the page, 0…1 of its width and height (the toolbar's touch). */
  origin?: { x: number; y: number }
}

/** What a toolbar host draws for one action: the id it names back and the title it shows. */
export interface SelectionToolbarItem {
  id: string
  title: string
}

/**
 * The toolbar's order, by id: what a 412 dp phone fits in the bar first (after the system's Copy:
 * the search or the glance, then Share) and the widest, Translate, last, so that at most one of
 * Zenium's items sits behind the overflow; an id not named here goes after them, in the order
 * of `Menus.selectionActions`. The menu keeps that order throughout (Translate Selection before
 * Share, as on the desktop).
 */
const SELECTION_TOOLBAR_ORDER: readonly string[] = [
  'search',
  'glance',
  'share',
  'translate',
  'readAloud'
]

function toolbarRank(id: string): number {
  const rank = SELECTION_TOOLBAR_ORDER.indexOf(id)
  return rank === -1 ? SELECTION_TOOLBAR_ORDER.length : rank
}

/** How long state changes are batched before the menu bar is rebuilt from them. */
const APPLICATION_MENU_DEBOUNCE_MS = 80

/**
 * What the key table says about each item, filled in: the chord shown after the label of every
 * item that names an `action` (its primary binding, else its first alternative; nothing when the
 * action is unbound) – as the native accelerator and, given the `platform`, as the user reads
 * it (`hint`, for a menu the renderer draws) – and the click of items that name one but bring
 * none. Pure: returns copies.
 */
export function withAccelerators(
  items: Template,
  shortcuts: Shortcut[],
  run: (action: ShortcutAction) => void,
  platform?: PlatformOs
): Template {
  return items.map((item) => {
    const out: MenuItemTemplate = { ...item }
    const action = item.action
    if (action) {
      const binding = bindingFor(shortcuts, action)
      if (out.accelerator === undefined) {
        const accelerator = toAccelerator(binding)
        if (accelerator) out.accelerator = accelerator
      }
      if (out.hint === undefined && binding && platform) out.hint = formatChord(binding, platform)
      if (!out.click) out.click = () => run(action)
    }
    if (item.submenu) out.submenu = withAccelerators(item.submenu, shortcuts, run, platform)
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
/** The "Spell check" submenu lists the user's languages, not every dictionary there is. */
const SPELLCHECK_MENU_LANGUAGES_MAX = 8
/**
 * A device's submenu under Tabs from Other Devices lists this many of its tabs, newest activity
 * first, as Recently Closed lists ten; the rest read as a count, Open All in Tabs opens them all.
 */
const REMOTE_TABS_MENU_MAX = 10
/** The name a device with none reads under; the engine fills one in, a seeded list may not. */
const UNNAMED_DEVICE = 'Another device'

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
   * The extension action menu last handed to a renderer as data (`extensionActionMenuItems`):
   * its items' handlers by id, live until the next request retires them.
   */
  private actionMenuHandlers: { id: string; handlers: Map<string, () => void> } | null = null
  private actionMenuSeq = 0

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

  private popup(template: Template, win: ZenWindow, source: MenuSource, anchor?: MenuAnchor): void {
    const items = withAccelerators(
      tidySeparators(template),
      this.browser.state.shortcuts,
      (a) => this.browser.actions.run(a, { sourceTabId: null, win }),
      this.browser.platform.info.os
    )
    this.browser.platform.menus.popup(items, { source, win, ...anchor })
  }

  /**
   * Where a page's menu opens for Shift+F10 or the Menu key (Chrome's rule): at the caret or the
   * focused element, where Chromium reports the event, with the first item selected. The
   * event's coordinates are the view's; the window's come from where the chrome placed it. A
   * pointer's menu opens at the pointer, which the host does by itself.
   */
  private pageAnchor(tabId: string, params: PageContextParams, win: ZenWindow): MenuAnchor {
    if (params.menuSourceType !== 'keyboard') return {}
    const rect = win.viewRect(tabId)
    return rect
      ? { x: rect.x + params.x, y: rect.y + params.y, keyboard: true }
      : { keyboard: true }
  }

  /** The chrome document's own: the event's coordinates are the window's already. */
  private chromeAnchor(params: ChromeContextParams): MenuAnchor {
    return params.keyboard ? { x: params.x, y: params.y, keyboard: true } : {}
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

  /**
   * Chrome's "Send to your devices" (ID-27) for a tab's page, in the shape Chrome's page menu
   * gives it: with one other device the item names it – "Send to Laptop" – and sends on the
   * click; with more, "Send to Your Devices" opens the devices, most recently seen first, one
   * row each – a submenu on the desktop and the tablet, and on the phone the device picker
   * sheet (`sendTab.open`, the chrome's `SendTabSheet`: the §9.13 picker that rises as the menu
   * sheet leaves, so the item carries the ellipsis of a row that opens a sheet). Sync off, or no
   * other device yet, and there is no item: an action with nothing to send to is not drawn
   * disabled (§10.4). Only a web page travels (`isSendableUrl`, the engine's rule): an internal
   * or extension page keeps the item, disabled, so the page reads as the reason. The engine
   * confirms the hand-over with its toast, "Sent to Laptop".
   */
  private sendToDevicesItems(tab: Tab | undefined, win: ZenWindow): Template {
    if (!tab) return []
    const sync = this.browser.sync.status()
    if (!sync.enabled || sync.devices.length === 0) return []
    const enabled = isSendableUrl(tab.url)
    const send = (deviceId: string): void =>
      void this.browser.sync.sendTab({ deviceId, url: tab.url, tabId: tab.id }, win)
    const devices = [...sync.devices].sort((a, b) => b.lastSeen - a.lastSeen)
    if (devices.length === 1) {
      const [device] = devices
      return [{ label: `Send to ${device.name}`, enabled, click: () => send(device.id) }]
    }
    if (win.formFactor === 'phone') {
      return [
        {
          label: 'Send to Your Devices…',
          enabled,
          click: () => this.browser.emit('sendTab.open', { tabId: tab.id }, win)
        }
      ]
    }
    return [
      {
        label: 'Send to Your Devices',
        enabled,
        submenu: devices.map((device) => ({ label: device.name, click: () => send(device.id) }))
      }
    ]
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
      // Chrome's "Spell check" submenu, its own group after the editing items, on hosts with a
      // spellchecker of the browser's own.
      const spellcheck = this.spellcheckSubmenu(win)
      if (spellcheck) groups.push([spellcheck])
    } else if (selection) {
      groups.push(this.selectionGroup(tab, selection, win, { x: params.x, y: params.y }))
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
    this.popup(joinGroups(groups), win, 'page', this.pageAnchor(tabId, params, win))
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
    // One of the user's own tiles (the whole grid under "My shortcuts", the leading tiles under
    // "Most visited") can be edited; a most-visited tile can only be removed.
    if (this.browser.newTab.isShortcut(tile.id)) {
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
    // Chrome for Android's pair for a tab in a group (TAB-15): "Open in new tab in group" adds
    // the new tab to the group, behind the current tab, and "Open in new tab" then opens it
    // outside the group, after the group's last member. The desktop keeps Chrome desktop's one
    // item, whose tab joins the group as it always has.
    const group =
      win.formFactor !== 'desktop' && tab.folderId ? state.model.folders[tab.folderId] : undefined
    // `mailto:` and `tel:` links have nowhere to open in a tab: only their copy items (Chrome).
    if (navigable) {
      if (group) {
        open.push({
          label: 'Open Link in New Tab in Group',
          click: () =>
            tabs.createTab(
              {
                url,
                active: false,
                afterTabId: tab.id,
                containerId: tab.containerId,
                openerTabId: tab.id,
                folderId: group.id
              },
              win
            )
        })
      }
      open.push({
        label: 'Open Link in New Tab',
        click: () =>
          tabs.createTab(
            {
              url,
              active: false,
              afterTabId: tab.essential
                ? undefined
                : group
                  ? (folderTabs(state.model, group.id).at(-1)?.id ?? tab.id)
                  : tab.id,
              containerId: tab.containerId,
              openerTabId: tab.id,
              joinGroup: group ? false : undefined
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
      // Hosts that keep private browsing in tabs (Android): Chrome's "Open in Incognito tab",
      // second item; the link opens in the private container of this window, in front.
      if (caps.privateTabs) {
        open.push({
          label: 'Open Link in Private Tab',
          click: () => tabs.newPrivateTab(url, win)
        })
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
    // Withheld from private tabs, as Chrome withholds it from Incognito (ruled 2026-09-21).
    if (
      params.mediaType === 'video' &&
      state.capabilities.pictureInPicture &&
      !tabs.isPrivate(tab)
    ) {
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
      // The profile's one custom dictionary (every session), not this view's session alone.
      click: () => void this.browser.spellcheck.addWord(params.misspelledWord, view)
    })
    return items
  }

  /**
   * Chrome's "Spell check" submenu of an editable field: the languages the fields are checked
   * in (checked) and the user's other languages with a dictionary (unchecked), each a toggle;
   * then "Check the spelling of text fields" and the way to Settings › Languages. Null on a host
   * without a spellchecker of its own (Android) and on one that follows the OS's languages
   * (macOS), where the item would have nothing to offer.
   */
  private spellcheckSubmenu(win: ZenWindow): MenuItemTemplate | null {
    const { spellcheck, state, translate } = this.browser
    const status = spellcheck.uiState()
    if (!status.available || status.systemLanguages) return null
    const checked = new Set(spellcheck.languages())
    const available = status.languages.map((l) => l.code)
    // The user's languages: the ones checked now, the UI locales' dictionaries and the
    // languages they read (the translate preferences), in that order, without repeats.
    const candidates = [
      ...checked,
      ...this.browser.platform.spellcheck!.locales,
      ...translate.uiState().preferences.preferred
    ]
    const codes: string[] = []
    for (const candidate of candidates) {
      const code = dictionaryFor(candidate, available)
      if (code && !codes.includes(code)) codes.push(code)
      if (codes.length === SPELLCHECK_MENU_LANGUAGES_MAX) break
    }
    const nameOf = new Map(status.languages.map((l) => [l.code, l.name]))
    const enabled = state.settings.spellcheck.enabled
    const languages: Template = codes.map((code) => ({
      label: nameOf.get(code) ?? code,
      type: 'checkbox',
      checked: checked.has(code),
      enabled,
      click: () => spellcheck.setLanguage(code, !checked.has(code))
    }))
    return {
      label: 'Spell Check',
      submenu: [
        ...languages,
        ...(languages.length > 0 ? [{ type: 'separator' as const }] : []),
        {
          label: 'Check the Spelling of Text Fields',
          type: 'checkbox',
          checked: enabled,
          click: () => spellcheck.setEnabled(!enabled)
        },
        { type: 'separator' },
        {
          label: 'Language Settings',
          click: () => void this.browser.pages.open('settings', 'languages', win)
        }
      ]
    }
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
   * `Search <engine> for "…"` (a new tab next to this one, like Chrome), Translate Selection
   * where the click landed (`at`; the page's own selection, not a text field's), Share.
   */
  private selectionGroup(
    tab: Tab,
    selection: string,
    win: ZenWindow,
    at?: { x: number; y: number }
  ): Template {
    const items: Template = [{ label: 'Copy', role: 'copy' }]
    for (const action of this.selectionActions(tab, selection, win, { at })) {
      if (action.menu) items.push({ label: action.label, click: () => action.run('menu') })
    }
    return items
  }

  /**
   * What can be done with selected page text, the one list both surfaces draw from: the page
   * context menu (`selectionGroup`, its `label`, in this order) and – on hosts with
   * `capabilities.selectionToolbar` – the system's floating toolbar over the selection (`title`,
   * short and Title Case, the toolbar has room for a handful of words; its order is
   * `SELECTION_TOOLBAR_ORDER`). An action names the surfaces it belongs on; a future item needs
   * an entry here and nothing else. The toolbar's search opens its tab in the background: the
   * reader keeps their place and the result waits next door.
   */
  private selectionActions(
    tab: Tab,
    selection: string,
    win: ZenWindow,
    { at, origin = { x: 0.5, y: 0.5 } }: SelectionPlaces = {}
  ): SelectionAction[] {
    const { tabs, state, translate } = this.browser
    const engine = state.defaultSearchEngine()
    // The toolbar's tab opens in the background, with this tab as its opener: a back on it
    // returns here, like a link's "Open Link in New Tab" (the menu's opens in front, like Chrome).
    const open = (url: string, surface: SelectionSurface): void =>
      void tabs.createTab(
        {
          url,
          active: surface === 'menu',
          afterTabId: tab.id,
          containerId: tab.containerId,
          openerTabId: tab.id
        },
        win
      )
    const asUrl = selectionUrl(selection)
    const actions: SelectionAction[] = []
    if (asUrl) {
      // The menu's item for an address; the toolbar previews it in a glance instead (Chrome's
      // toolbar has no item for an address either, and the toolbar's width is a handful of words).
      actions.push({
        id: 'go',
        label: `Go to ${clipLabel(displayUrl(asUrl), SELECTION_LABEL_MAX)}`,
        title: 'Open in New Tab',
        menu: true,
        toolbar: false,
        run: (surface) => open(asUrl, surface)
      })
      // Glance previews the address over the page: the toolbar's own item (the menu's link
      // items offer it for links). Off with the setting, and never on top of another glance.
      if (state.settings.glanceEnabled && !win.glance) {
        actions.push({
          id: 'glance',
          label: 'Open in Glance',
          title: 'Open in Glance',
          menu: false,
          toolbar: true,
          run: () => tabs.openGlance(asUrl, tab.id, clamp01(origin.x), clamp01(origin.y), win)
        })
      }
    } else if (engine) {
      // The toolbar names the engine the search goes through, as the menu does (Chrome's
      // pattern); Zenium is the browser, not an engine.
      const short = clipLabel(selection, SELECTION_LABEL_MAX)
      actions.push({
        id: 'search',
        label: `Search ${engine.name} for “${short}”`,
        title: `Search ${engine.name}`,
        menu: true,
        toolbar: true,
        run: (surface) => open(buildSearchUrl(engine, selection), surface)
      })
    }
    // Chrome's Copy Link to Highlight: the menu's item for the link alone (the toolbar's Share
    // carries it, and the phone's sheet has Copy link in Zenium's own row). Web pages only: a
    // highlight in a `zen://` page or a file means nothing to whoever gets the link.
    if (/^https?:\/\//i.test(tab.url)) {
      actions.push({
        id: 'copyHighlight',
        label: 'Copy Link to Highlight',
        title: 'Copy Link',
        menu: true,
        toolbar: false,
        run: () => void this.copyHighlightLink(tab, win)
      })
    }
    // The services core's selection translation: the menu offers it for the page's own selection
    // (a text field's comes without `at`) and puts the popover where the click landed; the
    // toolbar's touch anchors nothing, so the phone shows its sheet.
    if (translate.available) {
      actions.push({
        id: 'translate',
        label: 'Translate Selection',
        title: 'Translate',
        menu: at !== undefined,
        toolbar: true,
        run: (surface) =>
          void translate.showSelection(
            tab.id,
            selection,
            surface === 'menu' ? (at ?? null) : null,
            win
          )
      })
    }
    // The selection's share carries a link to the highlight (SH-11, Chrome's shared
    // highlighting): the text, and the page's URL with the selection as its `#:~:text=`
    // directive when the page can single it out – the text alone otherwise, as Chrome shares it.
    if (state.capabilities.share) {
      actions.push({
        id: 'share',
        label: 'Share…',
        title: 'Share',
        menu: true,
        toolbar: true,
        run: () => void this.shareSelection(tab, selection, win)
      })
    }
    // Listen from a selection (EDGE-11 / GN-13): `readAloud.start { from: 'selection-on' }`,
    // the core's model takes the selection from the page, reads it first and then reads on
    // through the rest of the document after it – the main content when the page is readerable
    // (Edge's "Read aloud from here"; Chrome reads the selection alone, and stopping at the
    // selection's end left a mid-article start with nothing to follow). Hosts with a speech
    // host; any page, since a selection is text to read whether or not the page is an article.
    // The phone's item, on both of its surfaces, and the desktop's right-click item (#265) read
    // on the same way, since a selection is mostly a place to start from; both dock the shared
    // player, which shows where the reading is. Worded "Listen", the app menu's own verb
    // ("Listen to This Page"), so that beside the system's process-text item ("Read aloud",
    // Google's, which stays) the pair reads as two things (the lead, #240).
    if (this.browser.readAloud.available) {
      actions.push({
        id: 'readAloud',
        label: 'Listen',
        title: 'Listen',
        menu: true,
        toolbar: true,
        run: () => void this.browser.readAloud.start({ tabId: tab.id, from: 'selection-on' })
      })
    }
    return actions
  }

  /** The selection onto the share sheet with its link to the highlight when the page can make one. */
  private async shareSelection(tab: Tab, selection: string, win: ZenWindow): Promise<void> {
    const url = await this.browser.textFragments.highlightUrl(tab.id)
    await this.browser.share({ text: selection, url: url ?? undefined, tabId: tab.id }, win)
  }

  /** The link to the highlight on the clipboard – or a word when the selection cannot be linked to. */
  private async copyHighlightLink(tab: Tab, win: ZenWindow): Promise<void> {
    const url = await this.browser.textFragments.highlightUrl(tab.id)
    if (url) this.browser.copyText(url, 'Link copied', win, 'Link copied')
    else this.browser.toast("Couldn't make a link to this text", 'info', win)
  }

  /**
   * Zenium's items for the host's floating selection toolbar over `selection` in `tabId`, in
   * order: the id the host hands back to `runSelectionAction` and the title it shows (and reads
   * out). Empty on hosts without the toolbar (`capabilities.selectionToolbar`), whose menus carry
   * the same actions, and for a tab that is gone.
   */
  selectionToolbar(tabId: string, selection: string): SelectionToolbarItem[] {
    const { tabs, state } = this.browser
    const tab = tabs.tab(tabId)
    const text = clipSelection(selection)
    if (!state.capabilities.selectionToolbar || !tab || !text.trim()) return []
    const win = tabs.windowFor(tabId)
    return this.selectionActions(tab, text, win)
      .filter((action) => action.toolbar)
      .sort((a, b) => toolbarRank(a.id) - toolbarRank(b.id))
      .map(({ id, title }) => ({ id, title }))
  }

  /**
   * The toolbar item `id` was touched with `selection` selected (the host reads the selection
   * again at the touch, so the text is the one on screen): run it. The list is built afresh
   * from the text, so an id the text no longer warrants (an address that stopped being one)
   * does nothing. `origin` is where the selection sits in the page, 0…1 of its width and
   * height, for the glance to grow out of.
   */
  runSelectionAction(
    tabId: string,
    id: string,
    selection: string,
    origin?: { x: number; y: number }
  ): boolean {
    const { tabs, state } = this.browser
    const tab = tabs.tab(tabId)
    const text = clipSelection(selection)
    if (!state.capabilities.selectionToolbar || !tab || !text.trim()) return false
    const win = tabs.windowFor(tabId)
    const action = this.selectionActions(tab, text, win, { origin }).find(
      (candidate) => candidate.toolbar && candidate.id === id
    )
    if (!action) return false
    action.run('toolbar')
    return true
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

  /** The page's own actions: bookmark, save, print, screenshot, Reader View, Translate Page. */
  private pageGroup(tab: Tab, win: ZenWindow): Template {
    const { state, reader, translate } = this.browser
    const run = (
      action:
        | 'page.savePage'
        | 'page.printPreview'
        | 'page.screenshot'
        | 'page.captureFullPage'
        | 'capture.start'
    ): void => this.browser.actions.run(action, { sourceTabId: tab.id, win })
    const readerOpen = reader.isReaderUrl(tab.url)
    return [
      {
        label: tab.bookmarked ? 'Remove Bookmark' : 'Bookmark Page',
        action: 'bookmark.add',
        click: () => this.browser.toggleBookmark(tab.id, win)
      },
      { label: 'Save Page As…', action: 'page.savePage', click: () => run('page.savePage') },
      ...(state.capabilities.print
        ? [
            {
              label: 'Print…',
              action: 'page.printPreview' as const,
              click: () => run('page.printPreview')
            }
          ]
        : []),
      { label: 'Take Screenshot', action: 'page.screenshot', click: () => run('page.screenshot') },
      {
        label: 'Capture Full Page',
        action: 'page.captureFullPage',
        click: () => run('page.captureFullPage')
      },
      // Edge's Web capture row (a region of the dimmed page): the desktop's overlay alone.
      ...(win.formFactor === 'desktop'
        ? [
            {
              label: 'Capture Page…',
              action: 'capture.start' as const,
              click: () => run('capture.start')
            }
          ]
        : []),
      {
        label: readerOpen ? 'Exit Reader View' : 'Enter Reader View',
        enabled: readerOpen || reader.canRead(tab),
        action: 'page.readerMode',
        click: () => reader.toggle(tab.id, win)
      },
      ...(translate.available
        ? [
            {
              label: 'Translate Page',
              enabled: translate.canTranslate(tab.id),
              click: () => void translate.open(tab.id, win)
            }
          ]
        : [])
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
    const anchor = this.chromeAnchor(params)
    if (params.target === 'reload') {
      if (!tab || !state.devtoolsOpenFor.has(tab.id)) return
      this.popup(this.reloadItems(tab), win, 'urlbar', anchor)
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
          click: () => void this.browser.pages.open('settings', 'search', win)
        }
      ])
      this.popup(joinGroups(groups), win, 'urlbar', anchor)
      return
    }
    if (params.isEditable) {
      this.popup(this.editGroup(params), win, 'urlbar', anchor)
      return
    }
    if (params.selectionText.trim())
      this.popup([{ label: 'Copy', role: 'copy' }], win, 'urlbar', anchor)
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
   * `contextMenus` items (`action` / `browser_action` contexts) above the browser's entries. A
   * context menu, so its own source: the platform's native menu at the button on the desktop
   * (§6 "Menus": the context menus stay native), not the "⋯" menu's in-chrome panel.
   */
  showExtensionActionMenu(id: string, win: ZenWindow, anchor?: MenuAnchor): void {
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
      {
        label: info.toolbarPinned ? 'Unpin from Toolbar' : 'Pin to Toolbar',
        click: () => extensions.setToolbarPinned(id, !info.toolbarPinned)
      },
      { type: 'separator' },
      { label: 'Remove from Zenium', click: () => void extensions.remove(id) },
      {
        label: 'Manage Extensions',
        click: () => this.browser.actions.run('addons.open', { sourceTabId: null, win })
      }
    )
    this.popup(template, win, 'extension', anchor)
  }

  /**
   * The extension's own items of its action's context menu as data, for a chrome that draws the
   * menu itself (the phone's long-press menu sheet, which puts them above its own rows as
   * `showExtensionActionMenu` does): the `contextMenus` items with the `action` context in
   * Chrome's layout, serialised like a renderer-drawn menu. Their `click`s are kept by id for
   * `runExtensionActionMenuItem`; a new request retires the previous ones (a menu can only be
   * open once at a time). Empty for an extension the browser does not know or that adds none.
   */
  extensionActionMenuItems(id: string, win: ZenWindow): MenuItemDescriptor[] {
    const { extensions } = this.browser
    if (!extensions.list().some((entry) => entry.id === id)) {
      this.actionMenuHandlers = null
      return []
    }
    const own = extensions.actionContextMenuItems(id, win)
    const { items, handlers } = serialiseMenu(own, `action_${++this.actionMenuSeq}`)
    this.actionMenuHandlers = { id, handlers }
    return items
  }

  /**
   * The user picked `itemId` of the menu `extensionActionMenuItems` last answered for `id`: its
   * click runs – the host fires `contextMenus.onClicked` with `OnClickData` for the `action`
   * context and the active tab, as a pick in the native menu does. A stale or unknown id is
   * nothing (the menu the pick came from was retired).
   */
  runExtensionActionMenuItem(id: string, itemId: string): void {
    const open = this.actionMenuHandlers
    if (!open || open.id !== id) return
    const handler = open.handlers.get(itemId)
    if (!handler) return
    // One pick per menu: the sheet has gone by now, its handles with it.
    this.actionMenuHandlers = null
    handler()
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

  showTabContextMenu(tabId: string, win: ZenWindow, anchor?: MenuAnchor): void {
    const { tabs, state } = this.browser
    const tab = tabs.tab(tabId)
    if (!tab) return
    const m = state.model
    const caps = state.capabilities
    const active = tabs.activeTabFor(win)
    const space = win.activeSpace()
    const local = Boolean(win.localSpace)
    const otherSpaces = m.spaces.filter((s) => s.id !== (tab.spaceId ?? win.activeSpaceId))
    // The space's folders to move the tab to; a regular tab's menu names no private group
    // (`isPrivateFolder`: private browsing leaks nothing outside its mode), a private tab's – on
    // a host that keeps private browsing in tabs – every folder of its space.
    const folders = Object.values(m.folders).filter(
      (f) =>
        f.spaceId === (tab.spaceId ?? win.activeSpaceId) &&
        (tabs.isPrivate(tab) || !isPrivateFolder(m, f))
    )
    const canSplitWithActive = Boolean(active) && active!.id !== tab.id
    const pinnedChanged =
      (tab.pinned || tab.essential) && tab.pinnedUrl !== null && tab.url !== tab.pinnedUrl
    const domain = getDomain(tab.url)
    // The shortcuts act on the active tab: only its menu shows them.
    const key = (action: ShortcutAction): { action?: ShortcutAction } =>
      active?.id === tab.id ? { action } : {}
    const otherWindows = tabs.windowsForMove(tabId, win)

    const when = (able: boolean, ...items: Template): Template => (able ? items : [])

    // Firefox's tab menu in Firefox's groups (design language v2 §6 "Menus": a context menu that
    // runs long is regrouped to the app menu's counts – about eighteen rows, four separators at
    // most): the new tab; the tab's own state – reload, mute, unload, freeze, duplicate, pin
    // (Firefox's order), Zen's Essentials, rename and icon; the tab's place – bookmark, "Move
    // Tab ▸" with the space, folder,
    // routing and window moves that were five rows, split, container, share; closing, with the
    // three scoped closes under Firefox's "Close Multiple Tabs ▸"; then Reopen Closed Tab. Nothing
    // the flat menu did is gone – the long tails are in the submenus.
    const openGroup: Template = [
      {
        label: 'New Tab Below',
        enabled: !tab.essential,
        click: () => this.browser.newTabAfter(tabId, win)
      }
    ]

    const stateGroup: Template = [
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
      // Unload and Freeze are the tab's state, as its mute is – Firefox's state group runs
      // Reload, Mute, Unload, Duplicate, Pin – and stand between the mutes and Duplicate.
      {
        label: 'Unload Tab',
        enabled: !tab.discarded && active?.id !== tabId,
        click: () => tabs.discard(tabId)
      },
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
      { label: 'Duplicate Tab', ...key('tab.duplicate'), click: () => tabs.duplicate(tabId, win) },
      // Pin after Duplicate, as Firefox orders them; a pinned row's own rows stand with it.
      tab.essential
        ? { label: 'Unpin Tab', ...key('tab.togglePin'), click: () => tabs.togglePin(tabId, win) }
        : {
            label: tab.pinned ? 'Unpin Tab' : 'Pin Tab',
            ...key('tab.togglePin'),
            click: () => tabs.togglePin(tabId, win)
          },
      ...when(
        tab.pinned || tab.essential,
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
      ),
      ...when(
        !local,
        tab.essential
          ? { label: 'Remove from Essentials', click: () => tabs.toggleEssential(tabId, win) }
          : {
              label: 'Add to Essentials',
              enabled: m.essentialTabIds.length < state.settings.essentialsMax,
              click: () => tabs.toggleEssential(tabId, win)
            }
      ),
      {
        label: 'Rename Tab…',
        // The pick mounts the row's rename field: the keyboard stays in the chrome for it.
        keepsKeyboard: true,
        click: () => this.browser.emit('tab.startRename', { tabId }, win)
      },
      { label: 'Change Icon…', click: () => this.browser.emit('tab.pickIcon', { tabId }, win) }
    ]

    // Firefox's "Move Tab ▸" holds every move: to a space, a folder (Chrome's group items,
    // context-menus-91: "Add Tab to New Folder" while the space has no folder, else "Move to
    // Folder ▸" – a new folder first, then the space's folders, the tab's own checked – and
    // "Remove from Folder" beside it), the domain's route, and – Chrome's pair (tabs-23,
    // context-menus-93) – to a new window or to another, listed by their active tab, most
    // recently focused first and greyed with none to go to.
    const moveTab: Template = joinGroups([
      [
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
        ...when(
          !local,
          folders.length === 0
            ? {
                label: 'Add Tab to New Folder',
                enabled: !tab.essential && !tab.pinned,
                click: () => this.browser.newFolderWithTab(space.id, tabId, win)
              }
            : {
                label: 'Move to Folder',
                enabled: !tab.essential && !tab.pinned,
                submenu: [
                  {
                    label: 'New Folder…',
                    click: () => this.browser.newFolderWithTab(space.id, tabId, win)
                  },
                  { type: 'separator' as const },
                  ...folders.map((f) => ({
                    label: `${f.icon} ${f.name}`,
                    type: 'checkbox' as const,
                    checked: tab.folderId === f.id,
                    click: () => tabs.moveToFolder(tabId, tab.folderId === f.id ? null : f.id)
                  }))
                ]
              },
          ...when(Boolean(tab.folderId), {
            label: 'Remove from Folder',
            click: () => tabs.moveToFolder(tabId, null)
          }),
          {
            label: 'Add Route for Domain',
            enabled: Boolean(domain) && !state.settings.spaceRouting[domain],
            submenu: this.spaceSubmenu(null, (sid) => this.browser.addRouteForTab(tabId, sid))
          }
        )
      ],
      when(
        caps.windows,
        {
          label: 'Move Tab to New Window',
          click: () => void tabs.moveTabToNewWindow(tabId, null, win)
        },
        {
          label: 'Move Tab to Another Window',
          enabled: otherWindows.length > 0,
          submenu: otherWindows.map((w) => ({
            label: this.windowLabel(w),
            click: () => void tabs.moveTabToWindow(tabId, w, null, win)
          }))
        }
      )
    ])

    const placeGroup: Template = [
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
      { label: 'Move Tab', submenu: moveTab },
      {
        label: 'Split with Current Tab',
        enabled: canSplitWithActive,
        click: () => active && tabs.createSplit([active.id, tab.id], 'vertical', win)
      },
      ...when(Boolean(tab.splitGroupId), {
        label: 'Un-split Tab',
        click: () => tabs.removeFromSplit(tabId, true, win)
      }),
      {
        label: 'Open in New Container Tab',
        enabled: !win.isPrivate,
        submenu: this.containerSubmenu((cid) =>
          tabs.createTab({ url: tab.url, active: true, containerId: cid }, win)
        )
      },
      {
        label: 'Share',
        submenu: [
          ...when(
            caps.share,
            { label: 'Share…', click: () => this.browser.shareTab(tabId, win) },
            { type: 'separator' as const }
          ),
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
      // Beside Share, where the link leaves the tab (Firefox's "Send Tab to Device" sits here).
      ...this.sendToDevicesItems(tab, win)
    ]

    const closeGroup: Template = [
      {
        // Firefox's "Close Multiple Tabs ▸". One scope for the three (tabs-25, BUG-013): the
        // space's regular tabs in this window, pinned and Essentials exempt; an item with
        // nothing to close is greyed, not gone (§9.30).
        label: 'Close Multiple Tabs',
        submenu: [
          {
            label: 'Close Tabs Above',
            enabled: tabs.closeScope(tabId, 'above', win).length > 0,
            click: () => tabs.closeAbove(tabId, win)
          },
          {
            label: 'Close Tabs Below',
            enabled: tabs.closeScope(tabId, 'below', win).length > 0,
            click: () => tabs.closeBelow(tabId, win)
          },
          {
            label: 'Close Other Tabs',
            enabled: tabs.closeScope(tabId, 'others', win).length > 0,
            click: () => tabs.closeOthers(tabId, win)
          }
        ]
      },
      {
        label: tab.pinned || tab.essential ? 'Close Tab (keep pinned)' : 'Close Tab',
        ...key('tab.close'),
        click: () => void tabs.requestClose(tabId, false, win)
      },
      ...when(tab.pinned || tab.essential, {
        label: 'Remove Tab',
        click: () => void tabs.requestClose(tabId, true, win)
      })
    ]

    // Edge's (and Chrome's strip) Reopen closed tab, from any row (tabs-24, history-10).
    const template = joinGroups([
      openGroup,
      stateGroup,
      placeGroup,
      closeGroup,
      [this.reopenClosedItem(win)]
    ])
    this.popup(template, win, 'tab', anchor)
  }

  /**
   * "Reopen Closed Tab" (Ctrl+Shift+T): the newest recently closed tab or window, greyed while
   * the list is empty (Chrome's strip menu does the same).
   */
  private reopenClosedItem(win: ZenWindow): MenuItemTemplate {
    return {
      label: 'Reopen Closed Tab',
      action: 'tab.reopenClosed',
      enabled: this.browser.session.recentlyClosed().length > 0,
      click: () => this.browser.tabs.reopenClosed(win)
    }
  }

  /** Zen: select several tabs (Ctrl / Shift+click) and act on all of them at once. */
  showSelectionContextMenu(tabIds: string[], win: ZenWindow, anchor?: MenuAnchor): void {
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
    // As the tab menu's: a selection with a regular tab in it names no private group.
    const allPrivate = selected.every((t) => tabs.isPrivate(t))
    const folders = Object.values(m.folders).filter(
      (f) => f.spaceId === space.id && (allPrivate || !isPrivateFolder(m, f))
    )
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
      'selection',
      anchor
    )
  }

  /**
   * The tab strip's menu (tabs-35): the New Tab row's and the empty space below the rows share
   * it. Chrome's strip rows first – New tab, Reopen closed tab, Bookmark all tabs…, and on the
   * desktop Name window… (context-menus-108) – then Zenium's own: the space's folders and
   * spaces, Clear Unpinned Tabs.
   */
  showNewTabContextMenu(win: ZenWindow, anchor?: MenuAnchor): void {
    const { tabs, state } = this.browser
    const space = win.activeSpace()
    const local = Boolean(win.localSpace)
    const nameWindow: MenuItemTemplate[] =
      win.formFactor === 'desktop'
        ? [
            {
              label: 'Name Window…',
              action: 'window.name',
              click: () => this.browser.emit('windowName.open', undefined, win)
            }
          ]
        : []
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
        this.reopenClosedItem(win),
        {
          label: 'Bookmark All Tabs…',
          action: 'bookmark.allTabs',
          click: () => this.browser.bookmarkTabs(win)
        },
        ...nameWindow,
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
      'newtab',
      anchor
    )
  }

  /**
   * Long-press on a new tab page tile: open it elsewhere, pin it, edit it (a shortcut's name and
   * address, NTP-06: the chrome's edit sheet over the page in `tabId`), move it a slot along the
   * grid, or take it off the page.
   */
  showTopSiteContextMenu(url: string, title: string, tabId: string | null, win: ZenWindow): void {
    if (!isNavigableUrl(url)) return
    const { tabs, state, newTab } = this.browser
    const shortcut = state.newTabDevice.shortcuts.find((s) => s.url === url)
    const pageTab = tabId ?? tabs.activeTabFor(win)?.id ?? null
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
        ...(shortcut && pageTab
          ? [
              {
                label: 'Edit Shortcut…',
                click: () => newTab.openShortcutDialog(pageTab, shortcut.id, win)
              }
            ]
          : []),
        ...(shortcut ? this.moveShortcutItems(shortcut.id) : []),
        {
          label: shortcut ? 'Unpin Shortcut' : 'Pin Shortcut',
          click: () => (shortcut ? newTab.unpin(url) : newTab.pin(url, title))
        },
        { label: 'Remove', click: () => newTab.remove(url) }
      ],
      win,
      'topsite'
    )
  }

  /**
   * Move Left / Move Right for a pinned tile (NTP-06; the #348 design gate's addendum): the
   * hold-and-drag's accessible path – a screen reader's, a keyboard's – one slot at a time in
   * the grid's order, the space menu's two rows, greyed at the ends (§9.17: disabled, not
   * hidden), writing the same `newtab.reorderShortcuts` the drop does.
   */
  private moveShortcutItems(id: string): MenuItemTemplate[] {
    const { state, newTab } = this.browser
    const ids = state.newTabDevice.shortcuts.map((s) => s.id)
    const idx = ids.indexOf(id)
    const moveTo = (to: number): void => {
      const next = ids.filter((other) => other !== id)
      next.splice(to, 0, id)
      newTab.reorderShortcuts(next)
    }
    return [
      { label: 'Move Left', enabled: idx > 0, click: () => moveTo(idx - 1) },
      {
        label: 'Move Right',
        enabled: idx >= 0 && idx < ids.length - 1,
        click: () => moveTo(idx + 1)
      }
    ]
  }

  // ---------------------------------------------------------------------------
  // Spaces & folders
  // ---------------------------------------------------------------------------

  showSpaceContextMenu(spaceId: string, win: ZenWindow, anchor?: MenuAnchor): void {
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
          click: () => void this.browser.pages.open('settings', undefined, win)
        },
        { type: 'separator' },
        {
          label: 'Delete Space',
          enabled: state.model.spaces.length > 1,
          click: () => void this.browser.deleteSpace(spaceId, win)
        }
      ],
      win,
      'space',
      anchor
    )
  }

  private openSpaceInNewWindow(spaceId: string, from: ZenWindow): void {
    const win = this.browser.openWindow('synced', from)
    if (win) this.browser.tabs.switchSpace(spaceId, win)
  }

  /**
   * How a window is named in "Move Tab to Another Window" and tab search: the name the user
   * gave it (Name Window…), else its active tab, like Chrome's submenu.
   */
  windowLabel(win: ZenWindow): string {
    const title = win.name ?? this.browser.tabs.activeTitleFor(win)?.trim()
    const label = title ? clipLabel(title, 60) : 'Empty window'
    return win.isPrivate ? `${label} (Private)` : label
  }

  showFolderContextMenu(folderId: string, win: ZenWindow, anchor?: MenuAnchor): void {
    const { state } = this.browser
    const folder = state.model.folders[folderId]
    if (!folder) return
    if (win.formFactor !== 'desktop') {
      this.popup(this.groupMenu(folder, win), win, 'folder', anchor)
      return
    }
    const live = this.browser.liveFolders.get(folderId)
    // The desktop's folder is the sidebar's tab group, saved when its tabs close (TAB-16, the
    // desktop half of the shared groups). Its menu runs act / change / destroy in four groups:
    // what the folder does (Open Folder while it is saved, then New Tab in Folder on either),
    // what changes it (Edit Folder… – Chrome's group editor bubble, tabs-13: name, colour and
    // the group's actions in one surface beside the header – the live folder's items or Make
    // Live Folder…, and last, for an open folder with tabs on a host with windows to give, Move
    // Folder to New Window – a change of place, filed with the verbs that change the folder as
    // the tab menu files Move Tab to New Window with its place-changing verbs, not beside New
    // Tab), what ends one half of an open folder and can be undone (Unpack Folder leaves the
    // tabs loose to regroup, Close Folder closes them and the folder stays SAVED with their
    // pages, Open Folder brings them back), then Delete Folder alone – Chrome's for a saved
    // group – which forgets what the folder holds, or closes its tabs with it, and so asks first
    // through the chrome's prompt when there is anything to lose (`folder.confirmDelete`). New
    // Tab in Folder on a saved folder opens it first – its pages back as its tabs – and adds the
    // tab behind them (`newTabInFolder`), so the plain-ink verb loses nothing (§5, §9.1). Move
    // Folder to New Window (Chrome's Move group to new window, context-menus-107) takes the
    // folder's tabs and the folder to a window of their own beside this one
    // (`moveFolderToNewWindow`); the saved folder keeps its three rows (Open Folder brings the
    // pages back here). No Rename Folder… and no Expand or Collapse Folder: each duplicates a
    // control the row already has (the editor's Name field, the header's own click). Zen's word
    // is Folder; the touch hosts say Group.
    const when = (able: boolean, ...items: Template): Template => (able ? items : [])
    const saved = isSavedFolder(state.model, folder)
    const count = saved ? (folder.savedTabs?.length ?? 0) : folderTabs(state.model, folderId).length
    const tabs = `${count} ${count === 1 ? 'Tab' : 'Tabs'}`
    const act: Template = [
      ...when(saved, {
        label: `Open Folder (${tabs})`,
        click: () => this.browser.openFolder(folderId, win)
      }),
      { label: 'New Tab in Folder', click: () => this.browser.newTabInFolder(folderId, win) }
    ]
    const change: Template = [
      {
        label: 'Edit Folder…',
        click: () => this.browser.emit('folder.edit', { folderId }, win)
      },
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
              click: () => this.browser.emit('overlay.open', { kind: 'live-folder', folderId }, win)
            },
            {
              label: 'Stop Updating (make static)',
              click: () => this.browser.liveFolders.remove(folderId)
            }
          ]
        : [
            {
              label: 'Make Live Folder…',
              click: () => this.browser.emit('overlay.open', { kind: 'live-folder', folderId }, win)
            }
          ]) as Template),
      ...when(!saved && count > 0 && state.capabilities.windows, {
        label: 'Move Folder to New Window',
        click: () => void this.browser.tabs.moveFolderToNewWindow(folderId, win)
      })
    ]
    const end: Template =
      count && !saved
        ? [
            { label: 'Unpack Folder', click: () => this.browser.deleteFolder(folderId, true) },
            {
              label: `Close Folder (${tabs})`,
              click: () => this.browser.closeFolder(folderId, win)
            }
          ]
        : []
    const destroy: Template = [
      { label: 'Delete Folder', danger: true, click: () => this.deleteFolderAsking(folderId, win) }
    ]
    this.popup(joinGroups([act, change, end, destroy]), win, 'folder', anchor)
  }

  /**
   * The desktop's "Delete Folder": a folder with tabs or saved pages is deleted only once the
   * chrome's prompt (`folder.confirmDelete`, a §9.23 dialog) is answered – the answer runs
   * `folder.delete` – and an empty one goes at once.
   */
  private deleteFolderAsking(folderId: string, win: ZenWindow): void {
    const { model } = this.browser.state
    const folder = model.folders[folderId]
    if (!folder) return
    const holds = folderTabs(model, folderId).length > 0 || Boolean(folder.savedTabs?.length)
    if (holds) this.browser.emit('folder.confirmDelete', { folderId }, win)
    else this.browser.deleteFolder(folderId, false)
  }

  /**
   * A tab group's menu on a touch host (TABLET-04: the tablet sidebar chip's hold, a §9.36
   * popover; the phone's groups have their sheets): Chrome's group header menu with the editor
   * bubble's name and colour folded in, the bubble being the desktop's. Rename Group…, Colour
   * (Chrome's nine as radio items, the group's checked), New Tab in Group, Collapse or Expand
   * Group; then Ungroup – the tabs stay, loose – Close Group (N Tabs) – the tabs close and the
   * group stays SAVED with their pages (TAB-16) – and Delete Group. A saved group (its tabs
   * closed, its pages kept) leads with Open Group (N Tabs) and has nothing to fold, ungroup or
   * close; Delete Group forgets its pages. Title Case throughout (v2 §9.1). Delete Group alone
   * takes the danger ink (§6: for what destroys the user's own; Close Group destroys nothing
   * the saved group does not keep, and Chrome's "Close group" is plain), as the phone's group
   * sheet writes them. The menu is a folder's and never the app menu's, whose renderer-drawn
   * desktop form (#299) would draw a `danger` item red there too.
   */
  private groupMenu(folder: Folder, win: ZenWindow): Template {
    const { browser } = this
    const id = folder.id
    // The group's tabs are its regular members (`regularFolderTabs`): a private tab in it is
    // none of the count, and Close Group leaves it.
    const live = regularFolderTabs(browser.state.model, id).length
    const saved = isSavedFolder(browser.state.model, folder)
    const count = saved ? (folder.savedTabs?.length ?? 0) : live
    const tabs = `${count} ${count === 1 ? 'Tab' : 'Tabs'}`
    const open: Template = saved
      ? [{ label: `Open Group (${tabs})`, click: () => browser.openFolder(id, win) }]
      : []
    const fold: Template = live
      ? [
          {
            label: folder.collapsed ? 'Expand Group' : 'Collapse Group',
            click: () => browser.updateFolder(id, { collapsed: !folder.collapsed })
          }
        ]
      : []
    const closing: Template = live
      ? [
          { label: 'Ungroup', click: () => browser.deleteFolder(id, true) },
          { label: `Close Group (${tabs})`, click: () => browser.closeFolder(id, win) }
        ]
      : []
    return [
      ...open,
      {
        label: 'Rename Group…',
        // The pick mounts the row's rename field: the keyboard stays in the chrome for it.
        keepsKeyboard: true,
        click: () => browser.emit('folder.startRename', { folderId: id }, win)
      },
      {
        label: 'Colour',
        submenu: FOLDER_COLOR_ORDER.map((color) => ({
          label: FOLDER_COLOR_NAMES[color],
          type: 'radio' as const,
          checked: (folder.color ?? null) === color,
          click: () => browser.updateFolder(id, { color })
        }))
      },
      { label: 'New Tab in Group', click: () => browser.newTabInFolder(id, win) },
      ...fold,
      { type: 'separator' },
      ...closing,
      { label: 'Delete Group', danger: true, click: () => browser.deleteFolder(id, false) }
    ]
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
    anchor: MenuAnchor & { x: number; y: number },
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
          click: () => this.browser.deleteBookmarks(ids, win)
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
          click: () =>
            this.browser.pages.open('bookmarks', null, win, undefined, {
              query: folderId ? { folder: folderId } : undefined
            })
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
        { label: 'Move Here', click: () => void this.browser.bookmarkUndo.move(ids, folderId) },
        ...(subfolders.length ? [{ type: 'separator' as const }] : []),
        ...subfolders.map((f) => ({ label: f.title, submenu: build(f.id) }))
      ]
    }
    return bookmarks.roots().map((root) => ({ label: root.title, submenu: build(root.id) }))
  }

  /**
   * Chrome's "Recently closed" block of the History submenu: a header, then the closed tabs and
   * windows (Firefox's "Recently Closed Tabs / Windows" as one list) newest first, ten at most,
   * then Restore All and Clear List. With nothing closed the block is §9.17's empty state – one
   * plain sentence in the deemphasised ink, not a command (Chrome's lone greyed header read as
   * a dead one) – so the menu keeps its shape from one opening to the next without hiding
   * the block.
   */
  private recentlyClosedItems(win: ZenWindow): Template {
    const { session } = this.browser
    const entries = session.summaries().slice(0, 10)
    if (entries.length === 0)
      return [{ label: 'No recently closed tabs', enabled: false, note: true }]
    const header: MenuItemTemplate = { label: 'Recently Closed', enabled: false }
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
    return [
      header,
      ...items,
      { type: 'separator' },
      { label: 'Restore All', click: () => session.restoreAll(win) },
      { label: 'Clear List', click: () => session.clearRecentlyClosed() }
    ]
  }

  /**
   * Chrome's "Tabs from other devices" block of the History submenu (shortcuts-menus-108) – and
   * the macOS History menu's – from services' `open-tabs` records as the engine lists them
   * (`sync.tabsFromDevices`, the read the History page's group makes, #326): a header, then one
   * submenu per device, the most recently published first, of the device's tabs, newest activity
   * first, each with its favicon; a row opens the tab through the held-tab rule (#314: a tab this
   * browser already holds under the same id comes to the front instead), and the submenu ends
   * with the page's device menu's Open All in Tabs. A device the page's heading menu hid (Hide
   * Device, the core's set, `PageService.hideDevice`) is left out here too, as Chrome's "Hide for
   * now" takes the device out of its menu; the page's way back, Show Hidden Devices, follows the
   * devices while any is hidden, and stands under the header alone – over §9.17's sentence –
   * when every one is. The block follows the page's rulings for when there is nothing: with sync
   * off, or Open tabs out of what syncs, or nothing published by any device, there is no block
   * at all (the lead's #326 amendment to §10.1 – a sentence with no way out would be a permanent
   * line of nothing for the single-device user; the page one row up, Show Full History, carries
   * the settings doors). The header is a note kind (`note`): the chrome's menu writes it in the
   * deemphasised ink on a row that takes no focus and answers no click – a heading, not a
   * command greyed out at .4 (the #396 review's A7; #299 B2's complaint) – while a native menu,
   * which has no such row, shows the disabled item, Chrome's own form of the header. `open` is
   * how a row opens its tabs, since the mac bar stands with no window of its own
   * (`applicationMenu`'s `withWindow` finds or opens one).
   */
  tabsFromDevicesItems(open: (tabs: readonly SyncRemoteTab[]) => void): Template {
    const { sync, pages } = this.browser
    const status = sync.status()
    if (!status.enabled || !status.scope.openTabs) return []
    const hidden = new Set(pages.hiddenDeviceIds())
    const lists = sync.tabsFromDevices().filter((device) => device.tabs.length > 0)
    const shown = lists.filter((device) => !hidden.has(device.deviceId))
    const hiddenCount = lists.length - shown.length
    if (shown.length === 0 && hiddenCount === 0) return []
    const header: MenuItemTemplate = {
      label: 'Tabs from Other Devices',
      enabled: false,
      note: true
    }
    const devices: Template = shown.map((device) => {
      const tabs = [...device.tabs].sort((a, b) => b.lastActive - a.lastActive)
      const rows: Template = tabs.slice(0, REMOTE_TABS_MENU_MAX).map((tab) => ({
        label: clipLabel(tab.title.trim() || displayUrl(tab.url), 60),
        icon: tab.favicon,
        click: () => open([tab])
      }))
      if (tabs.length > REMOTE_TABS_MENU_MAX)
        rows.push({ label: `${tabs.length - REMOTE_TABS_MENU_MAX} more…`, enabled: false })
      return {
        label: clipLabel(device.deviceName.trim() || UNNAMED_DEVICE, 40),
        submenu: [
          ...rows,
          { type: 'separator' },
          { label: 'Open All in Tabs', click: () => open(tabs) }
        ]
      }
    })
    const allHidden: Template =
      shown.length === 0
        ? [{ label: "You've hidden every device", enabled: false, note: true }]
        : []
    const showHidden: Template =
      hiddenCount > 0
        ? [{ label: 'Show Hidden Devices', click: () => pages.showHiddenDevices() }]
        : []
    return [header, ...devices, ...allHidden, ...showHidden]
  }

  // ---------------------------------------------------------------------------
  // History page
  // ---------------------------------------------------------------------------

  /**
   * Context menu of one visit on the history page. "Select" picks the row on the page (the page's
   * selection is a mode entered from here, by Ctrl/Shift-click or Ctrl+A; the checkboxes show
   * while it lasts) so several can be removed at once. A row that names a page but no visit –
   * a tab from another device in the page's "Tabs from other devices" group (ID-28) – asks with
   * `visitId` null and gets the page's items alone: nothing of it is in this device's history to
   * select or remove.
   */
  showHistoryContextMenu(
    visitId: string | null,
    url: string,
    win: ZenWindow,
    anchor?: MenuAnchor
  ): void {
    const { tabs, history, state } = this.browser
    const caps = state.capabilities
    const host = getDomain(url)
    const visit: Template =
      visitId === null
        ? []
        : [
            { type: 'separator' },
            { label: 'Select', click: () => this.browser.emit('history.select', { visitId }, win) },
            { label: 'Remove from History', click: () => history.deleteVisits([visitId]) },
            {
              label: 'Forget About This Page',
              click: () => history.deleteUrls([url])
            }
          ]
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
        ...visit,
        { type: 'separator' },
        {
          // Chrome's "More from this site": the History page searching the host
          // (`chrome://history/?q=<host>`), in the tab the window has or a new one.
          label: 'More from This Site',
          enabled: Boolean(host),
          click: () =>
            this.browser.pages.open('history', null, win, undefined, { query: { q: host ?? '' } })
        }
      ],
      win,
      'history',
      anchor
    )
  }

  /**
   * A download row's menu (Chrome's shelf menu with the bubble's Copy download link, parity row
   * downloads-11): Open when done while the transfer runs and Open once the file is on disk,
   * Always open files of this type for the types Chromium lets open by themselves (the engine's
   * `autoOpenTypes`), Show in folder, Copy download link, then the transfer's own verb – Pause,
   * Resume or Cancel while it runs, Retry once it was cancelled or failed for a reason a retry
   * can get past (`canRetryDownload`, the same predicate as the row's controls) – then Delete
   * file for a finished file on disk (Chrome's, on `download.deleteFile`; the row stays as
   * Deleted, a toast says when the file would not go) and Remove from list for anything settled.
   * A flagged file waiting on Keep / Delete offers only its link and its removal (Delete on the
   * row is what takes the file away). A finished file the engine found gone from disk
   * (`fileMissing`) has nothing to open, show or delete and offers Retry instead.
   */
  showDownloadContextMenu(
    id: string,
    anchor: { x?: number; y?: number; keyboard?: boolean },
    win: ZenWindow
  ): void {
    const { downloads, platform } = this.browser
    const item = downloads.item(id)
    if (!item) return
    const inFlight = isInFlight(item.state)
    const onDisk = item.state === 'completed' && !isQuarantined(item) && !item.fileMissing
    const resumable = item.state === 'paused' || (item.state === 'interrupted' && item.canResume)
    const retryable = canRetryDownload(item)
    const name = item.finalName || item.filename
    const ext = fileExtension(name)
    const settings = resolveDownloadSettings(this.browser.state.settings)
    const autoOpens = settings.autoOpenTypes.includes(ext)
    const alwaysOpen: Template =
      ext && mayAutoOpen(name, platform.info.os)
        ? [
            {
              label: 'Always Open Files of This Type',
              type: 'checkbox',
              checked: autoOpens,
              click: () =>
                this.browser.handleCommand(win, 'settings.update', {
                  downloads: {
                    autoOpenTypes: autoOpens
                      ? settings.autoOpenTypes.filter((t) => t !== ext)
                      : [...settings.autoOpenTypes, ext]
                  }
                })
            }
          ]
        : []
    this.popup(
      [
        inFlight
          ? {
              label: 'Open When Done',
              type: 'checkbox',
              checked: item.openWhenDone,
              click: () => downloads.setOpenWhenDone(id, !item.openWhenDone)
            }
          : { label: 'Open', enabled: onDisk, click: () => void downloads.open(id) },
        ...alwaysOpen,
        {
          label: 'Show in Folder',
          enabled: onDisk && Boolean(item.savePath),
          click: () => downloads.showInFolder(id)
        },
        { type: 'separator' },
        { label: 'Copy Download Link', click: () => platform.clipboard.writeText(item.url) },
        { type: 'separator' },
        ...(item.state === 'progressing'
          ? [{ label: 'Pause', click: () => downloads.pause(id) }]
          : []),
        ...(resumable ? [{ label: 'Resume', click: () => downloads.resume(id) }] : []),
        ...(!resumable && retryable ? [{ label: 'Retry', click: () => downloads.retry(id) }] : []),
        ...(inFlight ? [{ label: 'Cancel', click: () => downloads.cancel(id) }] : []),
        { type: 'separator' },
        ...(item.state === 'completed'
          ? [
              {
                label: 'Delete File',
                enabled: onDisk && Boolean(item.savePath),
                click: () => void this.deleteDownloadFile(id, win)
              }
            ]
          : []),
        { label: 'Remove from List', enabled: !inFlight, click: () => downloads.remove(id) }
      ],
      win,
      'download',
      anchor
    )
  }

  /**
   * The menu's Delete file: the engine removes the file and marks the row Deleted; when the
   * file would not go (locked, a folder, no permission) the window is told in a toast.
   */
  private async deleteDownloadFile(id: string, win: ZenWindow): Promise<void> {
    const { downloads } = this.browser
    const item = downloads.item(id)
    if (!item) return
    const name = displayName(item)
    let result: DownloadDeleteFileResult = 'failed'
    try {
      result = await downloads.deleteFile(id)
    } catch {
      // The host's delete threw: the file is where it was.
    }
    const toast = deleteFileToast(result, name)
    if (toast) this.browser.toast(toast, 'error', win)
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
          click: () => this.browser.pages.open('history', undefined, win)
        }
      ],
      win,
      'history'
    )
  }

  /**
   * The menu of a device's heading in the History page's "Tabs from other devices" (ID-28; the
   * lead's #326 ruling: a device's actions are its heading's context menu on desktop – a
   * right-click or the menu key on the line, as Firefox's Synced Tabs keep theirs – and the
   * phone's sheet). Two items, Chrome's synced-device card's pair under §10.1's names: Open All
   * in Tabs (Firefox's word for the action) opens every tab the device lists here, and Hide
   * Device takes the group off the page for the session (the core
   * holds the set, `PageService.hideDevice`; the page's "Show hidden devices" row brings them
   * back). A device the engine no longer lists – its list moved since the page drew it – has no
   * tabs to open; its Hide Device still stands, since its heading does.
   */
  showHistoryDeviceMenu(deviceId: string, win: ZenWindow, anchor?: MenuAnchor): void {
    const device = this.browser.sync.tabsFromDevices().find((d) => d.deviceId === deviceId)
    const tabs = device?.tabs ?? []
    this.popup(
      [
        {
          label: 'Open All in Tabs',
          enabled: tabs.length > 0,
          click: () => this.openRemoteTabs(tabs, win)
        },
        { label: 'Hide Device', click: () => this.browser.pages.hideDevice(deviceId, true) }
      ],
      win,
      'history',
      anchor
    )
  }

  /**
   * Open All in Tabs: each tab the device lists opens in this window as a new tab, the first in
   * front and the rest behind it in the group's order (newest activity first). A tab the browser
   * already holds under the tab's own id – in this window or another; the Open tabs scope
   * carries the records too (ID-10), and held anywhere is held, the rule the page's row follows
   * (#314) – is not opened a second time. The first held tab comes to the front in the window
   * that shows it, and that window comes forward when it is another (the shape of a reopened
   * tab's return to its own window, `Session.showRestored`); the other held tabs stay where they
   * are, and the tabs that do open all open behind – the first of them takes the front only when
   * no held tab did. A held tab no window can show now (a space of a window that is gone) is
   * left as it is too: the user has it. The History submenu's rows and the mac bar's take the
   * same path with one tab (`tabsFromDevicesItems`), so a row for a held tab brings it forward.
   */
  openRemoteTabs(remote: readonly SyncRemoteTab[], win: ZenWindow): void {
    const { tabs } = this.browser
    let front = true
    for (const tab of remote) {
      const held = tabs.tab(tab.tabId)
      if (!held) continue
      const home = tabs.windowShowing(held, win)
      if (!home) continue
      tabs.activateTab(held.id, home, { userSwitch: true })
      if (home !== win) home.host.focus()
      front = false
      break
    }
    for (const tab of remote) {
      if (tabs.tab(tab.tabId)) continue
      tabs.createTab({ url: tab.url, active: front }, win)
      front = false
    }
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
   * "Add to Home screen" on hosts that pin shortcuts, for web pages outside private windows.
   * Inside the scope of an app that is already on the Home screen the item reads
   * "Open <app>" and goes to the app's start URL instead (PWA-11). The install item is offered
   * only where the window's chrome has an install surface up to take it (`ChromeSurface`: the
   * phone's sheet; the desktop's dialog is UI work to come, and its menu item comes with it).
   * The phone's flat list takes the pair as one row; the sidebar layouts split it, the install
   * row a save (`installItems`, Chrome's Save and share carries Create shortcut…) and Open in
   * <app> a window action (`openAppItems`, in More Tools).
   */
  private homeScreenItems(active: Tab | undefined, win: ZenWindow): Template {
    return [...this.openAppItems(active, win), ...this.installItems(active, win)]
  }

  /**
   * "Open in <app>" inside an installed app's scope: the desktop launches the app's own window
   * (Chrome), the phone goes to the app's start URL in this tab.
   */
  private openAppItems(active: Tab | undefined, win: ZenWindow): Template {
    const { webApps } = this.browser
    if (!active || !webApps.canPin(active, win)) return []
    const pinned = webApps.pinnedFor(active.url)
    if (!pinned) return []
    return [
      {
        label: openAppMenuLabel(webApps.surface, pinned.name),
        click: () => webApps.launch(pinned.id, win)
      }
    ]
  }

  /**
   * The install row – Create Shortcut…, Install <app>…, or the phone's Add to Home Screen – for
   * a page no installed app owns, while the window's chrome has the install surface up.
   */
  private installItems(active: Tab | undefined, win: ZenWindow): Template {
    const { webApps } = this.browser
    if (!active || !webApps.canPin(active, win)) return []
    if (webApps.pinnedFor(active.url)) return []
    if (!surfaceMounted(win, 'install')) return []
    return [
      {
        label: installMenuLabel(webApps.surface, active.webApp),
        click: () => webApps.openInstall(active.id, win)
      }
    ]
  }

  /**
   * The "⋯" application menu in the toolbar (Firefox's hamburger menu). One set of items for
   * every layout, in two orders. The sidebar layouts (desktop and tablet) take Firefox's groups
   * (design language v2 §6 "Menus"): the tabs and windows; the library – bookmarks, history,
   * downloads, passwords, add-ons; the page's actions, closing with Chrome's Save and share –
   * Save Page As…, Create Shortcut…, Web Capture…, Print…, Share…, Send to Your Devices – as
   * the submenu Chrome folds it into (shortcuts-menus-120; Firefox keeps save and print in the
   * flat list, and a flat group here spent rows the menu has not got); the app's – Settings,
   * More Tools, Help, Quit, Firefox's order and §6's ("settings, tools, help, quit") – about
   * eighteen rows and three separators (§6's ceiling; a fourth under the "Now Playing…" row
   * while the media hub's button has folded), so the menu stands on an 800 px window without
   * scrolling (§6: a menu is exempt from §9.20's 60% cap and takes the room to the window's
   * bottom margin). What Firefox's count leaves out is not lost but moves into a submenu:
   * History carries the recently closed list as Chrome's does, Zoom the fullscreen toggle as
   * Firefox's zoom row does, More Tools Zenium's space and window actions with an installed
   * app's Open in <app>, the captures, the developer tools and the resources (Chrome's More
   * tools holds its window and task-manager rows the same way), Help the menu bar's Help
   * entries and the About row. The phone layout – which has no
   * sidebar, window frame or keyboard to speak of – keeps Chrome's phone menu (TB-08): the icon
   * row first, then the tabs, library, page and app groups in one flat list, without the items
   * that only act on a window (Chrome's phone menu has none of them either). An item the host
   * cannot do is left out of either rather than greyed (`caps`). `mediaHubFolded` is the
   * chrome's word that the media hub's toolbar button is off the row (§9.29): the menu then
   * heads with the "Now Playing…" row in its stead.
   */
  showAppMenu(
    win: ZenWindow,
    options: { anchor?: Rect; keyboard: boolean; mediaHubFolded?: boolean }
  ): void {
    const { state, tabs } = this.browser
    const caps = state.capabilities
    const active = tabs.activeTabFor(win)
    const local = Boolean(win.localSpace)
    const phone = win.formFactor === 'phone'
    /** Items the host must be able to act on; left out rather than greyed where it cannot. */
    const when = (able: boolean, ...items: Template): Template => (able ? items : [])
    /** Items of the sidebar layouts (desktop and tablet) only. */
    const sidebar = (...items: Template): Template => (phone ? [] : items)
    /**
     * Items of the desktop layout alone: what acts on chrome the tablet does not draw. The
     * tablet's sidebar collapses to its icon rail from the toolbar (Zen's compact mode is the
     * desktop's hover-revealed sidebar, which a finger cannot reveal) and it has no bookmarks bar.
     */
    const desktop = (...items: Template): Template => (win.formFactor === 'desktop' ? items : [])
    const separator: MenuItemTemplate = { type: 'separator' }
    // From its button the menu hangs off the button's bottom edge (Chrome, Firefox); from a
    // shortcut it also starts with its first item selected (design language v2 §9.22).
    const anchor = options.anchor
      ? { x: options.anchor.x, y: options.anchor.y + options.anchor.height }
      : undefined
    // A web app's standalone window has Chrome's web-app menu, not the browser's.
    if (win.chrome === 'app' && win.app) {
      this.showWebAppMenu(win, win.app, active, { ...anchor, keyboard: options.keyboard })
      return
    }

    // --- The items, each once; the two layouts below put them in their order. ----------------
    const newTab: MenuItemTemplate = {
      label: 'New Tab',
      action: 'tab.new',
      click: () => this.browser.openNewTab(win)
    }
    // Chrome's tab search (tabs-17): a popover of the sidebar layouts, and the desktop's one
    // pointer way into it (the chord and the macOS menu bar are the others), so it keeps a row
    // in the tabs group; the phone's tab switcher searches on its own.
    const searchTabs: MenuItemTemplate = {
      label: 'Search Tabs…',
      action: 'tab.search',
      click: () => this.browser.emit('tabsearch.open', undefined, win)
    }
    // Hosts without private windows (Android) keep the private session in tabs: New Private
    // Tab is Chrome's second item, and Close Private Tabs ends the session; with no private
    // tab open it is greyed, not gone (design language v2 §9.17: a menu row whose count is
    // zero is disabled), so the menu keeps its shape from one opening to the next.
    const privateTabs = when(
      caps.privateTabs,
      { label: 'New Private Tab', click: () => tabs.newPrivateTab(undefined, win) },
      {
        label: 'Close Private Tabs',
        enabled: tabs.privateTabs().length > 0,
        click: () => tabs.closePrivateTabs(win)
      }
    )
    const newSpace = when(!local, {
      label: 'New Space…',
      action: 'space.new',
      click: () => this.browser.emit('space.new', undefined, win)
    })
    const newWindow = when(caps.windows, {
      label: 'New Window',
      action: 'window.new',
      click: () => this.browser.openWindow('synced', win)
    })
    const newBlankWindow = when(caps.windows, {
      label: 'New Blank Window',
      action: 'window.newUnsynced',
      click: () => this.browser.openWindow('unsynced', win)
    })
    // Chrome's More tools › Name window… (shortcuts-menus-121): the desktop's, whose OS title
    // bar and window switcher read the name; a tablet's one window has neither.
    const nameWindow = desktop({
      label: 'Name Window…',
      action: 'window.name',
      click: () => this.browser.emit('windowName.open', undefined, win)
    })
    const newPrivateWindow = when(caps.windows, {
      label: 'New Private Window',
      action: 'window.newPrivate',
      click: () => this.browser.openWindow('private', win)
    })
    const bookmarks: MenuItemTemplate = {
      label: 'Bookmarks',
      submenu: [
        // The phone's bookmark entry is the icon row's star (TB-16), with Chrome's star flow;
        // the sidebar layouts keep the toggle here, whose star bubble names and files it.
        ...sidebar({
          label: active?.bookmarked ? 'Remove Bookmark' : 'Bookmark This Page',
          action: 'bookmark.add',
          enabled: Boolean(active && !active.url.startsWith('zen://')),
          click: () => active && this.browser.toggleBookmark(active.id, win)
        }),
        {
          label: 'Bookmark All Tabs…',
          action: 'bookmark.allTabs',
          click: () => this.browser.bookmarkTabs(win)
        },
        separator,
        {
          label: 'Show Bookmarks',
          action: 'bookmark.sidebar',
          click: () => this.browser.pages.open('bookmarks', undefined, win)
        },
        // The desktop's alone: the tablet has no bookmarks bar.
        ...desktop({ label: 'Show Bookmarks Bar', submenu: this.bookmarksBarSubmenu(win) }),
        separator,
        // Chrome's entry opens Settings > Import with the dialog up; a phone has no other
        // browser's profile to read and keeps the bookmarks-file pick (Edge Android's).
        phone
          ? {
              label: 'Import Bookmarks…',
              click: () => void this.browser.importBookmarks(win)
            }
          : {
              label: 'Import Bookmarks and Settings…',
              click: () => this.browser.openImportDialog(win)
            },
        {
          label: 'Export Bookmarks…',
          click: () => void this.browser.exportBookmarks(win)
        }
      ]
    }
    /** The History page (Ctrl+H): the phone's row, the head of the sidebar layouts' submenu. */
    const showHistory = (label: string): MenuItemTemplate => ({
      label,
      action: 'history.sidebar',
      click: () => this.browser.pages.open('history', undefined, win)
    })
    const downloads: MenuItemTemplate = {
      label: 'Downloads',
      action: 'downloads.open',
      click: () => this.browser.pages.open('downloads', undefined, win)
    }
    const passwords = when(caps.passwords, {
      label: 'Passwords',
      click: () => this.browser.emit('overlay.open', { kind: 'passwords' }, win)
    })
    // The phone's way to the extensions' actions (Firefox for Android's Extensions item, in
    // the library block before the management page): the chrome's sheet of one row per
    // action. The sidebar layouts have the toolbar buttons and the puzzle panel.
    const extensions = when(phone && caps.extensions, {
      label: 'Extensions',
      click: () => this.browser.emit('extensions.open', undefined, win)
    })
    const addons = when(caps.extensions, {
      label: 'Add-ons and Themes',
      action: 'addons.open',
      click: () => this.browser.emit('overlay.open', { kind: 'addons' }, win)
    })
    // Chrome's Delete browsing data (Ctrl+Shift+Delete), a top-level row since Chrome moved it out
    // of More tools: the library group's last row on the sidebar layouts, the dialog the History
    // page's button and Settings › Privacy open. The phone's form is the Settings sheet.
    const deleteBrowsingData = sidebar({
      label: 'Delete Browsing Data…',
      action: 'privacy.clearBrowsingData',
      click: () => this.browser.actions.run('privacy.clearBrowsingData', { sourceTabId: null, win })
    })
    // The desktop's alone: Zen's compact mode is the hover-revealed sidebar, which a finger
    // cannot reveal; the tablet's sidebar collapses to its rail from the toolbar.
    const compactMode = desktop({
      label: 'Compact Mode',
      type: 'checkbox',
      action: 'compact.toggle',
      checked: win.compactEnabled,
      click: () => this.browser.toggleCompactMode(win)
    })
    const changeTheme = when(!local, {
      label: 'Change Theme…',
      click: () => this.browser.emit('theme.open', { spaceId: win.activeSpaceId }, win)
    })
    const fullscreen: MenuItemTemplate = {
      label: 'Fullscreen',
      type: 'checkbox',
      action: 'page.fullscreen',
      checked: win.host.isFullScreen(),
      click: () => this.browser.toggleFullscreen(win)
    }
    // A host with page controls (the phone, the tablet) gets Chrome's "Zoom…" sheet in place
    // of the stepping submenu; the sheet docks under the live page and carries the percentage.
    const zoomSheet = when(caps.pageControls, ...this.zoomSheetItem(active, win))
    // Chrome's and Firefox's zoom row (- / percentage / + / fullscreen): a menu has no inline
    // controls, so the row is a submenu whose label carries the live percentage and whose
    // Reset says where it goes; on the sidebar layouts its last row is the row's fullscreen
    // glyph (the phone has no window to fill).
    const zoom = when(
      !caps.pageControls,
      this.zoomSubmenu(active, phone ? [] : [separator, fullscreen])
    )
    // Where Edge's users look for "Split screen" (split-01): the sidebar layouts' menu (the
    // tablet splits its content card as the desktop does); a phone has no split view. The
    // tab row's "Split with Current Tab" stays as it is.
    const splitView = splitViewSubmenu(
      active,
      active?.splitGroupId ? state.model.splitGroups[active.splitGroupId] : undefined
    )
    const findInPage: MenuItemTemplate = {
      label: 'Find in Page…',
      action: 'find.open',
      enabled: Boolean(active),
      click: () => this.browser.actions.run('find.open', { sourceTabId: null, win })
    }
    const readerView: MenuItemTemplate = {
      label: 'Reader View',
      action: 'page.readerMode',
      enabled: Boolean(active) && this.browser.reader.canRead(active),
      click: () => active && this.browser.reader.toggle(active.id, win)
    }
    // Edge's Immersive Reader has "Text preferences" on its toolbar; here the item sits under
    // Reader View while an article is open, and the chrome shows the popover (a mouse) or
    // the sheet (a phone): the one home of the reader's controls, the document carrying no
    // toolbar of its own (§10.1). On a phone, whose pill has no chip, this is the way in.
    const textPreferences = when(Boolean(active) && this.browser.reader.isReaderUrl(active!.url), {
      label: 'Text Preferences…',
      click: () => active && this.browser.emit('reader.preferences', { tabId: active.id }, win)
    })
    // Chrome's "Listen to this page" (A11Y-06; Title Case like the menu's other items): on
    // hosts with a speech host, enabled by the reader core's readability signal exactly as
    // Reader View is (`reader.canRead`: the page is readerable, or it is the reader's own
    // document, which the core then reads as `source: 'reader'`). The player it docks is
    // the one component on both hosts, in the frame's shape on each (§9.32).
    const listen = when(this.browser.readAloud.available, {
      label: 'Listen to This Page',
      enabled: Boolean(active) && this.browser.reader.canRead(active),
      click: () => active && void this.browser.readAloud.start({ tabId: active.id })
    })
    const translate = when(this.browser.translate.available, {
      label: 'Translate Page…',
      enabled: Boolean(active) && this.browser.translate.canTranslate(active!.id),
      click: () => active && void this.browser.translate.open(active.id, win)
    })
    const share = when(caps.share, {
      label: 'Share…',
      enabled: Boolean(active) && /^https?:/i.test(active!.url),
      click: () => active && this.browser.shareTab(active.id, win)
    })
    // "Send to your devices" beside Share (Chrome's phone menu keeps it in its share sheet,
    // which is the system's here): one device names it; several open the picker sheet on the
    // phone, a submenu on the sidebar layouts.
    const sendToDevices = this.sendToDevicesItems(active, win)
    const homeScreen = this.homeScreenItems(active, win)
    // The sidebar layouts split the phone's pair: the install row is a save, Open in <app> a
    // window action.
    const createShortcut = sidebar(...this.installItems(active, win))
    const openInApp = sidebar(...this.openAppItems(active, win))
    const print = when(caps.print, {
      label: 'Print…',
      action: 'page.printPreview',
      enabled: Boolean(active),
      click: () =>
        active && this.browser.actions.run('page.printPreview', { sourceTabId: active.id, win })
    })
    // The phone's save is the icon row's Download Page (TB-08, `phoneIconRow`), the one entry
    // Chrome's menu has for it; the sidebar layouts keep the text item.
    const savePageAs: MenuItemTemplate = {
      label: 'Save Page As…',
      action: 'page.savePage',
      enabled: Boolean(active),
      click: () =>
        active && this.browser.actions.run('page.savePage', { sourceTabId: active.id, win })
    }
    const screenshot: MenuItemTemplate = {
      label: 'Take Screenshot',
      action: 'page.screenshot',
      enabled: Boolean(active),
      click: () =>
        active && this.browser.actions.run('page.screenshot', { sourceTabId: active.id, win })
    }
    const captureFullPage: MenuItemTemplate = {
      label: 'Capture Full Page',
      action: 'page.captureFullPage',
      enabled: Boolean(active),
      click: () =>
        active && this.browser.actions.run('page.captureFullPage', { sourceTabId: active.id, win })
    }
    // Edge's "Web capture" row of its page group (Print, Web capture, Share): the desktop's
    // overlay over the dimmed page; the tablet's menu keeps the two captures in More Tools.
    const webCapture = desktop({
      label: 'Web Capture…',
      action: 'capture.start',
      enabled: Boolean(active),
      click: () =>
        active && this.browser.actions.run('capture.start', { sourceTabId: active.id, win })
    })
    // Chrome's per-site page controls (Desktop Site, the dark-theme exception) on the hosts
    // that have them; a phone puts "Add to Home Screen" (W1-7) ahead of them.
    const pageControls = when(
      caps.pageControls || caps.darkenSites,
      ...this.pageControlItems(active)
    )
    const resources = when(caps.resourceGovernor, {
      label: 'Resources',
      submenu: [
        {
          label: `Memory ${Math.round(state.resources.memory.used)} MB · CPU ${Math.round(state.resources.cpu.used)}% · ${state.resources.loadedTabs} live, ${state.resources.frozenTabs} frozen`,
          enabled: false
        },
        separator,
        { label: 'Free Up Memory Now', click: () => void this.browser.governor.trim() },
        { label: 'Freeze Other Tabs', click: () => void this.browser.governor.freezeOthers() },
        { label: 'Wake All Tabs', click: () => void this.browser.governor.wakeAll() },
        separator,
        {
          label: 'Resource Settings…',
          click: () => void this.browser.pages.open('settings', 'resources', win)
        }
      ]
    })
    const keyboardShortcuts: MenuItemTemplate = {
      label: 'Keyboard Shortcuts',
      click: () => void this.browser.pages.open('settings', 'shortcuts', win)
    }
    const settings: MenuItemTemplate = {
      label: 'Settings',
      action: 'settings.open',
      click: () => void this.browser.pages.open('settings', undefined, win)
    }
    const devtools = when(caps.devtools, {
      label: 'Developer Tools',
      action: 'devtools.toggle',
      enabled: Boolean(active),
      click: () => active && tabs.toggleDevtools(active.id)
    })
    const about: MenuItemTemplate = { label: `About Zenium ${state.version}`, enabled: false }
    // An Android app is left, not quit: the system owns its lifetime – on a tablet as on a
    // phone. Hosts with windows of their own (the desktop, at any layout) quit.
    const quit = when(caps.windows, {
      label: 'Quit',
      action: 'app.quit',
      click: () => this.browser.actions.run('app.quit', { sourceTabId: null, win })
    })

    // --- The phone: Chrome's phone menu, one flat list behind the icon row (TB-08). ------------
    if (phone) {
      this.popup(
        [
          // Chrome's icon row heads the phone's menu: Forward, Home while a homepage is set,
          // the star, Download page, Page info and Reload / Stop – less what the user's bar
          // carries (§9.13) – which the chrome draws as a row of icon buttons from each item's
          // glyph.
          ...this.phoneIconRow(active, win),
          separator,
          newTab,
          ...privateTabs,
          ...newSpace,
          separator,
          ...newWindow,
          ...newBlankWindow,
          ...newPrivateWindow,
          separator,
          bookmarks,
          showHistory('History'),
          downloads,
          ...passwords,
          ...extensions,
          ...addons,
          separator,
          ...changeTheme,
          ...zoomSheet,
          ...zoom,
          separator,
          findInPage,
          readerView,
          ...textPreferences,
          ...listen,
          ...translate,
          ...share,
          ...sendToDevices,
          ...homeScreen,
          ...print,
          screenshot,
          captureFullPage,
          ...pageControls,
          separator,
          ...resources,
          settings,
          ...devtools,
          separator,
          about,
          ...quit
        ],
        win,
        'app',
        { ...anchor, keyboard: options.keyboard }
      )
      return
    }

    // --- The sidebar layouts: Firefox's groups (§6 "Menus"). ----------------------------------
    this.popup(
      [
        // The window's live media heads the menu while the media hub's toolbar button has
        // folded (design language v2 §9.29: the sidebar's width tier folds it at 240, and this
        // row is where it goes; with the button up, the button is the hub). The phone has its
        // own chip and sheet (§9.33).
        ...when(Boolean(options.mediaHubFolded), ...this.nowPlayingRow(win)),
        // The tabs and windows.
        newTab,
        searchTabs,
        ...privateTabs,
        ...newWindow,
        ...newPrivateWindow,
        separator,
        // The library. History is Chrome's submenu: the page first, then the recently closed
        // list, which had a submenu of its own on the row before, then the other devices' tabs
        // (their block stands only while sync lists some; `tabsFromDevicesItems`).
        bookmarks,
        {
          label: 'History',
          submenu: tidySeparators([
            showHistory('Show Full History'),
            separator,
            ...this.recentlyClosedItems(win),
            separator,
            ...this.tabsFromDevicesItems((tabs) => this.openRemoteTabs(tabs, win))
          ])
        },
        downloads,
        ...passwords,
        ...addons,
        ...deleteBrowsingData,
        separator,
        // The page's actions: find, zoom, translate, then the reader's and the per-site
        // controls; the long tail is the app group's More Tools.
        findInPage,
        ...zoomSheet,
        ...zoom,
        ...translate,
        readerView,
        ...textPreferences,
        ...listen,
        ...pageControls,
        // Chrome's Save and share (shortcuts-menus-120) closes the page group as its last row,
        // folded into a submenu as Chrome folds it (the #396 review's ruling 1): the saves first
        // – Save Page As…, the install row (Create Shortcut…, or Install <app>…), Web Capture…
        // between the save and the print where Edge's menu keeps it, Print… – then the shares,
        // Share… and Send to Your Devices. No Cast row: Zenium has no cast target. Folded, the
        // top level keeps #299's count whatever the host gates – twenty rows and three
        // separators on the Linux build, 661 px – and stands whole on an 800 px window (§6).
        {
          label: 'Save and Share',
          submenu: [
            savePageAs,
            ...createShortcut,
            ...webCapture,
            ...print,
            ...share,
            ...sendToDevices
          ]
        },
        separator,
        // The app's, in Firefox's order and §6's: settings, tools, help, quit.
        settings,
        {
          label: 'More Tools',
          // Firefox's "More tools" row of its app group; Chrome's More tools, which carries its
          // window rows (Name window…), Task manager and Developer tools, gives the submenu its
          // contents: an installed app's Open in <app>, Zenium's space and window actions with
          // Chrome's Name Window…, the window's layout toggles, the captures, then the
          // developer's and the resources.
          // Fullscreen rides the zoom submenu where there is one (Firefox's zoom row); a host
          // whose zoom is the sheet keeps it here with the other window toggles.
          submenu: tidySeparators([
            ...openInApp,
            separator,
            ...newSpace,
            ...newBlankWindow,
            ...nameWindow,
            separator,
            ...compactMode,
            splitView,
            ...changeTheme,
            ...when(caps.pageControls, fullscreen),
            separator,
            screenshot,
            captureFullPage,
            separator,
            ...resources,
            ...devtools
          ])
        },
        {
          label: 'Help',
          // The menu bar's Help menu (macOS), with the About row that closed the menu before.
          submenu: [
            {
              label: 'Zenium Help',
              click: () => this.browser.platform.shell.openExternal(HELP_URL)
            },
            keyboardShortcuts,
            separator,
            {
              label: 'Report an Issue…',
              click: () => this.browser.platform.shell.openExternal(ISSUES_URL)
            },
            separator,
            about
          ]
        },
        ...quit
      ],
      win,
      'app',
      { ...anchor, keyboard: options.keyboard }
    )
  }

  /**
   * The "Now Playing…" row at the head of the desktop app menu (design language v2 §9.29,
   * §9.32): the media hub's toolbar button is tiered by the sidebar's width like the pill's
   * chips, and where it has folded (the 240 sidebar) the menu carries the window's live media
   * instead – Firefox's badge on its menu button, with the row at the menu's top saying what
   * the badge is about. The row is its name alone – no picture, no title: the app menu is
   * renderer-drawn on every desktop, and §9.29's rule for a renderer-drawn menu is all or
   * nothing per menu, a submenu counting as its own – Firefox's app menu has no icons, and a
   * glyph column reserved only while a session plays would move every label between one
   * opening and the next (History ▸ Recently Closed, where every row is a page with its
   * favicon, is the all-glyph submenu). The card's artwork, title, artist and site are the
   * hub's to show on the pick, and any content in the label would widen the whole menu past
   * §5's 232–332. Title Case, as §9.1 casts the menu's items (the phone's "Now playing" chip
   * is a chip on a page surface, not a menu item), and the ellipsis because it opens a popover,
   * as "Search Tabs…" does. Its pick opens the hub – every player and the whole transport –
   * from the "⋯" button the menu hung from (`mediahub.open`), so the fold loses no control.
   * There while anything is to be controlled (a tab that paused stays until its media goes,
   * as the button does), gone otherwise, and no separate row per player: the hub is the list.
   * The window's media only: the hub reads its cards from the tabs the window lists
   * (`shared/mediaHub.ts`'s order – the session first, then what plays – decides that there is
   * a card, not what the row shows), and the row is that hub's, not another window's.
   */
  private nowPlayingRow(win: ZenWindow): Template {
    const { state, tabs } = this.browser
    const entries = orderMediaEntries(
      (state.media ?? []).filter((m) => {
        const tab = tabs.tab(m.tabId)
        return tab !== undefined && this.listedIn(win, tab)
      })
    )
    if (entries.length === 0) return []
    return [
      {
        label: 'Now Playing…',
        click: () => this.browser.emit('mediahub.open', undefined, win)
      },
      { type: 'separator' }
    ]
  }

  /**
   * Whether `win`'s sidebar lists `tab` – the tabs its `UIState.tabs` carries (`State.snapshot`):
   * a blank or private window its own space's, a synced window every tab shown in it that is not
   * another window's own.
   */
  private listedIn(win: ZenWindow, tab: Tab): boolean {
    if (win.localSpace) return win.localSpace.tabIds.includes(tab.id)
    const m = this.browser.state.model
    return tabVisibleIn(tab, win.id) && !(tab.spaceId && m.localSpaces[tab.spaceId])
  }

  /**
   * Chrome's icon row at the head of the phone's app menu (matrix TB-08): Forward, Home while a
   * homepage is set, the bookmark star, Download page, Page info and Reload / Stop (v2 §9.13's
   * six), each an item with a `glyph` the chrome draws as a 44 px icon button (§9.3) named by its
   * label. Every button runs what the bar's own button for it runs – the row consumes the core's
   * commands and adds none – and a button whose action has nowhere to go (Forward on the last
   * entry, Download off the web) is disabled rather than dropped (§9.30), so the row keeps its
   * shape from one opening to the next. An action the bar carries is not repeated in the row
   * (§9.13; Firefox's customisation: a control lives once): the user's bar is `settings.phoneBar`
   * (`shared/phoneBar.ts`, what the chrome draws – its four of the six, Forward, Home, Bookmark
   * and Reload / Stop, need nothing of the host), and each leaves the row while the bar holds
   * it; Download page and Page info have no bar item and always stand. Home the bar shows only
   * while a homepage is set, as the row does, so the two agree on when there is a Home at all.
   */
  private phoneIconRow(active: Tab | undefined, win: ZenWindow): Template {
    const { tabs } = this.browser
    const bar = this.browser.state.settings.phoneBar
    const unlessOnBar = (id: PhoneBarItemId, item: MenuItemTemplate): Template =>
      phoneBarHas(bar, id) ? [] : [item]
    return [
      ...unlessOnBar('forward', {
        label: 'Forward',
        glyph: 'forward',
        action: 'nav.forward',
        enabled: Boolean(active?.canGoForward),
        click: () => active && tabs.goForward(active.id)
      }),
      // Home (TB-15 / NTP-30, v2 §9.13): a button wherever it lives – the bar's item when the
      // user adds it, this glyph otherwise, never a text row among New Tab and New Private Tab
      // (a row reads as a destination). The tab goes to the homepage; with the homepage off
      // there is no Home anywhere, as Chrome's button leaves the toolbar.
      ...(this.browser.newTab.homepageUrl() !== null
        ? unlessOnBar('home', {
            label: 'Home',
            glyph: 'home',
            enabled: Boolean(active),
            click: () => active && this.browser.goHome(active.id, win)
          })
        : []),
      // The star (TB-16), with Chrome's flow as the phone's Bookmarks submenu ran it before: a
      // page that is not bookmarked is saved and toasted with Edit, a bookmarked one opens its
      // editor. `checked` is the fill; the label says which of the two a press does (§9.13's
      // words, Chrome's: "Bookmark" outlined, "Edit Bookmark" filled). A plain item, not a
      // checkbox (a stateful glyph, not a toggle): a press never unchecks it, and the mouse
      // popover would otherwise mark a checked action row.
      ...unlessOnBar('bookmark', {
        label: active?.bookmarked ? 'Edit Bookmark' : 'Bookmark',
        glyph: 'star',
        action: 'bookmark.add',
        checked: Boolean(active?.bookmarked),
        enabled: Boolean(active) && this.browser.bookmarkable(active!.url),
        click: () => active && this.browser.starTab(active.id, win)
      }),
      // Chrome's Download keeps the page for later; `page.savePage` is the core's way (the host
      // writes an archive into Downloads and files it there). A page of the web only.
      {
        label: 'Download Page',
        glyph: 'download',
        action: 'page.savePage',
        enabled: Boolean(active) && isWebPageUrl(active!.url),
        click: () =>
          active && this.browser.actions.run('page.savePage', { sourceTabId: active.id, win })
      },
      // Page info: the site information sheet the pill's site chip opens (the chrome's; the core
      // asks for it as it asks for the zoom sheet). None for a blank or new tab, which have no
      // page, nor for a registered internal page (Settings), which has no site (§10.1).
      {
        label: 'Page Info',
        glyph: 'info',
        enabled: Boolean(active) && hasSiteInfo(active!),
        click: () => active && this.browser.emit('siteInfo.open', { tabId: active.id }, win)
      },
      // Reload and Stop share the last slot, as they share the bar's button: Stop while the page
      // loads, Reload otherwise. The menu is a picture of the moment it opened, like any menu.
      ...unlessOnBar(
        'reload',
        active?.loading
          ? { label: 'Stop', glyph: 'stop', action: 'nav.stop', click: () => tabs.stop(active.id) }
          : {
              label: 'Reload',
              glyph: 'reload',
              action: 'nav.reload',
              enabled: Boolean(active),
              click: () => active && tabs.reload(active.id)
            }
      )
    ]
  }

  /**
   * The zoom submenu of the desktop menus: its label carries the live percentage, its Reset
   * says where it goes – the default zoom for a web page, 100 percent for any other page – and
   * each step is greyed at the range's end. The factor compared is the one the user set (before
   * the system font size), so Reset compares like with like. `trailing` rows follow the steps
   * (the app menu's Fullscreen toggle, Firefox's zoom row's last control).
   */
  private zoomSubmenu(active: Tab | undefined, trailing: Template = []): MenuItemTemplate {
    const { pageControls, tabs } = this.browser
    const defaultZoom =
      active && pageControls.remembersZoom(active) ? pageControls.settings.zoom : 1
    const zoomSet = active
      ? pageControls.remembersZoom(active)
        ? pageControls.siteZoomOf(active)
        : active.zoom
      : 1
    return {
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
        },
        ...trailing
      ]
    }
  }

  /**
   * The "⋯" menu of a web app's standalone window (MW-23; Chrome's web-app menu, from the title
   * bar's button): Copy URL and Open in Zenium – the page in a tab of the browser window behind
   * the app, where an out-of-scope link goes –, the zoom submenu, Find in Page and Print, and
   * Uninstall for a window an installed app owns, behind the host's confirmation (Chrome asks
   * too); the app's windows close with the record. Nothing of the browser's: no tabs, spaces,
   * windows, library or settings – the window is the app's.
   */
  private showWebAppMenu(
    win: ZenWindow,
    app: AppWindowInfo,
    active: Tab | undefined,
    anchor: MenuAnchor
  ): void {
    const { state, tabs } = this.browser
    const caps = state.capabilities
    const when = (able: boolean, ...items: Template): Template => (able ? items : [])
    this.popup(
      [
        {
          label: 'Copy URL',
          action: 'tab.copyUrl',
          enabled: Boolean(active),
          click: () => active && tabs.copyUrl(active.id)
        },
        {
          label: 'Open in Zenium',
          enabled: Boolean(active),
          click: () => {
            if (!active) return
            const target = this.browser.browserWindowFor(win)
            tabs.createTab({ url: active.url, active: true }, target)
            target.host.show()
            target.host.focus()
          }
        },
        { type: 'separator' },
        this.zoomSubmenu(active),
        { type: 'separator' },
        {
          label: 'Find in Page…',
          action: 'find.open',
          enabled: Boolean(active),
          click: () => this.browser.actions.run('find.open', { sourceTabId: null, win })
        },
        // Zenium's preview (CT-06), as the browser's menu opens it; the engine's own flow where a
        // host has no preview.
        ...when(caps.print, {
          label: 'Print…',
          action: 'page.printPreview',
          enabled: Boolean(active),
          click: () =>
            active && this.browser.actions.run('page.printPreview', { sourceTabId: active.id, win })
        }),
        ...when(app.appId !== null, { type: 'separator' } as MenuItemTemplate, {
          label: `Uninstall ${app.name}…`,
          click: () => void this.uninstallApp(app, win)
        })
      ],
      win,
      'app',
      anchor
    )
  }

  /** The menu's Uninstall: the host's confirmation first, then the record and its launcher go. */
  private async uninstallApp(app: AppWindowInfo, win: ZenWindow): Promise<void> {
    if (app.appId === null) return
    let ok = false
    try {
      ok = await this.browser.platform.dialogs.confirm(
        {
          message: `Uninstall ${app.name}?`,
          detail: `${app.name} and its launcher will be removed from this computer. Its windows close.`,
          okLabel: 'Uninstall',
          cancelLabel: 'Cancel',
          danger: true
        },
        win
      )
    } catch {
      ok = false
    }
    if (ok) await this.browser.webApps.uninstall(app.appId)
  }

  /**
   * Chrome's page controls in the app menu, closing the page group as "Desktop site" does in
   * Chrome: "Desktop Site" is the per-site checkbox, and while sites are darkened "Dark Theme for
   * This Site" is its exception. Both act on the active tab's site, so they wait for a web page.
   */
  private pageControlItems(active: Tab | undefined): Template {
    const { pageControls, state } = this.browser
    const web = Boolean(active) && siteKey(active!.url) !== null
    const items: Template = []
    if (state.capabilities.pageControls) {
      items.push({
        label: 'Desktop Site',
        type: 'checkbox',
        enabled: web,
        checked: web && pageControls.isDesktop(active!),
        click: () =>
          active && pageControls.setDesktopSite(active.id, !pageControls.isDesktop(active))
      })
    }
    // The per-site exception shows once the setting is on, on every host that can darken.
    if (state.capabilities.darkenSites && pageControls.settings.darkenSites) {
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

  /**
   * Chrome's "Zoom…" on a host with page controls: the zoom sheet docked under the live page,
   * where the desktop has its stepping submenu. It acts on the active tab's site, so it waits for
   * a web page.
   */
  private zoomSheetItem(active: Tab | undefined, win: ZenWindow): Template {
    const web = Boolean(active) && siteKey(active!.url) !== null
    return [
      {
        label: 'Zoom…',
        enabled: web,
        click: () => active && this.browser.emit('zoom.open', { tabId: active.id }, win)
      }
    ]
  }

  /**
   * The translation options of a tab, from the bar's "⋯" button (Firefox's gear menu, Chrome's
   * "⋮"): the languages to translate from and into – the bar has menulists for these on the
   * desktop, the phone's bar leaves them to this menu – the always / never rules for the page's
   * language and its site, the auto-offer switch and the Languages settings.
   */
  showTranslateMenu(
    tabId: string,
    anchor: { x: number; y: number } | undefined,
    win: ZenWindow
  ): void {
    const { translate } = this.browser
    const tab = this.browser.tabs.tab(tabId)
    if (!tab || !translate.available) return
    const state = translate.tabState(tabId)
    const prefs = translate.preferences
    const source = state?.source ?? null
    const target = state?.target ?? null
    const site = translate.siteOf(tabId)
    const rule = source ? translate.languageRule(source) : 'ask'
    const languages = sortedByName(translate.uiState().languages)
    const running = state?.status === 'translating' || state?.status === 'translated'
    /** Re-translate right away while a translation shows; otherwise only change the offer. */
    const retarget = (patch: { source?: string; target?: string }): void => {
      if (running) void translate.translatePage(tabId, patch).catch(() => undefined)
      else translate.retarget(tabId, patch)
    }
    const languageMenu = (
      current: string | null,
      except: string | null,
      pick: (code: string) => void
    ): Template =>
      languages
        .filter((code) => code !== except)
        .map((code) => ({
          label: languageName(code),
          type: 'radio' as const,
          checked: code === current,
          click: () => pick(code)
        }))
    const template: Template = [
      {
        label: 'Translate To',
        submenu: languageMenu(target, source, (code) => retarget({ target: code }))
      },
      {
        label: source ? `Page Is in ${languageName(source)}` : 'Page Language',
        submenu: languageMenu(source, target, (code) => retarget({ source: code }))
      },
      { type: 'separator' },
      ...(source
        ? [
            {
              label: `Always Translate ${languageName(source)}`,
              type: 'checkbox' as const,
              checked: rule === 'always',
              click: () => {
                translate.setLanguageRule(source, rule === 'always' ? 'ask' : 'always')
                if (rule !== 'always' && !running)
                  void translate.translatePage(tabId).catch(() => undefined)
              }
            },
            {
              label: `Never Translate ${languageName(source)}`,
              type: 'checkbox' as const,
              checked: rule === 'never',
              click: () => translate.setLanguageRule(source, rule === 'never' ? 'ask' : 'never')
            }
          ]
        : []),
      ...(site
        ? [
            {
              label: 'Never Translate This Site',
              type: 'checkbox' as const,
              checked: prefs.neverTranslateSites.includes(site),
              click: () => translate.setSiteRule(tabId, !prefs.neverTranslateSites.includes(site))
            }
          ]
        : []),
      { type: 'separator' },
      {
        label: 'Offer to Translate Pages',
        type: 'checkbox',
        checked: prefs.autoOffer,
        click: () => translate.setPreferences({ autoOffer: !prefs.autoOffer })
      },
      { type: 'separator' },
      {
        label: 'Language Settings…',
        click: () => void this.browser.pages.open('settings', 'languages', win)
      }
    ]
    this.popup(template, win, 'translate', anchor)
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
 * A tab the chrome's site information sheet has something to say about – the pill's site chip's
 * rule: no registered internal page (Settings, which has no site, design language v2 §10.1), and
 * no blank or new tab, which have no page at all. Every other document – a site, an error page
 * standing in for one, an extension's page, a local file – gets the sheet.
 */
export function hasSiteInfo(tab: Pick<Tab, 'url'>): boolean {
  return internalPageOf(tab.url) === null && tab.url !== BLANK_URL && tab.url !== NEW_TAB_URL
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

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5
}

/**
 * The most of a selection the toolbar's entry points take from a host (the Android host cuts
 * at the same length, `SelectionToolbar.SELECTION_MAX_CHARS`): a query or a share needs no more,
 * and a host's text is not to be trusted with the length.
 */
export const SELECTION_TEXT_MAX = 10_000

function clipSelection(selection: string): string {
  return selection.length > SELECTION_TEXT_MAX ? selection.slice(0, SELECTION_TEXT_MAX) : selection
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

/**
 * The entries behind (`back`) or ahead of (`forward`) the current one, nearest first and at most
 * `limit` of them, each with its index in the stack – Chrome's `getDirectedNavigationHistory`,
 * the list its Back button's long press shows. The current entry is never in it; an index off
 * the stack, or a stack of one, gives an empty list.
 */
export function directedNavigationHistory(
  entries: readonly NavigationSnapshotEntry[],
  index: number,
  direction: NavigationDirection,
  limit: number
): Array<{ index: number; url: string; title: string }> {
  const out: Array<{ index: number; url: string; title: string }> = []
  if (index < 0 || index >= entries.length) return out
  const step = direction === 'back' ? -1 : 1
  for (let i = index + step; i >= 0 && i < entries.length && out.length < limit; i += step) {
    const entry = entries[i]
    out.push({ index: i, url: entry.url, title: entry.title })
  }
  return out
}
