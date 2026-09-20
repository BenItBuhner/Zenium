import { describe, expect, it } from 'vitest'
import {
  DESTRUCTIVE_ACTIONS,
  applyShortcutOverrides,
  bindingFor,
  bindingFromInput,
  bindingMatches,
  collisions,
  defaultShortcuts,
  findConflicts,
  formatBinding,
  matchShortcut,
  shortcutHint,
  toAccelerator
} from '../shortcuts'
import { chromeReference } from '../shortcutReference'
import type { KeyBinding, Platform, ShortcutPreset } from '../types'

const PLATFORMS: Platform[] = ['linux', 'win32', 'darwin']

const key = (
  id: string,
  platform: Platform = 'linux',
  preset: ShortcutPreset = 'zen'
): KeyBinding | null => defaultShortcuts(platform, preset).find((s) => s.id === id)?.binding ?? null

const extras = (id: string, platform: Platform, preset: ShortcutPreset): KeyBinding[] =>
  defaultShortcuts(platform, preset).find((s) => s.id === id)?.extraBindings ?? []

const ctrl = (k: string, extra: Partial<KeyBinding> = {}): KeyBinding => ({
  ctrl: true,
  alt: false,
  shift: false,
  meta: false,
  key: k,
  ...extra
})

const cmd = (k: string, extra: Partial<KeyBinding> = {}): KeyBinding => ({
  ctrl: false,
  alt: false,
  shift: false,
  meta: true,
  key: k,
  ...extra
})

const plain = (k: string, extra: Partial<KeyBinding> = {}): KeyBinding => ({
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
  key: k,
  ...extra
})

describe('the Zen preset (Linux/Windows)', () => {
  it('binds compact mode to Ctrl+S and the floating sidebar to Ctrl+Alt+S', () => {
    expect(key('zen-compact-mode-toggle')).toEqual(ctrl('s'))
    expect(key('zen-compact-mode-show-sidebar')).toEqual(ctrl('s', { alt: true }))
  })

  it('binds space navigation to Ctrl+Alt+Arrow and leaves numbered spaces unbound', () => {
    expect(key('zen-workspace-forward')).toEqual(ctrl('ArrowRight', { alt: true }))
    expect(key('zen-workspace-backward')).toEqual(ctrl('ArrowLeft', { alt: true }))
    expect(key('zen-workspace-switch-1')).toBeNull()
  })

  it('binds split view to Ctrl+Alt+G/V/H/U and new empty split to Ctrl+Shift+*', () => {
    expect(key('zen-split-view-grid')).toEqual(ctrl('g', { alt: true }))
    expect(key('zen-split-view-vertical')).toEqual(ctrl('v', { alt: true }))
    expect(key('zen-split-view-horizontal')).toEqual(ctrl('h', { alt: true }))
    expect(key('zen-split-view-unsplit')).toEqual(ctrl('u', { alt: true }))
    expect(key('zen-new-empty-split-view')).toEqual(ctrl('*', { shift: true }))
  })

  it('keeps the Zen extras: copy URL, pin toggle, glance expand, blank window', () => {
    expect(key('zen-copy-url')).toEqual(ctrl('c', { shift: true }))
    expect(key('zen-copy-url-markdown')).toEqual(ctrl('c', { shift: true, alt: true }))
    expect(key('zen-toggle-pin-tab')).toEqual(ctrl('d', { shift: true }))
    expect(key('zen-glance-expand')).toEqual(ctrl('o'))
    expect(key('zen-new-unsynced-window')).toEqual(ctrl('n', { shift: true }))
    expect(key('key_privatebrowsing')).toEqual(ctrl('p', { shift: true }))
  })

  it('moves Close All Unpinned Tabs off Ctrl+Shift+K (Edge duplicates the tab there)', () => {
    expect(key('zen-close-all-unpinned-tabs')).toEqual(ctrl('k', { alt: true, shift: true }))
    expect(key('zen-close-all-unpinned-tabs', 'darwin')).toEqual(
      cmd('k', { alt: true, shift: true })
    )
  })

  it('moves Save Page to Ctrl+Alt+Shift+S so Ctrl+S is free for compact mode', () => {
    expect(key('key_savePage')).toEqual(ctrl('s', { alt: true, shift: true }))
  })

  it('uses Alt+N for tab selection on Linux and Ctrl+N on Windows', () => {
    expect(key('key_selectTab1', 'linux')).toEqual(plain('1', { alt: true }))
    expect(key('key_selectTab1', 'win32')).toEqual(ctrl('1'))
  })

  it('leaves the Chrome-only actions unbound', () => {
    expect(key('key_webconsole')).toBeNull()
    expect(key('bookmarkAllTabsKb')).toBeNull()
    expect(key('openFileKb')).toBeNull()
    expect(key('key_tabSearch')).toBeNull()
    expect(key('key_minimizeWindow', 'darwin')).toBeNull()
  })

  it('opens the application menu on F10 and Alt+F (Windows and Linux only)', () => {
    expect(key('key_appMenu')).toEqual(plain('F10'))
    expect(extras('key_appMenu', 'linux', 'zen')).toEqual([plain('f', { alt: true })])
    expect(key('key_appMenu', 'darwin')).toBeNull()
    expect(extras('key_appMenu', 'darwin', 'zen')).toEqual([])
  })
})

