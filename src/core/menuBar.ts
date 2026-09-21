import type { Browser } from './browser'
import type { MenuItemTemplate } from './platform'
import type { ZenWindow } from './window'
import type {
  BookmarksBarMode,
  ShortcutAction,
  SplitGroup,
  SplitLayout,
  Tab
} from '../shared/types'
import { BOOKMARKS_BAR_ID } from '../shared/bookmarks'
import { displayUrl } from '../shared/url'
import { clipLabel } from './menus'

type Template = MenuItemTemplate[]

/** The layouts as the "Split View" submenu lists them: the chords' order, Ctrl+Alt+G / V / H. */
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
 * layout the split has is checked – choosing it again leaves the split, as the chord does.
 * Unsplit View and New Empty Split View follow, named as the key table names them. Items name
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
      { label: 'Unsplit View', action: 'split.unsplit', enabled: Boolean(group) },
      { label: 'New Empty Split View', action: 'split.newEmpty', enabled: Boolean(active) }
    ]
  }
}

/** Where the Help menu's entries go. */
export const HELP_URL = 'https://github.com/BenItBuhner/Zenium#readme'
export const ISSUES_URL = 'https://github.com/BenItBuhner/Zenium/issues'

/** Bookmarks the Bookmarks menu lists per folder, and how deep it follows folders. */
const BOOKMARK_MENU_MAX = 40
const BOOKMARK_MENU_DEPTH = 3

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
  'space.new'
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
 * The macOS menu bar: Chrome's eight menus (Zenium, File, Edit, View, History, Bookmarks,
 * Window, Help) with Zenium's actions in Chrome's order, plus Zenium's own features (Spaces,
 * split view, compact mode) where they belong. Items name their `action`, so the chord shown
 * after each label comes from the active key table and the click runs the same code as the
 * key. System entries (About, Services, Hide, Quit, the editing commands, Zoom and Bring All
 * to Front) are the host's roles. Rebuilt when what it shows changed; `click`s look the front
 * window up when they run, so a menu built while one window was in front works from another.
 */
