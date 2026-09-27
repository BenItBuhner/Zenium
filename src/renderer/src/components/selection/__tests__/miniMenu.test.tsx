// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AutofillPicker, SelectionMenuState, UIState } from '@shared/types'
import { browserStore } from '@renderer/lib/ui'

/*
 * The mini menu over a text selection (CT-39) as the popup surface's document draws it
 * (`PopupSurface`, `MiniMenu`): the document marks itself, draws the picker in front of the
 * pill and the pill alone otherwise; the pill is a toolbar of the button primitive with a glyph
 * and the core's title per chip, in the core's order, tells the core the box it measured (again
 * for a new list of chips), runs a chip's action through the core and dismisses on Escape.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run = vi.fn()
const cmd = vi.fn<(name: string, args: unknown) => Promise<unknown>>()
vi.mock('@renderer/lib/api', () => ({
  run: (...args: unknown[]) => run(...args),
  cmd: (name: string, args: unknown) => cmd(name, args),
  onEvent: () => () => undefined
}))
vi.mock('@renderer/hooks/useTheme', () => ({ useTheme: () => ({ isDark: false }) }))

const { PopupSurface } = await import('../../surface/PopupSurface')
const { MiniMenu } = await import('../MiniMenu')

const MENU: SelectionMenuState = {
  tabId: 't1',
  text: 'quantum foam',
  rect: { x: 100, y: 200, width: 120, height: 18 },
  isEditable: false,
  actions: [
    { id: 'copy', title: 'Copy' },
    { id: 'search', title: 'Search DuckDuckGo' },
    { id: 'define', title: 'Define' },
    { id: 'translate', title: 'Translate' },
    { id: 'readAloud', title: 'Listen' }
  ]
}

const PICKER: AutofillPicker = {
  id: 'p1',
  tabId: 't1',
  group: 'login',
  field: 'username',
  anchor: { x: 100, y: 300, width: 200, height: 32 },
  items: [{ id: 'i1', title: 'ann', subtitle: 'example.com', favicon: null }],
  manageLabel: 'Manage passwords'
}

function state(over: Partial<UIState>): UIState {
  return {
    platform: 'linux',
    tabs: {},
    spaces: [{ id: 's1', activeTabId: null, tabIds: [] }],
    activeSpaceId: 's1',
    essentialTabIds: [],
    settings: {},
    capabilities: { selectionMenu: true },
    autofill: { prompts: [], picker: null },
    selectionMenu: null,
    window: { kind: 'normal', fullscreen: false },
    ...over
  } as unknown as UIState
}

let container: HTMLDivElement
let root: Root
let box = { width: 0, height: 0 }
const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')

function render(el: ReactElement): void {
  act(() => root.render(el))
}
const click = (el: Element | null): void => {
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
const escape = (): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}
const pill = (): HTMLElement | null => container.querySelector<HTMLElement>('[data-mini-menu]')
const chips = (): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>('[data-mini-menu-chip]')
]

beforeEach(() => {
  run.mockClear()
  cmd.mockReset()
  cmd.mockResolvedValue(true)
  box = { width: 0, height: 0 }
  // happy-dom lays nothing out: the pill's layout box is what the test says it is.
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-mini-menu') ? box.width : 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-mini-menu') ? box.height : 0
    }
  })
  browserStore.set({ state: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  if (offsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth)
  else delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth
  if (offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight)
  else delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight
  delete document.documentElement.dataset.chromeSurface
})

describe('the popup surface’s document', () => {
  it('marks its root and draws nothing until the window’s state has come', () => {
    render(<PopupSurface />)
    expect(document.documentElement.dataset.chromeSurface).toBe('popup')
    expect(container.innerHTML).toBe('')
  })

  it('draws the pill for the selection menu, and nothing when there is none', () => {
    browserStore.set({ state: state({ selectionMenu: MENU }) })
    render(<PopupSurface />)
    expect(pill()).not.toBeNull()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    act(() => browserStore.set({ state: state({}) }))
    expect(pill()).toBeNull()
    expect(container.innerHTML).toBe('')
  })

  it('draws the autofill picker in front of the pill, as the core places the surface', () => {
    browserStore.set({
      state: state({
        selectionMenu: MENU,
        autofill: { prompts: [], picker: PICKER } as unknown as UIState['autofill']
      })
    })
    render(<PopupSurface />)
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    expect(pill()).toBeNull()
  })
})

describe('the mini menu', () => {
  it('is a toolbar of the button primitive with a glyph and the core’s title per chip, in its order', () => {
    render(<MiniMenu menu={MENU} />)
    const bar = pill()!
    expect(bar.getAttribute('role')).toBe('toolbar')
    expect(bar.getAttribute('aria-label')).toBe('Selection')
    expect(bar.classList.contains('zen-v2-panel')).toBe(true)
    expect(bar.classList.contains('zen-mini-menu')).toBe(true)
    expect(bar.parentElement!.getAttribute('data-surface')).toBe('page')
    expect(chips().map((c) => c.getAttribute('data-mini-menu-chip'))).toEqual([
      'copy',
      'search',
      'define',
      'translate',
      'readAloud'
    ])
    expect(chips().map((c) => c.textContent)).toEqual([
      'Copy',
      'Search DuckDuckGo',
      'Define',
      'Translate',
      'Listen'
    ])
    for (const chip of chips()) {
      expect(chip.classList.contains('zen-v2-button')).toBe(true)
      expect(chip.getAttribute('type')).toBe('button')
      const glyph = chip.querySelector('svg')!
      expect(glyph).not.toBeNull()
      expect(glyph.getAttribute('aria-hidden')).toBe('true')
    }
    expect(bar.querySelector('[tabindex]')).toBeNull()
  })

  it('tells the core the layout box it measured (not the pop animation’s scaled one), rounded up, and nothing for an empty one', () => {
    render(<MiniMenu menu={MENU} />)
    expect(run).not.toHaveBeenCalledWith('selectionMenu.surfaceSize', expect.anything())
    box = { width: 412.4, height: 45.6 }
    act(() => root.unmount())
    root = createRoot(container)
    render(<MiniMenu menu={MENU} />)
    expect(run).toHaveBeenCalledWith('selectionMenu.surfaceSize', {
      tabId: 't1',
      width: 413,
      height: 46
    })
  })

  it('tells the same box again for a new list of chips, and not for the same list', () => {
    box = { width: 300, height: 46 }
    render(<MiniMenu menu={MENU} />)
    const sizes = (): unknown[] =>
      run.mock.calls.filter(([name]) => name === 'selectionMenu.surfaceSize')
    expect(sizes()).toHaveLength(1)
    render(<MiniMenu menu={{ ...MENU, text: 'foam' }} />)
    expect(sizes()).toHaveLength(1)
    render(<MiniMenu menu={{ ...MENU, actions: MENU.actions.slice(0, 2) }} />)
    expect(sizes()).toHaveLength(2)
    expect(sizes()[1]).toEqual([
      'selectionMenu.surfaceSize',
      { tabId: 't1', width: 300, height: 46 }
    ])
  })

  it('runs a chip’s action through the core for the selection’s tab', () => {
    render(<MiniMenu menu={MENU} />)
    click(chips()[2])
    expect(run).toHaveBeenCalledWith('selectionMenu.run', { tabId: 't1', id: 'define' })
    click(chips()[0])
    expect(run).toHaveBeenCalledWith('selectionMenu.run', { tabId: 't1', id: 'copy' })
  })

  it('dismisses on Escape while its document holds the keyboard', () => {
    render(<MiniMenu menu={MENU} />)
    escape()
    expect(run).toHaveBeenCalledWith('selectionMenu.dismiss', { tabId: 't1' })
  })
})
