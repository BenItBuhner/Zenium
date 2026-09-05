import type { CommandDescriptor } from './types'

/**
 * Zen's "Command Bar": actions that can be run by typing their name into the URL bar.
 */
export const URLBAR_COMMANDS: CommandDescriptor[] = [
  {
    id: 'compact',
    label: 'Toggle Compact Mode',
    keywords: ['compact', 'mode', 'hide sidebar'],
    action: 'compact.toggle'
  },
  {
    id: 'compact-sidebar',
    label: 'Toggle Floating Sidebar',
    keywords: ['sidebar', 'floating'],
    action: 'compact.toggleSidebar'
  },
  {
    id: 'sidebar',
    label: 'Toggle Sidebar Width',
    keywords: ['sidebar', 'collapse', 'expand'],
    action: 'sidebar.toggle'
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
    action: 'split.grid'
  },
  {
    id: 'split-vertical',
    label: 'Split View: Vertical',
    keywords: ['split', 'vertical', 'side by side'],
    action: 'split.vertical'
  },
  {
    id: 'split-horizontal',
    label: 'Split View: Horizontal',
    keywords: ['split', 'horizontal', 'stack'],
    action: 'split.horizontal'
  },
  {
    id: 'unsplit',
    label: 'Unsplit View',
    keywords: ['split', 'unsplit', 'remove'],
    action: 'split.unsplit'
  },
  {
    id: 'new-split',
    label: 'New Empty Split View',
    keywords: ['split', 'empty', 'new'],
    action: 'split.newEmpty'
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
    id: 'screenshot',
    label: 'Take Screenshot',
    keywords: ['screenshot', 'capture'],
    action: 'page.screenshot'
  },
  {
    id: 'fullscreen',
    label: 'Toggle Fullscreen',
    keywords: ['fullscreen', 'full screen'],
    action: 'page.fullscreen'
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
    id: 'bookmarks',
    label: 'Show Bookmarks',
    keywords: ['bookmarks', 'library'],
    action: 'bookmarks.open'
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
    action: 'devtools.toggle'
  },
  { id: 'print', label: 'Print Page', keywords: ['print'], action: 'page.print' },
  {
    id: 'source',
    label: 'View Page Source',
    keywords: ['source', 'html'],
    action: 'page.viewSource'
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
