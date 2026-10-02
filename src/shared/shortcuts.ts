import { S } from './strings'
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

/**
 * One action of the table. Its words are the string table's (`strings/actions.ts`, §9 item 10):
 * `label` is `S.menu(action)`, the Settings page's Title Case; the system helper's sentence form
 * is `S.title(action)`, derived (§9.1) or the entry's own `sentence` where the helper says more
 * than the menu's words ("Jump to the next Space"). No row types a label of its own.
 */
interface Def {
  id: string
  action: ShortcutAction
  group: ShortcutGroup
  /**
   * The helper's words (`Shortcut.helperLabel`) where they are to differ from the table's
   * sentence face. The table's `sentence` is where such words live, so no row sets this; the slot
   * stays as the row shape Android's twin reads (`ShortcutHelperTest`).
   */
  helperLabel?: string
  unsupported?: boolean
  /** Unsupported on these platforms alone: the host has no surface for the action there. */
  unsupportedOn?: Platform[]
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
const META_ALT_SHIFT: Mods = { meta: true, alt: true, shift: true }
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
  // Compact Mode is the desktop layout's (design language v2 §9.36): the phone and the tablet
  // shells have no sidebar or toolbar to fold away, so their listings leave both rows out (the
  // chords still route). A DeX desktop is the desktop layout, and lists them.
  {
    id: 'zen-compact-mode-toggle',
    action: 'compact.toggle',
    group: 'zen-compact-mode',
    layouts: ['desktop'],
    zen: { key: 's', mods: ACCEL },
    chrome: zenFeature('s')
  },
  {
    id: 'zen-compact-mode-show-sidebar',
    action: 'compact.toggleSidebar',
    group: 'zen-compact-mode',
    layouts: ['desktop'],
    zen: { key: 's', mods: ACCEL_ALT },
    chrome: zenFeature('s', true)
  },

  // --- Spaces ---------------------------------------------------------------
  ...Array.from({ length: 10 }, (_, i) => i + 1).map((n): Def => ({
    id: `zen-workspace-switch-${n}`,
    action: `space.switch${n}` as ShortcutAction,
    group: 'zen-workspace',
    ...both({ key: n === 10 ? '0' : String(n), mods: CTRL, platforms: MAC })
  })),
  {
    id: 'zen-workspace-forward',
    action: 'space.next',
    group: 'zen-workspace',
    zen: { key: 'ArrowRight', mods: ACCEL_ALT },
    chrome: zenFeature('ArrowRight')
  },
  {
    id: 'zen-workspace-backward',
    action: 'space.prev',
    group: 'zen-workspace',
    zen: { key: 'ArrowLeft', mods: ACCEL_ALT },
    chrome: zenFeature('ArrowLeft')
  },
  {
    // Zen has this on Ctrl+Shift+K, which duplicates the tab in Edge: too close a call for a
    // chord that closes every unpinned tab, so both presets add Alt.
    id: 'zen-close-all-unpinned-tabs',
    action: 'space.closeUnpinned',
    group: 'zen-workspace',
    destructive: true,
    zen: { key: 'k', mods: ACCEL_ALT_SHIFT },
    chrome: zenFeature('k', true)
  },
  {
    // Added in Zen's shortcut schema v18; unbound by default like upstream.
    id: 'zen-workspace-create',
    action: 'space.new',
    group: 'zen-workspace',
    ...both(UNBOUND)
  },

