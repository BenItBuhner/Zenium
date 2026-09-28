// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type {
  AutofillPicker,
  MiniMenuRoom,
  MiniMenuSurfaceSize,
  SelectionMenuState,
  UIState
} from '@shared/types'
import { browserStore } from '@renderer/lib/ui'

/*
 * The mini menu over a text selection (CT-39) as the popup surface's document draws it
 * (`PopupSurface`, `MiniMenu`): the document marks itself, draws the picker in front of the
 * pill and the pill alone otherwise; the pill is a toolbar of the button primitive with a glyph
 * and the core's title per chip, in the core's order – or, folded by the core for a narrow view,
 * the whole row as icon buttons with the title as the chrome's tooltip (§9.31's `data-tooltip`,
 * the `Tooltip` host mounted in this document; no toolkit `title`), in the same 46 box (the
 * fold changes the width alone) – tells the core the box it measured with its pose (again for
 * a new list of chips or the other pose) and, folded, the room its tooltips need under the
 * pill for the tooltip's moment alone (asked as a tooltip arms – the mouse pointer on a glyph,
 * or keyboard focus – and given back as the pointer leaves the pill, on a press, on blur, on
 * Escape; none at rest), holds the tooltip's show until the room has landed (§11's paint
 * handshake: the core's word back to the report and this document's frame at the size, or the
 * ceiling), runs a chip's action through the core and dismisses on Escape, the tooltip going
 * first in the one press.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run = vi.fn()
const cmd = vi.fn<(name: string, args: unknown) => Promise<unknown>>()
/** Every call to the core in order, across both channels (`run` and `cmd`), by name. */
const calls: string[] = []
vi.mock('@renderer/lib/api', () => ({
  run: (...args: unknown[]) => {
    calls.push(String(args[0]))
    return run(...args)
  },
  cmd: (name: string, args: unknown) => {
    calls.push(name)
    return cmd(name, args)
  },
  onEvent: () => () => undefined
}))
vi.mock('@renderer/hooks/useTheme', () => ({ useTheme: () => ({ isDark: false }) }))

const { PopupSurface } = await import('../../surface/PopupSurface')
const { MiniMenu } = await import('../MiniMenu')
const {
  TOOLTIP_ATTR,
  TOOLTIP_DELAY,
  TOOLTIP_ID,
  TOOLTIP_ROOM_CEILING_MS,
  tooltip,
  tooltipRoomStore,
  tooltipStore
} = await import('@renderer/lib/tooltip')

/** A report's arguments (`selectionMenu.surfaceSize`'s), as the core reads them. */
interface Report {
  width: number
  height: number
  room?: MiniMenuRoom | null
}

/**
 * The surface's size as the core sets it for a report (`placeMiniMenuSurface`): the pill's box
 * at the surface's 8 padding each side, the room's `below` under it, widened to the room's
 * width – the core's word back (`MiniMenuSurfaceSize`).
 */
const surfaceSizeFor = (report: Report): MiniMenuSurfaceSize => ({
  width: Math.max(report.width + 16, report.room?.width ?? 0),
  height: report.height + 16 + (report.room?.below ?? 0)
})

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
/**
 * The rest of the folded row's layout, for the room its tooltips need: the surface's padding
 * the pill stands at, a glyph button's height and the tooltip probe's box (`measureTooltipSize`
 * draws one in the tooltip's class). Zero until a test lays them out: no room is asked then.
 */
let fold = { pad: 0, chip: 0, tip: { width: 0, height: 0 } }
const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')

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
/** What the pill told the core of its size, report by report (`selectionMenu.surfaceSize`'s args). */
const told = (): unknown[] =>
  cmd.mock.calls.filter(([name]) => name === 'selectionMenu.surfaceSize').map(([, a]) => a)
const pointer = (
  type: 'pointerover' | 'pointerout' | 'pointerdown',
  target: Element,
  relatedTarget: Element | null = null,
  pointerType = 'mouse'
): void => {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, composed: true, pointerType, relatedTarget })
    )
  })
}

