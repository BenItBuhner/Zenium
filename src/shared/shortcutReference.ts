import type { Platform, ShortcutAction } from './types'
import { binding, type Mods, type ReferenceBinding } from './shortcuts'

/**
 * Chrome's and Edge's default keyboard shortcuts, the reference `collisions` checks Zenium's
 * presets against. Sources: Chrome's `accelerator_table.cc` and macOS main menu
 * (`chrome/app/chrome_main_menu.mm`), Chrome's keyboard shortcuts help pages for Windows, Linux
 * and macOS, and Edge's keyboard shortcuts page; Edge starts from Chrome's table and adds its own
 * chords (Ctrl+Shift+K duplicates the tab, Ctrl+M mutes it, F9 opens Immersive Reader, …).
 *
 * Text-editing chords (Ctrl+C, Ctrl+Z, …) are left out: pages and fields handle them, Zenium
 * never binds them.
 */

type Browsers = ReferenceBinding['browsers']
const BOTH: Browsers = ['chrome', 'edge']
const CHROME: Browsers = ['chrome']
const EDGE: Browsers = ['edge']

const ACCEL: Mods = { accel: true }
const ACCEL_SHIFT: Mods = { accel: true, shift: true }
const CTRL: Mods = { ctrl: true }
const CTRL_SHIFT: Mods = { ctrl: true, shift: true }
const ALT: Mods = { alt: true }
const ALT_SHIFT: Mods = { alt: true, shift: true }
const SHIFT: Mods = { shift: true }
const NONE: Mods = {}
const META: Mods = { meta: true }
const META_SHIFT: Mods = { meta: true, shift: true }
const META_ALT: Mods = { meta: true, alt: true }
const META_CTRL: Mods = { meta: true, ctrl: true }

