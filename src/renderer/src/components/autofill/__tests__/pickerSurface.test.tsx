// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AutofillPicker, PopupSurfaceRoom, PopupSurfaceSize, UIState } from '@shared/types'
import { browserStore } from '@renderer/lib/ui'

/*
 * The autofill picker as the popup surface's document draws it (`PopupSurface`, `PickerSurface`;
 * W8-F18, §9.31): the lock on a row whose fill asks for the passphrase names its meaning by the
 * chrome's tooltip – the `Tooltip` host mounted in this document, no toolkit `title` – and the
 * document asks the core, with its height report (`autofill.surfaceSize`), for the room that
 * tooltip needs beyond the panel's box, for the tooltip's moment alone: asked as a tooltip arms
 * on a control at the panel's edge (the mouse pointer on the lock; a tooltip the store shows),
 * none for a control well inside the panel, given back as the pointer leaves the panel, on a
 * press, on the tooltip going with no pointer on the panel. The show waits for the room to
 * land (§11's paint handshake: the core's word back and this document's frame at the size, or
 * the ceiling). The panel keeps its box through the room: pinned to the surface's size at rest
 * from the core's word, centred in a widened surface.
 *
 * And the lock's meaning for the readers a tooltip never reaches (W8-F19): a visually hidden
 * "Asks for the vault passphrase" inside the lock span – the renderer's `sr-only` – ends a
 * locked row's accessible name, one constant with the tooltip; an unlocked row's name is its
 * text alone.
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
const {
  TOOLTIP_ATTR,
  TOOLTIP_DELAY,
  TOOLTIP_ID,
  TOOLTIP_ROOM_CEILING_MS,
  tooltip,
  tooltipRoomStore,
  tooltipTargetOf
} = await import('@renderer/lib/tooltip')

/** A report's arguments (`autofill.surfaceSize`'s), as the core reads them. */
interface Report {
  id: string
  height: number
  room?: PopupSurfaceRoom | null
}

const PICKER: AutofillPicker = {
  id: 'p1',
  tabId: 't1',
  group: 'login',
  field: 'password',
  anchor: { x: 100, y: 300, width: 200, height: 32 },
  items: [
    { id: 'i1', title: 'ada@example.com', subtitle: '', favicon: null, needsPassphrase: true },
    { id: 'i2', title: 'grace@example.com', subtitle: '', favicon: null },
    { id: 'i3', title: 'linus@example.com', subtitle: '', favicon: null, needsPassphrase: true }
  ],
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
    capabilities: {},
    autofill: { prompts: [], picker: PICKER },
    selectionMenu: null,
    window: { kind: 'normal', fullscreen: false },
    ...over
  } as unknown as UIState
}

/*
 * The layout happy-dom has not: the panel at the surface's 8 padding, 320 wide and `PANEL`
 * tall (its content 2 less, the borders); the tooltip probe's box (`measureTooltipSize` draws
 * one in the tooltip's class); the two locks – the first row's well inside the panel, the last
 * row's at its bottom edge – where their client rects say. The document at rest is the surface
 * at the panel's padded box: 336 × (PANEL + 16).
 */
const PAD = 8
const PANEL = { width: 320, height: 137 }
const TIP = { width: 156, height: 26 }
/** The locks' client rects, by row: the first row's ends at 50, the last row's at 130 – 15 over the panel's bottom edge less the gap and the tooltip. */
const LOCK_BOTTOM: Record<number, number> = { 0: 50, 2: 130 }
let content = { height: PANEL.height - 2 }

const REST_SURFACE: PopupSurfaceSize = {
  width: PANEL.width + 2 * PAD,
  height: PANEL.height + 2 * PAD
}
/**
 * What the last row's lock needs: its tooltip 8 under it (130 + 8 + 26) ends 8 inside the
 * document – 172 – against the document's 153 at rest: 19 more under the box; the tooltip's
 * 156 with 8 each side across, well inside the box's 336.
 */