  // --- Split view ------------------------------------------------------------
  {
    id: 'zen-split-view-grid',
    action: 'split.grid',
    group: 'zen-split-view',
    zen: { key: 'g', mods: ACCEL_ALT },
    chrome: zenFeature('g')
  },
  {
    id: 'zen-split-view-vertical',
    action: 'split.vertical',
    group: 'zen-split-view',
    zen: { key: 'v', mods: ACCEL_ALT },
    chrome: zenFeature('v')
  },
  {
    id: 'zen-split-view-horizontal',
    action: 'split.horizontal',
    group: 'zen-split-view',
    zen: { key: 'h', mods: ACCEL_ALT },
    chrome: zenFeature('h')
  },
  {
    id: 'zen-split-view-unsplit',
    action: 'split.unsplit',
    group: 'zen-split-view',
    zen: { key: 'u', mods: ACCEL_ALT },
    chrome: zenFeature('u')
  },
  {
    id: 'zen-new-empty-split-view',
    action: 'split.newEmpty',
    group: 'zen-split-view',
    ...both({ key: '*', mods: ACCEL_SHIFT })
  },
  {
    // Neither reference browser has a chord for the pane (Chrome's and Edge's F6 rotates the
    // chrome's panes and the pages in turn, which `focus.nextPane` keeps): the space chords with
    // Shift added, one pane along the split's order.
    id: 'zen-split-view-next-pane',
    action: 'split.nextPane',
    group: 'zen-split-view',
    zen: { key: 'ArrowRight', mods: ACCEL_ALT_SHIFT },
    chrome: zenFeature('ArrowRight', true)
  },
  {
    id: 'zen-split-view-previous-pane',
    action: 'split.prevPane',
    group: 'zen-split-view',
    zen: { key: 'ArrowLeft', mods: ACCEL_ALT_SHIFT },
    chrome: zenFeature('ArrowLeft', true)
  },
  {
    // Neither reference browser binds a key to it (Chrome's Reverse position and Edge's Swap
    // are menu rows): unbound in both presets, the row here so the user can give it one.
    id: 'zen-split-view-swap',
    action: 'split.swap',
    group: 'zen-split-view',
    ...both(UNBOUND)
  },

  // --- Zen: other ------------------------------------------------------------
  {
    id: 'zen-copy-url',
    action: 'tab.copyUrl',
    group: 'zen-other',
    zen: { key: 'c', mods: ACCEL_SHIFT },
    chrome: zenFeature('c')
  },
  {
    id: 'zen-copy-url-markdown',
    action: 'tab.copyUrlMarkdown',
    group: 'zen-other',
    zen: { key: 'c', mods: ACCEL_ALT_SHIFT },
    chrome: zenFeature('c', true)
  },
  {
    id: 'zen-toggle-pin-tab',
    action: 'tab.togglePin',
    group: 'zen-other',
    zen: { key: 'd', mods: ACCEL_SHIFT },
    chrome: zenFeature('p')
  },
  {
    id: 'zen-pinned-tab-reset-shortcut',
    action: 'tab.resetPinned',
    group: 'zen-other',
    destructive: true,
    ...both(UNBOUND)
  },
  {
    id: 'zen-toggle-sidebar',
    action: 'sidebar.toggle',
    group: 'zen-other',
    ...both(UNBOUND)
  },
  {
    id: 'zen-glance-expand',
    action: 'glance.expand',
    group: 'zen-other',
    zen: { key: 'o', mods: ACCEL },
    chrome: zenFeature('o')
  },
  {
    id: 'zen-new-unsynced-window',
    action: 'window.newUnsynced',
    group: 'zen-other',
    zen: { key: 'n', mods: ACCEL_SHIFT },
    chrome: zenFeature('n')
  },