export function applicationMenu(browser: Browser): Template {
  const { state, tabs } = browser
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
  /** A Settings section: the Settings page, as a tab or its overlay (`PageService.open`). */
  const settings = (section: string): (() => void) =>
    withWindow((w) => void browser.pages.open('settings', section, w), true)

  const zenium: MenuItemTemplate = {
    label: 'Zenium',
    submenu: [
      { label: 'About Zenium', role: 'about' },
      { type: 'separator' },
      { label: 'Settings…', action: 'settings.open' },
      { type: 'separator' },
      { label: 'Services', role: 'services', submenu: [] },
      { type: 'separator' },
      { label: 'Hide Zenium', role: 'hide' },
      { label: 'Hide Others', role: 'hideOthers' },
      { label: 'Show All', role: 'unhide' },
      { type: 'separator' },
      // The role's chord stays registered: it is what quits with every window closed.
      { label: 'Quit Zenium', role: 'quit' }
    ]
  }

  const file: MenuItemTemplate = {
    label: 'File',
    submenu: [
      { label: 'New Tab', action: 'tab.new' },
      { label: 'New Window', action: 'window.new' },
      { label: 'New Blank Window', action: 'window.newUnsynced' },
      { label: 'New Private Window', action: 'window.newPrivate' },
      { label: 'Reopen Closed Tab', action: 'tab.reopenClosed' },
      { label: 'Open File…', action: 'page.openFile' },
      { label: 'Open Location…', action: 'urlbar.focus' },
      { type: 'separator' },
      { label: 'Close Window', action: 'window.close', enabled: Boolean(win) },
      { label: 'Close Tab', action: 'tab.close', enabled: Boolean(active) },
      { label: 'Save Page As…', action: 'page.savePage', enabled: web },
      { type: 'separator' },
      { label: 'Email Page Link…', action: 'page.emailLink', enabled: web },
      { type: 'separator' },
      { label: 'Print…', action: 'page.printPreview', enabled: Boolean(active) }
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
          { label: 'Find…', action: 'find.open', enabled: Boolean(active) },
          { label: 'Find Next', action: 'find.next', enabled: Boolean(active) },
          { label: 'Find Previous', action: 'find.prev', enabled: Boolean(active) },
          { label: 'Use Selection for Find', action: 'find.useSelection', enabled: web }
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
      { label: 'Toggle Sidebar', action: 'sidebar.toggle', enabled: Boolean(win) },
      {
        label: 'Compact Mode',
        type: 'checkbox',
        action: 'compact.toggle',
        checked: Boolean(win?.compactEnabled),
        enabled: Boolean(win)
      },
      { type: 'separator' },
      { label: 'Stop', action: 'nav.stop', enabled: Boolean(active?.loading) },
      { label: 'Reload', action: 'nav.reload', enabled: Boolean(active) },
      { label: 'Reload (Override Cache)', action: 'nav.reloadSkipCache', enabled: Boolean(active) },
      { type: 'separator' },
      {
        label: fullScreen ? 'Exit Full Screen' : 'Enter Full Screen',
        action: 'page.fullscreen',
        enabled: Boolean(win)
      },
      { label: 'Actual Size', action: 'zoom.reset', enabled: Boolean(active) },
      { label: 'Zoom In', action: 'zoom.in', enabled: Boolean(active) },
      { label: 'Zoom Out', action: 'zoom.out', enabled: Boolean(active) },
      { type: 'separator' },
      {
        label:
          active && browser.reader.isReaderUrl(active.url) ? 'Exit Reader View' : 'Reader View',
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
          { label: 'View Source', action: 'page.viewSource', enabled: web },
          { label: 'Developer Tools', action: 'devtools.toggle', enabled: Boolean(active) },
          { label: 'Inspect Element', action: 'devtools.inspector', enabled: Boolean(active) },
          { label: 'JavaScript Console', action: 'devtools.console', enabled: Boolean(active) }
        ]
      }
    ]
  }

  const history: MenuItemTemplate = {
    label: 'History',
    submenu: [
      { label: 'Home', action: 'nav.home', enabled: Boolean(active) },
      { label: 'Back', action: 'nav.back', enabled: Boolean(active?.canGoBack) },
      { label: 'Forward', action: 'nav.forward', enabled: Boolean(active?.canGoForward) },
      { type: 'separator' },
      { label: 'Reopen Closed Tab', action: 'tab.reopenClosed' },
      recentlyClosed(browser),
      { type: 'separator' },
      { label: 'Show Full History', action: 'history.sidebar' }
    ]
  }

  const bookmarks: MenuItemTemplate = {
    label: 'Bookmarks',
    submenu: [
      { label: 'Bookmark Manager', action: 'bookmark.library' },
      {
        label: active?.bookmarked ? 'Edit Bookmark…' : 'Bookmark This Page…',
        action: 'bookmark.add',
        enabled: Boolean(active) && !active!.url.startsWith('zen://')
      },
      { label: 'Bookmark All Tabs…', action: 'bookmark.allTabs', enabled: Boolean(win) },
      { type: 'separator' },
      { label: 'Show Bookmarks', action: 'bookmark.sidebar' },
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
  const window: MenuItemTemplate = {
    label: 'Window',
    role: 'window',
    submenu: [
      { label: 'Minimize', action: 'window.minimize', enabled: Boolean(win) },
      { label: 'Zoom', role: 'zoom' },
      { type: 'separator' },
      { label: 'Select Next Tab', action: 'tab.next', enabled: Boolean(active) },
      { label: 'Select Previous Tab', action: 'tab.prev', enabled: Boolean(active) },
      { label: 'Search Tabs…', action: 'tab.search', enabled: Boolean(win) },
      { type: 'separator' },
      { label: 'Next Space', action: 'space.next', enabled: Boolean(win) && !local },
      { label: 'Previous Space', action: 'space.prev', enabled: Boolean(win) && !local },
      { label: 'New Space…', action: 'space.new', enabled: !local },
      { type: 'separator' },
      { label: 'Downloads', action: 'downloads.open' },
      ...(state.capabilities.extensions
        ? [{ label: 'Add-ons and Themes', action: 'addons.open' as const }]
        : []),
      { type: 'separator' },
      { label: 'Bring All to Front', role: 'front' }
    ]
  }

  const help: MenuItemTemplate = {
    label: 'Help',
    role: 'help',
    submenu: [
      { label: 'Zenium Help', click: () => browser.platform.shell.openExternal(HELP_URL) },
      { label: 'Keyboard Shortcuts', click: settings('shortcuts') },
      { type: 'separator' },
      { label: 'Report an Issue…', click: () => browser.platform.shell.openExternal(ISSUES_URL) }
    ]
  }

  return [zenium, file, edit, view, history, bookmarks, window, help]
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
