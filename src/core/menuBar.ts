import type { Browser } from './browser'
import type { MenuItemTemplate } from './platform'
import type { ZenWindow } from './window'
import type {
  BookmarksBarMode,
  ShortcutAction,
  SplitGroup,
  SplitLayout,
  SyncRemoteTab,
  Tab
} from '../shared/types'
import { BOOKMARKS_BAR_ID } from '../shared/bookmarks'
import { HELP_URL, ISSUES_URL } from '../shared/links'
import { S } from '../shared/strings'
import { forcesRail, isHorizontalTabs } from '../shared/toolbarLayout'
import { displayUrl } from '../shared/url'
import { openHelp, openReportUnsafeSite, reportUnsafeSiteUrl } from './help'
import { clipLabel } from './menus'
import { isPrivateFolder, orderedTabsForSpace } from './model'
import { permissionSite } from './permissions'

type Template = MenuItemTemplate[]

/**
 * The layouts as the "Split View" submenu lists them: the chords' order, Ctrl+Alt+G / V / H.
 * The words are the parent's children – "Grid" under "Split View" – not the acts' table labels
 * ("Split View Grid"), which would say the parent's words again; the table has no child face.
 */
const SPLIT_LAYOUT_ITEMS: ReadonlyArray<{
  layout: SplitLayout
  label: string
  action: ShortcutAction
}> = [
  { layout: 'grid', label: 'Grid', action: 'split.grid' },
  { layout: 'vertical', label: 'Vertical', action: 'split.vertical' },
  { layout: 'horizontal', label: 'Horizontal', action: 'split.horizontal' }
]

/**
 * The "Split View" submenu of the application menu (⋯) and of the macOS View menu (split-01:
 * Edge's "Split screen" sits in its Settings and more menu; Chrome's split view lives on a
 * toolbar icon, which here is a shell-pass decision, so the menus carry the entry points).
 * Grid / Vertical / Horizontal run the chords' actions: out of a split they split the active
 * tab with the tab below it in that layout; in a split they turn it to that layout, and the
 * layout the split has is checked – choosing it again leaves the split, as the chord does. The
 * three read as the parent's children (the string table's "Split View Grid" would say the
 * parent's words again). Swap Split Panes (split-07, on the active pane), Unsplit View and New
 * Empty Split View follow, the table's words (`S.menu`), as the key table says them. Items name
 * their `action`, so each shows its chord and the click runs the same code as the key.
 */
export function splitViewSubmenu(
  active: Tab | undefined,
  group: SplitGroup | undefined
): MenuItemTemplate {
  return {
    label: 'Split View',
    submenu: [
      ...SPLIT_LAYOUT_ITEMS.map(({ layout, label, action }): MenuItemTemplate => ({
        label,
        type: 'checkbox',
        action,
        checked: group?.layout === layout,
        enabled: Boolean(active)
      })),
      { type: 'separator' },
      // "Swap Split Panes" – the key table's and the palette's words for `split.swap`; the pane
      // header's own menu says "Swap Panes" (`menus.ts`) and resolves with its family.
      { label: S.menu('split.swap'), action: 'split.swap', enabled: Boolean(group) },
      { label: S.menu('split.unsplit'), action: 'split.unsplit', enabled: Boolean(group) },
      { label: S.menu('split.newEmpty'), action: 'split.newEmpty', enabled: Boolean(active) }
    ]
  }
}

/** Where the Help menu's entries go (shared with Settings › About, `shared/links.ts`). */
export { HELP_URL, ISSUES_URL }

/** Bookmarks the Bookmarks menu lists per folder, and how deep it follows folders. */
const BOOKMARK_MENU_MAX = 40
const BOOKMARK_MENU_DEPTH = 3

/** Pages the History menu's Recently Visited block lists (Chrome's `kVisitedCount`). */
const RECENTLY_VISITED_MAX = 10

/**
 * Actions the menu bar runs with every window closed (macOS keeps the app alive then): they
 * open one first. Everything else needs a window and is ignored without one.
 */
const OPENS_WINDOW: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>([
  'tab.new',
  'window.new',
  'window.newUnsynced',
  'window.newPrivate',
  'tab.reopenClosed',
  'page.openFile',
  'urlbar.focus',
  'settings.open',
  'history.sidebar',
  'downloads.open',
  'addons.open',
  'bookmark.sidebar',
  'bookmark.library',
  'space.new',
  // The dialog is a window's chrome's: Chrome opens a window for it too.
  'privacy.clearBrowsingData'
])