const ROOM: PopupSurfaceRoom = { below: 19, width: TIP.width + 16 }
const ROOM_SURFACE: PopupSurfaceSize = {
  width: REST_SURFACE.width,
  height: REST_SURFACE.height + ROOM.below
}
const REST: Report = { id: 'p1', height: PANEL.height, room: null }
const ASKED: Report = { ...REST, room: ROOM }

/** The surface's size as the core sets it for a report (`placePickerSurface`): the box, the room under it. */
const surfaceSizeFor = (report: Report): PopupSurfaceSize => ({
  width: Math.max(REST_SURFACE.width, report.room?.width ?? 0),
  height: report.height + 2 * PAD + (report.room?.below ?? 0)
})

const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')
const clientRect = Element.prototype.getBoundingClientRect

const rect = (top: number, height: number, left = 0, width = 0): DOMRect =>
  ({
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({})
  }) as DOMRect

/** The ResizeObservers the document made, so a test can say the content's box changed. */
let observers: Array<() => void> = []
class FakeResizeObserver {
  constructor(callback: () => void) {
    observers.push(callback)
  }
  observe = (): void => undefined
  unobserve = (): void => undefined
  disconnect = (): void => undefined
}

let container: HTMLDivElement
let root: Root
function render(el: ReactElement): void {
  act(() => root.render(el))
}
const popover = (): HTMLElement | null => container.querySelector<HTMLElement>('[role="dialog"]')
const locks = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>(`.zen-v2-af-row-lock[${TOOLTIP_ATTR}]`)
]
const rows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[role="option"]')]
/** What the document told the core of its size, report by report (`autofill.surfaceSize`'s args). */
const told = (): unknown[] =>
  cmd.mock.calls.filter(([name]) => name === 'autofill.surfaceSize').map(([, a]) => a)
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
const shown = (): HTMLElement | null => document.getElementById(TOOLTIP_ID)
/** The tooltip up and painted – not one mounted and waiting, hidden, for its room. */
const visible = (): boolean => shown()?.style.visibility === 'visible'
const tick = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

/*
 * The core's side of the handshake, by hand: a report is answered when the test says (`word`),
 * with the surface's size as the core would set it, and this document's frame is brought to
 * that size when the test says (`frame`). Nothing is answered on its own: a test that lands
 * nothing has the ceiling.
 */
let pending: Array<{ size: PopupSurfaceSize; say: (size: PopupSurfaceSize) => void }>
const word = async (): Promise<PopupSurfaceSize> => {
  const last = pending.at(-1)
  if (!last) throw new Error('no report to answer')
  pending = []
  await act(async () => {
    last.say(last.size)
    await Promise.resolve()
  })
  return last.size
}
const frame = (size: PopupSurfaceSize): void => {
  act(() => {
    Object.assign(window, { innerWidth: size.width, innerHeight: size.height })
    window.dispatchEvent(new Event('resize'))
  })
}
const land = async (): Promise<void> => {
  frame(await word())
}

/** Each test's fake clock starts here, and each starts later than the one before ran to. */
let epoch = 0

