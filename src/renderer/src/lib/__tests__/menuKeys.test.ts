// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UIState } from '@shared/types'

vi.mock('../api', () => ({ cmd: vi.fn(), run: vi.fn(), onEvent: vi.fn(() => () => undefined) }))

import {
  contextMenuAnchor,
  handleMenuKey,
  menuItemLabel,
  menuKeyIntent,
  mnemonicActivates,
  mnemonicKey,
  mnemonicMatch,
  type MenuKeyLike
} from '../menuKeys'
import { browserStore } from '../ui'

/*
 * The keyboard of the chrome's menus (lib/menuKeys.ts; a11y-08): how Shift+F10 and the Menu key
 * ask for a context menu at the focused element, and how a menu the renderer draws answers the
 * arrows, Home/End and a letter – Chromium's `MenuController` rules, the ones Chrome's native
 * menus follow on Windows and Linux.
 */

const key = (k: string, mods: Partial<MenuKeyLike> = {}): MenuKeyLike => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...mods
})

const platform = (p: UIState['platform']): void =>
  browserStore.set({ state: { platform: p } as unknown as UIState })

afterEach(() => {
  browserStore.set({ state: null })
  document.body.innerHTML = ''
})

describe('contextMenuAnchor', () => {
  const event = (init: MouseEventInit & { firesTouchEvents?: boolean }): MouseEvent => {
    const e = new MouseEvent('contextmenu', init)
    if (init.firesTouchEvents !== undefined)
      Object.defineProperty(e, 'sourceCapabilities', {
        value: { firesTouchEvents: init.firesTouchEvents }
      })
    return e
  }

  it("a right-click's menu opens at the pointer, a pointer's menu", () => {
    expect(contextMenuAnchor(event({ button: 2, clientX: 40.4, clientY: 300.6 }))).toEqual({
      x: 40,
      y: 301
    })
  })

  it('Shift+F10 and the Menu key come with no button: at the spot, in keyboard mode', () => {
    // Chromium raises the event at the middle of the focused element with `button` -1 (kNoButton).
    expect(contextMenuAnchor(event({ button: -1, clientX: 120, clientY: 64 }))).toEqual({
      x: 120,
      y: 64,
      keyboard: true
    })
    // Any button but the right one reads the same (a synthetic event's default 0).
    expect(contextMenuAnchor(event({ button: 0, clientX: 1, clientY: 2 }))).toEqual({
      x: 1,
      y: 2,
      keyboard: true
    })
  })

  it("a long-press has no button either but is a finger's: a pointer's menu at the finger", () => {
    expect(
      contextMenuAnchor(event({ button: 0, clientX: 10, clientY: 20, firesTouchEvents: true }))
    ).toEqual({ x: 10, y: 20 })
  })
})

describe('mnemonicKey', () => {
  it('one printable character, Shift allowed, lowercased', () => {
    expect(mnemonicKey(key('c'))).toBe('c')
    expect(mnemonicKey(key('C', { shiftKey: true }))).toBe('c')
    expect(mnemonicKey(key('ü'))).toBe('ü')
  })

  it('not a mnemonic: a named key, Space, or a letter with Control, Alt or Command', () => {
    expect(mnemonicKey(key('ArrowDown'))).toBeNull()
    expect(mnemonicKey(key('Enter'))).toBeNull()
    expect(mnemonicKey(key(' '))).toBeNull()
    expect(mnemonicKey(key('c', { ctrlKey: true }))).toBeNull()
    expect(mnemonicKey(key('c', { altKey: true }))).toBeNull()
    expect(mnemonicKey(key('c', { metaKey: true }))).toBeNull()
  })
})