/** The window the user is in, without opening one (unlike `Browser.focusedWindow`). */
export function frontWindow(browser: Browser): ZenWindow | null {
  const alive = browser.allWindows()
  return (
    alive.find((w) => w.host.isFocused()) ??
    [...alive].sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)[0] ??
    null
  )
}

/**
 * Run a shortcut action from the menu bar: on the front window, or on a fresh one when the
 * action opens something and no window is up.
 */
export function runFromMenuBar(browser: Browser, action: ShortcutAction): void {
  const win = frontWindow(browser) ?? (OPENS_WINDOW.has(action) ? browser.ensureWindow() : null)
  if (win) browser.actions.run(action, { sourceTabId: null, win })
}

/**
 * The macOS menu bar: Chrome's nine menus (Zenium, File, Edit, View, History, Bookmarks, Tab,
 * Window, Help – Chrome's Profiles menu has no counterpart) with Zenium's actions in Chrome's
 * order, plus Zenium's own features (Spaces, split view, compact mode) where they belong. Items
 * name their `action`, so the chord shown after each label comes from the active key table and
 * the click runs the same code as the key. System entries (Services, Hide, Quit, the editing
 * commands, Zoom and Bring All to Front) are the host's roles. Rebuilt when what it shows
 * changed; `click`s look the front window up when they run, so a menu built while one window
 * was in front works from another.
 *
 * Every action row's words are the string table's (`S.menu`, §9 item 10). The bar's standard
 * items take the platform's own words through the `os` axis (Q4: "Settings…", Window ▸
 * "Minimize", Edit ▸ Find ▸ "Find…", and Chrome's mac words where they differ from the house
 * label – Open Location…, Actual Size, Show Full History, Inspect Element, Downloads, Select
 * Next Tab); Zenium's own acts keep the house label, and View says "Hard Reload". A row that
 * knows its state reads the state pair (Enter / Exit Full Screen, Enter / Exit Reader View,
 * Expand / Collapse Sidebar, Bookmark This Tab… / Edit Bookmark…) or is a checkbox (Compact
 * Mode).
 */
