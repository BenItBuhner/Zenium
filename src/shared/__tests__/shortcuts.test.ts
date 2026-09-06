import { describe, expect, it } from 'vitest'
import {
  applyShortcutOverrides,
  bindingFromInput,
  defaultShortcuts,
  findConflicts,
  formatBinding,
  matchShortcut
} from '../shortcuts'
import type { KeyBinding } from '../types'

const key = (id: string, platform: 'linux' | 'win32' | 'darwin' = 'linux'): KeyBinding | null =>
  defaultShortcuts(platform).find((s) => s.id === id)?.binding ?? null

const ctrl = (k: string, extra: Partial<KeyBinding> = {}): KeyBinding => ({
  ctrl: true,
  alt: false,
  shift: false,
  meta: false,
  key: k,
  ...extra
})

describe("Zen's default shortcuts (Linux/Windows)", () => {
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

  it('binds the Zen extras: copy URL, pin toggle, glance expand, close unpinned', () => {
    expect(key('zen-copy-url')).toEqual(ctrl('c', { shift: true }))
    expect(key('zen-copy-url-markdown')).toEqual(ctrl('c', { shift: true, alt: true }))
    expect(key('zen-toggle-pin-tab')).toEqual(ctrl('d', { shift: true }))
    expect(key('zen-glance-expand')).toEqual(ctrl('o'))
    expect(key('zen-close-all-unpinned-tabs')).toEqual(ctrl('k', { shift: true }))
  })

  it('moves Save Page to Ctrl+Alt+Shift+S so Ctrl+S is free for compact mode', () => {
    expect(key('key_savePage')).toEqual(ctrl('s', { alt: true, shift: true }))
  })

  it('uses Alt+N for tab selection on Linux and Ctrl+N on Windows', () => {
    expect(key('key_selectTab1', 'linux')).toEqual({
      ctrl: false,
      alt: true,
      shift: false,
      meta: false,
      key: '1'
    })
    expect(key('key_selectTab1', 'win32')).toEqual(ctrl('1'))
  })

  it('does not bind Ctrl+Shift+K to the web console (Zen reuses it)', () => {
    expect(key('key_webconsole')).toBeNull()
  })
})

describe("Zen's default shortcuts (macOS)", () => {
  it('maps accel to Cmd and binds Control+N for space switching', () => {
    expect(key('zen-compact-mode-toggle', 'darwin')).toEqual({
      ctrl: false,
      alt: false,
      shift: false,
      meta: true,
      key: 's'
    })
    expect(key('zen-workspace-switch-1', 'darwin')).toEqual(ctrl('1'))
    expect(key('zen-workspace-switch-10', 'darwin')).toEqual(ctrl('0'))
  })

  it('keeps Ctrl+Tab (not Cmd+Tab) for cycling tabs', () => {
    expect(key('key_nextTab', 'darwin')).toEqual(ctrl('Tab'))
  })
})

describe('matching', () => {
  const shortcuts = defaultShortcuts('linux')

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

  it('applies user overrides and detects conflicts', () => {
    const overridden = applyShortcutOverrides(shortcuts, { 'zen-workspace-switch-1': ctrl('1') })
    expect(overridden.find((s) => s.id === 'zen-workspace-switch-1')?.binding).toEqual(ctrl('1'))
    expect(findConflicts(overridden, ctrl('s'), 'zen-workspace-switch-1').map((s) => s.id)).toEqual(
      ['zen-compact-mode-toggle']
    )
    expect(findConflicts(overridden, ctrl('1'), 'zen-workspace-switch-1')).toEqual([])
  })

  it('formats bindings for display', () => {
    expect(formatBinding(ctrl('ArrowRight', { alt: true }), 'linux')).toBe('Ctrl + Alt + →')
    expect(
      formatBinding({ ctrl: false, alt: true, shift: false, meta: true, key: 's' }, 'darwin')
    ).toBe('⌥⌘S')
    expect(formatBinding(null, 'linux')).toBe('Not set')
  })

  it('builds bindings from DOM-style key events', () => {
    expect(
      bindingFromInput({ key: 'Esc', control: false, alt: false, shift: false, meta: false }).key
    ).toBe('Escape')
  })
})