export function chromeReference(platform: Platform): ReferenceBinding[] {
  const ref = (
    key: string,
    mods: Mods,
    label: string,
    actions: ShortcutAction[] = [],
    browsers: Browsers = BOTH
  ): ReferenceBinding => ({ binding: binding(key, mods, platform), label, actions, browsers })

  const everywhere: ReferenceBinding[] = [
    ref('t', ACCEL, 'New tab', ['tab.new']),
    ref('n', ACCEL, 'New window', ['window.new']),
    ref('n', ACCEL_SHIFT, 'New Incognito / InPrivate window', ['window.newPrivate']),
    ref('w', ACCEL, 'Close tab', ['tab.close']),
    ref('w', ACCEL_SHIFT, 'Close window', ['window.close']),
    ref('t', ACCEL_SHIFT, 'Reopen closed tab', ['tab.reopenClosed']),
    ref('Tab', CTRL, 'Next tab', ['tab.next']),
    ref('Tab', CTRL_SHIFT, 'Previous tab', ['tab.prev']),
    ref('PageDown', CTRL, 'Next tab', ['tab.next']),
    ref('PageUp', CTRL, 'Previous tab', ['tab.prev']),
    ...Array.from({ length: 8 }, (_, i) =>
      ref(String(i + 1), ACCEL, `Select tab ${i + 1}`, [`tab.select${i + 1}` as ShortcutAction])
    ),
    ref('9', ACCEL, 'Select last tab', ['tab.selectLast']),
    ref('PageDown', CTRL_SHIFT, 'Move tab right', ['tab.moveForward']),
    ref('PageUp', CTRL_SHIFT, 'Move tab left', ['tab.moveBackward']),
    ref('r', ACCEL, 'Reload', ['nav.reload']),
    ref('r', ACCEL_SHIFT, 'Reload ignoring cached content', ['nav.reloadSkipCache']),
    ref('Escape', NONE, 'Stop loading', ['nav.stop']),
    ref('l', ACCEL, 'Focus the address bar', ['urlbar.focus']),
    ref('f', ACCEL, 'Find in page', ['find.open']),
    ref('g', ACCEL, 'Find next', ['find.next']),
    ref('g', ACCEL_SHIFT, 'Find previous', ['find.prev']),
    ref('d', ACCEL, 'Bookmark this page', ['bookmark.add']),
    ref('d', ACCEL_SHIFT, 'Bookmark all open tabs', ['bookmark.allTabs']),
    ref('b', ACCEL_SHIFT, 'Show or hide the bookmarks bar', ['bookmark.toggleBar']),
    ref('p', ACCEL, 'Print', ['page.printPreview']),
    ref('s', ACCEL, 'Save page as', ['page.savePage']),
    ref('o', ACCEL, 'Open a file', ['page.openFile']),
    ref('Delete', ACCEL_SHIFT, 'Clear browsing data'),
    ref('m', ACCEL_SHIFT, 'Profile menu'),
    ref('a', ACCEL_SHIFT, 'Tab search (Chrome) / tab actions menu (Edge)', ['tab.search']),
    ref('=', ACCEL, 'Zoom in', ['zoom.in']),
    ref('+', ACCEL, 'Zoom in', ['zoom.in']),
    ref('+', ACCEL_SHIFT, 'Zoom in', ['zoom.in']),
    ref('-', ACCEL, 'Zoom out', ['zoom.out']),
    ref('0', ACCEL, 'Reset zoom', ['zoom.reset']),
    ref('v', ACCEL_SHIFT, 'Paste as plain text'),
    ref('c', ACCEL_SHIFT, 'Inspect element', ['devtools.inspector']),
    ref('F12', NONE, 'Developer tools', ['devtools.toggle']),
    ref('k', ACCEL_SHIFT, 'Duplicate tab', ['tab.duplicate'], EDGE),
    ref('l', ACCEL_SHIFT, 'Paste and search', [], EDGE),
    ref('u', ACCEL_SHIFT, 'Read aloud', [], EDGE),
    ref('y', ACCEL_SHIFT, 'Collections', [], EDGE),
    ref('s', ACCEL_SHIFT, 'Web capture', ['page.screenshot'], EDGE),
    ref(',', ACCEL_SHIFT, 'Toggle vertical tabs', [], EDGE)
  ]

  if (platform === 'darwin') {
    return [
      ...everywhere,
      ref('ArrowRight', META_ALT, 'Next tab', ['tab.next']),
      ref('ArrowLeft', META_ALT, 'Previous tab', ['tab.prev']),
      ref('[', META, 'Back', ['nav.back']),
      ref('ArrowLeft', META, 'Back', ['nav.back']),
      ref(']', META, 'Forward', ['nav.forward']),
      ref('ArrowRight', META, 'Forward', ['nav.forward']),
      ref('h', META_SHIFT, 'Open the home page', ['nav.home']),
      ref('f', META_ALT, 'Search the web', ['urlbar.search']),
      ref('e', META, 'Use selection for find', ['find.useSelection']),
      ref('j', META, 'Jump to selection'),
      ref('b', META_ALT, 'Bookmark manager', ['bookmark.library']),
      ref('y', META, 'History', ['history.sidebar']),
      ref('j', META_SHIFT, 'Downloads', ['downloads.open']),
      ref('p', META_ALT, 'Print using the system dialog', ['page.print']),
      ref('u', META_ALT, 'View page source', ['page.viewSource']),
      ref('i', META_ALT, 'Developer tools', ['devtools.toggle']),
      ref('j', META_ALT, 'JavaScript console', ['devtools.console']),
      ref('c', META_ALT, 'Inspect element', ['devtools.inspector']),
      ref('i', META_SHIFT, 'Email page location', ['page.emailLink']),
      ref('f', META_CTRL, 'Enter full screen', ['page.fullscreen']),
      ref('m', META, 'Minimise window', ['window.minimize'], CHROME),
      ref('m', META, 'Mute tab', ['page.toggleMute'], EDGE),
      ref('h', META, 'Hide the browser'),
      ref('h', META_ALT, 'Hide others'),
      ref('q', META, 'Quit', ['app.quit']),
      ref(',', META, 'Settings', ['settings.open'])
    ]
  }

  const desktop: ReferenceBinding[] = [
    ...everywhere,
    ref('F4', CTRL, 'Close tab', ['tab.close']),
    ref('F4', ALT, 'Close window', ['window.close']),
    ref('ArrowLeft', ALT, 'Back', ['nav.back']),
    ref('ArrowRight', ALT, 'Forward', ['nav.forward']),
    ref('Home', ALT, 'Open the home page', ['nav.home']),
    ref('F5', NONE, 'Reload', ['nav.reload']),
    ref('F5', CTRL, 'Reload ignoring cached content', ['nav.reloadSkipCache']),
    ref('F5', SHIFT, 'Reload ignoring cached content', ['nav.reloadSkipCache']),
    ref('d', ALT, 'Focus the address bar', ['urlbar.focus']),
    ref('F6', NONE, 'Focus the next pane', ['focus.nextPane']),
    ref('F6', SHIFT, 'Focus the previous pane', ['focus.prevPane']),
    ref('k', CTRL, 'Search from the address bar', ['urlbar.search']),
    ref('e', CTRL, 'Search from the address bar', ['urlbar.search']),
    ref('F3', NONE, 'Find next', ['find.next', 'find.open']),
    ref('F3', SHIFT, 'Find previous', ['find.prev']),
    ref('o', CTRL_SHIFT, 'Bookmark manager', ['bookmark.library']),
    ref('h', CTRL, 'History', ['history.sidebar']),
    ref('j', CTRL, 'Downloads', ['downloads.open']),
    ref('p', CTRL_SHIFT, 'Print using the system dialog', ['page.print']),
    ref('u', CTRL, 'View page source', ['page.viewSource']),
    ref('i', CTRL_SHIFT, 'Developer tools', ['devtools.toggle']),
    ref('j', CTRL_SHIFT, 'JavaScript console', ['devtools.console']),
    ref('F11', NONE, 'Full screen', ['page.fullscreen']),
    ref('Escape', SHIFT, 'Task manager'),
    ref('F1', NONE, 'Help'),
    ref('F7', NONE, 'Caret browsing'),
    ref('f', ALT, 'Open the browser menu', ['menu.app']),
    ref('e', ALT, 'Open the browser menu', ['menu.app']),
    ref('F10', NONE, 'Focus the browser menu', ['menu.app']),
    ref('t', ALT_SHIFT, 'Focus the toolbar', ['focus.toolbar']),
    ref('b', ALT_SHIFT, 'Focus the bookmarks bar', ['focus.bookmarksBar']),
    ref('i', ALT_SHIFT, 'Send feedback'),
    ref('m', CTRL, 'Mute tab', ['page.toggleMute'], EDGE),
    ref('F9', NONE, 'Immersive Reader', ['page.readerMode'], EDGE)
  ]
  if (platform === 'linux') desktop.push(ref('q', CTRL_SHIFT, 'Exit', ['app.quit'], CHROME))
  return desktop
}