export function applicationMenu(browser: Browser): Template {
  const { state, tabs } = browser
  const os = browser.platform.info.os
  const win = frontWindow(browser)
  const active = win ? tabs.activeTabFor(win) : undefined
  const web = Boolean(active) && /^https?:/i.test(active!.url)
  /** Run something on the front window (opening one when `open` and none is up). */
  const withWindow =
    (fn: (win: ZenWindow) => void, open = false): (() => void) =>
    () => {
      const target = frontWindow(browser) ?? (open ? browser.ensureWindow() : null)
      if (target) fn(target)
    }
  /** Run something on the front window's active tab, both looked up when the row is picked. */
  const withActiveTab = (fn: (tab: Tab, win: ZenWindow) => void): (() => void) =>
    withWindow((w) => {
      const tab = tabs.activeTabFor(w)
      if (tab) fn(tab, w)
    })
  /** A Settings section: the Settings page, as a tab or its overlay (`PageService.open`). */
  const settings = (section: string): (() => void) =>
    withWindow((w) => void browser.pages.open('settings', section, w), true)

  // Chrome's application menu (`main_menu_builder.mm`): About; Settings, Delete Browsing Data,
  // Import; Services; the hide trio; Warn Before Quitting; Quit.
  const warnBeforeQuitting = state.settings.warnBeforeQuitting
  const zenium: MenuItemTemplate = {
    label: 'Zenium',
    submenu: [
      // Chrome's About Google Chrome opens its About page (`chrome://settings/help`), not the
      // system's About panel: this row opens Zenium's – Settings › About, the version, the
      // update row and the legal pages – as the ⋯ menu's Help › About Zenium does
      // (shortcuts-menus-123), in a window opened for it when none is up. The `about` role it
      // had drew Electron's generic panel (the icon, the name and the version) instead.
      { label: 'About Zenium', click: settings('about') },
      { type: 'separator' },
      { label: S.menu('settings.open', { os }), action: 'settings.open' },
      { label: S.menu('privacy.clearBrowsingData'), action: 'privacy.clearBrowsingData' },
      // The Bookmarks menu's row again, where Chrome's application menu also keeps it.
      {
        label: 'Import Bookmarks and Settings…',
        click: withWindow((w) => browser.openImportDialog(w), true)
      },
      { type: 'separator' },
      { label: 'Services', role: 'services', submenu: [] },
      { type: 'separator' },
      { label: 'Hide Zenium', role: 'hide' },
      { label: 'Hide Others', role: 'hideOthers' },
      { label: 'Show All', role: 'unhide' },
      { type: 'separator' },
      // Chrome's checkbox (session-08), arming the hold: while it is set the quit chord shows
      // "Hold ⌘Q to quit" over the front window and quits once the keys were held
      // (`QuitHoldService`); off, the chord quits at once. The chord in the label is Chrome's
      // wording. Its own setting – the tab-count warning stays `warnOnCloseWindow`'s.
      {
        label: 'Warn Before Quitting (⌘Q)',
        type: 'checkbox',
        checked: warnBeforeQuitting,
        click: () => browser.setWarnBeforeQuitting(!browser.state.settings.warnBeforeQuitting)
      },
      { type: 'separator' },
      // The role's chord stays registered: it is what quits with every window closed. With a
      // window in front the key table sees ⌘Q first: off, it quits at once and consumes the
      // key, and the role never sees it; on, it arms the hold and lets the key through (its
      // release has to reach the table), so the role fires too – a quit request the browser
      // refuses while the hold runs (`Browser.requestQuit`). A pick of the row itself quits at
      // once, as Chrome's does.
      { label: 'Quit Zenium', role: 'quit' }
    ]
  }

  const file: MenuItemTemplate = {
    label: 'File',
    submenu: [
      { label: S.menu('tab.new'), action: 'tab.new' },
      { label: S.menu('window.new'), action: 'window.new' },
      { label: S.menu('window.newUnsynced'), action: 'window.newUnsynced' },
      { label: S.menu('window.newPrivate'), action: 'window.newPrivate' },
      { label: S.menu('tab.reopenClosed'), action: 'tab.reopenClosed' },
      { label: S.menu('page.openFile'), action: 'page.openFile' },
      { label: S.menu('urlbar.focus', { os }), action: 'urlbar.focus' },
      { type: 'separator' },
      { label: S.menu('window.close'), action: 'window.close', enabled: Boolean(win) },
      { label: S.menu('tab.close'), action: 'tab.close', enabled: Boolean(active) },
      { label: S.menu('page.savePage'), action: 'page.savePage', enabled: web },
      { type: 'separator' },
      { label: S.menu('page.emailLink'), action: 'page.emailLink', enabled: web },
      { type: 'separator' },
      { label: S.menu('page.printPreview'), action: 'page.printPreview', enabled: Boolean(active) }
    ]
  }

  const edit: MenuItemTemplate = {
    label: 'Edit',
    submenu: [
      { label: 'Undo', role: 'undo' },
      { label: 'Redo', role: 'redo' },
      { type: 'separator' },
      { label: 'Cut', role: 'cut' },
      { label: 'Copy', role: 'copy' },
      { label: 'Paste', role: 'paste' },
      { label: 'Paste and Match Style', role: 'pasteAndMatchStyle' },
      { label: 'Delete', role: 'delete' },
      { label: 'Select All', role: 'selectAll' },
      { type: 'separator' },
      {
        label: 'Find',
        submenu: [
          { label: S.menu('find.open', { os }), action: 'find.open', enabled: Boolean(active) },
          { label: S.menu('find.next'), action: 'find.next', enabled: Boolean(active) },
          { label: S.menu('find.prev'), action: 'find.prev', enabled: Boolean(active) },
          { label: S.menu('find.useSelection'), action: 'find.useSelection', enabled: web }
        ]
      },
      {
        label: 'Speech',
        submenu: [
          { label: 'Start Speaking', role: 'startSpeaking' },
          { label: 'Stop Speaking', role: 'stopSpeaking' }
        ]
      }
    ]
  }

  const barMode = state.settings.bookmarksBar
  const barChoices: Array<{ mode: BookmarksBarMode; label: string }> = [
    { mode: 'always', label: 'Always' },
    { mode: 'newtab', label: 'Only on New Tab Page' },
    { mode: 'never', label: 'Never' }
  ]
  const fullScreen = Boolean(win?.host.isFullScreen())
  const railFixed = forcesRail(state.settings.toolbarLayout)
  const sidebarExpanded = state.settings.sidebarExpanded && !railFixed
  const view: MenuItemTemplate = {
    label: 'View',
    submenu: [
      {
        label: 'Show Bookmarks Bar',
        submenu: barChoices.map(({ mode, label }) => ({
          type: 'radio' as const,
          label,
          checked: barMode === mode,
          click: withWindow((w) => browser.setBookmarksBarMode(mode, w))
        }))
      },
      // The sidebar's width: the state pair's side the act would take – Collapse Sidebar while
      // it is expanded, Expand Sidebar at the rail. A layout that fixes the rail (`forcesRail`)
      // leaves the act nothing to change, so the row greys there.
      {
        label: S.menu('sidebar.toggle', { state: sidebarExpanded }),
        action: 'sidebar.toggle',
        enabled: Boolean(win) && !railFixed
      },
      {
        label: S.menu('compact.toggle'),
        type: 'checkbox',
        action: 'compact.toggle',
        checked: Boolean(win?.compactEnabled),
        enabled: Boolean(win)
      },
      { type: 'separator' },
      { label: S.menu('nav.stop'), action: 'nav.stop', enabled: Boolean(active?.loading) },
      { label: S.menu('nav.reload'), action: 'nav.reload', enabled: Boolean(active) },
      {
        label: S.menu('nav.reloadSkipCache'),
        action: 'nav.reloadSkipCache',
        enabled: Boolean(active)
      },
      { type: 'separator' },
      {
        label: S.menu('page.fullscreen', { state: fullScreen }),
        action: 'page.fullscreen',
        enabled: Boolean(win)
      },
      { label: S.menu('zoom.reset', { os }), action: 'zoom.reset', enabled: Boolean(active) },
      { label: S.menu('zoom.in'), action: 'zoom.in', enabled: Boolean(active) },
      { label: S.menu('zoom.out'), action: 'zoom.out', enabled: Boolean(active) },
      { type: 'separator' },
      {
        label: S.menu('page.readerMode', {
          state: Boolean(active && browser.reader.isReaderUrl(active.url))
        }),
        action: 'page.readerMode',
        enabled:
          Boolean(active) &&
          (browser.reader.isReaderUrl(active!.url) || browser.reader.canRead(active!))
      },
      splitViewSubmenu(
        active,
        active?.splitGroupId ? state.model.splitGroups[active.splitGroupId] : undefined
      ),
      { type: 'separator' },
      {
        label: 'Developer',
        submenu: [
          { label: S.menu('page.viewSource'), action: 'page.viewSource', enabled: web },
          { label: S.menu('devtools.toggle'), action: 'devtools.toggle', enabled: Boolean(active) },
          {
            label: S.menu('devtools.inspector', { os }),
            action: 'devtools.inspector',
            enabled: Boolean(active)
          },
          {
            label: S.menu('devtools.console'),
            action: 'devtools.console',
            enabled: Boolean(active)
          }
        ]
      }
    ]
  }

  const history: MenuItemTemplate = {
    label: 'History',
    submenu: [
      { label: S.menu('nav.home'), action: 'nav.home', enabled: Boolean(active) },
      { label: S.menu('nav.back'), action: 'nav.back', enabled: Boolean(active?.canGoBack) },
      {
        label: S.menu('nav.forward'),
        action: 'nav.forward',
        enabled: Boolean(active?.canGoForward)
      },
      { type: 'separator' },
      { label: S.menu('tab.reopenClosed'), action: 'tab.reopenClosed' },
      recentlyClosed(browser),
      ...recentlyVisited(browser),
      ...tabsFromOtherDevices(browser),
      { type: 'separator' },
      { label: S.menu('history.sidebar', { os }), action: 'history.sidebar' }
    ]
  }

  const bookmarks: MenuItemTemplate = {
    label: 'Bookmarks',
    submenu: [
      { label: S.menu('bookmark.library'), action: 'bookmark.library' },
      {
        label: S.menu('bookmark.add', { state: Boolean(active?.bookmarked) }),
        action: 'bookmark.add',
        enabled: Boolean(active) && !active!.url.startsWith('zen://')
      },
      { label: S.menu('bookmark.allTabs'), action: 'bookmark.allTabs', enabled: Boolean(win) },
      { type: 'separator' },
      { label: S.menu('bookmark.sidebar'), action: 'bookmark.sidebar' },
      // Chrome's Bookmarks menu entry: Settings > Import with the dialog up (the bookmark
      // manager's own menu keeps the plain "Import Bookmarks…" file pick, as Chrome's does).
      {
        label: 'Import Bookmarks and Settings…',
        click: withWindow((w) => browser.openImportDialog(w), true)
      },
      {
        label: 'Export Bookmarks…',
        click: withWindow((w) => void browser.exportBookmarks(w), true)
      },
      ...bookmarksBarItems(browser, withWindow)
    ]
  }

  const local = Boolean(win?.localSpace)
  const tab = tabMenu(browser, win, active, local, withActiveTab)

  // The private window's app menu row (profiles-25), here while a private window is up: the
  // window operations' group, Firefox's counted verb; the front window closes last.
  const count = browser.allWindows().filter((w) => w.isPrivate).length
  const closePrivateWindows: Template =
    count > 0
      ? [
          {
            label: S.menu('window.closePrivate', { n: count }),
            click: withWindow((w) => void browser.closePrivateWindows(w))
          }
        ]
      : []
  // Chrome's Window menu (`BuildWindowMenu`): the window's own rows and the app's – no tab
  // rows, which are the Tab menu's.
  const window: MenuItemTemplate = {
    label: 'Window',
    role: 'window',
    submenu: [
      {
        label: S.menu('window.minimize', { os }),
        action: 'window.minimize',
        enabled: Boolean(win)
      },
      { label: 'Zoom', role: 'zoom' },
      ...closePrivateWindows,
      { type: 'separator' },
      // The group about this window, in the order More Tools has the pair (one order in both
      // menus, the #451 lead check's): Chrome's Window › Name Window… – the window's own name
      // first – then Duplicate Window (session-19), the verb that makes another, greyed for a
      // popup or an app window, which have no tab strip to duplicate, as a menu bar greys rather
      // than hides. A group of its own, as Chrome's menu has it.
      { label: S.menu('window.name'), action: 'window.name', enabled: Boolean(win) },
      {
        label: S.menu('window.duplicate'),
        action: 'window.duplicate',
        enabled: Boolean(win) && win!.chrome === 'full'
      },
      { type: 'separator' },
      { label: S.menu('space.next'), action: 'space.next', enabled: Boolean(win) && !local },
      { label: S.menu('space.prev'), action: 'space.prev', enabled: Boolean(win) && !local },
      { label: S.menu('space.new'), action: 'space.new', enabled: !local },
      { type: 'separator' },
      { label: S.menu('downloads.open', { os }), action: 'downloads.open' },
      ...(state.capabilities.extensions
        ? [{ label: S.menu('addons.open'), action: 'addons.open' as const }]
        : []),
      { type: 'separator' },
      { label: 'Bring All to Front', role: 'front' }
    ]
  }

  // The app menu's Help submenu (`Menus.showAppMenu`) in the one order, less About Zenium, which
  // is the application menu's (where Chrome keeps About on macOS): this build's group – its
  // release notes – over the hairline, then the help (shortcuts-menus-152, -162). The two
  // surfaces read the same, so the eye that learned one finds the other. The `help` role gives
  // the menu macOS's Search field. Chrome's Help menu (`BuildHelpMenu`) is Report an Issue…,
  // Report an Unsafe Site…, then "Google Chrome Help", its help a tab (`ShowHelp` opens a
  // singleton tab): Zenium Help opens `HELP_URL` in a new tab in front too (`openHelp`, the
  // lead's ruling on #578), in a window opened for it when none is up. Report an Issue… shows
  // Chrome's ⌥⇧⌘I, the key table's `help.reportIssue`, and opens the tracker in the system
  // browser with or without a window. Report an Unsafe Site… is Google's Safe Browsing report
  // form for the front window's page in a new tab (`openReportUnsafeSite`, services' word on
  // #578: shown whether Safe Browsing is on), greyed when the page is not one the form takes –
  // a `zen://` page, a blank tab, no tab – where the ⋯ menu hides its row: a menu bar greys
  // rather than hides (§9.30). Chrome's ⇧⌘/ names no action of the key table: no chord there.
  const help: MenuItemTemplate = {
    label: 'Help',
    role: 'help',
    submenu: [
      { label: "What's New", click: withWindow((w) => browser.updates.openWhatsNew(w), true) },
      { type: 'separator' },
      { label: 'Zenium Help', click: withWindow((w) => openHelp(browser, w), true) },
      { label: 'Keyboard Shortcuts', click: settings('shortcuts') },
      {
        label: S.menu('help.reportIssue'),
        action: 'help.reportIssue',
        click: () => browser.platform.shell.openExternal(ISSUES_URL)
      },
      {
        label: S.menu('help.reportUnsafeSite'),
        enabled: reportUnsafeSiteUrl(active?.url) !== null,
        click: withWindow((w) => void openReportUnsafeSite(browser, w))
      }
    ]
  }

  return [zenium, file, edit, view, history, bookmarks, tab, window, help]
}

