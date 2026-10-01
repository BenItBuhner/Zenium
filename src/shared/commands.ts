import { S } from './strings'
import type { CommandDescriptor, FormFactor, HostCapabilities } from './types'

/**
 * The layouts with a sidebar and a window of their own: what the sidebar toggles, Split View and
 * Fullscreen act on. The phone layout has none of these, so those commands would do nothing
 * there.
 */
const SIDEBAR_LAYOUTS: FormFactor[] = ['desktop', 'tablet']
/**
 * The desktop layout alone: Zen's compact mode hides the sidebar for a hover to reveal, which a
 * finger cannot; the tablet collapses its sidebar to the icon rail from the toolbar instead.
 */
const DESKTOP_LAYOUT: FormFactor[] = ['desktop']

/**
 * Zen's "Command Bar": actions that can be run by typing their name into the URL bar. A row's
 * label is the string table's menu face of its action (§9 item 10: one label per act on every
 * surface, the ellipsis where the act asks – Q5), so the palette says what the key table and
 * the menus say. The words a row's old name carried and its label no longer does ("toggle",
 * "switch", "width", "page", "open") stay as keywords: what the user typed yesterday finds the
 * row today.
 */
export const URLBAR_COMMANDS: CommandDescriptor[] = [
  {
    id: 'compact',
    label: S.menu('compact.toggle'),
    keywords: ['compact', 'mode', 'toggle', 'hide sidebar'],
    action: 'compact.toggle',
    layouts: DESKTOP_LAYOUT
  },
  {
    id: 'compact-sidebar',
    label: S.menu('compact.toggleSidebar'),
    keywords: ['sidebar', 'floating', 'toggle'],
    action: 'compact.toggleSidebar',
    layouts: DESKTOP_LAYOUT
  },
  {
    id: 'sidebar',
    label: S.menu('sidebar.toggle'),
    keywords: ['sidebar', 'width', 'collapse', 'expand', 'toggle'],
    action: 'sidebar.toggle',
    layouts: SIDEBAR_LAYOUTS
  },
  {
    id: 'new-space',
    label: S.menu('space.new'),
    keywords: ['space', 'workspace', 'new'],
    action: 'space.new'
  },
  {
    id: 'next-space',
    label: S.menu('space.next'),
    keywords: ['space', 'next', 'switch', 'workspace'],
    action: 'space.next'
  },
  {
    id: 'prev-space',
    label: S.menu('space.prev'),
    keywords: ['space', 'previous', 'switch', 'workspace'],
    action: 'space.prev'
  },
  {
    id: 'theme',
    label: S.menu('theme.open'),
    keywords: ['theme', 'gradient', 'color', 'colour', 'picker'],
    action: 'theme.open'
  },
  {
    id: 'split-grid',
    label: S.menu('split.grid'),
    keywords: ['split', 'grid'],
    action: 'split.grid',
    layouts: SIDEBAR_LAYOUTS
  },
  {
    id: 'split-vertical',
    label: S.menu('split.vertical'),
    keywords: ['split', 'vertical', 'side by side'],
    action: 'split.vertical',
    layouts: SIDEBAR_LAYOUTS
  },
  {
    id: 'split-horizontal',
    label: S.menu('split.horizontal'),
    keywords: ['split', 'horizontal', 'stack'],
    action: 'split.horizontal',
    layouts: SIDEBAR_LAYOUTS
  },
  {
    id: 'unsplit',
    label: S.menu('split.unsplit'),
    keywords: ['split', 'unsplit', 'remove'],
    action: 'split.unsplit',
    layouts: SIDEBAR_LAYOUTS
  },
  {
    id: 'new-split',
    label: S.menu('split.newEmpty'),
    keywords: ['split', 'empty', 'new'],
    action: 'split.newEmpty',
    layouts: SIDEBAR_LAYOUTS
  },
  {
    id: 'swap-split',
    label: S.menu('split.swap'),
    keywords: ['split', 'swap', 'reverse', 'panes', 'left', 'right'],
    action: 'split.swap',
    layouts: SIDEBAR_LAYOUTS
  },
  {
    id: 'pin',
    label: S.menu('tab.togglePin'),
    keywords: ['pin', 'unpin', 'tab'],
    action: 'tab.togglePin'
  },
  {
    id: 'reset-pinned',
    label: S.menu('tab.resetPinned'),
    keywords: ['pin', 'reset'],
    action: 'tab.resetPinned'
  },
  {
    id: 'duplicate',
    label: S.menu('tab.duplicate'),
    keywords: ['duplicate', 'tab', 'copy'],
    action: 'tab.duplicate'
  },
  {
    id: 'copy-url',
    label: S.menu('tab.copyUrl'),
    keywords: ['copy', 'url', 'link', 'current'],
    action: 'tab.copyUrl'
  },
  {
    id: 'copy-url-md',
    label: S.menu('tab.copyUrlMarkdown'),
    keywords: ['copy', 'url', 'link', 'markdown', 'current'],
    action: 'tab.copyUrlMarkdown'
  },
  {
    id: 'close-unpinned',
    label: S.menu('space.closeUnpinned'),
    keywords: ['close', 'clear', 'all', 'unpinned', 'tabs'],
    action: 'space.closeUnpinned'
  },
  {
    id: 'reopen',
    label: S.menu('tab.reopenClosed'),
    keywords: ['reopen', 'undo', 'closed'],
    action: 'tab.reopenClosed'
  },
  {
    id: 'reload',
    label: S.menu('nav.reload'),
    keywords: ['reload', 'refresh', 'page'],
    action: 'nav.reload'
  },
  {
    id: 'mute',
    label: S.menu('page.toggleMute'),
    keywords: ['mute', 'audio', 'sound'],
    action: 'page.toggleMute'
  },
  {
    id: 'mute-site',
    label: S.menu('page.toggleMuteSite'),
    keywords: ['mute', 'site', 'audio', 'sound', 'host'],
    action: 'page.toggleMuteSite'
  },
  {
    id: 'screenshot',
    label: S.menu('page.screenshot'),
    keywords: ['screenshot', 'capture'],
    action: 'page.screenshot'
  },
  {
    id: 'captureFullPage',
    label: S.menu('page.captureFullPage'),
    keywords: ['screenshot', 'capture', 'full page', 'long'],
    action: 'page.captureFullPage'
  },
  // Edge's Web capture: the overlay over the dimmed page (a region, the visible area or the
  // full page, then Copy or Save). "web capture" typed names this row, not the one above.
  {
    id: 'web-capture',
    label: S.menu('capture.start'),
    keywords: ['web capture', 'capture', 'screenshot', 'region', 'select', 'clip', 'snip'],
    action: 'capture.start',
    layouts: DESKTOP_LAYOUT
  },
  {
    id: 'fullscreen',
    label: S.menu('page.fullscreen'),
    keywords: ['fullscreen', 'full screen', 'toggle'],
    action: 'page.fullscreen',
    layouts: SIDEBAR_LAYOUTS
  },
  {
    id: 'zoom-in',
    label: S.menu('zoom.in'),
    keywords: ['zoom', 'in', 'bigger'],
    action: 'zoom.in'
  },
  {
    id: 'zoom-out',
    label: S.menu('zoom.out'),
    keywords: ['zoom', 'out', 'smaller'],
    action: 'zoom.out'
  },
  {
    id: 'zoom-reset',
    label: S.menu('zoom.reset'),
    keywords: ['zoom', 'reset'],
    action: 'zoom.reset'
  },
  {
    id: 'find',
    label: S.menu('find.open'),
    keywords: ['find', 'search page'],
    action: 'find.open'
  },
  {
    id: 'bookmark',
    label: S.menu('bookmark.add'),
    keywords: ['bookmark', 'save', 'star', 'page'],
    action: 'bookmark.add'
  },
  {
    id: 'bookmark-all-tabs',
    label: S.menu('bookmark.allTabs'),
    keywords: ['bookmark', 'all', 'tabs', 'folder'],
    action: 'bookmark.allTabs'
  },
  // `bookmarks.open` and `history.open` are the palette's own ids for the key table's
  // `bookmark.library` and `history.sidebar` (the same code runs): the rows read the act's entry.
  {
    id: 'bookmarks',
    label: S.menu('bookmark.library'),
    keywords: ['bookmarks', 'library', 'manager'],
    action: 'bookmarks.open'
  },
  {
    id: 'bookmarks-bar',
    label: S.menu('bookmark.toggleBar'),
    keywords: ['bookmarks', 'bar', 'toolbar', 'favorites'],
    action: 'bookmark.toggleBar'
  },
  // Chrome's reading list (bookmarks-33): "read later" and "save for later" name both rows. The
  // sidebar layouts' – the `zen://reading-list` page is theirs; the phone has no form of the
  // list yet, so neither row is offered there (as its menus leave the rows out).
  {
    id: 'reading-list-add',
    label: S.menu('readingList.add'),
    keywords: ['reading list', 'read later', 'save for later', 'unread'],
    action: 'readingList.add',
    layouts: SIDEBAR_LAYOUTS
  },
  {
    id: 'reading-list',
    label: S.menu('readingList.open'),
    keywords: ['reading list', 'read later', 'saved pages', 'unread'],
    action: 'readingList.open',
    layouts: SIDEBAR_LAYOUTS
  },
  {
    id: 'history',
    label: S.menu('history.sidebar'),
    keywords: ['history', 'recent'],
    action: 'history.open'
  },
  // Chrome's "Delete browsing data" action (its Ctrl+Shift+Delete dialog; omnibox-39): "clear
  // browsing data", "delete browsing data" and "clear history" all name this row.
  {
    id: 'clear-browsing-data',
    label: S.menu('privacy.clearBrowsingData'),
    keywords: ['delete', 'clear', 'browsing data', 'history', 'cookies', 'cache'],
    action: 'privacy.clearBrowsingData',
    layouts: SIDEBAR_LAYOUTS
  },
  // Chrome's "Manage search engines" action (omnibox-39): Settings › Search, the page the pill
  // menu's Manage Search Engines… row opens – on every host, since the section is a page tab or
  // a sheet wherever Settings is.
  {
    id: 'manage-search-engines',
    label: S.menu('search.manageEngines'),
    keywords: ['search engines', 'engines', 'manage', 'change', 'edit', 'default', 'keyword'],
    action: 'search.manageEngines'
  },
  {
    id: 'downloads',
    label: S.menu('downloads.open'),
    keywords: ['downloads', 'files'],
    action: 'downloads.open'
  },
  {
    id: 'settings',
    label: S.menu('settings.open'),
    keywords: ['settings', 'preferences', 'options', 'open'],
    action: 'settings.open'
  },
  {
    id: 'devtools',
    label: S.menu('devtools.toggle'),
    keywords: ['devtools', 'inspect', 'developer', 'toggle'],
    action: 'devtools.toggle',
    requires: 'devtools'
  },
  {
    // Chrome's More Tools › Task Manager (Shift+Esc): the `zen://tasks` page – in its own
    // window on a host with windows (W5-18) – desktop alone.
    id: 'task-manager',
    label: S.menu('tasks.open'),
    keywords: ['task manager', 'tasks', 'processes', 'memory', 'cpu', 'end process'],
    action: 'tasks.open',
    layouts: DESKTOP_LAYOUT
  },
  {
    id: 'print',
    label: S.menu('page.printPreview'),
    keywords: ['print', 'page'],
    action: 'page.printPreview',
    requires: 'print'
  },
  {
    // Zen 1.20.1: type "New Boost" to boost the current site.
    id: 'new-boost',
    label: S.menu('boost.new'),
    keywords: ['boost', 'tint', 'zap', 'dark mode', 'site style'],
    action: 'boost.new'
  },
  {
    id: 'reader',
    label: S.menu('page.readerMode'),
    keywords: ['reader', 'read', 'article', 'toggle'],
    action: 'page.readerMode'
  },
  {
    id: 'translate',
    label: S.menu('translate.open'),
    keywords: ['translate', 'translation', 'language'],
    action: 'translate.open'
  },
  {
    id: 'new-window',
    label: S.menu('window.new'),
    keywords: ['window', 'new'],
    action: 'window.new',
    requires: 'windows'
  },
  {
    id: 'new-blank-window',
    label: S.menu('window.newUnsynced'),
    keywords: ['window', 'blank', 'unsynced'],
    action: 'window.newUnsynced',
    requires: 'windows'
  },
  {
    id: 'move-tab-to-new-window',
    label: S.menu('tab.moveToNewWindow'),
    keywords: ['window', 'move', 'tab', 'tear', 'detach'],
    action: 'tab.moveToNewWindow',
    requires: 'windows'
  },
  {
    id: 'new-private-window',
    label: S.menu('window.newPrivate'),
    keywords: ['window', 'private', 'incognito'],
    action: 'window.newPrivate',
    requires: 'windows'
  },
  // Chrome's More tools › Name window…: the desktop's, whose title bar reads the name.
  {
    id: 'name-window',
    label: S.menu('window.name'),
    keywords: ['window', 'name', 'rename', 'title'],
    action: 'window.name',
    layouts: DESKTOP_LAYOUT
  },
  // Duplicate Window (session-19): a second window like this one, cascaded from it.
  {
    id: 'duplicate-window',
    label: S.menu('window.duplicate'),
    keywords: ['window', 'duplicate', 'clone', 'copy'],
    action: 'window.duplicate',
    requires: 'windows'
  },
  {
    id: 'addons',
    label: S.menu('addons.open'),
    keywords: ['addons', 'extensions', 'mods'],
    action: 'addons.open',
    requires: 'extensions'
  },
  {
    id: 'source',
    label: S.menu('page.viewSource'),
    keywords: ['source', 'html'],
    action: 'page.viewSource',
    requires: 'viewSource'
  },
  {
    id: 'freeze-others',
    label: S.menu('tab.freezeOthers'),
    keywords: ['freeze', 'sleep', 'suspend', 'tabs', 'background'],
    action: 'tab.freezeOthers',
    requires: 'resourceGovernor'
  },
  {
    id: 'wake-all',
    label: S.menu('tab.wakeAll'),
    keywords: ['wake', 'thaw', 'unfreeze', 'resume', 'tabs'],
    action: 'tab.wakeAll',
    requires: 'resourceGovernor'
  },
  {
    id: 'trim',
    label: S.menu('resources.trim'),
    keywords: ['memory', 'free', 'trim', 'unload', 'purge', 'ram', 'cpu'],
    action: 'resources.trim',
    requires: 'resourceGovernor'
  },
  {
    id: 'resources',
    label: S.menu('resources.open'),
    keywords: ['resources', 'memory', 'cpu', 'gpu', 'budget', 'limit', 'performance'],
    action: 'resources.open',
    requires: 'resourceGovernor'
  },
  {
    id: 'passwords',
    label: S.menu('passwords.open'),
    keywords: ['passwords', 'logins', 'credentials', 'vault', 'checkup', 'generator'],
    action: 'passwords.open',
    requires: 'passwords'
  }
]

/** Where a URL bar is: what its host can do and the layout its chrome is in. */
export interface CommandContext {
  capabilities: HostCapabilities
  formFactor: FormFactor
}

/** Whether the command would do anything on this host, in this layout. */
export function commandAvailable(cmd: CommandDescriptor, ctx: CommandContext): boolean {
  if (cmd.layouts && !cmd.layouts.includes(ctx.formFactor)) return false
  return cmd.requires === undefined || ctx.capabilities[cmd.requires] === true
}

/**
 * The commands matching what was typed, at most four. Given a context, only those that work
 * there: a phone is not offered Compact Mode or Split View, a host without windows no New Window.
 */
export function searchCommands(query: string, ctx?: CommandContext): CommandDescriptor[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const offered = ctx ? URLBAR_COMMANDS.filter((c) => commandAvailable(c, ctx)) : URLBAR_COMMANDS
  return offered
    .filter((c) => {
      const label = c.label.toLowerCase()
      if (label.includes(q)) return true
      const words = q.split(/\s+/)
      return words.every((w) => label.includes(w) || c.keywords.some((k) => k.includes(w)))
    })
    .slice(0, 4)
}
