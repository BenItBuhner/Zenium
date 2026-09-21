// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MenuDescriptor, MenuItemDescriptor } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))
vi.mock('@renderer/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/ui')>()),
  closeMenu: vi.fn(),
  pickMenuItem: vi.fn()
}))
// Whether the ⋯ was reached with the keyboard (its `:focus-visible` ring), under the test's hand:
// the DOM's own heuristic remembers the last input across a file's tests.
let keyboard = false
vi.mock('@renderer/lib/popover', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/popover')>()),
  openedFromKeyboard: () => keyboard
}))

import { closeMenu, menuAnchor, pickMenuItem } from '@renderer/lib/ui'
import { TabletMenu } from '../TabletMenu'

/*
 * The tablet's popover menu on the chassis's keyboard (v2 §9.20, §9.22; the first-line review's
 * nits on #273): the a11y tree holds the `menuitem` rows straight under `menu` (the `<li>`
 * wrappers are `role="none"`); once placed, the panel takes focus – itself after a finger, its
 * first row when the ⋯ was reached with the keyboard – so the arrows and mnemonics answer from
 * the first key; Escape closes the topmost panel (a cascade first, then the menu); and when the
 * menu goes, focus returns to the control that opened it. Placement itself is tested with
 * `tabletMenuPlacement.test.ts`.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
}

function unmount(): void {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
}

function item(
  id: string,
  label: string,
  submenu: MenuItemDescriptor[] | null = null
): MenuItemDescriptor {
  return { id, type: 'normal', label, enabled: true, checked: false, submenu }
}

const MENU: MenuDescriptor = {
  id: 'm1',
  source: 'app',
  x: 1200,
  y: 40,
  items: [
    item('new-tab', 'New Tab'),
    { id: 'sep', type: 'separator', label: '', enabled: true, checked: false, submenu: null },
    item('bookmarks', 'Bookmarks', [
      item('bm-all', 'All Bookmarks'),
      item('bm-bar', 'Bookmarks Bar')
    ]),
    item('history', 'History')
  ]
}

function panel(depth = 0): HTMLElement {
  const el = document.querySelector<HTMLElement>(`.zen-tablet-menu[data-depth="${depth}"]`)
  if (!el) throw new Error(`no panel at depth ${depth}`)
  return el
}

function rowNamed(label: string): HTMLButtonElement {
  const el = [...document.querySelectorAll<HTMLButtonElement>('.zen-tablet-menu-item')].find(
    (b) => b.textContent?.trim() === label
  )
  if (!el) throw new Error(`no row ${label}`)
  return el
}

function key(target: Element, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

/** The ⋯ the menu hangs from: a real button on a bar, so the anchor resolves as a control. */
let opener: HTMLButtonElement

beforeEach(() => {
  keyboard = false
  vi.mocked(closeMenu).mockClear()
  vi.mocked(pickMenuItem).mockClear()
  const bar = document.createElement('div')
  bar.className = 'zen-tablet-toolbar'
  bar.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:56px'
  opener = document.createElement('button')
  opener.textContent = 'Menu'
  opener.getBoundingClientRect = () =>
    ({
      left: 1232,
      top: 8,
      right: 1272,
      bottom: 48,
      width: 40,
      height: 40,
      x: 1232,
      y: 8
    }) as DOMRect
  bar.appendChild(opener)
  document.body.appendChild(bar)
  menuAnchor.element = opener
  opener.focus()
})

afterEach(() => {
  unmount()
  menuAnchor.element = null
  document.body.innerHTML = ''
})

describe('TabletMenu', () => {
  it('keeps the menuitem rows straight under the menu in the a11y tree', () => {
    render(<TabletMenu menu={MENU} />)
    const menu = panel()
    expect(menu.getAttribute('role')).toBe('menu')
    expect(menu.tabIndex).toBe(-1)
    const wrappers = [...menu.querySelectorAll(':scope > li')]
    expect(wrappers.length).toBe(4)
    for (const li of wrappers) expect(['none', 'separator']).toContain(li.getAttribute('role'))
    expect(menu.querySelectorAll('[role="separator"]').length).toBe(1)
    expect(
      [...menu.querySelectorAll('[role^="menuitem"]')].map((b) => b.textContent?.trim())
    ).toEqual(['New Tab', 'Bookmarks', 'History'])
  })

  it('takes focus itself after a finger, so the arrows work from the first key', () => {
    // A finger's press leaves the ⋯ focused without a visible ring: not from the keyboard.
    render(<TabletMenu menu={MENU} />)
    const menu = panel()
    expect(document.activeElement).toBe(menu)
    key(menu, 'ArrowDown')
    expect(document.activeElement).toBe(rowNamed('New Tab'))
    key(rowNamed('New Tab'), 'End')
    expect(document.activeElement).toBe(rowNamed('History'))
  })

  it('takes its first row when the ⋯ was reached with the keyboard, closes on Escape and hands focus back', () => {
    keyboard = true
    render(<TabletMenu menu={MENU} />)
    expect(document.activeElement).toBe(rowNamed('New Tab'))
    key(document.activeElement!, 'Escape')
    expect(closeMenu).toHaveBeenCalledTimes(1)
    // The chrome closes the menu on the store's word; the panel then goes and focus returns.
    unmount()
    expect(document.activeElement).toBe(opener)
  })

  it('opens a cascade on Right, keeps its keys to itself, and closes it alone on Left or Escape', () => {
    keyboard = true
    render(<TabletMenu menu={MENU} />)
    key(rowNamed('New Tab'), 'ArrowDown')
    const bookmarks = rowNamed('Bookmarks')
    expect(document.activeElement).toBe(bookmarks)
    key(bookmarks, 'ArrowRight')
    const cascade = panel(1)
    expect(bookmarks.getAttribute('aria-expanded')).toBe('true')
    // Opened from the keyboard (the row shows its ring), the cascade takes its first row …
    expect(document.activeElement).toBe(rowNamed('All Bookmarks'))
    // … and its arrows move among its own rows, not the parent's.
    key(rowNamed('All Bookmarks'), 'ArrowDown')
    expect(document.activeElement).toBe(rowNamed('Bookmarks Bar'))
    expect(cascade.contains(document.activeElement)).toBe(true)
    // Left closes the cascade alone and puts focus back on the row that opened it.
    key(document.activeElement!, 'ArrowLeft')
    expect(document.querySelector('.zen-tablet-menu[data-depth="1"]')).toBeNull()
    expect(bookmarks.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(bookmarks)
    expect(closeMenu).not.toHaveBeenCalled()
    // Escape with a cascade up closes the cascade first (the topmost popup), not the menu.
    key(bookmarks, 'ArrowRight')
    expect(document.activeElement).toBe(rowNamed('All Bookmarks'))
    key(document.activeElement!, 'Escape')
    expect(document.querySelector('.zen-tablet-menu[data-depth="1"]')).toBeNull()
    expect(closeMenu).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(bookmarks)
    key(bookmarks, 'Escape')
    expect(closeMenu).toHaveBeenCalledTimes(1)
  })

  it('runs a row on its press and closes the whole menu', () => {
    render(<TabletMenu menu={MENU} />)
    act(() => rowNamed('History').click())
    expect(pickMenuItem).toHaveBeenCalledWith('history')
  })
})
