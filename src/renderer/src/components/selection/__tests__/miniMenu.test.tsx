// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AutofillPicker, SelectionMenuState, UIState } from '@shared/types'
import { browserStore } from '@renderer/lib/ui'

/*
 * The mini menu over a text selection (CT-39) as the popup surface's document draws it
 * (`PopupSurface`, `MiniMenu`): the document marks itself, draws the picker in front of the
 * pill and the pill alone otherwise; the pill is a toolbar of the button primitive with a glyph
 * and the core's title per chip, in the core's order – or, folded by the core for a narrow view,
 * the whole row as icon buttons with the title as the tooltip, in the same 46 box (the fold
 * changes the width alone) – tells the core the box it measured with its pose (again for a new
 * list of chips or the other pose), runs a chip's action through the core and dismisses on
 * Escape.
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
  folded: false,
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
      expect(chip.classList.contains('zen-mini-menu-chip')).toBe(true)
      expect(chip.classList.contains('zen-v2-icon-button')).toBe(false)
      expect(chip.getAttribute('type')).toBe('button')
      expect(chip.hasAttribute('title')).toBe(false)
      const glyph = chip.querySelector('svg')!
      expect(glyph).not.toBeNull()
      expect(glyph.getAttribute('aria-hidden')).toBe('true')
    }
    expect(bar.hasAttribute('data-folded')).toBe(false)
    expect(bar.querySelector('[tabindex]')).toBeNull()
  })

  it('folded by the core, draws the whole row as icon buttons – the glyph alone, the title as the tooltip and the name', () => {
    render(<MiniMenu menu={{ ...MENU, folded: true }} />)
    const bar = pill()!
    expect(bar.hasAttribute('data-folded')).toBe(true)
    expect(bar.getAttribute('role')).toBe('toolbar')
    expect(chips().map((c) => c.getAttribute('data-mini-menu-chip'))).toEqual([
      'copy',
      'search',
      'define',
      'translate',
      'readAloud'
    ])
    expect(chips().map((c) => c.textContent)).toEqual(['', '', '', '', ''])
    expect(chips().map((c) => c.getAttribute('title'))).toEqual([
      'Copy',
      'Search DuckDuckGo',
      'Define',
      'Translate',
      'Listen'
    ])
    for (const chip of chips()) {
      expect(chip.classList.contains('zen-v2-icon-button')).toBe(true)
      expect(chip.classList.contains('zen-v2-button')).toBe(false)
      expect(chip.getAttribute('type')).toBe('button')
      expect(chip.getAttribute('aria-label')).toBe(chip.getAttribute('title'))
      const glyph = chip.querySelector('svg')!
      expect(glyph).not.toBeNull()
      expect(glyph.getAttribute('aria-hidden')).toBe('true')
    }
    // A folded chip runs its action the same way.
    click(chips()[1])
    expect(run).toHaveBeenCalledWith('selectionMenu.run', { tabId: 't1', id: 'search' })
  })

  it('tells the core the layout box it measured (not the pop animation’s scaled one), rounded up, with the pose, and nothing for an empty one', () => {
    render(<MiniMenu menu={MENU} />)
    expect(run).not.toHaveBeenCalledWith('selectionMenu.surfaceSize', expect.anything())
    box = { width: 412.4, height: 45.6 }
    act(() => root.unmount())
    root = createRoot(container)
    render(<MiniMenu menu={MENU} />)
    expect(run).toHaveBeenCalledWith('selectionMenu.surfaceSize', {
      tabId: 't1',
      width: 413,
      height: 46,
      folded: false
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
      { tabId: 't1', width: 300, height: 46, folded: false }
    ])
  })

  it('measures each pose it draws: the folded row’s box is told as folded, the full row’s again on unfolding', () => {
    box = { width: 300, height: 46 }
    render(<MiniMenu menu={MENU} />)
    const sizes = (): unknown[] =>
      run.mock.calls.filter(([name]) => name === 'selectionMenu.surfaceSize').map(([, a]) => a)
    expect(sizes()).toEqual([{ tabId: 't1', width: 300, height: 46, folded: false }])
    // The folded row as the stylesheet draws it: narrower, the same 46 box.
    box = { width: 186, height: 46 }
    render(<MiniMenu menu={{ ...MENU, folded: true }} />)
    expect(sizes()).toEqual([
      { tabId: 't1', width: 300, height: 46, folded: false },
      { tabId: 't1', width: 186, height: 46, folded: true }
    ])
    // The same pose again tells nothing new; the other pose tells its own box again.
    render(<MiniMenu menu={{ ...MENU, folded: true, text: 'foam' }} />)
    expect(sizes()).toHaveLength(2)
    box = { width: 300, height: 46 }
    render(<MiniMenu menu={MENU} />)
    expect(sizes()).toHaveLength(3)
    expect(sizes()[2]).toEqual({ tabId: 't1', width: 300, height: 46, folded: false })
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

  it('keeps the 46 box across the fold: the row is the 32 control band in the stylesheet, the glyph buttons centred in it', () => {
    // The lead's line: the fold changes the pill's width, not its height. The core estimates
    // one height for both poses (`MINI_MENU_HEIGHT`, its own test); the document has to draw
    // it – a row of 28 glyph buttons would stand 28 tall on its own, the box 42. The pill's
    // rule holds the box at the control band plus its 6 padding and its hairlines
    // (`min-height: calc(var(--v2-control) + 2 * 6px + 2 * 1px)` = 46: every box is border-box
    // under the bundle's preflight, so the band alone as the minimum would sit under the 42)
    // and centres its items in it (`align-items: center`) as the capture toolbar centres its
    // 28 close among 32 buttons. The rule sets no box-sizing of its own: the preflight's stands.
    // `__dirname`, not `import.meta.url`: under happy-dom the module URL is the document's.
    const css = readFileSync(resolve(__dirname, '../../../assets/selection.css'), 'utf8')
    const rule = /\.zen-mini-menu\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toMatch(/min-height:\s*calc\(var\(--v2-control\) \+ 2 \* 6px \+ 2 \* 1px\)/)
    expect(rule).toMatch(/align-items:\s*center/)
    expect(rule).not.toMatch(/box-sizing/)
    // No rule of the folded pose overrides the band: the folded chip is the shared icon button
    // as it is (the attribute is named in a comment alone).
    expect(css).not.toMatch(/^[^\n*]*\[data-folded\][^\n{]*\{/m)
  })
})