describe('the Zen preset (macOS)', () => {
  it('maps accel to Cmd and binds Control+N for space switching', () => {
    expect(key('zen-compact-mode-toggle', 'darwin')).toEqual(cmd('s'))
    expect(key('zen-workspace-switch-1', 'darwin')).toEqual(ctrl('1'))
    expect(key('zen-workspace-switch-10', 'darwin')).toEqual(ctrl('0'))
  })

  it('keeps Ctrl+Tab (not Cmd+Tab) for cycling tabs', () => {
    expect(key('key_nextTab', 'darwin')).toEqual(ctrl('Tab'))
  })
})

describe('the Chrome preset', () => {
  const chrome = (id: string, platform: Platform = 'linux'): KeyBinding | null =>
    key(id, platform, 'chrome')

  it('is the default table', () => {
    expect(defaultShortcuts('linux')).toEqual(defaultShortcuts('linux', 'chrome'))
  })

  it("resolves the collision rows to Chrome's actions", () => {
    expect(chrome('key_privatebrowsing')).toEqual(ctrl('n', { shift: true }))
    expect(chrome('key_savePage')).toEqual(ctrl('s'))
    expect(chrome('bookmarkAllTabsKb')).toEqual(ctrl('d', { shift: true }))
    expect(chrome('key_inspector')).toEqual(ctrl('c', { shift: true }))
    expect(chrome('key_webconsole')).toEqual(ctrl('j', { shift: true }))
    expect(chrome('openFileKb')).toEqual(ctrl('o'))
    expect(chrome('key_tabSearch')).toEqual(ctrl('a', { shift: true }))
    expect(chrome('zen-duplicate-tab')).toEqual(ctrl('k', { shift: true }))
    expect(extras('printKb', 'linux', 'chrome')).toEqual([ctrl('p', { shift: true })])
    expect(chrome('key_openDownloads', 'linux')).toEqual(ctrl('j'))
    expect(chrome('key_selectTab1', 'linux')).toEqual(ctrl('1'))
    expect(extras('key_reload_skip_cache', 'linux', 'chrome')).toEqual([
      ctrl('F5'),
      plain('F5', { shift: true })
    ])
  })

  it("follows Chrome's macOS menu", () => {
    expect(chrome('key_minimizeWindow', 'darwin')).toEqual(cmd('m'))
    expect(chrome('key_findSelection', 'darwin')).toEqual(cmd('e'))
    expect(chrome('key_emailLink', 'darwin')).toEqual(cmd('i', { shift: true }))
    expect(chrome('key_openDownloads', 'darwin')).toEqual(cmd('j', { shift: true }))
    expect(chrome('key_toggleToolbox', 'darwin')).toEqual(cmd('i', { alt: true }))
    expect(chrome('key_inspector', 'darwin')).toEqual(cmd('c', { alt: true }))
    expect(extras('key_inspector', 'darwin', 'chrome')).toEqual([cmd('c', { shift: true })])
    expect(chrome('key_viewSource', 'darwin')).toEqual(cmd('u', { alt: true }))
    expect(chrome('goHome', 'darwin')).toEqual(cmd('h', { shift: true }))
    expect(chrome('key_search', 'darwin')).toEqual(cmd('f', { alt: true }))
    expect(extras('key_nextTab', 'darwin', 'chrome')).toEqual([
      ctrl('PageDown'),
      cmd('ArrowRight', { alt: true })
    ])
    expect(chrome('key_quitApplication', 'darwin')).toEqual(cmd('q'))
    expect(chrome('key_quitApplication', 'linux')).toEqual(ctrl('q', { shift: true }))
  })

  it('parks the Zen features on Ctrl+Alt (Windows, Linux) and Cmd+Ctrl (macOS)', () => {
    expect(chrome('zen-compact-mode-toggle')).toEqual(ctrl('s', { alt: true }))
    expect(chrome('zen-compact-mode-show-sidebar')).toEqual(ctrl('s', { alt: true, shift: true }))
    expect(chrome('zen-copy-url')).toEqual(ctrl('c', { alt: true }))
    expect(chrome('zen-toggle-pin-tab')).toEqual(ctrl('p', { alt: true }))
    expect(chrome('zen-glance-expand')).toEqual(ctrl('o', { alt: true }))
    expect(chrome('zen-new-unsynced-window')).toEqual(ctrl('n', { alt: true }))
    expect(chrome('zen-workspace-forward', 'darwin')).toEqual(cmd('ArrowRight', { ctrl: true }))
    expect(chrome('zen-split-view-unsplit', 'darwin')).toEqual(cmd('u', { ctrl: true }))
    expect(chrome('zen-close-all-unpinned-tabs')).toEqual(ctrl('k', { alt: true, shift: true }))
    expect(chrome('zen-close-all-unpinned-tabs', 'darwin')).toEqual(
      cmd('k', { ctrl: true, shift: true })
    )
  })

  it('opens the application menu on Alt+F, Alt+E and F10', () => {
    expect(chrome('key_appMenu')).toEqual(plain('f', { alt: true }))
    expect(extras('key_appMenu', 'win32', 'chrome')).toEqual([
      plain('e', { alt: true }),
      plain('F10')
    ])
    expect(chrome('key_appMenu', 'darwin')).toBeNull()
  })

  it('shows the tab search row on Ctrl+Shift+A', () => {
    const search = defaultShortcuts('linux', 'chrome').find((s) => s.id === 'key_tabSearch')
    expect(search?.hidden).toBeUndefined()
    expect(search?.label).toBe('Search Tabs')
    expect(
      matchShortcut(defaultShortcuts('linux', 'chrome'), {
        key: 'A',
        control: true,
        alt: false,
        shift: true,
        meta: false
      })?.action
    ).toBe('tab.search')
  })
})

