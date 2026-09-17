import type { KeyBinding, Platform, Shortcut, ShortcutAction, ShortcutGroup } from './types'

/**
 * Zen Browser's default keyboard shortcuts.
 *
 * Bindings are taken from `src/zen/kbs/ZenKeyboardShortcuts.mjs` (default set + migrations up to
 * version 17) plus Firefox's standard keyset, with Zen's corrections applied (e.g. "Save page" moved
 * to Accel+Alt+Shift+S so that Accel+S can toggle compact mode).
 *
 * `accel` is Ctrl on Linux/Windows and Cmd (meta) on macOS.
 */

interface Mods {
  accel?: boolean
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
}

export function binding(key: string, mods: Mods, platform: Platform): KeyBinding {
  const accelIsMeta = platform === 'darwin'
  return {
    ctrl: Boolean(mods.ctrl) || (Boolean(mods.accel) && !accelIsMeta),
    meta: Boolean(mods.meta) || (Boolean(mods.accel) && accelIsMeta),
    alt: Boolean(mods.alt),
    shift: Boolean(mods.shift),
    key: normaliseKey(key)
  }
}

/** Normalise a KeyboardEvent.key so bindings compare reliably. */
export function normaliseKey(key: string): string {
  if (key.length === 1) return key.toLowerCase()
  const aliases: Record<string, string> = {
    Esc: 'Escape',
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
    Up: 'ArrowUp',
    Down: 'ArrowDown',
    Del: 'Delete',
    Spacebar: ' '
  }
  return aliases[key] ?? key
}

export function bindingsEqual(a: KeyBinding | null, b: KeyBinding | null): boolean {
  if (!a || !b) return a === b
  return (
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift &&
    a.meta === b.meta &&
    a.key === b.key
  )
}

export interface KeyInput {
  key: string
  control: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

/** Build a binding from a raw key input (Electron `before-input-event` or a DOM KeyboardEvent). */
export function bindingFromInput(input: KeyInput): KeyBinding {
  return {
    ctrl: input.control,
    alt: input.alt,
    shift: input.shift,
    meta: input.meta,
    key: normaliseKey(input.key)
  }
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS'])

export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key)
}

/** Find the shortcut matching an input, if any. */
export function matchShortcut(shortcuts: Shortcut[], input: KeyInput): Shortcut | null {
  if (isModifierKey(input.key)) return null
  const pressed = bindingFromInput(input)
  for (const shortcut of shortcuts) {
    if (shortcut.binding && bindingsEqual(shortcut.binding, pressed)) return shortcut
    for (const extra of shortcut.extraBindings) {
      if (bindingsEqual(extra, pressed)) return shortcut
    }
  }
  return null
}

const KEY_LABELS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Escape: 'Esc',
  ' ': 'Space',
  Backspace: '⌫',
  Delete: 'Del',
  Tab: 'Tab',
  Enter: 'Enter',
  Home: 'Home',
  End: 'End'
}

/** Human readable label, e.g. `Ctrl + Alt + S` or `⌘ + ⌥ + S` on macOS. */
export function formatBinding(b: KeyBinding | null, platform: Platform): string {
  if (!b) return 'Not set'
  const mac = platform === 'darwin'
  const parts: string[] = []
  if (b.ctrl) parts.push(mac ? '⌃' : 'Ctrl')
  if (b.alt) parts.push(mac ? '⌥' : 'Alt')
  if (b.shift) parts.push(mac ? '⇧' : 'Shift')
  if (b.meta) parts.push(mac ? '⌘' : 'Meta')
  const key = KEY_LABELS[b.key] ?? (b.key.length === 1 ? b.key.toUpperCase() : b.key)
  parts.push(key)
  return parts.join(mac ? '' : ' + ')
}

export const SHORTCUT_GROUP_LABELS: Record<ShortcutGroup, string> = {
  'zen-compact-mode': 'Compact mode',
  'zen-workspace': 'Spaces',
  'zen-split-view': 'Split view',
  'zen-other': 'Zenium features',
  windowAndTabManagement: 'Window and tab management',
  navigation: 'Navigation',
  searchAndFind: 'Search and find',
  pageOperations: 'Page operations',
  historyAndBookmarks: 'History and bookmarks',
  mediaAndDisplay: 'Media and display',
  devTools: 'Developer tools'
}