  // --- Window & tab management -----------------------------------------------
  {
    id: 'key_newNavigatorTab',
    action: 'tab.new',
    group: 'windowAndTabManagement',
    ...both({ key: 't', mods: ACCEL })
  },
  {
    id: 'key_close',
    action: 'tab.close',
    group: 'windowAndTabManagement',
    destructive: true,
    zen: { key: 'w', mods: ACCEL, extra: [{ key: 'F4', mods: ACCEL }] },
    chrome: { key: 'w', mods: ACCEL, extra: [{ key: 'F4', mods: CTRL, platforms: WINLIN }] }
  },
  {
    id: 'key_undoCloseTab',
    action: 'tab.reopenClosed',
    group: 'windowAndTabManagement',
    ...both({ key: 't', mods: ACCEL_SHIFT })
  },
  {
    // Edge's chord; Chrome has none.
    id: 'zen-duplicate-tab',
    action: 'tab.duplicate',
    group: 'windowAndTabManagement',
    zen: UNBOUND,
    chrome: { key: 'k', mods: ACCEL_SHIFT }
  },
  {
    // Chrome's tab search popover (tabs-17).
    id: 'key_tabSearch',
    action: 'tab.search',
    group: 'windowAndTabManagement',
    zen: UNBOUND,
    chrome: { key: 'a', mods: ACCEL_SHIFT }
  },
  {
    id: 'key_newNavigator',
    action: 'window.new',
    group: 'windowAndTabManagement',
    ...both({ key: 'n', mods: ACCEL })
  },
  {
    id: 'key_privatebrowsing',
    action: 'window.newPrivate',
    group: 'windowAndTabManagement',
    zen: { key: 'p', mods: ACCEL_SHIFT },
    chrome: { key: 'n', mods: ACCEL_SHIFT }
  },
  {
    id: 'key_closeWindow',
    action: 'window.close',
    group: 'windowAndTabManagement',
    destructive: true,
    ...both({ key: 'w', mods: ACCEL_SHIFT })
  },
  {
    id: 'key_minimizeWindow',
    action: 'window.minimize',
    group: 'windowAndTabManagement',
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
    layouts: ['desktop'],
    ...both(UNBOUND)
  },
  {
    // Duplicate Window (session-19) has no chord in either browser; in the table, as the other
    // window rows are, so Settings can bind one and the palette lists it where windows exist.
    id: 'zen-duplicate-window',
    action: 'window.duplicate',
    group: 'windowAndTabManagement',
    ...both(UNBOUND)
  },
  {
    // Chrome quits on Ctrl+Shift+Q (Linux) and Cmd+Q; Zen keeps Firefox's Ctrl+Q.
    id: 'key_quitApplication',
    action: 'app.quit',
    group: 'windowAndTabManagement',
    destructive: true,
    zen: { key: 'q', mods: ACCEL },
    chrome: { key: 'q', mods: ACCEL_SHIFT, perPlatform: { darwin: { key: 'q', mods: META } } }
  },
  {
    id: 'key_appMenu',
    action: 'menu.app',
    group: 'windowAndTabManagement',
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
    ...both({ key: 'Home', mods: ACCEL_SHIFT })
  },
  {
    id: 'key_moveTabToEnd',
    action: 'tab.moveToEnd',
    group: 'windowAndTabManagement',
    ...both({ key: 'End', mods: ACCEL_SHIFT })
  },

  // --- Navigation -------------------------------------------------------------
  {
    // Chrome's History menu says ⌘[ and ⌘] and takes ⌘← and ⌘→ as well (history-14). The arrows
    // are the caret's line-start and line-end keys in a text field, which `KeyboardHandler`
    // leaves them to; the Zen preset keeps to the brackets.
    id: 'goBackKb',
    action: 'nav.back',
    group: 'navigation',
    zen: { key: 'ArrowLeft', mods: ALT, perPlatform: { darwin: { key: '[', mods: META } } },
    chrome: {
      key: 'ArrowLeft',
      mods: ALT,
      perPlatform: { darwin: { key: '[', mods: META } },
      extra: [{ key: 'ArrowLeft', mods: META, platforms: MAC }]
    }
  },
  {
    id: 'goForwardKb',
    action: 'nav.forward',
    group: 'navigation',
    zen: { key: 'ArrowRight', mods: ALT, perPlatform: { darwin: { key: ']', mods: META } } },
    chrome: {
      key: 'ArrowRight',
      mods: ALT,
      perPlatform: { darwin: { key: ']', mods: META } },
      extra: [{ key: 'ArrowRight', mods: META, platforms: MAC }]
    }
  },
  {
    id: 'key_reload',
    action: 'nav.reload',
    group: 'navigation',
    ...both({ key: 'r', mods: ACCEL, extra: [{ key: 'F5' }] })
  },
  {
    id: 'key_reload_skip_cache',
    action: 'nav.reloadSkipCache',
    group: 'navigation',
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
    ...both({ perPlatform: { darwin: { key: '.', mods: META } } })
  },
  {
    // Chrome's and Firefox's F6: the keyboard rotates through the chrome's panes (tab strip,
    // toolbar, bookmarks bar, side panel) and the page. The address bar is the toolbar's stop.
    id: 'key_focusNextPane',
    action: 'focus.nextPane',
    group: 'navigation',
    ...both({ key: 'F6' })
  },
  {
    id: 'key_focusPreviousPane',
    action: 'focus.prevPane',
    group: 'navigation',
    ...both({ key: 'F6', mods: SHIFT })
  },
  {
    // Chrome's Windows and Linux chords; its macOS build has none.
    id: 'key_focusToolbar',
    action: 'focus.toolbar',
    group: 'navigation',
    ...both({ key: 't', mods: ALT_SHIFT, platforms: WINLIN })
  },
  {
    id: 'key_focusBookmarksBar',
    action: 'focus.bookmarksBar',
    group: 'navigation',
    ...both({ key: 'b', mods: ALT_SHIFT, platforms: WINLIN })
  },