describe('mnemonicMatch', () => {
  const labels = ['Copy', 'Cut', 'Paste', null, 'Close Tab', 'Delete']

  it("the only item starting with the letter is meant: Chrome's menus run it", () => {
    expect(mnemonicMatch(labels, 'p', -1)).toEqual({ index: 2, unique: true })
    expect(mnemonicMatch(labels, 'd', 0)).toEqual({ index: 5, unique: true })
  })

  it('several: the first match after the current item, round to the first', () => {
    expect(mnemonicMatch(labels, 'c', -1)).toEqual({ index: 0, unique: false })
    expect(mnemonicMatch(labels, 'c', 0)).toEqual({ index: 1, unique: false })
    expect(mnemonicMatch(labels, 'c', 1)).toEqual({ index: 4, unique: false })
    expect(mnemonicMatch(labels, 'c', 4)).toEqual({ index: 0, unique: false })
  })

  it('skips items given as null (disabled, separators) and matches case-insensitively', () => {
    expect(mnemonicMatch(['Alpha', null, 'apple'], 'a', 0)).toEqual({ index: 2, unique: false })
    expect(mnemonicMatch([null, 'Beta'], 'b', -1)).toEqual({ index: 1, unique: true })
  })

  it('no item starts with the letter: null, the key does nothing', () => {
    expect(mnemonicMatch(labels, 'z', 0)).toBeNull()
    expect(mnemonicMatch([], 'a', -1)).toBeNull()
  })
})

describe('menuKeyIntent', () => {
  const labels = ['Open', null, 'Rename…', 'Remove']

  it('Down and Up step over disabled items and wrap', () => {
    expect(menuKeyIntent(key('ArrowDown'), labels, 0)).toEqual({ kind: 'move', index: 2 })
    expect(menuKeyIntent(key('ArrowDown'), labels, 3)).toEqual({ kind: 'move', index: 0 })
    expect(menuKeyIntent(key('ArrowUp'), labels, 2)).toEqual({ kind: 'move', index: 0 })
    expect(menuKeyIntent(key('ArrowUp'), labels, 0)).toEqual({ kind: 'move', index: 3 })
  })

  it('from no highlight (the menu itself has focus) Down starts at the first item, Up at the last', () => {
    expect(menuKeyIntent(key('ArrowDown'), labels, -1)).toEqual({ kind: 'move', index: 0 })
    expect(menuKeyIntent(key('ArrowUp'), labels, -1)).toEqual({ kind: 'move', index: 3 })
  })

  it('Home and End jump to the first and last enabled item', () => {
    expect(menuKeyIntent(key('Home'), [null, 'A', 'B'], 2)).toEqual({ kind: 'move', index: 1 })
    expect(menuKeyIntent(key('End'), ['A', 'B', null], 0)).toEqual({ kind: 'move', index: 1 })
  })

  it('a letter is nothing without mnemonics; with them it moves, and the only match runs off macOS', () => {
    expect(menuKeyIntent(key('r'), labels, 0)).toBeNull()
    expect(menuKeyIntent(key('r'), labels, 0, { mnemonics: true, platform: 'win32' })).toEqual({
      kind: 'move',
      index: 2
    })
    expect(menuKeyIntent(key('o'), labels, 2, { mnemonics: true, platform: 'win32' })).toEqual({
      kind: 'activate',
      index: 0
    })
    expect(menuKeyIntent(key('o'), labels, 2, { mnemonics: true, platform: 'linux' })).toEqual({
      kind: 'activate',
      index: 0
    })
    // macOS menus only highlight what is typed.
    expect(menuKeyIntent(key('o'), labels, 2, { mnemonics: true, platform: 'darwin' })).toEqual({
      kind: 'move',
      index: 0
    })
  })

  it('Enter, Space, Escape and other keys are not the model’s; an all-disabled menu answers nothing', () => {
    expect(menuKeyIntent(key('Enter'), labels, 0)).toBeNull()
    expect(menuKeyIntent(key(' '), labels, 0, { mnemonics: true })).toBeNull()
    expect(menuKeyIntent(key('Escape'), labels, 0)).toBeNull()
    expect(menuKeyIntent(key('ArrowDown'), [null, null], -1)).toBeNull()
  })

  it('mnemonicActivates: Chrome runs a unique match on Windows and Linux, not on macOS', () => {
    expect(mnemonicActivates('win32')).toBe(true)
    expect(mnemonicActivates('linux')).toBe(true)
    expect(mnemonicActivates('darwin')).toBe(false)
    expect(mnemonicActivates(undefined)).toBe(true)
  })
})