beforeEach(() => {
  // The chassis's one controller outlives a test, and reads its browse window
  // (`TOOLTIP_BROWSE` after a pointer leave) off `performance.now()`: faked with the timers
  // (a fresh clock starts at 0), and moved well past a leave at the end of the test before,
  // so no test's first tooltip shows at once for it.
  epoch += 600_000
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'Date',
      'performance'
    ]
  })
  vi.advanceTimersByTime(epoch)
  run.mockReset()
  cmd.mockReset()
  pending = []
  observers = []
  content = { height: PANEL.height - 2 }
  cmd.mockImplementation((name, args) => {
    if (name !== 'autofill.surfaceSize') return Promise.resolve(true)
    return new Promise<PopupSurfaceSize>((say) => {
      pending.push({ size: surfaceSizeFor(args as Report), say })
    })
  })
  Object.assign(globalThis, { ResizeObserver: FakeResizeObserver })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains('zen-v2-af-popover')) return PANEL.width
      return this.classList.contains('zen-tooltip') ? TIP.width : 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains('zen-v2-af-popover')) return PANEL.height
      return this.classList.contains('zen-tooltip') ? TIP.height : 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-v2-af-popover') ? PAD : 0
    }
  })
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (this.classList.contains('zen-v2-af-list'))
      return rect(PAD + 1, content.height, PAD + 1, 318)
    if (this.classList.contains('zen-v2-af-row-lock')) {
      const row = this.closest('[role="option"]')
      const index = row ? [...row.parentElement!.children].indexOf(row) : -1
      const bottom = LOCK_BOTTOM[index] ?? 0
      return rect(bottom - 16, 16, 296, 16)
    }
    return rect(0, 0)
  }
  // The document as the core has it at rest: the surface at the panel's padded box.
  Object.assign(window, { innerWidth: REST_SURFACE.width, innerHeight: REST_SURFACE.height })
  browserStore.set({ state: state({}) })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  render(<PopupSurface />)
})

afterEach(() => {
  tooltip.hide()
  tooltipRoomStore.set({ awaited: false })
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  if (offsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth)
  else delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth
  if (offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight)
  else delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight
  if (offsetTop) Object.defineProperty(HTMLElement.prototype, 'offsetTop', offsetTop)
  else delete (HTMLElement.prototype as { offsetTop?: number }).offsetTop
  Element.prototype.getBoundingClientRect = clientRect
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  delete document.documentElement.dataset.chromeSurface
})