/**
 * Chrome's Tab menu (`main_menu_builder.mm`'s `BuildTabMenu`; shortcuts-menus-160), between
 * Bookmarks and Window as Chrome seats it (its Profiles menu, which stands before it there,
 * has no counterpart): New Tab to the Right, Select Next Tab, Select Previous Tab, Duplicate
 * Tab, Mute Site, Pin Tab, Group Tab, Close Other Tabs, Close Tabs to the Right, Move Tab to
 * New Window, Search Tabs, in Chrome's order and without Chrome's separators (its menu is one
 * group). The two rows Chrome words by direction follow the strip (`tabDirectionLabels`): its
 * nib keeps both twins and shows the pair for the strip's orientation
 * (`app_controller_mac.mm`'s `onVerticalTabStripModeChanged`: "New Tab to the Right" / "Close
 * Tabs to the Right" beside a horizontal strip, `IDS_TAB_CXMENU_NEWTABBELOW` /
 * `IDS_TAB_CXMENU_CLOSETABSBELOW` beside a vertical one), so the rows read "to the Right"
 * under the desktop's horizontal layout and "Below" under its sidebar layouts. Chrome's Group
 * Tab is Zenium's folder rows in the tab context menu's own words (its Move Tab ▸ folder rows,
 * context-menus-91: "Add Tab to New Folder" while the space has no folder, else "Move to
 * Folder ▸" – a new folder first, then the space's folders, the tab's own checked – with
 * "Remove from Folder" beside it). Every row runs the command the tab's context menu runs
 * (`Menus.showTabContextMenu`), on the front window's active tab: the rows with a chord name
 * their `action`, so the key table's binding shows after the label and the pick runs the key's
 * code; the rest run the tab service's command directly. Greyed with no tab to act on, and
 * where the context menu greys (nothing to close, a page without a site to mute, a pinned or
 * Essentials tab that no folder takes, a local space that has none) – a menu bar greys rather
 * than hides (§9.30) – with the toggles reading their state: Mute Site / Unmute Site, Pin Tab /
 * Unpin Tab. Move Tab to New Window greys while the window shows one tab alone, as Chrome's
 * does (`CanMoveTabsToNewWindow`: more tabs than the selection – the move would only close
 * the window behind it). Chrome's Add Tab to New Split View (`IDC_NEW_SPLIT_TAB`: a new tab
 * after the active one, the two split side by side) is the key table's New Empty Split View
 * (`split.newEmpty`, the same code) under Chrome's words, greyed while the active tab is in a
 * split already – Chrome's command is a no-op there (`ExecuteCommand`'s `IsSplit` guard), and
 * a menu bar greys a row that would do nothing – or is an Essentials tab, which no split takes.
 */