describe('collisions with Chrome and Edge', () => {
  const describeCollision = (platform: Platform) => (c: ReturnType<typeof collisions>[number]) =>
    `${formatBinding(c.binding, platform)} ${c.shortcut.action} vs ${c.reference.label}`

  it('marks the actions that close or discard something as destructive', () => {
    expect([...DESTRUCTIVE_ACTIONS].sort()).toEqual([
      'app.quit',
      'space.closeUnpinned',
      'tab.close',
      'tab.resetPinned',
      'window.close'
    ])
  })

  it.each(PLATFORMS)('no destructive action collides in either preset on %s', (platform) => {
    for (const preset of ['chrome', 'zen'] as ShortcutPreset[]) {
      const found = collisions(defaultShortcuts(platform, preset), chromeReference(platform))
      expect(found.filter((c) => c.destructive).map(describeCollision(platform))).toEqual([])
    }
  })

  it.each(PLATFORMS)('no chord is bound twice within a preset on %s', (platform) => {
    for (const preset of ['chrome', 'zen'] as ShortcutPreset[]) {
      const table = defaultShortcuts(platform, preset)
      for (const s of table) {
        for (const b of s.binding ? [s.binding, ...s.extraBindings] : s.extraBindings) {
          expect(findConflicts(table, b, s.id).map((c) => `${s.id} & ${c.id}`)).toEqual([])
        }
      }
    }
  })

  it('the Chrome preset has no collisions on Windows and Linux', () => {
    for (const platform of ['linux', 'win32'] as Platform[]) {
      const found = collisions(defaultShortcuts(platform, 'chrome'), chromeReference(platform))
      expect(found.map(describeCollision(platform))).toEqual([])
    }
  })

  it('the Chrome preset on macOS only differs from Edge where Chrome and the OS agree', () => {
    const found = collisions(defaultShortcuts('darwin', 'chrome'), chromeReference('darwin'))
    expect(found.map(describeCollision('darwin'))).toEqual(['⌘M window.minimize vs Mute tab'])
  })

  it('the Zen preset keeps only benign collisions (Linux)', () => {
    const found = collisions(defaultShortcuts('linux', 'zen'), chromeReference('linux'))
    expect(found.map((c) => `${formatBinding(c.binding, 'linux')} ${c.shortcut.action}`)).toEqual([
      'Ctrl + S compact.toggle',
      'Ctrl + Shift + C tab.copyUrl',
      'Ctrl + Shift + D tab.togglePin',
      'Ctrl + O glance.expand',
      'Ctrl + Shift + N window.newUnsynced',
      'Ctrl + Shift + P window.newPrivate',
      'Ctrl + Shift + Y downloads.open',
      'Ctrl + Shift + L devtools.inspector',
      'Ctrl + Shift + J devtools.browserConsole',
      'Ctrl + Shift + A addons.open'
    ])
  })

  it('the Zen preset keeps only benign collisions (macOS)', () => {
    const found = collisions(defaultShortcuts('darwin', 'zen'), chromeReference('darwin'))
    expect(found.map((c) => c.shortcut.action).sort()).toEqual(
      [
        'compact.toggle',
        'space.next',
        'space.prev',
        'split.horizontal',
        'split.unsplit',
        'tab.copyUrl',
        'tab.togglePin',
        'glance.expand',
        'window.newUnsynced',
        'urlbar.search',
        'page.toggleMute',
        'downloads.open',
        'devtools.toggle',
        'devtools.inspector',
        'devtools.browserConsole',
        'addons.open'
      ].sort()
    )
  })

  it('reports the reference chord a Zenium action sits on', () => {
    const [first] = collisions(defaultShortcuts('linux', 'zen'), chromeReference('linux'))
    expect(first.shortcut.id).toBe('zen-compact-mode-toggle')
    expect(first.reference.label).toBe('Save page as')
    expect(first.reference.browsers).toEqual(['chrome', 'edge'])
    expect(first.destructive).toBe(false)
  })
})