  // --- Search & find -----------------------------------------------------------
  {
    // Edge's F4 (Windows and Linux; Ctrl+F4 stays Close Tab) focuses the address bar as well.
    id: 'focusURLBar',
    action: 'urlbar.focus',
    group: 'searchAndFind',
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
    ...both({ key: 'f', mods: ACCEL })
  },
  {
    id: 'key_findAgain',
    action: 'find.next',
    group: 'searchAndFind',
    ...both({ key: 'g', mods: ACCEL, extra: [{ key: 'F3' }] })
  },
  {
    id: 'key_findPrevious',
    action: 'find.prev',
    group: 'searchAndFind',
    ...both({ key: 'g', mods: ACCEL_SHIFT, extra: [{ key: 'F3', mods: SHIFT }] })
  },
  {
    id: 'key_findSelection',
    action: 'find.useSelection',
    group: 'searchAndFind',
    zen: UNBOUND,
    chrome: { key: 'e', mods: META, platforms: MAC }
  },

  // --- Page operations ----------------------------------------------------------
  {
    id: 'key_savePage',
    action: 'page.savePage',
    group: 'pageOperations',
    zen: { key: 's', mods: ACCEL_ALT_SHIFT },
    chrome: { key: 's', mods: ACCEL }
  },
  {
    id: 'openFileKb',
    action: 'page.openFile',
    group: 'pageOperations',
    zen: UNBOUND,
    chrome: { key: 'o', mods: ACCEL }
  },
  {
    // Ctrl+P opens Zenium's print preview (the engine's own flow on a host without one).
    id: 'printKb',
    action: 'page.printPreview',
    group: 'pageOperations',
    ...both({ key: 'p', mods: ACCEL })
  },
  {
    // Chrome's "Print using system dialog…": Ctrl+Shift+P (Cmd+Option+P on a Mac). Zen has no key
    // for it (Ctrl+Shift+P is its private window); the preview's own link reaches it there.
    id: 'printSystemKb',
    action: 'page.print',
    group: 'pageOperations',
    zen: UNBOUND,
    chrome: { key: 'p', mods: ACCEL_SHIFT, perPlatform: { darwin: { key: 'p', mods: META_ALT } } }
  },
  {
    // Android has no source view: the WebView renders no `view-source:` document and the host
    // reports `viewSource: false` (`src/android/platform.ts`), so the row is unsupported there
    // with the DevTools rows below.
    id: 'key_viewSource',
    action: 'page.viewSource',
    group: 'pageOperations',
    unsupportedOn: ['android'],
    zen: { key: 'u', mods: ACCEL },
    chrome: { key: 'u', mods: ACCEL, perPlatform: { darwin: { key: 'u', mods: META_ALT } } }
  },
  {
    id: 'key_fullScreen',
    action: 'page.fullscreen',
    group: 'pageOperations',
    ...both({ key: 'F11', perPlatform: { darwin: { key: 'f', mods: META_CTRL } } })
  },
  {
    id: 'key_toggleReaderMode',
    action: 'page.readerMode',
    group: 'pageOperations',
    zen: { key: 'r', mods: ACCEL_ALT },
    chrome: { key: 'r', mods: ACCEL_ALT, extra: [{ key: 'F9', platforms: WINLIN }] }
  },
  {
    id: 'key_togglePictureInPicture',
    action: 'page.pip',
    group: 'pageOperations',
    ...both({ key: ']', mods: ACCEL_SHIFT })
  },
  // Chrome's and Edge's F7 (CT-34): the one key in both presets, so a switcher's habit holds.
  {
    id: 'key_caretBrowsing',
    action: 'page.caretBrowsing',
    group: 'pageOperations',
    ...both({ key: 'F7' })
  },
  // Ctrl+Shift+S is Firefox's Take Screenshot and Edge's Web capture; Chrome has no chord for
  // either. The Zen preset keeps Firefox's; the Chrome preset gives the chord to Web capture
  // (Edge's, with its overlay) and leaves the one-key screenshot to the menus.
  {
    id: 'key_screenshot',
    action: 'page.screenshot',
    group: 'pageOperations',
    zen: { key: 's', mods: ACCEL_SHIFT },
    chrome: UNBOUND
  },
  {
    id: 'key_webCapture',
    action: 'capture.start',
    group: 'pageOperations',
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
    zen: { key: 'm', mods: ACCEL },
    chrome: { key: 'm', mods: ACCEL, perPlatform: { darwin: { key: 'm', mods: META_CTRL } } }
  },
  {
    id: 'key_emailLink',
    action: 'page.emailLink',
    group: 'pageOperations',
    zen: UNBOUND,
    chrome: { key: 'i', mods: META_SHIFT, platforms: MAC }
  },
  {
    id: 'key_preferencesCmdMac',
    action: 'settings.open',
    group: 'pageOperations',
    ...both({ key: ',', mods: META, platforms: MAC })
  },