function tabMenu(
  browser: Browser,
  win: ZenWindow | null,
  active: Tab | undefined,
  local: boolean,
  withActiveTab: (fn: (tab: Tab, win: ZenWindow) => void) => () => void
): MenuItemTemplate {
  const { state, tabs } = browser
  const os = browser.platform.info.os
  const m = state.model
  const has = Boolean(active)
  const direction = tabDirectionLabels(
    win?.formFactor === 'desktop' && isHorizontalTabs(state.settings.toolbarLayout)
  )
  // The tabs the window shows in its space – Essentials, pinned and regular – the count Chrome
  // reads the move row against.
  const shown = win
    ? orderedTabsForSpace(m, win.activeSpace(), state.settings.containerSpecificEssentials, win.id)
        .length
    : 0
  // Mute Site writes the site's `sound` setting: a page without a site (`zen://`, `about:blank`)
  // has none to write, and the row greys – the command's own precondition (`Tabs.toggleMuteSite`).
  const site = Boolean(active && permissionSite(active.url))
  const pinned = Boolean(active && (active.pinned || active.essential))
  // The space's folders the tab could move to, the context menu's rule: a regular tab's row
  // names no private folder (private browsing leaks nothing outside its mode), a private tab's
  // – on a host that keeps private browsing in tabs – every folder of its space.
  const folders =
    active && win
      ? Object.values(m.folders).filter(
          (f) =>
            f.spaceId === (active.spaceId ?? win.activeSpaceId) &&
            (tabs.isPrivate(active) || !isPrivateFolder(m, f))
        )
      : []
  const canFolder = has && !local && !pinned
  const newFolder = withActiveTab((t, w) => browser.newFolderWithTab(w.activeSpace().id, t.id, w))
  const folderRows: Template = [
    folders.length === 0
      ? { label: 'Add Tab to New Folder', enabled: canFolder, click: newFolder }
      : {
          label: 'Move to Folder',
          enabled: canFolder,
          submenu: [
            { label: 'New Folder…', click: newFolder },
            { type: 'separator' },
            ...folders.map((f): MenuItemTemplate => ({
              label: `${f.icon} ${f.name}`,
              type: 'checkbox',
              checked: active!.folderId === f.id,
              click: withActiveTab((t) =>
                tabs.moveToFolder(t.id, t.folderId === f.id ? null : f.id)
              )
            }))
          ]
        },
    {
      label: 'Remove from Folder',
      enabled: Boolean(active?.folderId),
      click: withActiveTab((t) => tabs.moveToFolder(t.id, null))
    }
  ]
  const closeScope = (which: 'others' | 'below'): boolean =>
    Boolean(active && win) && tabs.closeScope(active!.id, which, win!).length > 0
  return {
    label: 'Tab',
    submenu: [
      {
        label: direction.newTab,
        enabled: has && !active!.essential,
        click: withActiveTab((t, w) => browser.newTabAfter(t.id, w))
      },
      { label: S.menu('tab.next', { os }), action: 'tab.next', enabled: has },
      { label: S.menu('tab.prev', { os }), action: 'tab.prev', enabled: has },
      { label: S.menu('tab.duplicate'), action: 'tab.duplicate', enabled: has },
      {
        label: S.menu('page.toggleMuteSite', {
          state: Boolean(active && tabs.siteMuted(active.url))
        }),
        enabled: site,
        click: withActiveTab((t) => tabs.toggleMuteSite(t.id))
      },
      { label: S.menu('tab.togglePin', { state: pinned }), action: 'tab.togglePin', enabled: has },
      ...folderRows,
      {
        label: 'Close Other Tabs',
        enabled: closeScope('others'),
        click: withActiveTab((t, w) => tabs.closeOthers(t.id, w))
      },
      {
        label: direction.closeAfter,
        enabled: closeScope('below'),
        click: withActiveTab((t, w) => tabs.closeBelow(t.id, w))
      },
      ...(state.capabilities.windows
        ? [
            {
              label: S.menu('tab.moveToNewWindow'),
              enabled: has && shown > 1,
              click: withActiveTab((t, w) => void tabs.moveTabToNewWindow(t.id, null, w))
            }
          ]
        : []),
      // Chrome's words over the key table's New Empty Split View (`split.newEmpty`): the one
      // act's second row of this bar, which the string table names once – left as it is till
      // the Lead rules on the pair.
      {
        label: 'Add Tab to New Split View',
        action: 'split.newEmpty',
        enabled: has && !active!.essential && !active!.splitGroupId
      },
      { label: S.menu('tab.search'), action: 'tab.search', enabled: Boolean(win) }
    ]
  }
}