beforeEach(() => {
  run.mockReset()
  cmd.mockReset()
  calls.length = 0
  // The core answers a report at once with the surface's size; this document (happy-dom's
  // 1024 × 768 window) is already at any size asked, so a room lands on the word.
  cmd.mockImplementation(async (name, args) =>
    name === 'selectionMenu.surfaceSize' ? surfaceSizeFor(args as Report) : true
  )
  box = { width: 0, height: 0 }
  fold = { pad: 0, chip: 0, tip: { width: 0, height: 0 } }
  // happy-dom lays nothing out: the pill's layout box is what the test says it is.
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute('data-mini-menu')) return box.width
      return this.classList.contains('zen-tooltip') ? fold.tip.width : 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute('data-mini-menu')) return box.height
      if (this.hasAttribute('data-mini-menu-chip')) return fold.chip
      return this.classList.contains('zen-tooltip') ? fold.tip.height : 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-mini-menu') ? fold.pad : 0
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
  if (offsetTop) Object.defineProperty(HTMLElement.prototype, 'offsetTop', offsetTop)
  else delete (HTMLElement.prototype as { offsetTop?: number }).offsetTop
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

  it('folded by the core, draws the whole row as icon buttons – the glyph alone, the title as the chrome’s tooltip and the name, no toolkit title', () => {
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
    // §9.31's one vocabulary: the chrome's tooltip carries the title, as the shells' icon
    // buttons carry theirs; the system's `title` bubble (#635's declared stopgap, while this
    // document mounted no tooltip host) is gone from the popup surface.
    expect(chips().map((c) => c.getAttribute(TOOLTIP_ATTR))).toEqual([
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
      expect(chip.hasAttribute('title')).toBe(false)
      expect(chip.getAttribute('aria-label')).toBe(chip.getAttribute(TOOLTIP_ATTR))
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
    expect(cmd).not.toHaveBeenCalledWith('selectionMenu.surfaceSize', expect.anything())
    box = { width: 412.4, height: 45.6 }
    act(() => root.unmount())
    root = createRoot(container)
    render(<MiniMenu menu={MENU} />)
    expect(cmd).toHaveBeenCalledWith('selectionMenu.surfaceSize', {
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
      cmd.mock.calls.filter(([name]) => name === 'selectionMenu.surfaceSize')
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
      cmd.mock.calls.filter(([name]) => name === 'selectionMenu.surfaceSize').map(([, a]) => a)
    expect(sizes()).toEqual([{ tabId: 't1', width: 300, height: 46, folded: false }])
    // The folded row as the stylesheet draws it: narrower, the same 46 box – and, at rest, no
    // room for its tooltips (its report says so; the tooltip's moment asks it).
    box = { width: 186, height: 46 }
    render(<MiniMenu menu={{ ...MENU, folded: true }} />)
    expect(sizes()).toEqual([
      { tabId: 't1', width: 300, height: 46, folded: false },
      { tabId: 't1', width: 186, height: 46, folded: true, room: null }
    ])
    // The same pose again tells nothing new; the other pose tells its own box again.
    render(<MiniMenu menu={{ ...MENU, folded: true, text: 'foam' }} />)
    expect(sizes()).toHaveLength(2)
    box = { width: 300, height: 46 }
    render(<MiniMenu menu={MENU} />)
    expect(sizes()).toHaveLength(3)
    expect(sizes()[2]).toEqual({ tabId: 't1', width: 300, height: 46, folded: false })
  })

  it('folded, asks the core with its box for the room its tooltips need under the pill the instant a tooltip arms – the mouse pointer’s arrival on a glyph – measured off the tooltip’s own class, and none at rest; the full row asks none', () => {
    // The pill stands at the surface's 8 padding (`MINI_MENU_SURFACE_PAD`, its offset in the
    // document), its 28 glyph buttons centred in the 46 box: a button's bottom is 8 + (46 +
    // 28) / 2 = 45. The host places a tooltip `TOOLTIP_GAP` 8 under its button and keeps it
    // `POPOVER_MARGIN` 8 inside the document; the widest title's tooltip measures 96 × 30 in
    // the tooltip's class (`.zen-tooltip`: 13/20 at 4 8 padding, both hairlines), so the
    // surface needs 45 + 8 + 30 + 8 = 91 against its padded box of 8 + 46 + 8 = 62 – 29 more
    // under the box – and 96 + 2 × 8 across.
    box = { width: 186, height: 46 }
    fold = { pad: 8, chip: 28, tip: { width: 96, height: 30 } }
    render(<MiniMenu menu={{ ...MENU, folded: true }} />)
    // At rest – no pointer, no tooltip – the folded row asks no room: its report says so.
    expect(told()).toEqual([{ tabId: 't1', width: 186, height: 46, folded: true, room: null }])
    // The pointer arrives on a glyph: the tooltip arms (the host's dwell starts from this
    // event), and the room is asked with the same box, at once – before any dwell.
    const [copy, search] = chips()
    pointer('pointerover', search.querySelector('svg')!, pill())
    expect(told()).toHaveLength(2)
    expect(told()[1]).toEqual({
      tabId: 't1',
      width: 186,
      height: 46,
      folded: true,
      room: { below: 29, width: 112 }
    })
    // The probe is gone once measured: nothing in the tooltip's class stands in the document
    // before a tooltip shows.
    expect(document.querySelector('.zen-tooltip')).toBeNull()
    // Browsing the pill – the next glyph, the pill's own padding between – keeps the one room.
    pointer('pointerout', search, copy)
    pointer('pointerover', copy, search)
    pointer('pointerout', copy, pill())
    pointer('pointerover', pill()!, copy)
    expect(told()).toHaveLength(2)
    // The pointer leaves the pill: the room goes with it, the same box told again without.
    pointer('pointerout', pill()!, document.body)
    expect(told()).toHaveLength(3)
    expect(told()[2]).toEqual({ tabId: 't1', width: 186, height: 46, folded: true, room: null })
    // A wider tooltip – a longer engine name – asks a wider surface; the fraction is taken up.
    fold = { ...fold, tip: { width: 130.4, height: 30 } }
    render(<MiniMenu menu={{ ...MENU, folded: true, actions: MENU.actions.slice(0, 2) }} />)
    expect(told()[3]).toEqual({ tabId: 't1', width: 186, height: 46, folded: true, room: null })
    pointer('pointerover', chips()[1], pill())
    expect(told()[4]).toEqual({
      tabId: 't1',
      width: 186,
      height: 46,
      folded: true,
      room: { below: 29, width: 147 }
    })
    // The full row's tooltips are its labels: no room asked, nor said.
    box = { width: 300, height: 46 }
    render(<MiniMenu menu={MENU} />)
    expect(told()[5]).toEqual({ tabId: 't1', width: 300, height: 46, folded: false })
    pointer('pointerover', chips()[1], pill())
    expect(told()).toHaveLength(6)
  })

  it('folded, gives the room back on a press, and asks none for a touch or pen pointer (no tooltip arms for them)', () => {
    box = { width: 186, height: 46 }
    fold = { pad: 8, chip: 28, tip: { width: 96, height: 30 } }
    render(<MiniMenu menu={{ ...MENU, folded: true }} />)
    const [copy] = chips()
    pointer('pointerover', copy, pill(), 'touch')
    pointer('pointerover', copy, pill(), 'pen')
    expect(told()).toHaveLength(1)
    pointer('pointerover', copy, pill())
    expect(told()).toHaveLength(2)
    expect(told()[1]).toMatchObject({ room: { below: 29, width: 112 } })
    // A press takes the tooltip down (the chassis's rule; the action follows): the room goes
    // with it, before the action's own report.
    pointer('pointerdown', copy)
    expect(told()).toHaveLength(3)
    expect(told()[2]).toMatchObject({ room: null })
    click(copy)
    expect(run).toHaveBeenCalledWith('selectionMenu.run', { tabId: 't1', id: 'copy' })
  })

  it('folded, starts over for a pill moved to a new box: the room goes, and comes again with the pointer on a glyph', () => {
    box = { width: 186, height: 46 }
    fold = { pad: 8, chip: 28, tip: { width: 96, height: 30 } }
    render(<MiniMenu menu={{ ...MENU, folded: true }} />)
    pointer('pointerover', chips()[0], pill())
    expect(told()).toHaveLength(2)
    // The selection's box moved (the same words, the same chips): the pointer may be off the
    // pill now, with no `pointerout` to say so – the room is given back, the box not told anew.
    render(<MiniMenu menu={{ ...MENU, folded: true, rect: { ...MENU.rect!, y: 400 } }} />)
    expect(told()).toHaveLength(3)
    expect(told()[2]).toEqual({ tabId: 't1', width: 186, height: 46, folded: true, room: null })
    pointer('pointerover', chips()[0], pill())
    expect(told()).toHaveLength(4)
    expect(told()[3]).toMatchObject({ room: { below: 29, width: 112 } })
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

  it('centres the pill at the top of a surface the core widens and lengthens for its tooltips', () => {
    // The core gives the surface the room the folded row asks (`MiniMenuRoom`) around the
    // pill – under its padded box and, by an even count, at its sides – without moving the
    // pill: the surface's rule centres the pill across and holds it at the top, so it stands
    // on the pixel it had before the room came.
    const css = readFileSync(resolve(__dirname, '../../../assets/selection.css'), 'utf8')
    const rule = /\.zen-mini-menu-surface\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toMatch(/display:\s*flex/)
    expect(rule).toMatch(/justify-content:\s*center/)
    expect(rule).toMatch(/align-items:\s*flex-start/)
  })
})

describe('the folded pill’s tooltips in the popup surface’s document', () => {
  const shown = (): HTMLElement | null => document.getElementById(TOOLTIP_ID)
  /** The tooltip up and painted – not one mounted and waiting, hidden, for its room. */
  const visible = (): boolean => shown()?.style.visibility === 'visible'
  const tick = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }
  const REST = { tabId: 't1', width: 186, height: 46, folded: true, room: null }
  const ROOM = { ...REST, room: { below: 29, width: 112 } }
  /** The surface at the pill's box, and grown for the room: what the core sets, and the document's frame follows. */
  const REST_SURFACE: MiniMenuSurfaceSize = { width: 202, height: 62 }
  const ROOM_SURFACE: MiniMenuSurfaceSize = { width: 202, height: 91 }

  /*
   * The core's side of the handshake, by hand: a report is answered when the test says (`word`),
   * with the surface's size as the core would set it, and this document's frame is brought to
   * that size when the test says (`frame`: the window's inner size and its `resize`) – the two
   * halves of a room's landing, which the tooltip's show waits for. Nothing is answered on its
   * own: a test that lands nothing has the ceiling.
   */
  let pending: Array<{ size: MiniMenuSurfaceSize; say: (size: MiniMenuSurfaceSize) => void }>
  const word = async (): Promise<MiniMenuSurfaceSize> => {
    const last = pending.at(-1)
    if (!last) throw new Error('no report to answer')
    pending = []
    await act(async () => {
      last.say(last.size)
      await Promise.resolve()
    })
    return last.size
  }
  const frame = (size: MiniMenuSurfaceSize): void => {
    act(() => {
      Object.assign(window, { innerWidth: size.width, innerHeight: size.height })
      window.dispatchEvent(new Event('resize'))
    })
  }
  /** The room lands: the word, then the frame at the size it says. */
  const land = async (): Promise<void> => {
    frame(await word())
  }

  beforeEach(() => {
    vi.useFakeTimers()
    pending = []
    cmd.mockImplementation((name, args) => {
      if (name !== 'selectionMenu.surfaceSize') return Promise.resolve(true)
      return new Promise<MiniMenuSurfaceSize>((say) => {
        pending.push({ size: surfaceSizeFor(args as Report), say })
      })
    })
    box = { width: 186, height: 46 }
    fold = { pad: 8, chip: 28, tip: { width: 96, height: 30 } }
    // The document as the core has it at rest: the surface at the pill's padded box.
    Object.assign(window, { innerWidth: REST_SURFACE.width, innerHeight: REST_SURFACE.height })
    browserStore.set({ state: state({ selectionMenu: { ...MENU, folded: true } }) })
    render(<PopupSurface />)
  })
  afterEach(() => {
    tooltip.hide()
    tooltipRoomStore.set({ awaited: false })
    vi.useRealTimers()
  })

  it('shows the action’s title as the chrome’s one role=tooltip after the pointer’s dwell, describing the button by it, and takes it down as the pointer leaves – the room asked as the dwell starts, landed within it, and given back as the pointer leaves the pill', async () => {
    const [copy, search] = chips()
    expect(told()).toEqual([REST])
    pointer('pointerover', search.querySelector('svg')!, pill())
    // The room is asked the instant the tooltip arms, with the whole dwell for the surface to
    // grow in: by the time the tooltip paints, the document has the room under the pill.
    expect(told()).toEqual([REST, ROOM])
    expect(tooltipRoomStore.get().awaited).toBe(true)
    tick(TOOLTIP_DELAY / 2)
    await land()
    expect(tooltipRoomStore.get().awaited).toBe(false)
    expect(window.innerHeight).toBe(ROOM_SURFACE.height)
    tick(TOOLTIP_DELAY / 2 - 1)
    expect(shown()).toBeNull()
    tick(1)
    const tip = shown()!
    expect(tip).not.toBeNull()
    expect(visible()).toBe(true)
    expect(tip.getAttribute('role')).toBe('tooltip')
    expect(tip.textContent).toBe('Search DuckDuckGo')
    expect(tip.closest('.zen-chrome-layer')).not.toBeNull()
    expect(tip.getAttribute('data-surface')).toBe('page')
    expect(search.getAttribute('aria-describedby')).toBe(TOOLTIP_ID)
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1)
    // The next button along takes it at once, in the chassis's browse; the room stands, and
    // so nothing is asked or waited for anew.
    pointer('pointerout', search, copy)
    pointer('pointerover', copy, search)
    expect(shown()!.textContent).toBe('Copy')
    expect(visible()).toBe(true)
    expect(search.hasAttribute('aria-describedby')).toBe(false)
    expect(copy.getAttribute('aria-describedby')).toBe(TOOLTIP_ID)
    expect(told()).toEqual([REST, ROOM])
    // Onto the pill's own padding: the tooltip goes (the chassis's browse window opens), the
    // room stays for the next glyph's tooltip, which would show at once into it.
    pointer('pointerout', copy, pill())
    expect(shown()).toBeNull()
    expect(told()).toEqual([REST, ROOM])
    // Off the pill: the room goes with the pointer, the surface back to the pill's box.
    pointer('pointerout', pill()!, document.body)
    expect(told()).toEqual([REST, ROOM, REST])
    tick(TOOLTIP_DELAY)
    expect(shown()).toBeNull()
    expect(copy.hasAttribute('aria-describedby')).toBe(false)
  })

  it('paints no tooltip before the room has landed: back on a glyph within the chassis’s browse window – the tooltip at once, the room asked anew – it waits hidden for the core’s word and this document’s frame, and shows with the second of them', async () => {
    // The lead's fold (§11's stand-in rule): a tooltip painted into the surface's old bounds
    // is cut at the pill's box for its first frames – the case is a tooltip that shows with
    // no dwell to grow in: the pointer back on the pill within the browse window after leaving
    // it, the room given back and asked anew. The word – the core has set the bounds – is not
    // the landing on its own: this document's frame at the size is, in either order.
    const [copy, search] = chips()
    pointer('pointerover', copy, pill())
    await land()
    tick(TOOLTIP_DELAY)
    expect(visible()).toBe(true)
    // Off the pill: the room goes back, the surface shrinks to the pill's box, the frame with it.
    pointer('pointerout', copy, document.body)
    expect(shown()).toBeNull()
    expect(told()).toEqual([REST, ROOM, REST])
    const rest = await word()
    expect(rest).toEqual(REST_SURFACE)
    frame(rest)
    // Back within the browse window: the chassis shows at once – mounted here, and hidden.
    tick(100)
    pointer('pointerover', search, document.body)
    expect(told()).toEqual([REST, ROOM, REST, ROOM])
    const tip = shown()!
    expect(tip.textContent).toBe('Search DuckDuckGo')
    expect(tip.getAttribute('data-by')).toBe('pointer')
    expect(search.getAttribute('aria-describedby')).toBe(TOOLTIP_ID)
    expect(visible()).toBe(false)
    const size = await word()
    expect(size).toEqual(ROOM_SURFACE)
    // The word alone: this document's frame is still the old bounds.
    expect(visible()).toBe(false)
    frame(size)
    expect(visible()).toBe(true)
    expect(shown()!.textContent).toBe('Search DuckDuckGo')
  })

  it('the frame may land first: the document grown before the word holds the tooltip until the word', async () => {
    const define = chips()[2]
    act(() => define.focus())
    frame(ROOM_SURFACE)
    expect(shown()!.textContent).toBe('Define')
    expect(visible()).toBe(false)
    await word()
    expect(visible()).toBe(true)
  })

  it('keyboard focus follows the same path: the room asked with the focus, the tooltip mounted hidden – no show at once – and shown as the room lands; given back on blur', async () => {
    const define = chips()[2]
    act(() => define.focus())
    expect(told()).toEqual([REST, ROOM])
    const tip = shown()!
    expect(tip.textContent).toBe('Define')
    expect(tip.getAttribute('data-by')).toBe('focus')
    expect(define.getAttribute('aria-describedby')).toBe(TOOLTIP_ID)
    expect(visible()).toBe(false)
    await land()
    expect(visible()).toBe(true)
    expect(shown()!.textContent).toBe('Define')
    act(() => define.blur())
    expect(shown()).toBeNull()
    expect(told()).toEqual([REST, ROOM, REST])
  })

  it('the ceiling: a word that never comes lets the tooltip show regardless after `TOOLTIP_ROOM_CEILING_MS` (the cover report’s 500) – on focus, and on the pointer, whose dwell it ends with', () => {
    expect(TOOLTIP_ROOM_CEILING_MS).toBe(500)
    const [copy, , define] = chips()
    act(() => define.focus())
    expect(visible()).toBe(false)
    tick(TOOLTIP_ROOM_CEILING_MS - 1)
    expect(visible()).toBe(false)
    tick(1)
    expect(visible()).toBe(true)
    expect(shown()!.textContent).toBe('Define')
    act(() => define.blur())
    expect(shown()).toBeNull()
    // The pointer: the ceiling runs from the arm as the dwell does; with no word by the
    // dwell's end the tooltip shows then, into whatever bounds the surface has – and not a
    // frame before it (mounted hidden or not yet mounted, whichever the chassis's browse
    // window says: no paint either way).
    pointer('pointerover', copy, pill())
    expect(tooltipRoomStore.get().awaited).toBe(true)
    tick(TOOLTIP_DELAY - 1)
    expect(visible()).toBe(false)
    expect(tooltipRoomStore.get().awaited).toBe(true)
    tick(1)
    expect(tooltipRoomStore.get().awaited).toBe(false)
    expect(visible()).toBe(true)
    expect(shown()!.textContent).toBe('Copy')
  })

  it('the moment ending before the room lands lets the hold go with the room: nothing waits for a tooltip that is gone', async () => {
    const [copy, , define] = chips()
    act(() => define.focus())
    expect(tooltipRoomStore.get().awaited).toBe(true)
    act(() => define.blur())
    expect(shown()).toBeNull()
    expect(tooltipRoomStore.get().awaited).toBe(false)
    expect(told()).toEqual([REST, ROOM, REST])
    // The late word to the room's report changes nothing: the hold is gone, and the rest
    // report's own word is no room to wait for.
    await word()
    expect(tooltipRoomStore.get().awaited).toBe(false)
    // And the pointer leaving the pill before its dwell has run, the same.
    pointer('pointerover', copy, pill())
    expect(tooltipRoomStore.get().awaited).toBe(true)
    pointer('pointerout', copy, document.body)
    expect(tooltipRoomStore.get().awaited).toBe(false)
    tick(TOOLTIP_DELAY)
    expect(shown()).toBeNull()
  })

  it('leaving the pill straight off a glyph with its tooltip up gives the room back as the tooltip goes', async () => {
    const [copy] = chips()
    pointer('pointerover', copy, pill())
    await land()
    tick(TOOLTIP_DELAY)
    expect(visible()).toBe(true)
    pointer('pointerout', copy, document.body)
    expect(shown()).toBeNull()
    expect(told()).toEqual([REST, ROOM, REST])
  })

  it('keeps its dwell through the resize the room brings: the surface growing under the still pointer is no reason to take the tooltip down', async () => {
    // The core grows the surface for the room (`ElectronWindow.setPopupSurface`), which is a
    // resize of this window: the host in the shells hides for one, this document's host places
    // through it (`PopupSurface` mounts it with `resize="place"`).
    const [, search] = chips()
    pointer('pointerover', search, pill())
    tick(TOOLTIP_DELAY / 2)
    await land()
    tick(TOOLTIP_DELAY / 2)
    expect(shown()!.textContent).toBe('Search DuckDuckGo')
    expect(visible()).toBe(true)
    frame(ROOM_SURFACE)
    expect(shown()!.textContent).toBe('Search DuckDuckGo')
    expect(visible()).toBe(true)
  })

  it('Escape takes the tooltip down first – the room going with it – and dismisses the pill in the one press', async () => {
    // The pill's Escape (`useEscape`) stops the key at the window before the host's document
    // listener hears it, so the pill takes the tooltip down itself before it asks the core to
    // dismiss: the core hears the key with no tooltip up, and the surface at the pill's box.
    const define = chips()[2]
    act(() => define.focus())
    await land()
    expect(visible()).toBe(true)
    const upAtDismiss: unknown[] = []
    run.mockImplementation((name: unknown) => {
      if (name === 'selectionMenu.dismiss') upAtDismiss.push(tooltipStore.get().target)
    })
    act(() => {
      define.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(run).toHaveBeenCalledWith('selectionMenu.dismiss', { tabId: 't1' })
    expect(upAtDismiss).toEqual([null])
    expect(shown()).toBeNull()
    expect(calls.slice(-2)).toEqual(['selectionMenu.surfaceSize', 'selectionMenu.dismiss'])
    expect(told().at(-1)).toEqual(REST)
  })

  it('a press on a button takes the tooltip down as the action runs, as on any control – and the room with it', async () => {
    const [copy] = chips()
    pointer('pointerover', copy, pill())
    await land()
    tick(TOOLTIP_DELAY)
    expect(visible()).toBe(true)
    pointer('pointerdown', copy)
    expect(shown()).toBeNull()
    expect(told()).toEqual([REST, ROOM, REST])
    click(copy)
    expect(run).toHaveBeenCalledWith('selectionMenu.run', { tabId: 't1', id: 'copy' })
  })
})