interface Def {
  id: string
  action: ShortcutAction
  group: ShortcutGroup
  label: string
  key?: string
  mods?: Mods
  extra?: Array<{ key: string; mods: Mods }>
  unsupported?: boolean
  /** Only bind on these platforms (others are left unbound, like Zen does for space switching). */
  platforms?: Platform[]
  /** Platform specific overrides for the primary binding. */
  perPlatform?: Partial<Record<Platform, { key: string; mods: Mods }>>
}

const DEFS: Def[] = [
  // --- Compact mode ---------------------------------------------------------
  {
    id: 'zen-compact-mode-toggle',
    action: 'compact.toggle',
    group: 'zen-compact-mode',
    label: 'Toggle compact mode',
    key: 's',
    mods: { accel: true }
  },
  {
    id: 'zen-compact-mode-show-sidebar',
    action: 'compact.toggleSidebar',
    group: 'zen-compact-mode',
    label: 'Toggle floating sidebar',
    key: 's',
    mods: { accel: true, alt: true }
  },

  // --- Spaces ---------------------------------------------------------------
  ...Array.from({ length: 10 }, (_, i) => i + 1).map((n): Def => ({
    id: `zen-workspace-switch-${n}`,
    action: `space.switch${n}` as ShortcutAction,
    group: 'zen-workspace',
    label: `Switch to space ${n}`,
    key: n === 10 ? '0' : String(n),
    mods: { ctrl: true },
    platforms: ['darwin']
  })),
  {
    id: 'zen-workspace-forward',
    action: 'space.next',
    group: 'zen-workspace',
    label: 'Next space',
    key: 'ArrowRight',
    mods: { accel: true, alt: true }
  },
  {
    id: 'zen-workspace-backward',
    action: 'space.prev',
    group: 'zen-workspace',
    label: 'Previous space',
    key: 'ArrowLeft',
    mods: { accel: true, alt: true }
  },
  {
    id: 'zen-close-all-unpinned-tabs',
    action: 'space.closeUnpinned',
    group: 'zen-workspace',
    label: 'Close all unpinned tabs',
    key: 'k',
    mods: { accel: true, shift: true }
  },
  {
    // Added in Zen's shortcut schema v18; unbound by default like upstream.
    id: 'zen-workspace-create',
    action: 'space.new',
    group: 'zen-workspace',
    label: 'Create new space'
  },

  // --- Split view ------------------------------------------------------------
  {
    id: 'zen-split-view-grid',
    action: 'split.grid',
    group: 'zen-split-view',
    label: 'Toggle split view grid',
    key: 'g',
    mods: { accel: true, alt: true }
  },
  {
    id: 'zen-split-view-vertical',
    action: 'split.vertical',
    group: 'zen-split-view',
    label: 'Toggle split view vertical',
    key: 'v',
    mods: { accel: true, alt: true }
  },
  {
    id: 'zen-split-view-horizontal',
    action: 'split.horizontal',
    group: 'zen-split-view',
    label: 'Toggle split view horizontal',
    key: 'h',
    mods: { accel: true, alt: true }
  },
  {
    id: 'zen-split-view-unsplit',
    action: 'split.unsplit',
    group: 'zen-split-view',
    label: 'Unsplit view',
    key: 'u',
    mods: { accel: true, alt: true }
  },
  {
    id: 'zen-new-empty-split-view',
    action: 'split.newEmpty',
    group: 'zen-split-view',
    label: 'New empty split view',
    key: '*',
    mods: { accel: true, shift: true }
  },

  // --- Zen: other ------------------------------------------------------------
  {
    id: 'zen-copy-url',
    action: 'tab.copyUrl',
    group: 'zen-other',
    label: 'Copy current URL',
    key: 'c',
    mods: { accel: true, shift: true }
  },
  {
    id: 'zen-copy-url-markdown',
    action: 'tab.copyUrlMarkdown',
    group: 'zen-other',
    label: 'Copy current URL as Markdown',
    key: 'c',
    mods: { accel: true, shift: true, alt: true }
  },
  {
    id: 'zen-toggle-pin-tab',
    action: 'tab.togglePin',
    group: 'zen-other',
    label: 'Pin / unpin tab',
    key: 'd',
    mods: { accel: true, shift: true }
  },
  {
    id: 'zen-pinned-tab-reset-shortcut',
    action: 'tab.resetPinned',
    group: 'zen-other',
    label: 'Reset pinned tab'
  },
  {
    id: 'zen-toggle-sidebar',
    action: 'sidebar.toggle',
    group: 'zen-other',
    label: 'Toggle sidebar'
  },
  {
    id: 'zen-glance-expand',
    action: 'glance.expand',
    group: 'zen-other',
    label: 'Expand Glance',
    key: 'o',
    mods: { accel: true }
  },
  {
    id: 'zen-new-unsynced-window',
    action: 'window.newUnsynced',
    group: 'zen-other',
    label: 'New blank window',
    key: 'n',
    mods: { accel: true, shift: true }
  },

  // --- Window & tab management -----------------------------------------------
  {
    id: 'key_newNavigatorTab',
    action: 'tab.new',
    group: 'windowAndTabManagement',
    label: 'New tab',
    key: 't',
    mods: { accel: true }
  },
  {
    id: 'key_close',
    action: 'tab.close',
    group: 'windowAndTabManagement',
    label: 'Close tab',
    key: 'w',
    mods: { accel: true },
    extra: [{ key: 'F4', mods: { accel: true } }]
  },
  {
    id: 'key_undoCloseTab',
    action: 'tab.reopenClosed',
    group: 'windowAndTabManagement',
    label: 'Reopen closed tab',
    key: 't',
    mods: { accel: true, shift: true }
  },
  {
    id: 'zen-duplicate-tab',
    action: 'tab.duplicate',
    group: 'windowAndTabManagement',
    label: 'Duplicate tab'
  },
  {
    id: 'key_newNavigator',
    action: 'window.new',
    group: 'windowAndTabManagement',
    label: 'New window',
    key: 'n',
    mods: { accel: true }
  },
  {
    id: 'key_privatebrowsing',
    action: 'window.newPrivate',
    group: 'windowAndTabManagement',
    label: 'New private window',
    key: 'p',
    mods: { accel: true, shift: true }
  },
  {
    id: 'key_closeWindow',
    action: 'window.close',
    group: 'windowAndTabManagement',
    label: 'Close window',
    key: 'w',
    mods: { accel: true, shift: true }
  },
  {
    id: 'key_quitApplication',
    action: 'app.quit',
    group: 'windowAndTabManagement',
    label: 'Quit',
    key: 'q',
    mods: { accel: true }
  },
  {
    id: 'key_nextTab',
    action: 'tab.next',
    group: 'windowAndTabManagement',
    label: 'Next tab',
    key: 'Tab',
    mods: { ctrl: true },
    extra: [{ key: 'PageDown', mods: { accel: true } }]
  },
  {
    id: 'key_prevTab',
    action: 'tab.prev',
    group: 'windowAndTabManagement',
    label: 'Previous tab',
    key: 'Tab',
    mods: { ctrl: true, shift: true },
    extra: [{ key: 'PageUp', mods: { accel: true } }]
  },
  ...Array.from({ length: 8 }, (_, i) => i + 1).map((n): Def => ({
    id: `key_selectTab${n}`,
    action: `tab.select${n}` as ShortcutAction,
    group: 'windowAndTabManagement',
    label: `Select Tab ${n}`,
    key: String(n),
    mods: { alt: true },
    perPlatform: {
      win32: { key: String(n), mods: { ctrl: true } },
      darwin: { key: String(n), mods: { meta: true } }
    }
  })),
  {
    id: 'key_selectLastTab',
    action: 'tab.selectLast',
    group: 'windowAndTabManagement',
    label: 'Select last tab',
    key: '9',
    mods: { alt: true },
    perPlatform: {
      win32: { key: '9', mods: { ctrl: true } },
      darwin: { key: '9', mods: { meta: true } }
    }
  },
  {
    id: 'key_moveTabBackward',
    action: 'tab.moveBackward',
    group: 'windowAndTabManagement',
    label: 'Move tab up',
    key: 'PageUp',
    mods: { accel: true, shift: true }
  },
  {
    id: 'key_moveTabForward',
    action: 'tab.moveForward',
    group: 'windowAndTabManagement',
    label: 'Move tab down',
    key: 'PageDown',
    mods: { accel: true, shift: true }
  },
  {
    id: 'key_moveTabToStart',
    action: 'tab.moveToStart',
    group: 'windowAndTabManagement',
    label: 'Move tab to start',
    key: 'Home',
    mods: { accel: true, shift: true }
  },
  {
    id: 'key_moveTabToEnd',
    action: 'tab.moveToEnd',
    group: 'windowAndTabManagement',
    label: 'Move tab to end',
    key: 'End',
    mods: { accel: true, shift: true }
  },

  // --- Navigation -------------------------------------------------------------
  {
    id: 'goBackKb',
    action: 'nav.back',
    group: 'navigation',
    label: 'Back',
    key: 'ArrowLeft',
    mods: { alt: true },
    perPlatform: { darwin: { key: '[', mods: { meta: true } } }
  },
  {
    id: 'goForwardKb',
    action: 'nav.forward',
    group: 'navigation',
    label: 'Forward',
    key: 'ArrowRight',
    mods: { alt: true },
    perPlatform: { darwin: { key: ']', mods: { meta: true } } }
  },
  {
    id: 'key_reload',
    action: 'nav.reload',
    group: 'navigation',
    label: 'Reload',
    key: 'r',
    mods: { accel: true },
    extra: [{ key: 'F5', mods: {} }]
  },
  {
    id: 'key_reload_skip_cache',
    action: 'nav.reloadSkipCache',
    group: 'navigation',
    label: 'Reload (override cache)',
    key: 'r',
    mods: { accel: true, shift: true },
    extra: [{ key: 'F5', mods: { accel: true } }]
  },
  {
    id: 'goHome',
    action: 'nav.home',
    group: 'navigation',
    label: 'Home',
    key: 'Home',
    mods: { alt: true }
  },
  {
    id: 'key_stop',
    action: 'nav.stop',
    group: 'navigation',
    label: 'Stop'
  },

  // --- Search & find -----------------------------------------------------------
  {
    id: 'focusURLBar',
    action: 'urlbar.focus',
    group: 'searchAndFind',
    label: 'Focus address bar',
    key: 'l',
    mods: { accel: true },
    extra: [
      { key: 'd', mods: { alt: true } },
      { key: 'F6', mods: {} }
    ]
  },
  {
    id: 'key_search',
    action: 'urlbar.search',
    group: 'searchAndFind',
    label: 'Web search',
    key: 'k',
    mods: { accel: true },
    extra: [{ key: 'e', mods: { accel: true } }]
  },
  {
    id: 'key_find',
    action: 'find.open',
    group: 'searchAndFind',
    label: 'Find in page',
    key: 'f',
    mods: { accel: true }
  },
  {
    id: 'key_findAgain',
    action: 'find.next',
    group: 'searchAndFind',
    label: 'Find next',
    key: 'g',
    mods: { accel: true },
    extra: [{ key: 'F3', mods: {} }]
  },
  {
    id: 'key_findPrevious',
    action: 'find.prev',
    group: 'searchAndFind',
    label: 'Find previous',
    key: 'g',
    mods: { accel: true, shift: true },
    extra: [{ key: 'F3', mods: { shift: true } }]
  },

  // --- Page operations ----------------------------------------------------------
  {
    id: 'key_savePage',
    action: 'page.savePage',
    group: 'pageOperations',
    label: 'Save page as…',
    key: 's',
    mods: { accel: true, alt: true, shift: true }
  },
  {
    id: 'printKb',
    action: 'page.print',
    group: 'pageOperations',
    label: 'Print…',
    key: 'p',
    mods: { accel: true }
  },
  {
    id: 'key_viewSource',
    action: 'page.viewSource',
    group: 'pageOperations',
    label: 'View page source',
    key: 'u',
    mods: { accel: true }
  },
  {
    id: 'key_fullScreen',
    action: 'page.fullscreen',
    group: 'pageOperations',
    label: 'Toggle fullscreen',
    key: 'F11',
    mods: {},
    perPlatform: { darwin: { key: 'f', mods: { meta: true, ctrl: true } } }
  },
  {
    id: 'key_toggleReaderMode',
    action: 'page.readerMode',
    group: 'pageOperations',
    label: 'Toggle reader view',
    key: 'r',
    mods: { accel: true, alt: true }
  },
  {
    id: 'key_togglePictureInPicture',
    action: 'page.pip',
    group: 'pageOperations',
    label: 'Toggle picture-in-picture',
    key: ']',
    mods: { accel: true, shift: true }
  },
  {
    id: 'key_screenshot',
    action: 'page.screenshot',
    group: 'pageOperations',
    label: 'Take screenshot',
    key: 's',
    mods: { accel: true, shift: true }
  },
  {
    id: 'key_toggleMute',
    action: 'page.toggleMute',
    group: 'pageOperations',
    label: 'Mute / unmute tab',
    key: 'm',
    mods: { accel: true }
  },

  // --- Media & display ----------------------------------------------------------
  {
    id: 'key_fullZoomEnlarge',
    action: 'zoom.in',
    group: 'mediaAndDisplay',
    label: 'Zoom in',
    key: '=',
    mods: { accel: true },
    extra: [
      { key: '+', mods: { accel: true } },
      { key: '+', mods: { accel: true, shift: true } }
    ]
  },
  {
    id: 'key_fullZoomReduce',
    action: 'zoom.out',
    group: 'mediaAndDisplay',
    label: 'Zoom out',
    key: '-',
    mods: { accel: true }
  },
  {
    id: 'key_fullZoomReset',
    action: 'zoom.reset',
    group: 'mediaAndDisplay',
    label: 'Reset zoom',
    key: '0',
    mods: { accel: true }
  },

  // --- History & bookmarks -------------------------------------------------------
  {
    id: 'addBookmarkAsKb',
    action: 'bookmark.add',
    group: 'historyAndBookmarks',
    label: 'Bookmark this page',
    key: 'd',
    mods: { accel: true }
  },
  {
    id: 'viewBookmarksSidebarKb',
    action: 'bookmark.sidebar',
    group: 'historyAndBookmarks',
    label: 'Show bookmarks',
    key: 'b',
    mods: { accel: true }
  },
  {
    id: 'manBookmarkKb',
    action: 'bookmark.library',
    group: 'historyAndBookmarks',
    label: 'Manage bookmarks',
    key: 'o',
    mods: { accel: true, shift: true }
  },
  {
    id: 'key_gotoHistory',
    action: 'history.sidebar',
    group: 'historyAndBookmarks',
    label: 'Show history',
    key: 'h',
    mods: { accel: true },
    perPlatform: { darwin: { key: 'y', mods: { meta: true } } }
  },
  {
    id: 'key_openDownloads',
    action: 'downloads.open',
    group: 'historyAndBookmarks',
    label: 'Show downloads',
    key: 'y',
    mods: { accel: true, shift: true },
    perPlatform: {
      win32: { key: 'j', mods: { ctrl: true } },
      darwin: { key: 'j', mods: { meta: true } }
    }
  },

  // --- Developer tools -----------------------------------------------------------
  {
    id: 'key_toggleToolbox',
    action: 'devtools.toggle',
    group: 'devTools',
    label: 'Toggle developer tools',
    key: 'i',
    mods: { accel: true, shift: true },
    extra: [{ key: 'F12', mods: {} }]
  },
  {
    id: 'key_inspector',
    action: 'devtools.inspector',
    group: 'devTools',
    label: 'Inspector',
    key: 'l',
    mods: { accel: true, shift: true }
  },
  {
    id: 'key_webconsole',
    action: 'devtools.console',
    group: 'devTools',
    label: 'Web console'
  },
  {
    id: 'key_browserConsole',
    action: 'devtools.browserConsole',
    group: 'devTools',
    label: 'Browser console',
    key: 'j',
    mods: { accel: true, shift: true }
  },
  {
    id: 'key_openAddons',
    action: 'addons.open',
    group: 'devTools',
    label: 'Add-ons and themes',
    key: 'a',
    mods: { accel: true, shift: true }
  },
  {
    id: 'key_preferencesCmdMac',
    action: 'settings.open',
    group: 'pageOperations',
    label: 'Settings',
    key: ',',
    mods: { meta: true },
    platforms: ['darwin']
  }
]

