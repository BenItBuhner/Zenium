// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { NewTabShortcut, Tab, UIState } from '@shared/types'
import { DEFAULT_NEW_TAB_SETTINGS } from '@shared/newTab'
import { DEFAULT_PRIVACY_SETTINGS, emptyPrivacyStatus } from '@shared/privacy'
import { DEFAULT_SEARCH_ENGINES } from '@shared/search'
import { BLANK_URL } from '@shared/url'

/*
 * The new tab page's shortcuts reordered by hold-and-drag (NTP-06, v2 §11.4): a hold lifts a
 * pinned tile (scale 1.02), the finger carries it 1:1, the draft order follows the slot its
 * centre is nearest and the other tiles glide on the grid's FLIP set; the drop writes
 * `newtab.reorderShortcuts` and the tile glides home, the one in the hand (its cell's data-held)
 * to the end of the glide, a hold meanwhile refused; a hold that lifts without moving is the
 * tile's menu; a most visited tile is not a slot; the touch lost puts the order back, and so
 * does the tile itself leaving the DOM under the finger; under reduced motion the drop is at
 * its slot at once, arriving on the 120 ms fade.
 */

let ranked: Array<{ url: string; title: string; favicon: string | null }> = []
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) =>
  name === 'history.topSites' ? ranked : null
)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { NewTabPage } = await import('../NewTabPage')
const { TILE_LIFT_SCALE } = await import('../tileReorder')

const TAB = {
  id: 'r',
  spaceId: 'space',
  containerId: 'default',
  url: BLANK_URL,
  title: '',
  favicon: null,
  pinned: false,
  essential: false,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  audible: false,
  muted: false,
  discarded: false,
  frozen: false,
  zoom: 1,
  createdAt: 0,
  lastActiveAt: 0
} as unknown as Tab

const PINS: NewTabShortcut[] = ['a', 'b', 'c', 'd'].map((h) => ({
  id: `s-${h}`,
  title: h.toUpperCase(),
  url: `https://${h}.example/`
}))
const url = (h: string): string => `https://${h}.example/`

function stateWith(pins: readonly NewTabShortcut[]): UIState {
  return {
    platform: 'android',
    capabilities: { privateTabs: true },
    tabs: {},
    spaces: [],
    activeSpaceId: 'space',
    folders: {},
    settings: {
      newTab: structuredClone(DEFAULT_NEW_TAB_SETTINGS),
      privacy: structuredClone(DEFAULT_PRIVACY_SETTINGS),
      colorScheme: 'light',
      searchEngineId: 'google',
      phoneBarPosition: 'top'
    },
    searchEngines: DEFAULT_SEARCH_ENGINES,
    newTabShortcuts: pins,
    newTabHiddenHosts: [],
    bookmarks: [],
    privacy: emptyPrivacyStatus()
  } as unknown as UIState
}

// --- the grid's geometry, by hand ----------------------------------------------------------------

/** Four columns of 96 with a 12 gap from x 16, one row at y 300, 80 tall (the caption under the tile). */
const SLOT_W = 96
const SLOT_GAP = 12
const GRID_X = 16
const GRID_Y = 300
const SLOT_H = 80
const slotRect = (i: number): DOMRect =>
  new DOMRect(GRID_X + i * (SLOT_W + SLOT_GAP), GRID_Y, SLOT_W, SLOT_H)
const slotCentre = (i: number): { x: number; y: number } => ({
  x: GRID_X + i * (SLOT_W + SLOT_GAP) + SLOT_W / 2,
  y: GRID_Y + SLOT_H / 2
})

/**
 * Every cell measures at its slot in the grid's DOM order, and a tile at its cell's slot – grown
 * about its centre by a scale its own transform carries, as the browser would give a lifted
 * tile's box; nothing else has a size.
 */
function layOut(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const cell = this.closest<HTMLElement>('li.zen-ntp-site')
    if (!cell || !cell.parentElement) return new DOMRect(0, 0, 0, 0)
    const slot = slotRect([...cell.parentElement.children].indexOf(cell))
    const scale = /scale\(([\d.]+)\)/.exec((this as HTMLElement).style?.transform ?? '')
    if (!scale) return slot
    const k = Number(scale[1])
    return new DOMRect(
      slot.x - (slot.width * (k - 1)) / 2,
      slot.y - (slot.height * (k - 1)) / 2,
      slot.width * k,
      slot.height * k
    )
  })
}