describe('the picker’s tooltips in the popup surface’s document (§9.31, W8-F18)', () => {
  it('draws the picker with its locks carrying the chrome’s tooltip and no title, and tells the core its height at rest – no room', () => {
    expect(popover()).not.toBeNull()
    expect(container.querySelectorAll('[title]')).toHaveLength(0)
    const [first, last] = locks()
    expect(locks()).toHaveLength(2)
    expect(first.getAttribute(TOOLTIP_ATTR)).toBe('Asks for the vault passphrase')
    expect(last.getAttribute(TOOLTIP_ATTR)).toBe('Asks for the vault passphrase')
    expect(told()).toEqual([REST])
    expect(tooltipRoomStore.get().awaited).toBe(false)
  })

  it('shows the lock’s meaning as the chrome’s one role=tooltip after the pointer’s dwell – the room asked as the dwell starts for a lock at the panel’s edge, landed within it, kept while the pointer browses the panel, and given back as the pointer leaves it', async () => {
    const edge = locks()[1]
    pointer('pointerover', edge.querySelector('svg')!, rows()[2])
    // The room is asked the instant the tooltip arms, with the whole dwell for the surface to
    // grow in: by the time the tooltip paints, the document has the room under the panel.
    expect(told()).toEqual([REST, ASKED])
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
    expect(tip.textContent).toBe('Asks for the vault passphrase')
    expect(tip.getAttribute('data-surface')).toBe('page')
    expect(edge.getAttribute('aria-describedby')).toBe(TOOLTIP_ID)
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1)
    // Onto the row's own text: the tooltip goes (the chassis's browse window opens), the room
    // stays for the next lock's tooltip, which would show at once into it.
    pointer('pointerout', edge, rows()[2])
    expect(shown()).toBeNull()
    expect(told()).toEqual([REST, ASKED])
    // Off the panel: the room goes with the pointer, the surface back to the panel's box.
    pointer('pointerout', rows()[2], document.body)
    expect(told()).toEqual([REST, ASKED, REST])
    tick(TOOLTIP_DELAY)
    expect(shown()).toBeNull()
    expect(edge.hasAttribute('aria-describedby')).toBe(false)
  })

  it('asks no room for a lock well inside the panel: its tooltip stands inside the box as it is, nothing is waited for, and it shows on the dwell', () => {
    const inside = locks()[0]
    pointer('pointerover', inside, rows()[0])
    expect(told()).toEqual([REST])
    expect(tooltipRoomStore.get().awaited).toBe(false)
    tick(TOOLTIP_DELAY - 1)
    expect(shown()).toBeNull()
    tick(1)
    expect(visible()).toBe(true)
    expect(shown()!.textContent).toBe('Asks for the vault passphrase')
    // Down the list to the lock at the edge, in the browse: the tooltip at once, and now the
    // room – waited for, hidden, until it lands.
    pointer('pointerout', inside, rows()[1])
    pointer('pointerover', locks()[1], rows()[1])
    expect(told()).toEqual([REST, ASKED])
    expect(shown()).not.toBeNull()
    expect(visible()).toBe(false)
    // Back up to the inside lock: the room is given back, and the tooltip shows at once.
    pointer('pointerout', locks()[1], rows()[1])
    pointer('pointerover', inside, rows()[1])
    expect(told()).toEqual([REST, ASKED, REST])
    expect(tooltipRoomStore.get().awaited).toBe(false)
    expect(visible()).toBe(true)
    pointer('pointerout', inside, document.body)
    expect(told()).toEqual([REST, ASKED, REST])
  })

  it('paints no tooltip before the room has landed: back on the lock within the chassis’s browse window – the tooltip at once, the room asked anew – it waits hidden for the core’s word and this document’s frame, and shows with the second of them, in either order', async () => {
    // §11's stand-in rule: a tooltip painted into the surface's old bounds is cut at the
    // panel's box for its first frames – the case is a tooltip that shows with no dwell to
    // grow in: the pointer back on the lock within the browse window after leaving the panel.
    const edge = locks()[1]
    pointer('pointerover', edge, rows()[2])
    await land()
    tick(TOOLTIP_DELAY)
    expect(visible()).toBe(true)
    // Off the panel: the room goes back, the surface shrinks to the box, the frame with it.
    pointer('pointerout', edge, document.body)
    expect(shown()).toBeNull()
    expect(told()).toEqual([REST, ASKED, REST])
    const rest = await word()
    expect(rest).toEqual(REST_SURFACE)
    frame(rest)
    // Back within the browse window: the chassis shows at once – mounted here, and hidden.
    tick(100)
    pointer('pointerover', edge, document.body)
    expect(told()).toEqual([REST, ASKED, REST, ASKED])
    const tip = shown()!
    expect(tip.textContent).toBe('Asks for the vault passphrase')
    expect(tip.getAttribute('data-by')).toBe('pointer')
    expect(visible()).toBe(false)
    const size = await word()
    expect(size).toEqual(ROOM_SURFACE)
    // The word alone: this document's frame is still the old bounds.
    expect(visible()).toBe(false)
    frame(size)
    expect(visible()).toBe(true)
    // Given back and asked anew, the frame may land first: the document grown before the word
    // holds the tooltip until the word.
    pointer('pointerout', edge, document.body)
    expect(told()).toEqual([REST, ASKED, REST, ASKED, REST])
    frame(await word())
    tick(100)
    pointer('pointerover', edge, document.body)
    expect(visible()).toBe(false)
    frame(ROOM_SURFACE)
    expect(visible()).toBe(false)
    await word()
    expect(visible()).toBe(true)
  })

  it('the ceiling: a word that never comes lets the tooltip show regardless after `TOOLTIP_ROOM_CEILING_MS`, the dwell it ends with', () => {
    expect(TOOLTIP_ROOM_CEILING_MS).toBe(500)
    const edge = locks()[1]
    pointer('pointerover', edge, rows()[2])
    expect(tooltipRoomStore.get().awaited).toBe(true)
    tick(TOOLTIP_ROOM_CEILING_MS - 1)
    expect(visible()).toBe(false)
    expect(tooltipRoomStore.get().awaited).toBe(true)
    tick(1)
    expect(tooltipRoomStore.get().awaited).toBe(false)
    expect(visible()).toBe(true)
    expect(shown()!.textContent).toBe('Asks for the vault passphrase')
  })

  it('the moment ending before the room lands lets the hold go with the room: nothing waits for a tooltip that is gone', async () => {
    const edge = locks()[1]
    pointer('pointerover', edge, rows()[2])
    expect(tooltipRoomStore.get().awaited).toBe(true)
    pointer('pointerout', edge, document.body)
    expect(tooltipRoomStore.get().awaited).toBe(false)
    expect(told()).toEqual([REST, ASKED, REST])
    // The late word to the room's report changes nothing.
    await word()
    expect(tooltipRoomStore.get().awaited).toBe(false)
    tick(TOOLTIP_DELAY)
    expect(shown()).toBeNull()
  })

  it('a press takes the tooltip down as on any control – and the room with it', async () => {
    const edge = locks()[1]
    pointer('pointerover', edge, rows()[2])
    await land()
    tick(TOOLTIP_DELAY)
    expect(visible()).toBe(true)
    pointer('pointerdown', edge)
    expect(shown()).toBeNull()
    expect(told()).toEqual([REST, ASKED, REST])
  })

  it('a tooltip the store shows any other way follows the same path – the room asked, the tooltip hidden until it lands, and given back as the tooltip goes', async () => {
    // The chassis shows at once on keyboard focus; here the show waits the round trip. The lock
    // takes no focus of its own – the controller is told, as the host tells it for a control that does.
    const edge = locks()[1]
    act(() => tooltip.focus(edge))
    expect(told()).toEqual([REST, ASKED])
    expect(shown()!.textContent).toBe('Asks for the vault passphrase')
    expect(visible()).toBe(false)
    await land()
    expect(visible()).toBe(true)
    act(() => tooltip.hide())
    expect(shown()).toBeNull()
    expect(told()).toEqual([REST, ASKED, REST])
  })

  it('only a mouse pointer arms a tooltip and its room (§9.31): a touch on the lock asks nothing', () => {
    pointer('pointerover', locks()[1], rows()[2], 'touch')
    expect(told()).toEqual([REST])
    expect(tooltipRoomStore.get().awaited).toBe(false)
  })

  it('keeps its dwell through the resize the room brings: the surface growing under the still pointer is no reason to take the tooltip down', async () => {
    const edge = locks()[1]
    pointer('pointerover', edge, rows()[2])
    tick(TOOLTIP_DELAY / 2)
    await land()
    tick(TOOLTIP_DELAY / 2)
    expect(visible()).toBe(true)
    frame(ROOM_SURFACE)
    expect(visible()).toBe(true)
    expect(shown()!.textContent).toBe('Asks for the vault passphrase')
  })

  it('pins the panel to the surface’s size at rest from the core’s word – the stylesheet’s 100% until then, the same box – never to the room, and follows the content’s height', async () => {
    const panel = popover()!
    // Before the word: the stylesheet's (`width: 100%; max-height: 100%`).
    expect(panel.style.width).toBe('')
    expect(panel.style.maxHeight).toBe('')
    expect(await word()).toEqual(REST_SURFACE)
    expect(panel.style.width).toBe(`${PANEL.width}px`)
    expect(panel.style.maxHeight).toBe(`${PANEL.height}px`)
    // The room's word pins nothing: the panel keeps its box while the surface has the room.
    pointer('pointerover', locks()[1], rows()[2])
    expect(await word()).toEqual(ROOM_SURFACE)
    expect(panel.style.maxHeight).toBe(`${PANEL.height}px`)
    pointer('pointerout', locks()[1], document.body)
    expect(told()).toEqual([REST, ASKED, REST])
    expect(await word()).toEqual(REST_SURFACE)
    expect(panel.style.maxHeight).toBe(`${PANEL.height}px`)
    // The content grew (the list swapped for a taller step): the report, and the pin with the word.
    content = { height: 175 }
    act(() => observers.forEach((observe) => observe()))
    expect(told().at(-1)).toEqual({ id: 'p1', height: 177, room: null })
    expect(await word()).toEqual({ width: REST_SURFACE.width, height: 177 + 2 * PAD })
    expect(panel.style.maxHeight).toBe('177px')
    expect(panel.style.width).toBe(`${PANEL.width}px`)
  })

  it('the stylesheet: the panel takes the surface’s width and at most its height, centred in one the core widens', () => {
    const css = readFileSync(resolve(__dirname, '../../../assets/autofill.css'), 'utf8')
    const rule = /\.zen-v2-af-surface\s*>\s*\.zen-v2-af-popover\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toMatch(/width:\s*100%/)
    expect(rule).toMatch(/max-height:\s*100%/)
    expect(rule).toMatch(/margin-inline:\s*auto/)
    // No inline width on the panel: the stylesheet's, until the core's word pins it.
    expect(popover()!.getAttribute('style') ?? '').not.toMatch(/width/)
  })
})