export function defaultShortcuts(platform: Platform): Shortcut[] {
  return DEFS.map((def) => {
    let primary: KeyBinding | null = null
    const bindOnPlatform = !def.platforms || def.platforms.includes(platform)
    const override = def.perPlatform?.[platform]
    if (bindOnPlatform) {
      if (override) primary = binding(override.key, override.mods, platform)
      else if (def.key !== undefined) primary = binding(def.key, def.mods ?? {}, platform)
    }
    return {
      id: def.id,
      action: def.action,
      group: def.group,
      label: def.label,
      binding: primary,
      extraBindings: (def.extra ?? []).map((e) => binding(e.key, e.mods, platform)),
      unsupported: def.unsupported
    }
  })
}

/** Merge a persisted set of user overrides into the defaults (unknown ids are dropped). */
export function applyShortcutOverrides(
  defaults: Shortcut[],
  overrides: Record<string, KeyBinding | null>
): Shortcut[] {
  return defaults.map((s) =>
    Object.prototype.hasOwnProperty.call(overrides, s.id) ? { ...s, binding: overrides[s.id] } : s
  )
}

/** Return shortcuts whose primary binding collides with `candidate` (excluding `exceptId`). */
export function findConflicts(
  shortcuts: Shortcut[],
  candidate: KeyBinding,
  exceptId: string
): Shortcut[] {
  return shortcuts.filter(
    (s) =>
      s.id !== exceptId &&
      (bindingsEqual(s.binding, candidate) ||
        s.extraBindings.some((e) => bindingsEqual(e, candidate)))
  )
}
