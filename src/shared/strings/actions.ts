import type { ActId } from './acts'
import type { Entry } from './index'

/**
 * The action tables' family (the D7 proposal §D, PR-2): one entry per act of the key table
 * (`shortcuts.ts`), the URL-bar palette (`commands.ts`) and the mac menu bar (`menuBar.ts`),
 * the four dialects they spoke resolved to one label each (§A's P-2, P-3, P-9, P-10, P-21 to
 * P-32, P-34, P-45 as the Lead ruled them). The key table's rows read `S.menu(action)` for the
 * Settings label and `S.title(action)` for Android's helper, so the 49 hand-written sentence
 * twins are the derived face; an explicit `sentence` stays only where the helper says something
 * the menu's words do not ("Jump to the next Space" for "Next Space").
 *
 * The mac menu bar's standard items take Apple's and Chrome's own words through `os.darwin`
 * (Q4): the three the ruling names – "Settings…", Window ▸ "Minimize", Edit ▸ Find ▸ "Find…" –
 * and the rest of the bar's Chrome words that differed from the house label, carried as they
 * were (Select Next Tab, Open Location…, Actual Size, Show Full History, Inspect Element,
 * Downloads). Zenium's own acts keep the house label in that bar; View says "Hard Reload".
 *
 * Acts whose pair a later PR rules keep today's words here, named at the entry: `addons.open`
 * (P-6, PR-2b), `translate.open` (P-33, PR-2b), `tab.freezeOthers` and `resources.trim` (P-18,
 * PR-5). `bookmarks.open` and `history.open`, the palette's alias ids for `bookmark.library` and
 * `history.sidebar`, have no entry: their rows read the act they alias.
 */