  // --- Media & display ----------------------------------------------------------
  {
    id: 'key_fullZoomEnlarge',
    action: 'zoom.in',
    group: 'mediaAndDisplay',
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
    ...both({ key: '-', mods: ACCEL })
  },
  {
    id: 'key_fullZoomReset',
    action: 'zoom.reset',
    group: 'mediaAndDisplay',
    ...both({ key: '0', mods: ACCEL })
  },

  // --- History & bookmarks -------------------------------------------------------
  {
    id: 'addBookmarkAsKb',
    action: 'bookmark.add',
    group: 'historyAndBookmarks',
    ...both({ key: 'd', mods: ACCEL })
  },
  {
    // Firefox and Chrome bind Ctrl+Shift+D here; Zen gave that to "Pin / Unpin Tab".
    id: 'bookmarkAllTabsKb',
    action: 'bookmark.allTabs',
    group: 'historyAndBookmarks',
    zen: UNBOUND,
    chrome: { key: 'd', mods: ACCEL_SHIFT }
  },
  {
    id: 'viewBookmarksSidebarKb',
    action: 'bookmark.sidebar',
    group: 'historyAndBookmarks',
    ...both({ key: 'b', mods: ACCEL })
  },
  {
    // The bookmarks bar is the sidebar layouts' chrome – the desktop's (§9.36) and, under its
    // toolbar row, the tablet's (NTP-34; Chrome 152's tablet bar lists Ctrl+Shift+B in its
    // helper, `KeyboardShortcuts.TOGGLE_BOOKMARK_BAR`); the phone has none to show, so its
    // listing leaves the row out.
    id: 'viewBookmarksToolbarKb',
    action: 'bookmark.toggleBar',
    group: 'historyAndBookmarks',
    layouts: ['desktop', 'tablet'],
    ...both({ key: 'b', mods: ACCEL_SHIFT })
  },
  {
    id: 'manBookmarkKb',
    action: 'bookmark.library',
    group: 'historyAndBookmarks',
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
    ...both({ key: 'h', mods: ACCEL, perPlatform: { darwin: { key: 'y', mods: META } } })
  },
  {
    // Chrome's and Firefox's one chord for it (Firefox's `key_sanitize`, "Clear recent history").
    id: 'key_clearBrowsingData',
    action: 'privacy.clearBrowsingData',
    group: 'historyAndBookmarks',
    ...both({ key: 'Delete', mods: ACCEL_SHIFT })
  },
  {
    id: 'key_openDownloads',
    action: 'downloads.open',
    group: 'historyAndBookmarks',
    zen: {
      key: 'y',
      mods: ACCEL_SHIFT,
      perPlatform: { win32: { key: 'j', mods: CTRL }, darwin: { key: 'j', mods: META } }
    },
    chrome: { key: 'j', mods: ACCEL, perPlatform: { darwin: { key: 'j', mods: META_SHIFT } } }
  },