// --- frames and time -----------------------------------------------------------------------------

let frames: Array<(now: number) => void> = []
let now = 1000
const frame = (): void => {
  now += 16
  const batch = frames
  frames = []
  act(() => {
    for (const cb of batch) cb(now)
  })
}
const settle = (): void => {
  for (let i = 0; i < 400 && frames.length; i++) frame()
}
/** Time passes with the finger where it is (the velocity the drop glides from reads it). */
const later = (ms: number): void => {
  now += ms
}
const elapse = (ms: number): void => {
  act(() => void vi.advanceTimersByTime(ms))
}

// --- the finger ----------------------------------------------------------------------------------

const POINTER = 5

function pointer(type: string, target: EventTarget, x: number, y: number): PointerEvent {
  const event = new PointerEvent(type, {
    pointerId: POINTER,
    clientX: x,
    clientY: y,
    button: 0,
    bubbles: true,
    cancelable: true,
    pointerType: 'touch',
    isPrimary: true
  })
  // The touch's own clock is the test's, not the machine's: the velocity reads the stamps.
  Object.defineProperty(event, 'timeStamp', { value: now })
  act(() => void target.dispatchEvent(event))
  return event
}

// --- the page ------------------------------------------------------------------------------------

let root: Root | null = null
let host: HTMLElement | null = null
/** `Element.animate`, which happy-dom has not: the reduced-motion fade is asked of it. */
const animate = vi.fn(() => ({ cancel: () => undefined, finished: Promise.resolve() }))
const hadAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate')

async function render(pins: readonly NewTabShortcut[] = PINS): Promise<void> {
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  act(() =>
    root!.render(createElement(NewTabPage, { state: stateWith(pins), tab: TAB, hidden: false }))
  )
  // The history's answer lands and the grid draws.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const grid = (): HTMLElement => host!.querySelector<HTMLElement>('[aria-label="Most visited"]')!
const cells = (): HTMLElement[] => [...grid().querySelectorAll<HTMLElement>('li.zen-ntp-site')]
/** The grid's tiles by their caption, first to last. */
const order = (): string[] =>
  cells().map((li) => li.querySelector('.zen-ntp-caption')!.textContent ?? '')
const tile = (caption: string): HTMLElement =>
  cells()
    .find((li) => li.querySelector('.zen-ntp-caption')!.textContent === caption)!
    .querySelector<HTMLElement>('button.zen-v2-shortcut')!
const cellOf = (caption: string): HTMLElement => tile(caption).parentElement!
const translateX = (el: HTMLElement): number => {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style.transform)
  return m ? Number(m[1]) : 0
}
const commands = (name: string): unknown[] =>
  invoke.mock.calls.filter(([n]) => n === name).map(([, args]) => args)

/** Hold the tile until it lifts; the finger is at its slot's centre. */
function pickUp(caption: string): { x: number; y: number } {
  const at = slotCentre(order().indexOf(caption))
  const el = tile(caption)
  el.setPointerCapture = vi.fn()
  pointer('pointerdown', el, at.x, at.y)
  elapse(380)
  return at
}