/** The tab rows Chrome words by direction, per strip orientation (`tabDirectionLabels`). */
export interface TabDirectionLabels {
  /** Chrome's `IDC_NEW_TAB_TO_RIGHT`: the new tab after this one. */
  newTab: string
  /** Chrome's `IDC_WINDOW_CLOSE_TABS_TO_RIGHT`: every tab after this one. */
  closeAfter: string
  /** The context menu's Close Tabs Above: every tab before this one (Chrome has no such row). */
  closeBefore: string
}

/**
 * How the tab menus word the rows that name a direction: Chrome keeps both twins in its Tab
 * menu's nib and in its tab context menu (`tab_menu_model.cc`) and shows the pair for the
 * strip's orientation – "New Tab to the Right" / "Close Tabs to the Right" beside a horizontal
 * strip, "New Tab Below" / "Close Tabs Below" beside a vertical one
 * (`VerticalTabStripStateController::ShouldDisplayVerticalTabs`). The desktop's horizontal
 * layout (`isHorizontalTabs`) is the one strip that runs along the top; every sidebar layout,
 * the phone's and the tablet's strips included, runs down, so their rows keep "Below" (the
 * lead's ruling, wave 7's backlog under §9.37). Close Tabs Above is the vertical strip's
 * "before" row, which reads "to the Left" along a horizontal one. The words are the string
 * table's orientation axis (P-34: `tab.newAfter`, `tab.closeAfter`, `tab.closeBefore`).
 */
