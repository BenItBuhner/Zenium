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
 * Zen's "Command Bar": actions that can be run by typing their name into the URL bar.
 */
export const URLBAR_COMMANDS: CommandDescriptor[] = [
  {
    id: 'compact',
    label: 'Toggle Compact Mode',
    keywords: ['compact', 'mode', 'hide sidebar'],
    action: 'compact.toggle',
    layouts: DESKTOP_LAYOUT
  },
  {
    id: 'compact-sidebar',
    label: 'Toggle Floating Sidebar',
    keywords: ['sidebar', 'floating'],
    action: 'compact.toggleSidebar',
    layouts: DESKTOP_LAYOUT
  },
  {
    id: 'sidebar',
    label: 'Toggle Sidebar Width',
    keywords: ['sidebar', 'collapse', 'expand'],
    action: 'sidebar.toggle',
    layouts: SIDEBAR_LAYOUTS
  },
  {
    id: 'new-space',
    label: 'Create New Space',
    keywords: ['space', 'workspace', 'new'],
    action: 'space.new'
  },
  {
    id: 'next-space',
    label: 'Switch to Next Space',
    keywords: ['space', 'next', 'workspace'],
    action: 'space.next'
  },
  {
    id: 'prev-space',
    label: 'Switch to Previous Space',
    keywords: ['space', 'previous', 'workspace'],
    action: 'space.prev'
  },
  {
    id: 'theme',
    label: 'Change Theme',
    keywords: ['theme', 'gradient', 'color', 'colour', 'picker'],
    action: 'theme.open'
  },
  {
    id: 'split-grid',
    label: 'Split View: Grid',
    keywords: ['split', 'grid'],
    action: 'split.grid',
    layouts: SIDEBAR_LAYOUTS
  },
  {
    id: 'split-vertical',
    label: 'Split View: Vertical',
    keywords: ['split', 'vertical', 'side by side'],
    action: 'split.vertical',
    layouts: SIDEBAR_LAYOUTS
  },
  {
    id: 'split-horizontal',
    label: 'Split View: Horizontal',
    keywords: ['split', 'horizontal', 'stack'],
    action: 'split.horizontal',
    layouts: SIDEBAR_LAYOUTS
  },
  {
    id: 'unsplit',
    label: 'Unsplit View',
    keywords: ['split', 'unsplit', 'remove'],
    action: 'split.unsplit',
    layouts: SIDEBAR_LAYOUTS
  },
  {
    id: 'new-split',
    label: 'New Empty Split View',
    keywords: ['split', 'empty', 'new'],
    action: 'split.newEmpty',
    layouts: SIDEBAR_LAYOUTS
  },
  {
    id: 'pin',
    label: 'Pin / Unpin Tab',
    keywords: ['pin', 'unpin', 'tab'],
    action: 'tab.togglePin'
  },
  {
    id: 'reset-pinned',
    label: 'Reset Pinned Tab',
    keywords: ['pin', 'reset'],
    action: 'tab.resetPinned'
  },
  {
    id: 'duplicate',
    label: 'Duplicate Tab',
    keywords: ['duplicate', 'tab', 'copy'],
    action: 'tab.duplicate'
  },
  {
    id: 'copy-url',
    label: 'Copy Current URL',
    keywords: ['copy', 'url', 'link'],
    action: 'tab.copyUrl'
  },
  {
    id: 'copy-url-md',
    label: 'Copy Current URL as Markdown',
    keywords: ['copy', 'url', 'markdown'],
    action: 'tab.copyUrlMarkdown'
  },
  {
    id: 'close-unpinned',
    label: 'Close All Unpinned Tabs',
    keywords: ['close', 'clear', 'unpinned', 'tabs'],
    action: 'space.closeUnpinned'
  },
  {
    id: 'reopen',
    label: 'Reopen Closed Tab',
    keywords: ['reopen', 'undo', 'closed'],
    action: 'tab.reopenClosed'
  },
  { id: 'reload', label: 'Reload Page', keywords: ['reload', 'refresh'], action: 'nav.reload' },
  {
    id: 'mute',
    label: 'Mute / Unmute Tab',
    keywords: ['mute', 'audio', 'sound'],
    action: 'page.toggleMute'
  },
  {
    id: 'mute-site',
    label: 'Mute / Unmute Site',
    keywords: ['mute', 'site', 'audio', 'sound', 'host'],
    action: 'page.toggleMuteSite'
  },
  {
    id: 'screenshot',
    label: 'Take Screenshot',
    keywords: ['screenshot', 'capture'],
    action: 'page.screenshot'
  },
  {
    id: 'captureFullPage',
    label: 'Capture Full Page',
    keywords: ['screenshot', 'capture', 'full page', 'web capture', 'long'],
    action: 'page.captureFullPage'
  },
  {
    id: 'fullscreen',
    label: 'Toggle Fullscreen',
    keywords: ['fullscreen', 'full screen'],
    action: 'page.fullscreen',
    layouts: SIDEBAR_LAYOUTS
  },
  { id: 'zoom-in', label: 'Zoom In', keywords: ['zoom', 'in', 'bigger'], action: 'zoom.in' },
  { id: 'zoom-out', label: 'Zoom Out', keywords: ['zoom', 'out', 'smaller'], action: 'zoom.out' },
  { id: 'zoom-reset', label: 'Reset Zoom', keywords: ['zoom', 'reset'], action: 'zoom.reset' },
  { id: 'find', label: 'Find in Page', keywords: ['find', 'search page'], action: 'find.open' },
  {
    id: 'bookmark',
    label: 'Bookmark This Page',
    keywords: ['bookmark', 'save', 'star'],
    action: 'bookmark.add'
  },
  {
    id: 'bookmark-all-tabs',
    label: 'Bookmark All Tabs',
    keywords: ['bookmark', 'all', 'tabs', 'folder'],
    action: 'bookmark.allTabs'
  },
  {
    id: 'bookmarks',
    label: 'Bookmark Manager',
    keywords: ['bookmarks', 'library', 'manager'],
    action: 'bookmarks.open'
  },
  {
    id: 'bookmarks-bar',
    label: 'Show / Hide Bookmarks Bar',
    keywords: ['bookmarks', 'bar', 'toolbar', 'favorites'],
    action: 'bookmark.toggleBar'
  },
  { id: 'history', label: 'Show History', keywords: ['history', 'recent'], action: 'history.open' },
  {
    id: 'downloads',
    label: 'Show Downloads',
    keywords: ['downloads', 'files'],
    action: 'downloads.open'
  },
  {
    id: 'settings',
    label: 'Open Settings',
    keywords: ['settings', 'preferences', 'options'],
    action: 'settings.open'
  },
  {
    id: 'devtools',
    label: 'Toggle Developer Tools',
    keywords: ['devtools', 'inspect', 'developer'],
    action: 'devtools.toggle',
    requires: 'devtools'
  },
  {
    id: 'print',
    label: 'Print Page',
    keywords: ['print'],
    action: 'page.printPreview',
    requires: 'print'
  },
  {
    // Zen 1.20.1: type "New Boost" to boost the current site.
    id: 'new-boost',
    label: 'New Boost',
    keywords: ['boost', 'tint', 'zap', 'dark mode', 'site style'],
    action: 'boost.new'
  },
  {
    id: 'reader',
    label: 'Toggle Reader View',
    keywords: ['reader', 'read', 'article'],
    action: 'page.readerMode'
  },
  {
    id: 'translate',
    label: 'Translate Page',
    keywords: ['translate', 'translation', 'language'],
    action: 'translate.open'
  },
  {
    id: 'new-window',
    label: 'New Window',
    keywords: ['window', 'new'],
    action: 'window.new',
    requires: 'windows'
  },
  {
    id: 'new-blank-window',
    label: 'New Blank Window',
    keywords: ['window', 'blank', 'unsynced'],
    action: 'window.newUnsynced',
    requires: 'windows'
  },
  {
    id: 'move-tab-to-new-window',
    label: 'Move Tab to New Window',
    keywords: ['window', 'move', 'tab', 'tear', 'detach'],
    action: 'tab.moveToNewWindow',
    requires: 'windows'
  },
  {
    id: 'new-private-window',
    label: 'New Private Window',
    keywords: ['window', 'private', 'incognito'],
    action: 'window.newPrivate',
    requires: 'windows'
  },
  {
    id: 'addons',
    label: 'Add-ons and Themes',
    keywords: ['addons', 'extensions', 'mods'],
    action: 'addons.open',
    requires: 'extensions'
  },
  {
    id: 'source',
    label: 'View Page Source',
    keywords: ['source', 'html'],
    action: 'page.viewSource',
    requires: 'viewSource'
  },
  {
    id: 'freeze-others',
    label: 'Freeze Other Tabs',
    keywords: ['freeze', 'sleep', 'suspend', 'tabs', 'background'],
    action: 'tab.freezeOthers',
    requires: 'resourceGovernor'
  },
  {
    id: 'wake-all',
    label: 'Wake All Tabs',
    keywords: ['wake', 'thaw', 'unfreeze', 'resume', 'tabs'],
    action: 'tab.wakeAll',
    requires: 'resourceGovernor'
  },
  {
    id: 'trim',
    label: 'Free Up Memory Now',
    keywords: ['memory', 'free', 'trim', 'unload', 'purge', 'ram', 'cpu'],
    action: 'resources.trim',
    requires: 'resourceGovernor'
  },
  {
    id: 'resources',
    label: 'Resource Budgets',
    keywords: ['resources', 'memory', 'cpu', 'gpu', 'budget', 'limit', 'performance'],
    action: 'resources.open',
    requires: 'resourceGovernor'
  },
  {
    id: 'passwords',
    label: 'Password Manager',
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
  return cmd.requires === undefined || ctx.capabilities[cmd.requires]
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
