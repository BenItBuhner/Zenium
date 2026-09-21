// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MenuDescriptor, MenuItemDescriptor } from '@shared/types'
import { MenuSheet } from '../MenuSheet'
import { viewportStore } from '@renderer/lib/formFactor'
import { uiStore } from '@renderer/lib/ui'

/*
 * A descriptor menu on a mouse (`MenuSheet`'s popover pose; design language v2 §5, §6, §9.20,
 * §9.22; shell pass 7(b)), rendered for real in happy-dom: the shared `.zen-v2-menu` panel in
 * the chrome layer with `menuitem` rows, a check in the glyph slot, a submenu row's chevron and
 * `aria-haspopup`; the cascade – Right opens the submenu's level beside on its first row and
 * marks the row expanded, Left and Escape close it onto that row, Escape at the root closes the
 * menu and tells the host; a keyboard open lands on the first row, a pointer open on the panel;
 * a pick tells the host once the menu has been unpainted. Layout is given sizes by hand
 * (happy-dom lays nothing out).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let mount: HTMLElement | null = null
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => undefined)

function render(el: ReactElement): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
}

function item(
  id: string,
  label: string,
  patch: Partial<MenuItemDescriptor> = {}
): MenuItemDescriptor {
  return { id, type: 'normal', label, enabled: true, checked: false, submenu: null, ...patch }
}

function tabMenu(patch: Partial<MenuDescriptor> = {}): MenuDescriptor {
  return {
    id: 'menu_1',
    source: 'tab',
    x: 400,
    y: 300,
    keyboard: false,
    items: [
      item('reload', 'Reload'),
      item('mute', 'Mute Site', { type: 'checkbox', checked: true }),
      item('sep', '', { type: 'separator' }),
      item('move', 'Move Tab to Window', {
        submenu: [item('w1', 'Window 1'), item('w2', 'New Window')]
      }),
      item('close', 'Close Tab', { danger: true })
    ],
    ...patch
  }
}

function show(m: MenuDescriptor): void {
  uiStore.set({ menu: m })
  render(<MenuSheet key={m.id} menu={m} />)
}

const menus = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
const rows = (menu: HTMLElement = menus()[0]): HTMLElement[] => [
  ...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')
]
const rowOf = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-menu-row="${id}"]`)!
const key = (k: string, target: Element = document.activeElement ?? document.body): void => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
}
const click = (el: Element): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
const calls = (name: string): unknown[][] => invoke.mock.calls.filter(([n]) => n === name)

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 260
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 200
  })
  invoke.mockClear()
  Object.assign(window, { zen: { invoke, on: () => () => undefined } })
  viewportStore.set({ ...viewportStore.get(), coarse: false, formFactor: 'desktop' })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  uiStore.set({ menu: null })
  vi.unstubAllGlobals()
})

describe('the popover menu', () => {
  it('is the shared menu in the chrome layer: menuitem rows, the check in the glyph slot, the submenu chevron, the danger row', () => {
    show(tabMenu())
    const [menu] = menus()
    expect(menu.closest('#zen-chrome-layer')).not.toBeNull()
    expect(menu.className).toContain('zen-v2-menu')
    expect(menu.dataset.context).toBe('true')
    expect(rows(menu).map((r) => r.textContent)).toEqual([
      'Reload',
      'Mute Site',
      'Move Tab to Window',
      'Close Tab'
    ])
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(1)
    const mute = rowOf('mute')
    expect(mute.getAttribute('role')).toBe('menuitemcheckbox')
    expect(mute.getAttribute('aria-checked')).toBe('true')
    expect(mute.querySelector('.zen-v2-menu-glyph svg')).not.toBeNull()
    // Every row of a level with a check has the slot, so the labels share one edge.
    expect(rowOf('reload').querySelector('.zen-v2-menu-glyph')).not.toBeNull()
    const move = rowOf('move')
    expect(move.getAttribute('aria-haspopup')).toBe('menu')
    expect(move.getAttribute('aria-expanded')).toBe('false')
    expect(move.querySelector('.zen-v2-menu-chevron')).not.toBeNull()
    expect(rowOf('close').dataset.danger).toBe('true')
  })

  it('the app menu is not a context menu (radius 8, not 6)', () => {
    show(tabMenu({ source: 'app' }))
    expect(menus()[0].dataset.context).toBeUndefined()
  })

  it('opened by the pointer the panel holds the focus and Down starts at the first row; from the keyboard the first row has it', () => {
    show(tabMenu())
    expect(document.activeElement).toBe(menus()[0])
    key('ArrowDown')
    expect(document.activeElement).toBe(rowOf('reload'))
    key('End')
    expect(document.activeElement).toBe(rowOf('close'))
    act(() => root!.unmount())
    root = null
    show(tabMenu({ id: 'menu_2', keyboard: true }))
    expect(document.activeElement).toBe(rowOf('reload'))
  })

  it('Right opens a submenu row’s level beside it on its first row; Left closes it onto the row', () => {
    show(tabMenu({ keyboard: true }))
    key('ArrowDown')
    key('ArrowDown')
    expect(document.activeElement).toBe(rowOf('move'))
    key('ArrowRight')
    expect(menus()).toHaveLength(2)
    expect(rowOf('move').getAttribute('aria-expanded')).toBe('true')
    expect(menus()[1].getAttribute('aria-label')).toBe('Move Tab to Window')
    expect(document.activeElement).toBe(rowOf('w1'))
    key('ArrowLeft')
    expect(menus()).toHaveLength(1)
    expect(document.activeElement).toBe(rowOf('move'))
    expect(uiStore.get().menu).not.toBeNull()
  })

  it('Escape closes the deepest level, then the menu, telling the host', () => {
    show(tabMenu({ keyboard: true }))
    key('ArrowDown')
    key('ArrowDown')
    key('ArrowRight')
    expect(menus()).toHaveLength(2)
    key('Escape')
    expect(menus()).toHaveLength(1)
    expect(uiStore.get().menu).not.toBeNull()
    key('Escape')
    expect(uiStore.get().menu).toBeNull()
    expect(calls('menu.close')).toEqual([['menu.close', { menuId: 'menu_1' }]])
  })

  it('Escape closes the menu onto the control that had the focus as it opened – from the keyboard or the pointer – the page not taking the keyboard; the page takes it back only when it had it (§9.22)', () => {
    const control = document.createElement('button')
    document.body.appendChild(control)
    try {
      control.focus()
      show(tabMenu({ keyboard: true }))
      expect(document.activeElement).toBe(rowOf('reload'))
      key('Escape')
      expect(uiStore.get().menu).toBeNull()
      // The host clears the descriptor; the popover goes with the focus still in it.
      act(() => root!.unmount())
      root = null
      expect(document.activeElement).toBe(control)
      expect(calls('focus.content')).toEqual([])
      // By pointer from the same control (a press focuses the button): the panel has the
      // focus, Escape hands it back to the control all the same.
      show(tabMenu({ id: 'menu_2' }))
      expect(document.activeElement).toBe(menus()[0])
      key('Escape')
      expect(uiStore.get().menu).toBeNull()
      act(() => root!.unmount())
      root = null
      expect(document.activeElement).toBe(control)
      expect(calls('focus.content')).toEqual([])
      // Nothing of the chrome's focused (the page had the keyboard): the page takes it back.
      control.blur()
      expect(document.activeElement).toBe(document.body)
      show(tabMenu({ id: 'menu_3' }))
      expect(document.activeElement).toBe(menus()[0])
      key('Escape')
      expect(uiStore.get().menu).toBeNull()
      expect(calls('focus.content')).toHaveLength(1)
    } finally {
      control.remove()
    }
  })

  it('a letter goes to the row it names, and a pick tells the host once the menu is unpainted', async () => {
    vi.useFakeTimers()
    try {
      show(tabMenu({ keyboard: true }))
      // Close Tab is the one row that starts with a c: off macOS the lone match runs at once.
      key('c')
      expect(uiStore.get().menu).toBeNull()
      await act(async () => {
        await vi.runAllTimersAsync()
      })
      expect(calls('menu.click')).toEqual([['menu.click', { menuId: 'menu_1', itemId: 'close' }]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a click on a plain row picks it; on a submenu row it opens the level', () => {
    show(tabMenu())
    click(rowOf('move'))
    expect(menus()).toHaveLength(2)
    click(rowOf('w2'))
    expect(uiStore.get().menu).toBeNull()
  })

  it('draws a bound row’s chord after its label in the deemphasised ink, before a submenu row’s chevron', () => {
    show(
      tabMenu({
        items: [
          item('new', 'New Tab', { hint: 'Ctrl+T' }),
          item('more', 'More Tools', { hint: 'Ctrl+Shift+M', submenu: [item('x', 'X')] })
        ]
      })
    )
    const hint = rowOf('new').querySelector('.zen-v2-menu-hint')
    expect(hint?.textContent).toBe('Ctrl+T')
    expect(hint?.getAttribute('aria-hidden')).toBe('true')
    expect(rowOf('more').querySelector('.zen-v2-menu-hint + .zen-v2-menu-chevron')).not.toBeNull()
  })

  it('Tab and Shift+Tab walk the rows and wrap: nothing under the menu is reachable (§9.22)', () => {
    show(tabMenu({ keyboard: true }))
    expect(document.activeElement).toBe(rowOf('reload'))
    key('Tab')
    expect(document.activeElement).toBe(rowOf('mute'))
    act(() => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })
    expect(document.activeElement).toBe(rowOf('reload'))
    act(() => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })
    expect(document.activeElement).toBe(rowOf('close'))
    key('Tab')
    expect(document.activeElement).toBe(rowOf('reload'))
  })
})

/*
 * The desktop's app menu (design language v2 §6 "Menus", the #289 verdict): the same popover,
 * hung from the "⋯" button it finds on screen rather than from the point the core named –
 * flush under the toolbar row the button sits in (gap 0), end-aligned since the button is in
 * the row's trailing half – the button wearing `aria-expanded` while it stands; a press on the
 * button closes the menu without
 * reopening it and leaves the keyboard there (§9.22); Escape lands on the button too.
 */