export function tabDirectionLabels(horizontal: boolean): TabDirectionLabels {
  const orientation = horizontal ? 'horizontal' : 'vertical'
  return {
    newTab: S.menu('tab.newAfter', { orientation }),
    closeAfter: S.menu('tab.closeAfter', { orientation }),
    closeBefore: S.menu('tab.closeBefore', { orientation })
  }
}

/** "Recently Closed": newest first, ten at most; the newest is what the reopen chord brings back. */
function recentlyClosed(browser: Browser): MenuItemTemplate {
  const entries = browser.session.summaries().slice(0, 10)
  if (entries.length === 0) return { label: 'Recently Closed', enabled: false, submenu: [] }
  const restore =
    (id: string): (() => void) =>
    () => {
      const win = frontWindow(browser) ?? browser.ensureWindow()
      browser.session.restoreClosed(id, win)
    }
  return {
    label: 'Recently Closed',
    submenu: entries.map((e) => ({
      label:
        e.kind === 'window'
          ? `Reopen Window – ${clipLabel(e.title, 40)} (${e.tabCount} ${e.tabCount === 1 ? 'tab' : 'tabs'})`
          : clipLabel(e.title || (e.url ? displayUrl(e.url) : 'Untitled'), 60),
      click: restore(e.id)
    }))
  }
}