  // --- Developer tools -----------------------------------------------------------
  // The tablet has no DevTools surface (`capabilities.devtools` is false on Android; the
  // WebView's inspector is the desktop Chrome's remote one): the group's rows are unsupported
  // there until it has one – the chords route and say so, the Settings rows are disabled, the
  // system's shortcut helper leaves them out. Task Manager below is the desktop layout's by
  // `layouts` already; Extensions and Mods opens a page the tablet has.
  {
    id: 'key_toggleToolbox',
    action: 'devtools.toggle',
    group: 'devTools',
    unsupportedOn: ['android'],
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
    unsupportedOn: ['android'],
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
    unsupportedOn: ['android'],
    zen: UNBOUND,
    chrome: { key: 'j', mods: ACCEL_SHIFT, perPlatform: { darwin: { key: 'j', mods: META_ALT } } }
  },
  {
    id: 'key_browserConsole',
    action: 'devtools.browserConsole',
    group: 'devTools',
    unsupportedOn: ['android'],
    zen: { key: 'j', mods: ACCEL_SHIFT },
    chrome: UNBOUND
  },
  {
    id: 'key_taskManager',
    action: 'tasks.open',
    group: 'devTools',
    // Chrome's chord in both presets (`shortcutReference.ts` resolves the row to this action);
    // the page is desktop-only, so the touch shells' listings leave the row out.
    layouts: ['desktop'],
    ...both({ key: 'Escape', mods: SHIFT })
  },
  {
    id: 'key_openAddons',
    action: 'addons.open',
    group: 'devTools',
    zen: { key: 'a', mods: ACCEL_SHIFT },
    chrome: UNBOUND
  },
  {
    // Chrome's Help › Report an issue… (`IDC_FEEDBACK`): ⌥⇧⌘I on macOS (its main menu's chord),
    // Alt+Shift+I on Windows and Linux (`accelerator_table.cc`), both free in Zenium's table
    // until now, so the menu bar's row shows Chrome's chord and the key runs it. Zen (Firefox)
    // has none. The desktop's alone: unbound on Android, and the touch shells' listings leave
    // the row out (they have no Help menu to seat it in).
    id: 'key_reportIssue',
    action: 'help.reportIssue',
    group: 'devTools',
    // The helper's register (TABLET-20): Chrome's own words for the row (`shortcutReference.ts`),
    // no ellipsis; desktop-only, so the phone's and tablet's helper never print it – the field
    // keeps the table's one-register audit whole.
    layouts: ['desktop'],
    zen: UNBOUND,
    chrome: {
      key: 'i',
      mods: ALT_SHIFT,
      platforms: [...WINLIN, ...MAC],
      perPlatform: { darwin: { key: 'i', mods: META_ALT_SHIFT } }
    }
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

/**
 * The rows Chrome's keyboard-shortcuts helper has too. Android's helper prints Chrome's own words
 * for them from its table (`ShortcutHelper.CHROME_ROWS`, with the Select Tab rows Chrome folds
 * into one), so the core sends it none: the set mirrors that table, and `shortcutHelper.test.ts`
 * reads the Kotlin to hold the two equal.
 */
export const CHROMES_HELPER_ROWS: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>([
  'window.new',
  'window.close',
  'tab.new',
  'tab.reopenClosed',
  'window.newPrivate',
  'nav.reload',
  'nav.reloadSkipCache',
  'tab.close',
  'tab.search',
  'tab.next',
  'tab.prev',
  'tab.select1',
  'tab.select2',
  'tab.select3',
  'tab.select4',
  'tab.select5',
  'tab.select6',
  'tab.select7',
  'tab.select8',
  'tab.selectLast',
  'urlbar.focus',
  'urlbar.search',
  'find.open',
  'downloads.open',
  'page.caretBrowsing',
  'history.sidebar',
  'nav.back',
  'nav.forward',
  'privacy.clearBrowsingData',
  'bookmark.add',
  'bookmark.library',
  'bookmark.toggleBar',
  'page.printPreview',
  'page.savePage',
  'zoom.in',
  'zoom.out',
  'zoom.reset',
  'page.viewSource',
  'devtools.toggle',
  'tasks.open'
])

/**
 * The bindings of a preset on a platform, in display order. Every row's words are the string
 * table's: `label` is the act's menu face, the same on every platform (the shortcut reference
 * keeps "Minimise Window" where the mac bar says "Minimize"); `helperLabel` is the sentence face
 * Android's helper prints for Zenium's own rows, carried only where it differs from the label
 * ("Switch to Space 3" and "Expand Glance" read the same in both registers).
 */
export function defaultShortcuts(
  platform: Platform,
  preset: ShortcutPreset = 'chrome'
): Shortcut[] {
  return DEFS.map((def) => {
    const resolved = resolveSpec(def[preset], platform)
    const label = S.menu(def.action)
    const shortcut: Shortcut = {
      id: def.id,
      action: def.action,
      group: def.group,
      label,
      binding: resolved.binding,
      extraBindings: resolved.extraBindings
    }
    const helper = def.helperLabel ?? S.title(def.action)
    if (!CHROMES_HELPER_ROWS.has(def.action) && helper !== label) shortcut.helperLabel = helper
    if (def.unsupported || def.unsupportedOn?.includes(platform)) shortcut.unsupported = true
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