describe('the lock’s meaning for a keyboard and a screen reader (W8-F19)', () => {
  const LOCK_MEANING = 'Asks for the vault passphrase'
  /** The row's accessible name, near enough: its label, or – the rows carry none – the text it shows. */
  const nameOf = (el: HTMLElement): string =>
    (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()

  it('ends a locked row’s accessible name with the lock’s sentence – visually hidden text inside the lock span, the glyph hidden from the tree – and leaves an unlocked row’s name its text alone', () => {
    const [locked, unlocked, lockedLast] = rows()
    expect(rows()).toHaveLength(3)
    // Name from content: no label on the option, so what the tree reads is what the row holds.
    for (const row of rows()) expect(row.hasAttribute('aria-label')).toBe(false)
    expect(nameOf(locked).startsWith('ada@example.com')).toBe(true)
    expect(nameOf(locked).endsWith(LOCK_MEANING)).toBe(true)
    expect(nameOf(lockedLast).startsWith('linus@example.com')).toBe(true)
    expect(nameOf(lockedLast).endsWith(LOCK_MEANING)).toBe(true)
    expect(nameOf(unlocked)).toBe('grace@example.com')
    expect(unlocked.querySelector('.zen-v2-af-row-lock')).toBeNull()
    expect(unlocked.querySelector('.sr-only')).toBeNull()
    // The sentence is the lock's own: an `sr-only` span inside the carrier, in the tree (not
    // `aria-hidden`), beside the decorative glyph, which stays out of it.
    const lock = locked.querySelector<HTMLElement>('.zen-v2-af-row-lock')!
    const hidden = lock.querySelector<HTMLElement>('.sr-only')!
    expect(hidden).not.toBeNull()
    expect(hidden.parentElement).toBe(lock)
    expect(hidden.textContent).toBe(LOCK_MEANING)
    expect(hidden.hasAttribute('aria-hidden')).toBe(false)
    expect(lock.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
    // The visible text is untouched: the title span holds the title alone.
    expect(locked.querySelector('.zen-v2-af-row-text')!.textContent).toBe('ada@example.com')
  })

  it('says the same words to a mouse and to the tree: the hidden text is the tooltip’s string – one constant, two readers', () => {
    expect(locks()).toHaveLength(2)
    for (const lock of locks()) {
      const hidden = lock.querySelector<HTMLElement>('.sr-only')!
      expect(hidden.textContent).toBe(lock.getAttribute(TOOLTIP_ATTR))
      // The tooltip host still finds the carrier from the hidden text, as from the glyph.
      expect(tooltipTargetOf(hidden)).toBe(lock)
    }
  })
})