/**
 * Chrome's "Recently Visited" block of the mac History menu (history-12, Chrome's
 * `HistoryMenuBridge` with its `kVisitedCount`): the ten pages last visited, newest first, each
 * by its title (its address when it has none) with its favicon (shortcuts-menus-157), behind a
 * separator and Chrome's disabled header – a heading, not a dead command: the note kind the
 * sibling "Tabs from Other Devices" heading takes (#396's A7; §9.30), which a renderer-drawn
 * menu writes at the note's ink and the native bar shows disabled –
 * between Recently Closed and Tabs from Other Devices as Chrome orders them. A row loads its
 * page in the front window's current tab, as Chrome's does (a window is opened for it when none
 * is up – the bar stands without one). Nothing while history is empty: the block goes, separator
 * and header with it. Rebuilt with the history (`Browser` schedules the bar on its changes).
 */
function recentlyVisited(browser: Browser): Template {
  const entries = browser.history.recent(RECENTLY_VISITED_MAX)
  if (entries.length === 0) return []
  return [
    { type: 'separator' },
    { label: 'Recently Visited', enabled: false, note: true },
    ...entries.map((e): MenuItemTemplate => {
      // History keeps the address as the title of a page that had none: the row shows it the
      // way the bar does, scheme and `www.` dropped.
      const untitled = !e.title || e.title === e.url
      return {
        label: clipLabel(untitled ? displayUrl(e.url) || e.url : e.title, 60),
        icon: e.favicon,
        click: () =>
          browser.openRecentlyVisited(e.url, frontWindow(browser) ?? browser.ensureWindow())
      }
    })
  ]
}

/**
 * Chrome's "Tabs From Other Devices" block of the mac History menu, after Recently Visited and
 * behind its own separator: the app menu's block (`Menus.tabsFromDevicesItems` – the header,
 * the devices as submenus of their tabs, the hidden devices' way back) with a row opening its
 * tab in the front window through the held-tab rule, or in a window opened for it when none is
 * up (the bar stands without one). Nothing while sync lists no device, as in the app menu.
 */
function tabsFromOtherDevices(browser: Browser): Template {
  const open = (tabs: readonly SyncRemoteTab[]): void => {
    const win = frontWindow(browser) ?? browser.ensureWindow()
    browser.menus.openRemoteTabs(tabs, win)
  }
  const items = browser.menus.tabsFromDevicesItems(open)
  return items.length ? [{ type: 'separator' }, ...items] : []
}

/** The bookmarks bar's entries, folders as submenus, after a separator (Chrome lists them there). */
function bookmarksBarItems(
  browser: Browser,
  withWindow: (fn: (win: ZenWindow) => void, open?: boolean) => () => void
): Template {
  const { bookmarks } = browser
  const build = (folderId: string, depth: number): Template => {
    const children = bookmarks.getChildren(folderId)
    const items: Template = children.slice(0, BOOKMARK_MENU_MAX).map((node) => {
      if (node.type === 'folder') {
        const submenu = depth < BOOKMARK_MENU_DEPTH ? build(node.id, depth + 1) : []
        return {
          label: clipLabel(node.title || 'Untitled folder', 60),
          enabled: submenu.length > 0,
          submenu
        }
      }
      return {
        label: clipLabel(node.title || (node.url ? displayUrl(node.url) : 'Untitled'), 60),
        click: withWindow((w) => browser.openBookmark(node.id, true, null, w), true)
      }
    })
    if (children.length > BOOKMARK_MENU_MAX)
      items.push({ label: `${children.length - BOOKMARK_MENU_MAX} more…`, enabled: false })
    return items
  }
  const items = build(BOOKMARKS_BAR_ID, 1)
  return items.length ? [{ type: 'separator' }, ...items] : []
}

/**
 * What the host would draw: labels, kinds, states, chords and roles, submenus included. Two
 * templates with the same signature look the same, so the host is not asked to rebuild.
 */
export function menuSignature(items: Template): string {
  const strip = (list: Template): unknown[] =>
    list.map((item) => [
      item.type ?? 'normal',
      item.label ?? '',
      item.enabled !== false,
      Boolean(item.checked),
      item.accelerator ?? '',
      item.role ?? '',
      item.submenu ? strip(item.submenu) : null
    ])
  return JSON.stringify(strip(items))
}