describe('matching', () => {
  const shortcuts = defaultShortcuts('linux', 'zen')

  it('matches a keyboard input against the table, normalising letter case', () => {
    const hit = matchShortcut(shortcuts, {
      key: 'S',
      control: true,
      alt: false,
      shift: false,
      meta: false
    })
    expect(hit?.id).toBe('zen-compact-mode-toggle')
  })

  it('matches secondary built-in bindings such as F5 for reload', () => {
    expect(
      matchShortcut(shortcuts, { key: 'F5', control: false, alt: false, shift: false, meta: false })
        ?.id
    ).toBe('key_reload')
    expect(
      matchShortcut(shortcuts, { key: 'F5', control: true, alt: false, shift: false, meta: false })
        ?.id
    ).toBe('key_reload_skip_cache')
  })

  it('ignores bare modifier presses and unknown combinations', () => {
    expect(
      matchShortcut(shortcuts, {
        key: 'Control',
        control: true,
        alt: false,
        shift: false,
        meta: false
      })
    ).toBeNull()
    expect(
      matchShortcut(shortcuts, { key: 'x', control: true, alt: true, shift: true, meta: false })
    ).toBeNull()
  })

  it('treats the shifted spelling of a punctuation key as the same chord', () => {
    // Ctrl+Shift+] arrives as `}` on a US keyboard; the binding is written as `]`.
    expect(
      matchShortcut(shortcuts, { key: '}', control: true, alt: false, shift: true, meta: false })
        ?.id
    ).toBe('key_togglePictureInPicture')
    expect(bindingMatches(ctrl(']', { shift: true }), ctrl('}', { shift: true }))).toBe(true)
    expect(bindingMatches(ctrl('*', { shift: true }), ctrl('8', { shift: true }))).toBe(true)
    expect(bindingMatches(ctrl(']'), ctrl('}'))).toBe(false)
  })

  it('reads the physical key when macOS composed a Cmd+Option chord into a character', () => {
    expect(
      bindingFromInput({
        key: '©',
        code: 'KeyG',
        control: false,
        alt: true,
        shift: false,
        meta: true
      }).key
    ).toBe('g')
    // Without Cmd the character is text (Option+G types ©): left alone.
    expect(
      bindingFromInput({
        key: '©',
        code: 'KeyG',
        control: false,
        alt: true,
        shift: false,
        meta: false
      }).key
    ).toBe('©')
  })

  it('applies user overrides and detects conflicts', () => {
    const overridden = applyShortcutOverrides(shortcuts, { 'zen-workspace-switch-1': ctrl('1') })
    expect(overridden.find((s) => s.id === 'zen-workspace-switch-1')?.binding).toEqual(ctrl('1'))
    expect(findConflicts(overridden, ctrl('s'), 'zen-workspace-switch-1').map((s) => s.id)).toEqual(
      ['zen-compact-mode-toggle']
    )
    expect(findConflicts(overridden, ctrl('1'), 'zen-workspace-switch-1')).toEqual([])
  })

  it("takes a user's chord away from other shortcuts' built-in alternatives", () => {
    const overridden = applyShortcutOverrides(shortcuts, { 'zen-glance-expand': plain('F5') })
    expect(overridden.find((s) => s.id === 'key_reload')?.extraBindings).toEqual([])
    expect(
      matchShortcut(overridden, {
        key: 'F5',
        control: false,
        alt: false,
        shift: false,
        meta: false
      })?.id
    ).toBe('zen-glance-expand')
  })

  it('finds the chord that runs an action, for menus and tooltips', () => {
    expect(bindingFor(shortcuts, 'tab.new')).toEqual(ctrl('t'))
    expect(bindingFor(shortcuts, 'nav.stop')).toBeNull()
    expect(shortcutHint(shortcuts, 'page.readerMode', 'linux')).toBe('Ctrl+Alt+R')
    expect(shortcutHint(defaultShortcuts('darwin', 'chrome'), 'page.readerMode', 'darwin')).toBe(
      '⌥⌘R'
    )
    expect(shortcutHint(shortcuts, 'space.new', 'linux')).toBeNull()
  })

  it('formats bindings for display', () => {
    expect(formatBinding(ctrl('ArrowRight', { alt: true }), 'linux')).toBe('Ctrl + Alt + →')
    expect(formatBinding(cmd('s', { alt: true }), 'darwin')).toBe('⌥⌘S')
    expect(formatBinding(null, 'linux')).toBe('Not set')
  })

  it('formats bindings as Electron accelerators', () => {
    expect(toAccelerator(ctrl('n', { shift: true }))).toBe('Ctrl+Shift+N')
    expect(toAccelerator(cmd('i', { alt: true }))).toBe('Cmd+Alt+I')
    expect(toAccelerator(cmd('s', { ctrl: true }))).toBe('Cmd+Ctrl+S')
    expect(toAccelerator(plain('ArrowLeft', { alt: true }))).toBe('Alt+Left')
    expect(toAccelerator(ctrl('+', { shift: true }))).toBe('Ctrl+Shift+Plus')
    expect(toAccelerator(plain('F11'))).toBe('F11')
    expect(toAccelerator(ctrl(']', { shift: true }))).toBe('Ctrl+Shift+]')
    expect(toAccelerator(null)).toBeNull()
    expect(toAccelerator(plain('MediaPlayPause'))).toBeNull()
  })

  it('builds bindings from DOM-style key events', () => {
    expect(
      bindingFromInput({ key: 'Esc', control: false, alt: false, shift: false, meta: false }).key
    ).toBe('Escape')
  })
})
