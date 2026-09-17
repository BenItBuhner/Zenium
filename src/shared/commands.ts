import type { CommandDescriptor } from './types'

/**
 * Zen's "Command Bar": actions that can be run by typing their name into the URL bar.
 */
export const URLBAR_COMMANDS: CommandDescriptor[] = [
  {
    id: 'compact',
    label: 'Toggle compact mode',
    keywords: ['compact', 'mode', 'hide sidebar'],
    action: 'compact.toggle'
  },
  {
    id: 'compact-sidebar',
    label: 'Toggle floating sidebar',
    keywords: ['sidebar', 'floating'],
    action: 'compact.toggleSidebar'
  },
  {
    id: 'sidebar',
    label: 'Toggle sidebar width',
    keywords: ['sidebar', 'collapse', 'expand'],
    action: 'sidebar.toggle'
  },
  {
    id: 'new-space',
    label: 'Create new Space',
    keywords: ['space', 'workspace', 'new'],
    action: 'space.new'
  },
  {
    id: 'next-space',
    label: 'Switch to next Space',
    keywords: ['space', 'next', 'workspace'],
    action: 'space.next'
  },
  {
    id: 'prev-space',
    label: 'Switch to previous Space',
    keywords: ['space', 'previous', 'workspace'],
    action: 'space.prev'
  },
  {
    id: 'theme',
    label: 'Change theme',
    keywords: ['theme', 'gradient', 'color', 'colour', 'picker'],
    action: 'theme.open'
  },
  {
    id: 'split-grid',
    label: 'Split view: grid',
    keywords: ['split', 'grid'],
    action: 'split.grid'
  },
  {
    id: 'split-vertical',
    label: 'Split view: vertical',
    keywords: ['split', 'vertical', 'side by side'],
    action: 'split.vertical'
  },
  {
    id: 'split-horizontal',
    label: 'Split view: horizontal',
    keywords: ['split', 'horizontal', 'stack'],
    action: 'split.horizontal'
  },
  {
    id: 'unsplit',
    label: 'Unsplit view',
    keywords: ['split', 'unsplit', 'remove'],
    action: 'split.unsplit'
  },
  {
    id: 'new-split',
    label: 'New empty split view',
    keywords: ['split', 'empty', 'new'],
    action: 'split.newEmpty'
  },
  {
    id: 'pin',
    label: 'Pin / unpin tab',
    keywords: ['pin', 'unpin', 'tab'],
    action: 'tab.togglePin'
  },
  {
    id: 'reset-pinned',
    label: 'Reset pinned tab',
    keywords: ['pin', 'reset'],
    action: 'tab.resetPinned'
  },
  {
    id: 'duplicate',
    label: 'Duplicate tab',
    keywords: ['duplicate', 'tab', 'copy'],
    action: 'tab.duplicate'
  },
  {
    id: 'copy-url',
    label: 'Copy current URL',
    keywords: ['copy', 'url', 'link'],
    action: 'tab.copyUrl'
  },
  {
    id: 'copy-url-md',
    label: 'Copy current URL as Markdown',
    keywords: ['copy', 'url', 'markdown'],
    action: 'tab.copyUrlMarkdown'
  },
  {
    id: 'close-unpinned',
    label: 'Close all unpinned tabs',
    keywords: ['close', 'clear', 'unpinned', 'tabs'],
    action: 'space.closeUnpinned'
  },
  {
    id: 'reopen',
    label: 'Reopen closed tab',
    keywords: ['reopen', 'undo', 'closed'],
    action: 'tab.reopenClosed'
  },
  { id: 'reload', label: 'Reload page', keywords: ['reload', 'refresh'], action: 'nav.reload' },
  {
    id: 'mute',
    label: 'Mute / unmute tab',
    keywords: ['mute', 'audio', 'sound'],
    action: 'page.toggleMute'
  },
  {
    id: 'screenshot',
    label: 'Take screenshot',
    keywords: ['screenshot', 'capture'],
    action: 'page.screenshot'
  },
  {
    id: 'fullscreen',
    label: 'Toggle fullscreen',
    keywords: ['fullscreen', 'full screen'],
    action: 'page.fullscreen'
  },
  { id: 'zoom-in', label: 'Zoom in', keywords: ['zoom', 'in', 'bigger'], action: 'zoom.in' },
  { id: 'zoom-out', label: 'Zoom out', keywords: ['zoom', 'out', 'smaller'], action: 'zoom.out' },
  { id: 'zoom-reset', label: 'Reset zoom', keywords: ['zoom', 'reset'], action: 'zoom.reset' },
  { id: 'find', label: 'Find in page', keywords: ['find', 'search page'], action: 'find.open' },
  {
    id: 'bookmark',
    label: 'Bookmark this page',
    keywords: ['bookmark', 'save', 'star'],
    action: 'bookmark.add'
  },
  {
    id: 'bookmarks',
    label: 'Show Bookmarks',
    keywords: ['bookmarks', 'library'],
    action: 'bookmarks.open'
  },
  { id: 'history', label: 'Show history', keywords: ['history', 'recent'], action: 'history.open' },
  {
    id: 'downloads',
    label: 'Show downloads',
    keywords: ['downloads', 'files'],
    action: 'downloads.open'
  },
  {
    id: 'settings',
    label: 'Open settings',
    keywords: ['settings', 'preferences', 'options'],
    action: 'settings.open'
  },
  {
    id: 'devtools',
    label: 'Toggle developer tools',
    keywords: ['devtools', 'inspect', 'developer'],
    action: 'devtools.toggle'
  },
  { id: 'print', label: 'Print page', keywords: ['print'], action: 'page.print' },
  {
    // Zen 1.20.1: type "New Boost" to boost the current site.
    id: 'new-boost',
    label: 'New Boost',
    keywords: ['boost', 'tint', 'zap', 'dark mode', 'site style'],
    action: 'boost.new'
  },
  {
    id: 'reader',
    label: 'Toggle reader view',
    keywords: ['reader', 'read', 'article'],
    action: 'page.readerMode'
  },
  {
    id: 'new-window',
    label: 'New window',
    keywords: ['window', 'new'],
    action: 'window.new'
  },
  {
    id: 'new-blank-window',
    label: 'New blank window',
    keywords: ['window', 'blank', 'unsynced'],
    action: 'window.newUnsynced'
  },
  {
    id: 'new-private-window',
    label: 'New private window',
    keywords: ['window', 'private', 'incognito'],
    action: 'window.newPrivate'
  },
  {
    id: 'addons',
    label: 'Add-ons and themes',
    keywords: ['addons', 'extensions', 'mods'],
    action: 'addons.open'
  },
  {
    id: 'source',
    label: 'View page source',
    keywords: ['source', 'html'],
    action: 'page.viewSource'
  },
  {
    id: 'freeze-others',
    label: 'Freeze other tabs',
    keywords: ['freeze', 'sleep', 'suspend', 'tabs', 'background'],
    action: 'tab.freezeOthers'
  },
  {
    id: 'wake-all',
    label: 'Wake all tabs',
    keywords: ['wake', 'thaw', 'unfreeze', 'resume', 'tabs'],
    action: 'tab.wakeAll'
  },
  {
    id: 'trim',
    label: 'Free up memory now',
    keywords: ['memory', 'free', 'trim', 'unload', 'purge', 'ram', 'cpu'],
    action: 'resources.trim'
  },
  {
    id: 'resources',
    label: 'Resource budgets',
    keywords: ['resources', 'memory', 'cpu', 'gpu', 'budget', 'limit', 'performance'],
    action: 'resources.open'
  }
]

export function searchCommands(query: string): CommandDescriptor[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return URLBAR_COMMANDS.filter((c) => {
    const label = c.label.toLowerCase()
    if (label.includes(q)) return true
    const words = q.split(/\s+/)
    return words.every((w) => label.includes(w) || c.keywords.some((k) => k.includes(w)))
  }).slice(0, 4)
}