describe('handleMenuKey', () => {
  const menu = (
    labels: Array<string | { label: string; disabled?: boolean; name?: string }>
  ): { root: HTMLDivElement; items: HTMLButtonElement[] } => {
    const root = document.createElement('div')
    root.setAttribute('role', 'menu')
    root.tabIndex = -1
    const items = labels.map((entry) => {
      const spec = typeof entry === 'string' ? { label: entry } : entry
      const b = document.createElement('button')
      b.setAttribute('role', 'menuitem')
      if (spec.name) b.setAttribute('aria-label', spec.name)
      b.innerHTML = `<span class="icon"></span><span>${spec.label}</span><span class="hint">Ctrl+X</span>`
      b.disabled = Boolean(spec.disabled)
      root.append(b)
      return b
    })
    document.body.append(root)
    return { root, items }
  }
  const press = (k: string, mods: Partial<KeyboardEventInit> = {}): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', { key: k, cancelable: true, ...mods })
    return e
  }

  it('reads the label as the accessible name, else the text (the hint follows the label)', () => {
    const { items } = menu(['Copy Link', { label: 'x', name: 'Named' }])
    expect(menuItemLabel(items[0])).toBe('Copy LinkCtrl+X')
    expect(menuItemLabel(items[1])).toBe('Named')
  })

  it('arrows and Home/End move focus among the enabled items', () => {
    const { root, items } = menu(['Open', { label: 'Rename', disabled: true }, 'Remove'])
    root.focus()
    let e = press('ArrowDown')
    expect(handleMenuKey(e, items)).toBe(true)
    expect(e.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(items[0])
    e = press('ArrowDown')
    handleMenuKey(e, items)
    expect(document.activeElement).toBe(items[2])
    handleMenuKey(press('Home'), items)
    expect(document.activeElement).toBe(items[0])
    handleMenuKey(press('End'), items)
    expect(document.activeElement).toBe(items[2])
  })

  it('a letter goes to the next item it names, and runs the only one on Windows', () => {
    platform('win32')
    const { items } = menu(['Copy', 'Cut', 'Paste'])
    const clicks = items.map(() => vi.fn())
    items.forEach((el, i) => el.addEventListener('click', clicks[i]))
    items[0].focus()
    expect(handleMenuKey(press('c'), items, { mnemonics: true })).toBe(true)
    expect(document.activeElement).toBe(items[1])
    expect(clicks.some((fn) => fn.mock.calls.length > 0)).toBe(false)
    expect(handleMenuKey(press('p'), items, { mnemonics: true })).toBe(true)
    expect(clicks[2]).toHaveBeenCalledTimes(1)
  })

  it('on macOS the only match is highlighted, not run', () => {
    platform('darwin')
    const { items } = menu(['Copy', 'Paste'])
    const click = vi.fn()
    items[1].addEventListener('click', click)
    items[0].focus()
    handleMenuKey(press('p'), items, { mnemonics: true })
    expect(document.activeElement).toBe(items[1])
    expect(click).not.toHaveBeenCalled()
  })

  it('a letter without mnemonics, a modified letter, or one typed into a text field is not the menu’s', () => {
    platform('win32')
    const { root, items } = menu(['Copy', 'Paste'])
    items[0].focus()
    expect(handleMenuKey(press('p'), items)).toBe(false)
    expect(handleMenuKey(press('p', { ctrlKey: true }), items, { mnemonics: true })).toBe(false)
    expect(document.activeElement).toBe(items[0])
    const field = document.createElement('input')
    root.append(field)
    field.focus()
    expect(handleMenuKey(press('p'), items, { mnemonics: true })).toBe(false)
    expect(document.activeElement).toBe(field)
  })

  it('with `tab`, Tab and Shift+Tab walk the items like the arrows and wrap', () => {
    const { items } = menu(['A', 'B', 'C'])
    items[2].focus()
    expect(handleMenuKey(press('Tab'), items, { tab: true })).toBe(true)
    expect(document.activeElement).toBe(items[0])
    handleMenuKey(press('Tab', { shiftKey: true }), items, { tab: true })
    expect(document.activeElement).toBe(items[2])
    // Without it, Tab is left to the popover's own wrap.
    expect(handleMenuKey(press('Tab'), items)).toBe(false)
  })
})