describe('the app menu under ⋯', () => {
  let row: HTMLElement
  let button: HTMLElement
  const rect = (box: { x: number; y: number; width: number; height: number }): DOMRect =>
    ({
      ...box,
      left: box.x,
      top: box.y,
      right: box.x + box.width,
      bottom: box.y + box.height,
      toJSON: () => box
    }) as DOMRect

  const size = { width: window.innerWidth, height: window.innerHeight }

  beforeEach(() => {
    // A 1600 × 1000 window; the toolbar row 8 in from the top edge, 8 tall of padding around its
    // 28 buttons, the "⋯" its last button.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 })
    row = document.createElement('div')
    row.setAttribute('data-bar', '')
    row.getBoundingClientRect = () => rect({ x: 8, y: 8, width: 224, height: 36 })
    button = document.createElement('button')
    button.setAttribute('data-zen-app-menu-button', '')
    button.getBoundingClientRect = () => rect({ x: 200, y: 12, width: 28, height: 28 })
    row.appendChild(button)
    document.body.appendChild(row)
  })

  afterEach(() => {
    row.remove()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: size.width })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: size.height })
  })

  const appMenu = (patch: Partial<MenuDescriptor> = {}): MenuDescriptor =>
    tabMenu({ source: 'app', x: 200, y: 40, keyboard: false, ...patch })

  it('hangs flush under the toolbar row (gap 0), not from the point the core named, and marks the button expanded while it stands', () => {
    show(appMenu())
    const [menu] = menus()
    expect(menu.style.top).toBe('44px')
    // ⋯ is in the row's trailing half, so the box end-aligns – but at a left-hand sidebar the
    // end box (228 − 260 = −32) would cross the window's margin and flips to start on the
    // button's own edge (§9.20's order: align, flip, slide), never sliding off the button.
    expect(menu.style.left).toBe('200px')
    expect(menu.style.width).toBe('260px')
    expect(button.getAttribute('aria-expanded')).toBe('true')
    act(() => root!.unmount())
    root = null
    expect(button.hasAttribute('aria-expanded')).toBe(false)
  })

  it('end-aligns with ⋯ where the end box fits: a right-hand sidebar', () => {
    row.getBoundingClientRect = () => rect({ x: 1368, y: 8, width: 224, height: 36 })
    button.getBoundingClientRect = () => rect({ x: 1560, y: 12, width: 28, height: 28 })
    show(appMenu())
    const [menu] = menus()
    expect(menu.style.top).toBe('44px')
    expect(menu.style.left).toBe(`${1588 - 260}px`)
  })

  it('a press on ⋯ closes the menu without reopening it, the keyboard staying on the button; Escape lands there too', () => {
    button.focus()
    show(appMenu())
    expect(document.activeElement).toBe(menus()[0])
    act(() => {
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    })
    expect(uiStore.get().menu).toBeNull()
    expect(calls('menu.close')).toEqual([['menu.close', { menuId: 'menu_1' }]])
    expect(calls('focus.content')).toEqual([])
    expect(document.activeElement).toBe(button)
    act(() => root!.unmount())
    root = null
    // Opened by pointer with the page holding the keyboard (nothing of the chrome's focused):
    // Escape still lands on the button, the one control the menu belongs to.
    button.blur()
    show(appMenu({ id: 'menu_2' }))
    key('Escape')
    expect(uiStore.get().menu).toBeNull()
    act(() => root!.unmount())
    root = null
    expect(document.activeElement).toBe(button)
    expect(calls('focus.content')).toEqual([])
  })

  it('a press elsewhere in the chrome closes it and the page takes the keyboard back', () => {
    show(appMenu())
    act(() => {
      document.body.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      )
    })
    expect(uiStore.get().menu).toBeNull()
    expect(calls('focus.content')).toHaveLength(1)
  })

  it('without a ⋯ on screen the menu hangs from the point the core named, as a context menu does', () => {
    row.remove()
    show(appMenu({ x: 300, y: 50 }))
    const [menu] = menus()
    expect(menu.style.top).toBe('50px')
    expect(menu.style.left).toBe('300px')
  })
})
