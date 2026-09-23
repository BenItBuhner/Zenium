import type {
  FormFactor,
  KeyBinding,
  Platform,
  Shortcut,
  ShortcutAction,
  ShortcutGroup,
  ShortcutPreset
} from './types'

/**
 * Zenium's keyboard shortcut tables.
 *
 * Two presets exist. `chrome` (the default) follows Chrome's and Edge's bindings for every action
 * the two have (`chrome/browser/ui/views/accelerator_table.cc`, Chrome's macOS main menu and
 * Edge's keyboard shortcuts page), and parks Zen's own features (compact mode, Spaces, Glance,
 * split view, copy URL) on chords neither browser uses: Ctrl+Alt on Windows and Linux, Cmd+Ctrl
 * on macOS. `zen` is Zen Browser's set (`src/zen/kbs/ZenKeyboardShortcuts.mjs`, defaults plus
 * migrations up to version 17, on top of Firefox's keyset). In both presets a destructive action
 * never sits on a chord Chrome or Edge uses for something benign; `collisions` proves it.
 *
 * `accel` is Ctrl on Linux/Windows and Cmd (meta) on macOS.
 */

export interface Mods {
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

/**
 * What Shift turns the US-layout punctuation keys into. Chrome and Firefox match shortcuts by
 * key code, so Ctrl+Shift+] reaches a binding written as `]`; `KeyboardEvent.key` reports `}`
 * for that press, hence the two spellings are treated as the same chord while Shift is held.
 */
const US_SHIFTED: Record<string, string> = {
  '`': '~',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
  '-': '_',
  '=': '+',
  '[': '{',
  ']': '}',
  '\\': '|',
  ';': ':',
  "'": '"',
  ',': '<',
  '.': '>',
  '/': '?'
}
const US_UNSHIFTED: Record<string, string> = Object.fromEntries(
  Object.entries(US_SHIFTED).map(([base, shifted]) => [shifted, base])
)

/** The chord `pressed` triggers `bound`: same modifiers, same key up to Shift's spelling. */
export function bindingMatches(bound: KeyBinding | null, pressed: KeyBinding): boolean {
  if (!bound) return false
  if (
    bound.ctrl !== pressed.ctrl ||
    bound.alt !== pressed.alt ||
    bound.shift !== pressed.shift ||
    bound.meta !== pressed.meta
  )
    return false
  if (bound.key === pressed.key) return true
  if (!pressed.shift) return false
  return US_SHIFTED[pressed.key] === bound.key || US_UNSHIFTED[pressed.key] === bound.key
}

export interface KeyInput {
  key: string
  /**
   * The physical key (`KeyboardEvent.code`), when the host reports it. macOS composes Option
   * chords into characters (`Cmd+Option+G` arrives as `©`), so with Cmd and Option both held the
   * key is read from `code` instead.
   */
  code?: string
  control: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

/** Build a binding from a raw key input (Electron `before-input-event` or a DOM KeyboardEvent). */
export function bindingFromInput(input: KeyInput): KeyBinding {
  let key = normaliseKey(input.key)
  if (input.meta && input.alt && input.code) {
    const physical = keyFromCode(input.code)
    if (physical) key = physical
  }
  return {
    ctrl: input.control,
    alt: input.alt,
    shift: input.shift,
    meta: input.meta,
    key
  }
}

function keyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1].toLowerCase()
  const digit = /^Digit(\d)$/.exec(code)
  if (digit) return digit[1]
  return null
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
    if (bindingMatches(shortcut.binding, pressed)) return shortcut
    for (const extra of shortcut.extraBindings) {
      if (bindingMatches(extra, pressed)) return shortcut
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

/** Electron accelerator names for the keys `KeyboardEvent.key` spells differently. */
const ACCELERATOR_KEYS: Record<string, string> = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Escape: 'Esc',
  Enter: 'Return',
  ' ': 'Space',
  '+': 'Plus'
}

/**
 * The binding as an Electron accelerator (`Ctrl+Shift+N`, `Cmd+Alt+I`), for menus to display;
 * null for keys Electron's accelerator grammar has no name for. Modifiers are spelled per
 * platform already, so the string never uses `CmdOrCtrl`. The order is Chrome's documentation
 * order (Cmd, Ctrl, Alt, Shift); the host draws the chord in the OS's own order anyway.
 */
export function toAccelerator(b: KeyBinding | null): string | null {
  if (!b) return null
  let key: string
  if (ACCELERATOR_KEYS[b.key]) key = ACCELERATOR_KEYS[b.key]
  else if (b.key.length === 1) key = b.key.toUpperCase()
  else if (/^(F\d{1,2}|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown)$/.test(b.key))
    key = b.key
  else return null
  const parts: string[] = []
  if (b.meta) parts.push('Cmd')
  if (b.ctrl) parts.push('Ctrl')
  if (b.alt) parts.push('Alt')
  if (b.shift) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

export const SHORTCUT_GROUP_LABELS: Record<ShortcutGroup, string> = {
  'zen-compact-mode': 'Compact Mode',
  'zen-workspace': 'Spaces',
  'zen-split-view': 'Split View',
  'zen-other': 'Zenium Features',
  windowAndTabManagement: 'Window & Tab Management',
  navigation: 'Navigation',
  searchAndFind: 'Search & Find',
  pageOperations: 'Page Operations',
  historyAndBookmarks: 'History & Bookmarks',
  mediaAndDisplay: 'Media & Display',
  devTools: 'Developer Tools'
}

export const SHORTCUT_PRESETS: ShortcutPreset[] = ['chrome', 'zen']

export const SHORTCUT_PRESET_LABELS: Record<ShortcutPreset, string> = {
  chrome: 'Chrome shortcuts',
  zen: 'Zen shortcuts'
}

export const SHORTCUT_PRESET_DESCRIPTIONS: Record<ShortcutPreset, string> = {
  chrome: 'The chords Chrome and Edge use, so nothing learned there changes.',
  zen: 'The Zen Browser set: Ctrl+S for compact mode, Ctrl+Shift+P for a private window.'
}

export function isShortcutPreset(value: unknown): value is ShortcutPreset {
  return value === 'chrome' || value === 'zen'
}

/** Shown once to a profile whose bindings changed under it when the Chrome preset became the default. */
export const SHORTCUTS_MIGRATION_NOTICE =
  'Keyboard shortcuts now follow Chrome; switch back in Settings'

/**
 * The preset a stored profile lands on. Profiles from before the setting existed were on the Zen
 * table: one with customised bindings stays on it (`zen`), so nothing its user learned changes;
 * one without moves to `chrome` and is told so once (`notice`). A stored preset is kept.
 */
export function migrateShortcutPreset(
  stored: unknown,
  overrides: Record<string, KeyBinding | null>
): { preset: ShortcutPreset; notice: string | null } {
  if (isShortcutPreset(stored)) return { preset: stored, notice: null }
  if (Object.keys(overrides).length > 0) return { preset: 'zen', notice: null }
  return { preset: 'chrome', notice: SHORTCUTS_MIGRATION_NOTICE }
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/** One chord of a definition, optionally limited to some platforms. */
interface Chord {
  key: string
  mods?: Mods
  platforms?: Platform[]
}

/** The bindings of one action in one preset. No `key` (and no platform override) is unbound. */
interface Spec {
  key?: string
  mods?: Mods
  /** Only bind on these platforms (others are left unbound, like Zen does for space switching). */
  platforms?: Platform[]
  /** Platform specific primary chord; null leaves the action unbound on that platform. */
  perPlatform?: Partial<Record<Platform, Chord | null>>
  extra?: Chord[]
}

interface Def {
  id: string
  action: ShortcutAction
  group: ShortcutGroup
  label: string
  unsupported?: boolean
  hidden?: boolean
  /** Closes or discards something the user cannot get back with one key. */
  destructive?: boolean
  /** Listed on these chrome layouts alone (`Shortcut.layouts`). */
  layouts?: FormFactor[]
  zen: Spec
  chrome: Spec
}

const ACCEL: Mods = { accel: true }
const ACCEL_SHIFT: Mods = { accel: true, shift: true }
const ACCEL_ALT: Mods = { accel: true, alt: true }
const ACCEL_ALT_SHIFT: Mods = { accel: true, alt: true, shift: true }
const CTRL: Mods = { ctrl: true }
const CTRL_SHIFT: Mods = { ctrl: true, shift: true }
const ALT: Mods = { alt: true }
const ALT_SHIFT: Mods = { alt: true, shift: true }
const SHIFT: Mods = { shift: true }
const META: Mods = { meta: true }
const META_SHIFT: Mods = { meta: true, shift: true }
const META_ALT: Mods = { meta: true, alt: true }
const META_CTRL: Mods = { meta: true, ctrl: true }
const META_CTRL_SHIFT: Mods = { meta: true, ctrl: true, shift: true }
const WINLIN: Platform[] = ['win32', 'linux']
const MAC: Platform[] = ['darwin']

const UNBOUND: Spec = {}

const both = (spec: Spec): { zen: Spec; chrome: Spec } => ({ zen: spec, chrome: spec })

/**
 * Where the Chrome preset keeps a Zen feature: Ctrl+Alt (+Shift) on Windows and Linux and
 * Cmd+Ctrl (+Shift) on macOS, chords Chrome and Edge leave alone (Cmd+Option is Chrome's
 * developer and view menu space on macOS).
 */
const zenFeature = (key: string, shift = false): Spec => ({
  key,
  mods: shift ? ACCEL_ALT_SHIFT : ACCEL_ALT,
  perPlatform: { darwin: { key, mods: shift ? META_CTRL_SHIFT : META_CTRL } }
})

const DEFS: Def[] = [
  // --- Compact mode ---------------------------------------------------------
  {
    id: 'zen-compact-mode-toggle',
    action: 'compact.toggle',
    group: 'zen-compact-mode',
    label: 'Toggle Compact Mode',
    zen: { key: 's', mods: ACCEL },
    chrome: zenFeature('s')
  },
  {
    id: 'zen-compact-mode-show-sidebar',
    action: 'compact.toggleSidebar',
    group: 'zen-compact-mode',
    label: 'Toggle Floating Sidebar',
    zen: { key: 's', mods: ACCEL_ALT },
    chrome: zenFeature('s', true)
  },

  // --- Spaces ---------------------------------------------------------------
  ...Array.from({ length: 10 }, (_, i) => i + 1).map((n): Def => ({
    id: `zen-workspace-switch-${n}`,
    action: `space.switch${n}` as ShortcutAction,
    group: 'zen-workspace',
    label: `Switch to Space ${n}`,
    ...both({ key: n === 10 ? '0' : String(n), mods: CTRL, platforms: MAC })
  })),
  {
    id: 'zen-workspace-forward',
    action: 'space.next',
    group: 'zen-workspace',
    label: 'Next Space',
    zen: { key: 'ArrowRight', mods: ACCEL_ALT },
    chrome: zenFeature('ArrowRight')
  },
  {
    id: 'zen-workspace-backward',
    action: 'space.prev',
    group: 'zen-workspace',
    label: 'Previous Space',
    zen: { key: 'ArrowLeft', mods: ACCEL_ALT },
    chrome: zenFeature('ArrowLeft')
  },
  {
    // Zen has this on Ctrl+Shift+K, which duplicates the tab in Edge: too close a call for a
    // chord that closes every unpinned tab, so both presets add Alt.
    id: 'zen-close-all-unpinned-tabs',
    action: 'space.closeUnpinned',
    group: 'zen-workspace',
    label: 'Close All Unpinned Tabs',
    destructive: true,
    zen: { key: 'k', mods: ACCEL_ALT_SHIFT },
    chrome: zenFeature('k', true)
  },
  {
    // Added in Zen's shortcut schema v18; unbound by default like upstream.
    id: 'zen-workspace-create',
    action: 'space.new',
    group: 'zen-workspace',
    label: 'Create New Space',
    ...both(UNBOUND)
  },

  // --- Split view ------------------------------------------------------------
  {
    id: 'zen-split-view-grid',
    action: 'split.grid',
    group: 'zen-split-view',
    label: 'Toggle Split View Grid',
    zen: { key: 'g', mods: ACCEL_ALT },
    chrome: zenFeature('g')
  },
  {
    id: 'zen-split-view-vertical',
    action: 'split.vertical',
    group: 'zen-split-view',
    label: 'Toggle Split View Vertical',
    zen: { key: 'v', mods: ACCEL_ALT },
    chrome: zenFeature('v')
  },
  {
    id: 'zen-split-view-horizontal',
    action: 'split.horizontal',
    group: 'zen-split-view',
    label: 'Toggle Split View Horizontal',
    zen: { key: 'h', mods: ACCEL_ALT },
    chrome: zenFeature('h')
  },
  {
    id: 'zen-split-view-unsplit',
    action: 'split.unsplit',
    group: 'zen-split-view',
    label: 'Unsplit View',
    zen: { key: 'u', mods: ACCEL_ALT },
    chrome: zenFeature('u')
  },
  {
    id: 'zen-new-empty-split-view',
    action: 'split.newEmpty',
    group: 'zen-split-view',
    label: 'New Empty Split View',
    ...both({ key: '*', mods: ACCEL_SHIFT })
  },
  {
    // Neither reference browser has a chord for the pane (Chrome's and Edge's F6 rotates the
    // chrome's panes and the pages in turn, which `focus.nextPane` keeps): the space chords with
    // Shift added, one pane along the split's order.
    id: 'zen-split-view-next-pane',
    action: 'split.nextPane',
    group: 'zen-split-view',
    label: 'Next Split Pane',
    zen: { key: 'ArrowRight', mods: ACCEL_ALT_SHIFT },
    chrome: zenFeature('ArrowRight', true)
  },
  {
    id: 'zen-split-view-previous-pane',
    action: 'split.prevPane',
    group: 'zen-split-view',
    label: 'Previous Split Pane',
    zen: { key: 'ArrowLeft', mods: ACCEL_ALT_SHIFT },
    chrome: zenFeature('ArrowLeft', true)
  },

  // --- Zen: other ------------------------------------------------------------
  {
    id: 'zen-copy-url',
    action: 'tab.copyUrl',
    group: 'zen-other',
    label: 'Copy Current URL',
    zen: { key: 'c', mods: ACCEL_SHIFT },
    chrome: zenFeature('c')
  },
  {
    id: 'zen-copy-url-markdown',
    action: 'tab.copyUrlMarkdown',
    group: 'zen-other',
    label: 'Copy Current URL as Markdown',
    zen: { key: 'c', mods: ACCEL_ALT_SHIFT },
    chrome: zenFeature('c', true)
  },
  {
    id: 'zen-toggle-pin-tab',
    action: 'tab.togglePin',
    group: 'zen-other',
    label: 'Pin / Unpin Tab',
    zen: { key: 'd', mods: ACCEL_SHIFT },
    chrome: zenFeature('p')
  },
  {
    id: 'zen-pinned-tab-reset-shortcut',
    action: 'tab.resetPinned',
    group: 'zen-other',
    label: 'Reset Pinned Tab',
    destructive: true,
    ...both(UNBOUND)
  },
  {
    id: 'zen-toggle-sidebar',
    action: 'sidebar.toggle',
    group: 'zen-other',
    label: 'Toggle Sidebar',
    ...both(UNBOUND)
  },
  {
    id: 'zen-glance-expand',
    action: 'glance.expand',
    group: 'zen-other',
    label: 'Expand Glance',
    zen: { key: 'o', mods: ACCEL },
    chrome: zenFeature('o')
  },
  {
    id: 'zen-new-unsynced-window',
    action: 'window.newUnsynced',
    group: 'zen-other',
    label: 'New Blank Window',
    zen: { key: 'n', mods: ACCEL_SHIFT },
    chrome: zenFeature('n')
  },

  // --- Window & tab management -----------------------------------------------
  {
    id: 'key_newNavigatorTab',
    action: 'tab.new',
    group: 'windowAndTabManagement',
    label: 'New Tab',
    ...both({ key: 't', mods: ACCEL })
  },
  {
    id: 'key_close',
    action: 'tab.close',
    group: 'windowAndTabManagement',
    label: 'Close Tab',
    destructive: true,
    zen: { key: 'w', mods: ACCEL, extra: [{ key: 'F4', mods: ACCEL }] },
    chrome: { key: 'w', mods: ACCEL, extra: [{ key: 'F4', mods: CTRL, platforms: WINLIN }] }
  },
  {
    id: 'key_undoCloseTab',
    action: 'tab.reopenClosed',
    group: 'windowAndTabManagement',
    label: 'Reopen Closed Tab',
    ...both({ key: 't', mods: ACCEL_SHIFT })
  },
  {
    // Edge's chord; Chrome has none.
    id: 'zen-duplicate-tab',
    action: 'tab.duplicate',
    group: 'windowAndTabManagement',
    label: 'Duplicate Tab',
    zen: UNBOUND,
    chrome: { key: 'k', mods: ACCEL_SHIFT }
  },
  {
    // Chrome's tab search popover (tabs-17).
    id: 'key_tabSearch',
    action: 'tab.search',
    group: 'windowAndTabManagement',
    label: 'Search Tabs',
    zen: UNBOUND,
    chrome: { key: 'a', mods: ACCEL_SHIFT }
  },
  {
    id: 'key_newNavigator',
    action: 'window.new',
    group: 'windowAndTabManagement',
    label: 'New Window',
    ...both({ key: 'n', mods: ACCEL })
  },
  {
    id: 'key_privatebrowsing',
    action: 'window.newPrivate',
    group: 'windowAndTabManagement',
    label: 'New Private Window',
    zen: { key: 'p', mods: ACCEL_SHIFT },
    chrome: { key: 'n', mods: ACCEL_SHIFT }
  },
  {
    id: 'key_closeWindow',
    action: 'window.close',
    group: 'windowAndTabManagement',
    label: 'Close Window',
    destructive: true,
    ...both({ key: 'w', mods: ACCEL_SHIFT })
  },
  {
    id: 'key_minimizeWindow',
    action: 'window.minimize',
    group: 'windowAndTabManagement',
    label: 'Minimise Window',
    zen: UNBOUND,
    chrome: { key: 'm', mods: META, platforms: MAC }
  },
  {
    // Chrome's More tools › Name window… has no chord in either browser: the row is in the
    // table so Settings can bind one and the palette lists it. The desktop layout's alone, as
    // the palette's row is: a phone or tablet window shows no name (no title bar, no window
    // switcher), so their listings leave the row out rather than offer a chord that does nothing.
    id: 'key_nameWindow',
    action: 'window.name',
    group: 'windowAndTabManagement',
    label: 'Name Window…',
    layouts: ['desktop'],
    ...both(UNBOUND)
  },
  {
    // Chrome quits on Ctrl+Shift+Q (Linux) and Cmd+Q; Zen keeps Firefox's Ctrl+Q.
    id: 'key_quitApplication',
    action: 'app.quit',
    group: 'windowAndTabManagement',
    label: 'Quit',
    destructive: true,
    zen: { key: 'q', mods: ACCEL },
    chrome: { key: 'q', mods: ACCEL_SHIFT, perPlatform: { darwin: { key: 'q', mods: META } } }
  },
  {
    id: 'key_appMenu',
    action: 'menu.app',
    group: 'windowAndTabManagement',
    label: 'Open Application Menu',
    zen: { key: 'F10', platforms: WINLIN, extra: [{ key: 'f', mods: ALT }] },
    chrome: {
      key: 'f',
      mods: ALT,
      platforms: WINLIN,
      extra: [{ key: 'e', mods: ALT }, { key: 'F10' }]
    }
  },
  {
    id: 'key_nextTab',
    action: 'tab.next',
    group: 'windowAndTabManagement',
    label: 'Next Tab',
    zen: { key: 'Tab', mods: CTRL, extra: [{ key: 'PageDown', mods: ACCEL }] },
    chrome: {
      key: 'Tab',
      mods: CTRL,
      extra: [
        { key: 'PageDown', mods: CTRL },
        { key: 'ArrowRight', mods: META_ALT, platforms: MAC }
      ]
    }
  },
  {
    id: 'key_prevTab',
    action: 'tab.prev',
    group: 'windowAndTabManagement',
    label: 'Previous Tab',
    zen: { key: 'Tab', mods: CTRL_SHIFT, extra: [{ key: 'PageUp', mods: ACCEL }] },
    chrome: {
      key: 'Tab',
      mods: CTRL_SHIFT,
      extra: [
        { key: 'PageUp', mods: CTRL },
        { key: 'ArrowLeft', mods: META_ALT, platforms: MAC }
      ]
    }
  },
  ...Array.from({ length: 8 }, (_, i) => i + 1).map((n): Def => ({
    id: `key_selectTab${n}`,
    action: `tab.select${n}` as ShortcutAction,
    group: 'windowAndTabManagement',
    label: `Select Tab ${n}`,
    zen: {
      key: String(n),
      mods: ALT,
      perPlatform: {
        win32: { key: String(n), mods: CTRL },
        darwin: { key: String(n), mods: META }
      }
    },
    chrome: { key: String(n), mods: ACCEL }
  })),
  {
    id: 'key_selectLastTab',
    action: 'tab.selectLast',
    group: 'windowAndTabManagement',
    label: 'Select Last Tab',
    zen: {
      key: '9',
      mods: ALT,
      perPlatform: { win32: { key: '9', mods: CTRL }, darwin: { key: '9', mods: META } }
    },
    chrome: { key: '9', mods: ACCEL }
  },
  {
    id: 'key_moveTabBackward',
    action: 'tab.moveBackward',
    group: 'windowAndTabManagement',
    label: 'Move Tab Up',
    zen: { key: 'PageUp', mods: ACCEL_SHIFT },
    chrome: {
      key: 'PageUp',
      mods: CTRL_SHIFT,
      extra: [{ key: 'PageUp', mods: META_SHIFT, platforms: MAC }]
    }
  },
  {
    id: 'key_moveTabForward',
    action: 'tab.moveForward',
    group: 'windowAndTabManagement',
    label: 'Move Tab Down',
    zen: { key: 'PageDown', mods: ACCEL_SHIFT },
    chrome: {
      key: 'PageDown',
      mods: CTRL_SHIFT,
      extra: [{ key: 'PageDown', mods: META_SHIFT, platforms: MAC }]
    }
  },
  {
    id: 'key_moveTabToStart',
    action: 'tab.moveToStart',
    group: 'windowAndTabManagement',
    label: 'Move Tab to Start',
    ...both({ key: 'Home', mods: ACCEL_SHIFT })
  },
  {
    id: 'key_moveTabToEnd',
    action: 'tab.moveToEnd',
    group: 'windowAndTabManagement',
    label: 'Move Tab to End',
    ...both({ key: 'End', mods: ACCEL_SHIFT })
  },

  // --- Navigation -------------------------------------------------------------
  {
    id: 'goBackKb',
    action: 'nav.back',
    group: 'navigation',
    label: 'Back',
    ...both({ key: 'ArrowLeft', mods: ALT, perPlatform: { darwin: { key: '[', mods: META } } })
  },
  {
    id: 'goForwardKb',
    action: 'nav.forward',
    group: 'navigation',
    label: 'Forward',
    ...both({ key: 'ArrowRight', mods: ALT, perPlatform: { darwin: { key: ']', mods: META } } })
  },
  {
    id: 'key_reload',
    action: 'nav.reload',
    group: 'navigation',
    label: 'Reload',
    ...both({ key: 'r', mods: ACCEL, extra: [{ key: 'F5' }] })
  },
  {
    id: 'key_reload_skip_cache',
    action: 'nav.reloadSkipCache',
    group: 'navigation',
    label: 'Reload (Override Cache)',
    zen: { key: 'r', mods: ACCEL_SHIFT, extra: [{ key: 'F5', mods: ACCEL }] },
    chrome: {
      key: 'r',
      mods: ACCEL_SHIFT,
      extra: [
        { key: 'F5', mods: CTRL, platforms: WINLIN },
        { key: 'F5', mods: SHIFT, platforms: WINLIN }
      ]
    }
  },
  {
    id: 'goHome',
    action: 'nav.home',
    group: 'navigation',
    label: 'Home',
    zen: { key: 'Home', mods: ALT },
    chrome: { key: 'Home', mods: ALT, perPlatform: { darwin: { key: 'h', mods: META_SHIFT } } }
  },
  {
    // ⌘. is Chrome's, Safari's and Firefox's Stop on macOS. Windows and Linux stay unbound:
    // Escape is Stop there, and Escape is owned by the chrome's Escape stack and by the page
    // handler, not by this table.
    id: 'key_stop',
    action: 'nav.stop',
    group: 'navigation',
    label: 'Stop',
    ...both({ perPlatform: { darwin: { key: '.', mods: META } } })
  },
  {
    // Chrome's and Firefox's F6: the keyboard rotates through the chrome's panes (tab strip,
    // toolbar, bookmarks bar, side panel) and the page. The address bar is the toolbar's stop.
    id: 'key_focusNextPane',
    action: 'focus.nextPane',
    group: 'navigation',
    label: 'Focus Next Pane',
    ...both({ key: 'F6' })
  },
  {
    id: 'key_focusPreviousPane',
    action: 'focus.prevPane',
    group: 'navigation',
    label: 'Focus Previous Pane',
    ...both({ key: 'F6', mods: SHIFT })
  },
  {
    // Chrome's Windows and Linux chords; its macOS build has none.
    id: 'key_focusToolbar',
    action: 'focus.toolbar',
    group: 'navigation',
    label: 'Focus Toolbar',
    ...both({ key: 't', mods: ALT_SHIFT, platforms: WINLIN })
  },
  {
    id: 'key_focusBookmarksBar',
    action: 'focus.bookmarksBar',
    group: 'navigation',
    label: 'Focus Bookmarks Bar',
    ...both({ key: 'b', mods: ALT_SHIFT, platforms: WINLIN })
  },

  // --- Search & find -----------------------------------------------------------
  {
    // Edge's F4 (Windows and Linux; Ctrl+F4 stays Close Tab) focuses the address bar as well.
    id: 'focusURLBar',
    action: 'urlbar.focus',
    group: 'searchAndFind',
    label: 'Focus Address Bar',
    ...both({
      key: 'l',
      mods: ACCEL,
      extra: [
        { key: 'd', mods: ALT },
        { key: 'F4', platforms: WINLIN }
      ]
    })
  },
  {
    id: 'key_search',
    action: 'urlbar.search',
    group: 'searchAndFind',
    label: 'Web Search',
    zen: { key: 'k', mods: ACCEL, extra: [{ key: 'e', mods: ACCEL }] },
    chrome: {
      key: 'k',
      mods: ACCEL,
      perPlatform: { darwin: { key: 'f', mods: META_ALT } },
      extra: [
        { key: 'e', mods: ACCEL, platforms: WINLIN },
        { key: 'k', mods: META, platforms: MAC }
      ]
    }
  },
  {
    id: 'key_find',
    action: 'find.open',
    group: 'searchAndFind',
    label: 'Find in Page',
    ...both({ key: 'f', mods: ACCEL })
  },
  {
    id: 'key_findAgain',
    action: 'find.next',
    group: 'searchAndFind',
    label: 'Find Next',
    ...both({ key: 'g', mods: ACCEL, extra: [{ key: 'F3' }] })
  },
  {
    id: 'key_findPrevious',
    action: 'find.prev',
    group: 'searchAndFind',
    label: 'Find Previous',
    ...both({ key: 'g', mods: ACCEL_SHIFT, extra: [{ key: 'F3', mods: SHIFT }] })
  },
  {
    id: 'key_findSelection',
    action: 'find.useSelection',
    group: 'searchAndFind',
    label: 'Use Selection for Find',
    zen: UNBOUND,
    chrome: { key: 'e', mods: META, platforms: MAC }
  },

  // --- Page operations ----------------------------------------------------------
  {
    id: 'key_savePage',
    action: 'page.savePage',
    group: 'pageOperations',
    label: 'Save Page As…',
    zen: { key: 's', mods: ACCEL_ALT_SHIFT },
    chrome: { key: 's', mods: ACCEL }
  },
  {
    id: 'openFileKb',
    action: 'page.openFile',
    group: 'pageOperations',
    label: 'Open File…',
    zen: UNBOUND,
    chrome: { key: 'o', mods: ACCEL }
  },
  {
    // Ctrl+P opens Zenium's print preview (the engine's own flow on a host without one).
    id: 'printKb',
    action: 'page.printPreview',
    group: 'pageOperations',
    label: 'Print…',
    ...both({ key: 'p', mods: ACCEL })
  },
  {
    // Chrome's "Print using system dialog…": Ctrl+Shift+P (Cmd+Option+P on a Mac). Zen has no key
    // for it (Ctrl+Shift+P is its private window); the preview's own link reaches it there.
    id: 'printSystemKb',
    action: 'page.print',
    group: 'pageOperations',
    label: 'Print Using System Dialog…',
    zen: UNBOUND,
    chrome: { key: 'p', mods: ACCEL_SHIFT, perPlatform: { darwin: { key: 'p', mods: META_ALT } } }
  },
  {
    id: 'key_viewSource',
    action: 'page.viewSource',
    group: 'pageOperations',
    label: 'View Page Source',
    zen: { key: 'u', mods: ACCEL },
    chrome: { key: 'u', mods: ACCEL, perPlatform: { darwin: { key: 'u', mods: META_ALT } } }
  },
  {
    id: 'key_fullScreen',
    action: 'page.fullscreen',
    group: 'pageOperations',
    label: 'Toggle Fullscreen',
    ...both({ key: 'F11', perPlatform: { darwin: { key: 'f', mods: META_CTRL } } })
  },
  {
    id: 'key_toggleReaderMode',
    action: 'page.readerMode',
    group: 'pageOperations',
    label: 'Toggle Reader View',
    zen: { key: 'r', mods: ACCEL_ALT },
    chrome: { key: 'r', mods: ACCEL_ALT, extra: [{ key: 'F9', platforms: WINLIN }] }
  },
  {
    id: 'key_togglePictureInPicture',
    action: 'page.pip',
    group: 'pageOperations',
    label: 'Toggle Picture-in-Picture',
    ...both({ key: ']', mods: ACCEL_SHIFT })
  },
  // Ctrl+Shift+S is Firefox's Take Screenshot and Edge's Web capture; Chrome has no chord for
  // either. The Zen preset keeps Firefox's; the Chrome preset gives the chord to Web capture
  // (Edge's, with its overlay) and leaves the one-key screenshot to the menus.
  {
    id: 'key_screenshot',
    action: 'page.screenshot',
    group: 'pageOperations',
    label: 'Take Screenshot',
    zen: { key: 's', mods: ACCEL_SHIFT },
    chrome: UNBOUND
  },
  {
    id: 'key_webCapture',
    action: 'capture.start',
    group: 'pageOperations',
    label: 'Web Capture',
    // The desktop's overlay; the touch shells' Ctrl+Shift+S takes their screenshot instead
    // (`capture.start` falls through to `page.screenshot` there), so their listings leave the
    // row out rather than name a surface the chord does not open.
    layouts: ['desktop'],
    zen: UNBOUND,
    chrome: { key: 's', mods: ACCEL_SHIFT }
  },
  {
    id: 'key_toggleMute',
    action: 'page.toggleMute',
    group: 'pageOperations',
    label: 'Mute / Unmute Tab',
    zen: { key: 'm', mods: ACCEL },
    chrome: { key: 'm', mods: ACCEL, perPlatform: { darwin: { key: 'm', mods: META_CTRL } } }
  },
  {
    id: 'key_emailLink',
    action: 'page.emailLink',
    group: 'pageOperations',
    label: 'Email Page Link…',
    zen: UNBOUND,
    chrome: { key: 'i', mods: META_SHIFT, platforms: MAC }
  },
  {
    id: 'key_preferencesCmdMac',
    action: 'settings.open',
    group: 'pageOperations',
    label: 'Settings',
    ...both({ key: ',', mods: META, platforms: MAC })
  },

  // --- Media & display ----------------------------------------------------------
  {
    id: 'key_fullZoomEnlarge',
    action: 'zoom.in',
    group: 'mediaAndDisplay',
    label: 'Zoom In',
    ...both({
      key: '=',
      mods: ACCEL,
      extra: [
        { key: '+', mods: ACCEL },
        { key: '+', mods: ACCEL_SHIFT }
      ]
    })
  },
  {
    id: 'key_fullZoomReduce',
    action: 'zoom.out',
    group: 'mediaAndDisplay',
    label: 'Zoom Out',
    ...both({ key: '-', mods: ACCEL })
  },
  {
    id: 'key_fullZoomReset',
    action: 'zoom.reset',
    group: 'mediaAndDisplay',
    label: 'Reset Zoom',
    ...both({ key: '0', mods: ACCEL })
  },

  // --- History & bookmarks -------------------------------------------------------
  {
    id: 'addBookmarkAsKb',
    action: 'bookmark.add',
    group: 'historyAndBookmarks',
    label: 'Bookmark This Page',
    ...both({ key: 'd', mods: ACCEL })
  },
  {
    // Firefox and Chrome bind Ctrl+Shift+D here; Zen gave that to "Pin / Unpin Tab".
    id: 'bookmarkAllTabsKb',
    action: 'bookmark.allTabs',
    group: 'historyAndBookmarks',
    label: 'Bookmark All Tabs',
    zen: UNBOUND,
    chrome: { key: 'd', mods: ACCEL_SHIFT }
  },
  {
    id: 'viewBookmarksSidebarKb',
    action: 'bookmark.sidebar',
    group: 'historyAndBookmarks',
    label: 'Show Bookmarks',
    ...both({ key: 'b', mods: ACCEL })
  },
  {
    id: 'viewBookmarksToolbarKb',
    action: 'bookmark.toggleBar',
    group: 'historyAndBookmarks',
    label: 'Show / Hide Bookmarks Bar',
    ...both({ key: 'b', mods: ACCEL_SHIFT })
  },
  {
    id: 'manBookmarkKb',
    action: 'bookmark.library',
    group: 'historyAndBookmarks',
    label: 'Manage Bookmarks',
    zen: { key: 'o', mods: ACCEL_SHIFT },
    chrome: {
      key: 'o',
      mods: ACCEL_SHIFT,
      perPlatform: { darwin: { key: 'b', mods: META_ALT } },
      extra: [{ key: 'o', mods: META_SHIFT, platforms: MAC }]
    }
  },
  {
    id: 'key_gotoHistory',
    action: 'history.sidebar',
    group: 'historyAndBookmarks',
    label: 'Show History',
    ...both({ key: 'h', mods: ACCEL, perPlatform: { darwin: { key: 'y', mods: META } } })
  },
  {
    // Chrome's and Firefox's one chord for it (Firefox's `key_sanitize`, "Clear recent history").
    id: 'key_clearBrowsingData',
    action: 'privacy.clearBrowsingData',
    group: 'historyAndBookmarks',
    label: 'Delete Browsing Data…',
    ...both({ key: 'Delete', mods: ACCEL_SHIFT })
  },
  {
    id: 'key_openDownloads',
    action: 'downloads.open',
    group: 'historyAndBookmarks',
    label: 'Show Downloads',
    zen: {
      key: 'y',
      mods: ACCEL_SHIFT,
      perPlatform: { win32: { key: 'j', mods: CTRL }, darwin: { key: 'j', mods: META } }
    },
    chrome: { key: 'j', mods: ACCEL, perPlatform: { darwin: { key: 'j', mods: META_SHIFT } } }
  },

  // --- Developer tools -----------------------------------------------------------
  {
    id: 'key_toggleToolbox',
    action: 'devtools.toggle',
    group: 'devTools',
    label: 'Toggle Developer Tools',
    zen: { key: 'i', mods: ACCEL_SHIFT, extra: [{ key: 'F12' }] },
    chrome: {
      key: 'i',
      mods: ACCEL_SHIFT,
      perPlatform: { darwin: { key: 'i', mods: META_ALT } },
      extra: [{ key: 'F12' }]
    }
  },
  {
    id: 'key_inspector',
    action: 'devtools.inspector',
    group: 'devTools',
    label: 'Inspector',
    zen: { key: 'l', mods: ACCEL_SHIFT },
    chrome: {
      key: 'c',
      mods: ACCEL_SHIFT,
      perPlatform: { darwin: { key: 'c', mods: META_ALT } },
      extra: [{ key: 'c', mods: META_SHIFT, platforms: MAC }]
    }
  },
  {
    id: 'key_webconsole',
    action: 'devtools.console',
    group: 'devTools',
    label: 'Web Console',
    zen: UNBOUND,
    chrome: { key: 'j', mods: ACCEL_SHIFT, perPlatform: { darwin: { key: 'j', mods: META_ALT } } }
  },
  {
    id: 'key_browserConsole',
    action: 'devtools.browserConsole',
    group: 'devTools',
    label: 'Browser Console',
    zen: { key: 'j', mods: ACCEL_SHIFT },
    chrome: UNBOUND
  },
  {
    id: 'key_openAddons',
    action: 'addons.open',
    group: 'devTools',
    label: 'Add-ons and Themes',
    zen: { key: 'a', mods: ACCEL_SHIFT },
    chrome: UNBOUND
  }
]

/** Actions that close or discard something; `collisions` reports these separately. */
export const DESTRUCTIVE_ACTIONS: ReadonlySet<ShortcutAction> = new Set(
  DEFS.filter((d) => d.destructive).map((d) => d.action)
)

export function isDestructiveAction(action: ShortcutAction): boolean {
  return DESTRUCTIVE_ACTIONS.has(action)
}

function resolveSpec(
  spec: Spec,
  platform: Platform
): { binding: KeyBinding | null; extraBindings: KeyBinding[] } {
  const onPlatform = !spec.platforms || spec.platforms.includes(platform)
  if (!onPlatform) return { binding: null, extraBindings: [] }
  let primary: KeyBinding | null = null
  const override = spec.perPlatform?.[platform]
  if (override) primary = binding(override.key, override.mods ?? {}, platform)
  else if (override !== null && spec.key !== undefined)
    primary = binding(spec.key, spec.mods ?? {}, platform)
  const extraBindings = (spec.extra ?? [])
    .filter((chord) => !chord.platforms || chord.platforms.includes(platform))
    .map((chord) => binding(chord.key, chord.mods ?? {}, platform))
  return { binding: primary, extraBindings }
}

/** The bindings of a preset on a platform, in display order. */
export function defaultShortcuts(
  platform: Platform,
  preset: ShortcutPreset = 'chrome'
): Shortcut[] {
  return DEFS.map((def) => {
    const resolved = resolveSpec(def[preset], platform)
    const shortcut: Shortcut = {
      id: def.id,
      action: def.action,
      group: def.group,
      label: def.label,
      binding: resolved.binding,
      extraBindings: resolved.extraBindings
    }
    if (def.unsupported) shortcut.unsupported = true
    if (def.hidden) shortcut.hidden = true
    if (def.layouts) shortcut.layouts = [...def.layouts]
    return shortcut
  })
}

/**
 * Merge a persisted set of user overrides into the defaults (unknown ids are dropped). A chord
 * the user gave one action is taken away from every other action's built-in alternatives, so
 * the user's choice always wins.
 */
export function applyShortcutOverrides(
  defaults: Shortcut[],
  overrides: Record<string, KeyBinding | null>
): Shortcut[] {
  const taken: Array<{ id: string; binding: KeyBinding }> = []
  const merged = defaults.map((s) => {
    if (!Object.prototype.hasOwnProperty.call(overrides, s.id)) return s
    const override = overrides[s.id] ?? null
    if (override) taken.push({ id: s.id, binding: override })
    return { ...s, binding: override }
  })
  if (taken.length === 0) return merged
  return merged.map((s) => {
    const extraBindings = s.extraBindings.filter(
      (extra) => !taken.some((t) => t.id !== s.id && bindingMatches(extra, t.binding))
    )
    return extraBindings.length === s.extraBindings.length ? s : { ...s, extraBindings }
  })
}

/** Return shortcuts whose bindings collide with `candidate` (excluding `exceptId`). */
export function findConflicts(
  shortcuts: Shortcut[],
  candidate: KeyBinding,
  exceptId: string
): Shortcut[] {
  return shortcuts.filter(
    (s) =>
      s.id !== exceptId &&
      (bindingMatches(s.binding, candidate) ||
        s.extraBindings.some((e) => bindingMatches(e, candidate)))
  )
}

/** The chord that runs `action` (its primary binding, else its first alternative), if any. */
export function bindingFor(shortcuts: Shortcut[], action: ShortcutAction): KeyBinding | null {
  for (const s of shortcuts) {
    if (s.action !== action) continue
    if (s.binding) return s.binding
    if (s.extraBindings[0]) return s.extraBindings[0]
  }
  return null
}

/** The chord as tooltips spell it: `Ctrl+Shift+C`, and `⌘⇧C` on macOS. */
export function formatChord(b: KeyBinding, platform: Platform): string {
  const label = formatBinding(b, platform)
  return platform === 'darwin' ? label : label.replace(/ \+ /g, '+')
}

/** `formatChord` of the chord that runs `action`; null when it has none (for tooltips). */
export function shortcutHint(
  shortcuts: Shortcut[],
  action: ShortcutAction,
  platform: Platform
): string | null {
  const b = bindingFor(shortcuts, action)
  return b ? formatChord(b, platform) : null
}

/** `Label (Ctrl+R)` when `action` has a chord, else `Label` – a tooltip that follows the table. */
export function withShortcutHint(
  label: string,
  shortcuts: Shortcut[],
  action: ShortcutAction,
  platform: Platform
): string {
  const hint = shortcutHint(shortcuts, action, platform)
  return hint ? `${label} (${hint})` : label
}

// ---------------------------------------------------------------------------
// Collisions with another browser's defaults
// ---------------------------------------------------------------------------

/** A chord another browser binds, and which Zenium actions do the same thing there. */
export interface ReferenceBinding {
  binding: KeyBinding
  /** What the reference browser does on the chord. */
  label: string
  /** Zenium actions equivalent to it (empty when Zenium has no counterpart). */
  actions: ShortcutAction[]
  /** Which browsers bind it. */
  browsers: Array<'chrome' | 'edge'>
}

export interface Collision {
  shortcut: Shortcut
  /** The colliding chord of the shortcut (its primary binding or one of its alternatives). */
  binding: KeyBinding
  reference: ReferenceBinding
  /** The Zenium action closes or discards something: a switcher would lose work. */
  destructive: boolean
}

/**
 * Every chord of `table` that a reference browser uses for something else: a switcher pressing
 * it gets the Zenium action instead of the one they expect. Pure; the tests run it over both
 * presets on every platform.
 */
export function collisions(table: Shortcut[], reference: ReferenceBinding[]): Collision[] {
  const out: Collision[] = []
  for (const shortcut of table) {
    const chords = shortcut.binding
      ? [shortcut.binding, ...shortcut.extraBindings]
      : shortcut.extraBindings
    for (const chord of chords) {
      for (const ref of reference) {
        if (!bindingMatches(ref.binding, chord) && !bindingMatches(chord, ref.binding)) continue
        if (ref.actions.includes(shortcut.action)) continue
        out.push({
          shortcut,
          binding: chord,
          reference: ref,
          destructive: DESTRUCTIVE_ACTIONS.has(shortcut.action)
        })
      }
    }
  }
  return out
}