export const ACTIONS = {
  // --- Compact mode and the sidebar (P-23: the noun, no "Toggle") -------------------------------
  'compact.toggle': { menu: 'Compact Mode' },
  'compact.toggleSidebar': { menu: 'Floating Sidebar' },
  // P-23 names "Sidebar" for the key table and the mac bar and "Sidebar Width" for the palette's
  // row: one act, one label – the two sites' word.
  'sidebar.toggle': { menu: 'Sidebar' },

  // --- Spaces -----------------------------------------------------------------------------------
  'space.switch1': { menu: 'Switch to Space 1' },
  'space.switch2': { menu: 'Switch to Space 2' },
  'space.switch3': { menu: 'Switch to Space 3' },
  'space.switch4': { menu: 'Switch to Space 4' },
  'space.switch5': { menu: 'Switch to Space 5' },
  'space.switch6': { menu: 'Switch to Space 6' },
  'space.switch7': { menu: 'Switch to Space 7' },
  'space.switch8': { menu: 'Switch to Space 8' },
  'space.switch9': { menu: 'Switch to Space 9' },
  'space.switch10': { menu: 'Switch to Space 10' },
  'space.next': { menu: 'Next Space', sentence: 'Jump to the next Space' },
  'space.prev': { menu: 'Previous Space', sentence: 'Jump to the previous Space' },
  'space.closeUnpinned': { menu: 'Close Unpinned Tabs' },
  'space.new': { menu: 'Create New Space' },

  // --- Split view -------------------------------------------------------------------------------
  'split.grid': { menu: 'Split View Grid' },
  'split.vertical': { menu: 'Split View Vertical' },
  'split.horizontal': { menu: 'Split View Horizontal' },
  'split.unsplit': { menu: 'Unsplit View' },
  'split.newEmpty': { menu: 'New Empty Split View', sentence: 'Open a new empty split view' },
  'split.nextPane': { menu: 'Next Split Pane', sentence: 'Jump to the next split pane' },
  'split.prevPane': { menu: 'Previous Split Pane', sentence: 'Jump to the previous split pane' },
  'split.swap': { menu: 'Swap Split Panes' },

  // --- Zenium's own -----------------------------------------------------------------------------
  'tab.copyUrl': { menu: 'Copy Link' },
  'tab.copyUrlMarkdown': { menu: 'Copy Link as Markdown' },
  'tab.togglePin': {
    menu: 'Pin / Unpin Tab',
    sentence: 'Pin or unpin tab',
    state: { on: 'Unpin Tab', off: 'Pin Tab' }
  },
  'tab.resetPinned': { menu: 'Reset Pinned Tab' },
  'glance.expand': { menu: 'Expand Glance' },
  'window.newUnsynced': { menu: 'New Blank Window', sentence: 'Open a new blank window' },
  'boost.new': { menu: 'New Boost' },

  // --- Windows and tabs -------------------------------------------------------------------------
  'tab.new': { menu: 'New Tab' },
  'tab.close': { menu: 'Close Tab' },
  'tab.reopenClosed': { menu: 'Reopen Closed Tab' },
  'tab.duplicate': { menu: 'Duplicate Tab' },
  'tab.search': { menu: 'Search Tabs' },
  'window.new': { menu: 'New Window' },
  'window.newPrivate': { menu: 'New Private Window' },
  'window.close': { menu: 'Close Window' },
  'window.minimize': { menu: 'Minimise Window', os: { darwin: 'Minimize' } },
  'window.name': { menu: 'Name Window', ask: true },
  'window.duplicate': { menu: 'Duplicate Window' },
  'app.quit': { menu: 'Quit' },
  'menu.app': { menu: 'Open Application Menu' },
  'tab.next': { menu: 'Next Tab', os: { darwin: 'Select Next Tab' } },
  'tab.prev': { menu: 'Previous Tab', os: { darwin: 'Select Previous Tab' } },
  'tab.select1': { menu: 'Select Tab 1' },
  'tab.select2': { menu: 'Select Tab 2' },
  'tab.select3': { menu: 'Select Tab 3' },
  'tab.select4': { menu: 'Select Tab 4' },
  'tab.select5': { menu: 'Select Tab 5' },
  'tab.select6': { menu: 'Select Tab 6' },
  'tab.select7': { menu: 'Select Tab 7' },
  'tab.select8': { menu: 'Select Tab 8' },
  'tab.selectLast': { menu: 'Select Last Tab' },
  'tab.moveBackward': { menu: 'Move Tab Up' },
  'tab.moveForward': { menu: 'Move Tab Down' },
  'tab.moveToStart': { menu: 'Move Tab to Start' },
  'tab.moveToEnd': { menu: 'Move Tab to End' },
  'tab.moveToNewWindow': { menu: 'Move Tab to New Window' },
  // The strip's direction rows (P-34): Chrome's pair for a horizontal strip, the sidebar
  // layouts' for a vertical one.
  'tab.newAfter': {
    menu: 'New Tab to the Right',
    orientation: { horizontal: 'New Tab to the Right', vertical: 'New Tab Below' }
  },
  'tab.closeAfter': {
    menu: 'Close Tabs to the Right',
    orientation: { horizontal: 'Close Tabs to the Right', vertical: 'Close Tabs Below' }
  },
  'tab.closeBefore': {
    menu: 'Close Tabs to the Left',
    orientation: { horizontal: 'Close Tabs to the Left', vertical: 'Close Tabs Above' }
  },

  // --- Navigation -------------------------------------------------------------------------------
  'nav.back': { menu: 'Back' },
  'nav.forward': { menu: 'Forward' },
  'nav.reload': { menu: 'Reload' },
  'nav.reloadSkipCache': { menu: 'Hard Reload' },
  'nav.home': { menu: 'Home' },
  'nav.stop': { menu: 'Stop' },
  'focus.nextPane': { menu: 'Focus Next Pane' },
  'focus.prevPane': { menu: 'Focus Previous Pane' },
  'focus.toolbar': { menu: 'Focus Toolbar' },
  'focus.bookmarksBar': { menu: 'Focus Bookmarks Bar' },

  // --- Search and find --------------------------------------------------------------------------
  'urlbar.focus': {
    menu: 'Focus Address Bar',
    os: { darwin: { menu: 'Open Location', ask: true } }
  },
  'urlbar.search': { menu: 'Web Search' },
  'urlbar.pasteAndGo': { menu: 'Paste and Go' },
  'urlbar.pasteAndSearch': { menu: 'Paste and Search' },
  'find.open': { menu: 'Find in Page', ask: true, os: { darwin: 'Find' } },
  'find.next': { menu: 'Find Next' },
  'find.prev': { menu: 'Find Previous' },
  'find.useSelection': { menu: 'Use Selection for Find' },

  // --- The page ---------------------------------------------------------------------------------
  'page.savePage': { menu: 'Save Page As', ask: true },
  'page.openFile': { menu: 'Open File', ask: true },
  'page.printPreview': { menu: 'Print', ask: true },
  'page.print': { menu: 'Print Using System Dialog', ask: true },
  'page.viewSource': { menu: 'View Page Source' },
  'page.fullscreen': {
    menu: 'Full Screen',
    state: { on: 'Exit Full Screen', off: 'Enter Full Screen' }
  },
  'page.readerMode': {
    menu: 'Reader View',
    state: { on: 'Exit Reader View', off: 'Enter Reader View' }
  },
  'page.pip': { menu: 'Picture-in-Picture' },
  'page.caretBrowsing': { menu: 'Caret Browsing' },
  'page.screenshot': { menu: 'Take Screenshot' },
  'page.captureFullPage': { menu: 'Capture Full Page' },
  'capture.start': { menu: 'Screenshot', ask: true, sentence: 'Open the screenshot overlay' },
  'page.toggleMute': { menu: 'Mute / Unmute Tab', sentence: 'Mute or unmute tab' },
  'page.toggleMuteSite': {
    menu: 'Mute / Unmute Site',
    state: { on: 'Unmute Site', off: 'Mute Site' }
  },
  'page.emailLink': { menu: 'Email Page Link', ask: true },
  'settings.open': { menu: 'Settings', os: { darwin: { menu: 'Settings', ask: true } } },
  'theme.open': { menu: 'Change Theme', ask: true },
  'translate.open': { menu: 'Translate Page' },

  // --- Zoom -------------------------------------------------------------------------------------
  'zoom.in': { menu: 'Zoom In' },
  'zoom.out': { menu: 'Zoom Out' },
  'zoom.reset': { menu: 'Reset Zoom', os: { darwin: 'Actual Size' } },

  // --- History, bookmarks, downloads ------------------------------------------------------------
  'bookmark.add': {
    menu: 'Bookmark This Tab',
    ask: true,
    state: { on: 'Edit Bookmark', off: 'Bookmark This Tab' }
  },
  'bookmark.allTabs': { menu: 'Bookmark All Tabs', ask: true },
  'bookmark.sidebar': { menu: 'Show Bookmarks' },
  'bookmark.toggleBar': { menu: 'Show / Hide Bookmarks Bar' },
  'bookmark.library': { menu: 'Bookmark Manager' },
  'readingList.add': { menu: 'Add to Reading List' },
  'readingList.open': { menu: 'Show Reading List' },
  'history.sidebar': { menu: 'Show History', os: { darwin: 'Show Full History' } },
  'privacy.clearBrowsingData': { menu: 'Delete Browsing Data', ask: true },
  'downloads.open': { menu: 'Show Downloads', os: { darwin: 'Downloads' } },

  // --- Developer tools and the rest -------------------------------------------------------------
  'devtools.toggle': { menu: 'Developer Tools' },
  'devtools.inspector': { menu: 'Inspector', os: { darwin: 'Inspect Element' } },
  'devtools.console': { menu: 'JavaScript Console' },
  'devtools.browserConsole': { menu: 'Browser Console' },
  'tasks.open': { menu: 'Task Manager' },
  'addons.open': { menu: 'Add-ons and Themes' },
  'help.reportIssue': { menu: 'Report an Issue', ask: true },
  'tab.freezeOthers': { menu: 'Freeze Other Tabs' },
  'tab.wakeAll': { menu: 'Wake All Tabs' },
  'resources.trim': { menu: 'Free Up Memory Now' },
  'resources.open': { menu: 'Resource Budgets' },
  'passwords.open': { menu: 'Password Manager' },
  'search.manageEngines': { menu: 'Manage Search Engines' }
} satisfies Partial<Record<ActId, Entry>>