beforeEach(() => {
  vi.useFakeTimers()
  frames = []
  now = 1000
  vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
    frames.push(cb)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.splice(id - 1, 1)
  })
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  invoke.mockClear()
  animate.mockClear()
  HTMLElement.prototype.animate = animate as unknown as HTMLElement['animate']
  ranked = []
  layOut()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  if (hadAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', hadAnimate)
  else Reflect.deleteProperty(HTMLElement.prototype, 'animate')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('reordering the shortcuts by hold-and-drag', () => {
  it('a hold lifts a pinned tile over 120 ms at scale 1.02, out of the FLIP set; a lift without a move is the menu', async () => {
    await render()
    expect(order()).toEqual(['A', 'B', 'C', 'D'])
    for (const li of cells()) expect(li.dataset.cell).toBeDefined()
    const at = pickUp('B')
    const b = tile('B')
    expect(b.style.transform).toBe(`scale(${TILE_LIFT_SCALE})`)
    expect(b.style.transition).toBe('transform 120ms cubic-bezier(0.2, 0.8, 0.2, 1)')
    expect(cellOf('B').dataset.held).toBe('true')
    // The held tile's cell is the hole the others glide round: not a cell of the set.
    expect(cellOf('B').dataset.cell).toBeUndefined()
    expect(cellOf('A').dataset.cell).toBe(url('a'))
    // The finger lifts where it went down: the tile eases back and its menu opens at the lift.
    pointer('pointerup', b, at.x, at.y)
    expect(b.style.transform).toBe('')
    expect(cellOf('B').dataset.held).toBeUndefined()
    expect(cellOf('B').dataset.cell).toBe(url('b'))
    act(() => void b.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(commands('newtab.tileContextMenu')).toEqual([{ url: url('b'), title: 'B', tabId: 'r' }])
    expect(commands('tab.navigate')).toEqual([])
    expect(commands('newtab.reorderShortcuts')).toEqual([])
  })

  it('carries the tile 1:1 with the finger, moves the draft as its centre nears another slot – the others gliding on one spring – and writes the order at the drop', async () => {
    await render()
    const start = pickUp('A')
    const a = tile('A')
    // Past the slop: the drag begins from this move, the tile drawn where it lifted, scaled.
    pointer('pointermove', a, start.x + 12, start.y)
    expect(a.style.transition).toBe('')
    expect(translateX(a)).toBeCloseTo(0, 5)
    expect(a.style.transform).toContain(`scale(${TILE_LIFT_SCALE})`)
    // 1:1 with the finger from there.
    pointer('pointermove', a, start.x + 32, start.y)
    expect(translateX(a)).toBeCloseTo(20, 5)
    expect(order()).toEqual(['A', 'B', 'C', 'D'])
    // Over the third slot: A's cell moves there; B and C are drawn where they were (inverted)…
    const third = slotCentre(2)
    pointer('pointermove', a, third.x, third.y)
    expect(order()).toEqual(['B', 'C', 'A', 'D'])
    expect(translateX(cellOf('B'))).toBeCloseTo(SLOT_W + SLOT_GAP, 5)
    expect(translateX(cellOf('C'))).toBeCloseTo(SLOT_W + SLOT_GAP, 5)
    expect(cellOf('D').style.transform).toBe('')
    // …and A is drawn at the finger from its new cell: the finger is at the slot's centre, the
    // drag began 12 right of the tile's, so the tile sits 12 left of the slot.
    expect(translateX(a)).toBeCloseTo(-12, 5)
    // …then glide home together, the same fraction of the way on every frame.
    for (let i = 0; i < 4; i++) frame()
    const tb = translateX(cellOf('B'))
    expect(tb).toBeGreaterThan(0)
    expect(tb).toBeLessThan(SLOT_W + SLOT_GAP)
    expect(translateX(cellOf('C'))).toBeCloseTo(tb, 6)
    // Nothing is written until the finger lifts.
    expect(commands('newtab.reorderShortcuts')).toEqual([])
    // The drop, the finger at rest: the core gets the draft, the tile glides home from where the
    // finger left it (12 left of the slot) on the spring.
    later(200)
    pointer('pointerup', a, third.x, third.y)
    expect(commands('newtab.reorderShortcuts')).toEqual([{ ids: ['s-b', 's-c', 's-a', 's-d'] }])
    // Still the tile in the hand while it glides: over its neighbours (its cell's data-held, the
    // z-index) and out of the FLIP set, to the end of the glide rather than the drop.
    expect(cellOf('A').dataset.held).toBe('true')
    expect(cellOf('A').dataset.cell).toBeUndefined()
    frame()
    const home = translateX(a)
    expect(home).toBeGreaterThan(-12)
    expect(home).toBeLessThan(0)
    expect(cellOf('A').dataset.held).toBe('true')
    settle()
    expect(a.style.transform).toBe('')
    expect(cellOf('B').style.transform).toBe('')
    // Landed: the hand is empty and the cell is one of the set again.
    expect(cellOf('A').dataset.held).toBeUndefined()
    expect(cellOf('A').dataset.cell).toBe(url('a'))
    // The draft is drawn until the core's list has it, and stays when it does.
    expect(order()).toEqual(['B', 'C', 'A', 'D'])
    await render([PINS[1], PINS[2], PINS[0], PINS[3]])
    expect(order()).toEqual(['B', 'C', 'A', 'D'])
    expect(cells().every((li) => li.style.transform === '')).toBe(true)
  })

  it('the drop glides from the finger’s velocity: a tile let go on the move runs on before it comes home', async () => {
    await render()
    const start = pickUp('A')
    const a = tile('A')
    pointer('pointermove', a, start.x + 12, start.y)
    const third = slotCentre(2)
    // Carried far right, then back into the third slot from its right at a steady 40 px a frame,
    // still moving left as the finger lifts.
    later(200)
    pointer('pointermove', a, third.x + 120, third.y)
    for (const dx of [80, 40, 0]) {
      later(16)
      pointer('pointermove', a, third.x + dx, third.y)
    }
    expect(order()).toEqual(['B', 'C', 'A', 'D'])
    expect(translateX(a)).toBeCloseTo(-12, 5)
    later(16)
    pointer('pointerup', a, third.x, third.y)
    // Carried on leftward by its speed before the spring turns it home…
    frame()
    expect(translateX(a)).toBeLessThan(-12)
    // …and home it comes.
    settle()
    expect(a.style.transform).toBe('')
    expect(commands('newtab.reorderShortcuts')).toEqual([{ ids: ['s-b', 's-c', 's-a', 's-d'] }])
  })

  it('a hold or a drag while the dropped tile glides is refused, and its end does not take the mark from the tile still landing', async () => {
    await render()
    const start = pickUp('A')
    const a = tile('A')
    pointer('pointermove', a, start.x + 12, start.y)
    const third = slotCentre(2)
    pointer('pointermove', a, third.x, third.y)
    later(200)
    pointer('pointerup', a, third.x, third.y)
    frame()
    expect(cellOf('A').dataset.held).toBe('true')
    // Another tile held while the glide runs: not lifted, and its move is no drag – the order
    // stands where the drop left it.
    const at = pickUp('B')
    const b = tile('B')
    expect(b.style.transform).toBe('')
    expect(cellOf('B').dataset.held).toBeUndefined()
    pointer('pointermove', b, at.x + 40, at.y)
    expect(order()).toEqual(['B', 'C', 'A', 'D'])
    expect(b.style.transform).toBe('')
    // The refused hold's end leaves the landing tile the one in the hand…
    expect(cellOf('A').dataset.held).toBe('true')
    pointer('pointerup', b, at.x + 40, at.y)
    expect(cellOf('A').dataset.held).toBe('true')
    // …until it has landed.
    settle()
    expect(a.style.transform).toBe('')
    expect(cellOf('A').dataset.held).toBeUndefined()
    expect(cellOf('A').dataset.cell).toBe(url('a'))
    expect(commands('newtab.reorderShortcuts')).toEqual([{ ids: ['s-b', 's-c', 's-a', 's-d'] }])
    // The hand free again, the next hold lifts.
    const again = pickUp('B')
    expect(tile('B').style.transform).toBe(`scale(${TILE_LIFT_SCALE})`)
    pointer('pointerup', tile('B'), again.x, again.y)
  })

  it('the touch taken away mid-drag puts the order back and writes nothing', async () => {
    await render()
    const start = pickUp('A')
    const a = tile('A')
    pointer('pointermove', a, start.x + 12, start.y)
    const last = slotCentre(3)
    pointer('pointermove', a, last.x, last.y)
    expect(order()).toEqual(['B', 'C', 'D', 'A'])
    pointer('pointercancel', a, last.x, last.y)
    expect(order()).toEqual(['A', 'B', 'C', 'D'])
    expect(commands('newtab.reorderShortcuts')).toEqual([])
    settle()
    expect(a.style.transform).toBe('')
    expect(cellOf('A').dataset.held).toBeUndefined()
  })

  it('the dragged tile taken out of the DOM under the finger (its pin removed meanwhile) ends the drag: nothing written, the hand empty, the next hold lifts', async () => {
    await render()
    const start = pickUp('A')
    const a = tile('A')
    pointer('pointermove', a, start.x + 12, start.y)
    const third = slotCentre(2)
    pointer('pointermove', a, third.x, third.y)
    expect(order()).toEqual(['B', 'C', 'A', 'D'])
    // The list comes back without A while the finger still holds it: its tile unmounts, and
    // with it the touch's listeners – no release will come.
    await render([PINS[1], PINS[2], PINS[3]])
    expect(order()).toEqual(['B', 'C', 'D'])
    expect(a.isConnected).toBe(false)
    expect(a.style.transform).toBe('')
    expect(cells().every((li) => li.dataset.held === undefined)).toBe(true)
    expect(cells().every((li) => li.dataset.cell !== undefined)).toBe(true)
    expect(commands('newtab.reorderShortcuts')).toEqual([])
    // The session is over: a new hold lifts, its drag reorders and its drop writes.
    const at = pickUp('D')
    const d = tile('D')
    expect(d.style.transform).toBe(`scale(${TILE_LIFT_SCALE})`)
    expect(cellOf('D').dataset.held).toBe('true')
    pointer('pointermove', d, at.x - 12, at.y)
    const first = slotCentre(0)
    pointer('pointermove', d, first.x, first.y)
    expect(order()).toEqual(['D', 'B', 'C'])
    later(200)
    pointer('pointerup', d, first.x, first.y)
    expect(commands('newtab.reorderShortcuts')).toEqual([{ ids: ['s-d', 's-b', 's-c'] }])
    settle()
    expect(d.style.transform).toBe('')
    expect(cellOf('D').dataset.held).toBeUndefined()
  })

  it('a most visited tile is not a slot: a hold on it does not lift it, and its menu opens at the lift', async () => {
    ranked = [{ url: url('often'), title: 'Often', favicon: null }]
    await render([PINS[0], PINS[1]])
    expect(order()).toEqual(['A', 'B', 'Often'])
    const at = pickUp('Often')
    const often = tile('Often')
    expect(often.style.transform).toBe('')
    expect(cellOf('Often').dataset.held).toBeUndefined()
    // A move is not a drag of it: the hold is over and nothing is reordered.
    pointer('pointermove', often, at.x - 120, at.y)
    expect(order()).toEqual(['A', 'B', 'Often'])
    pointer('pointerup', often, at.x - 120, at.y)
    elapse(300)
    expect(commands('newtab.reorderShortcuts')).toEqual([])
    // Held still and lifted: its menu, with the page's tab.
    const again = pickUp('Often')
    pointer('pointerup', often, again.x, again.y)
    act(() => void often.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(commands('newtab.tileContextMenu')).toEqual([
      { url: url('often'), title: 'Often', tabId: 'r' }
    ])
    // Nor can a pinned tile be carried onto its slot: the pins are the only slots.
    const start = pickUp('A')
    const a = tile('A')
    pointer('pointermove', a, start.x + 12, start.y)
    const third = slotCentre(2)
    pointer('pointermove', a, third.x, third.y)
    expect(order()).toEqual(['B', 'A', 'Often'])
    pointer('pointerup', a, third.x, third.y)
    expect(commands('newtab.reorderShortcuts')).toEqual([{ ids: ['s-b', 's-a'] }])
  })

  it('under reduced motion the dropped tile is at its slot at once and arrives on the 120 ms fade; the others fade in place', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }))
    await render()
    const start = pickUp('A')
    const a = tile('A')
    pointer('pointermove', a, start.x + 12, start.y)
    const third = slotCentre(2)
    pointer('pointermove', a, third.x, third.y)
    expect(order()).toEqual(['B', 'C', 'A', 'D'])
    // No glide for B and C: no inverted transform written.
    expect(cellOf('B').style.transform).toBe('')
    pointer('pointerup', a, third.x + 20, third.y)
    expect(commands('newtab.reorderShortcuts')).toEqual([{ ids: ['s-b', 's-c', 's-a', 's-d'] }])
    // At its slot at once, and out of the hand at once (the glide it stays in the hand for is none)…
    expect(a.style.transform).toBe('')
    expect(cellOf('A').dataset.held).toBeUndefined()
    expect(cellOf('A').dataset.cell).toBe(url('a'))
    // …arriving on the fade (the spring's rest ran no frames).
    const fade = animate.mock.calls.find(
      (call) =>
        (call as unknown[])[1] && ((call as unknown[])[1] as { duration: number }).duration === 120
    )
    expect(fade).toBeDefined()
    expect(frames).toHaveLength(0)
  })
})
