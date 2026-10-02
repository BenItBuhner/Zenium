// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Space, UIState } from '@shared/types'

/*
 * Reordering the Spaces drawer's rows (W8-M1, §1 fold – the lead's call on #734): the rows a
 * held row passes glide to their new slot on the list's FLIP (`useFlip`, `SPRING_SNAPPY`), not
 * on a 220 ms transition of their own; the order the finger made stands after the drop until
 * the browser's order shows the row there, so nothing jumps back and forth meanwhile; under
 * reduced motion the step is a cut.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { SpacesDrawer } = await import('../SpacesDrawer')
const { drawerStore } = await import('@renderer/lib/gestures/drawer')
const { LIFT_SCALE } = await import('@renderer/lib/motion/tokens')

/** A space row's height with its gap: one slot of the reorder (the drawer's `ROW_HEIGHT`). */
const ROW_HEIGHT = 48
/** The hold before a row comes off the list (the drawer's `HOLD_MS`). */
const HOLD_MS = 380
/** How long a dropped row keeps its slot waiting for the browser (the drawer's `REORDER_GRACE_MS`). */
const REORDER_GRACE_MS = 800
const POINTER = 7

function space(id: string): Space {
  return {
    id,
    name: id,
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: [],
    activeTabId: null,
    pinnedCollapsed: false
  }
}

function stateOf(ids: string[]): UIState {
  return {
    platform: 'android',
    capabilities: { windowControls: false },
    tabs: {},
    spaces: ids.map(space),
    activeSpaceId: ids[0],
    folders: {},
    essentialTabIds: [],
    containers: [],
    settings: {
      colorScheme: 'light',
      sidebarSide: 'left',
      pinnedCloseBehavior: 'unload',
      containerSpecificEssentials: false
    },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: [],
    closingTabIds: [],
    sync: { enabled: false, scope: { openTabs: false } }
  } as unknown as UIState
}

// --- a layout ----------------------------------------------------------------------------------

/** happy-dom lays nothing out: a row answers from its place in the list, `ROW_HEIGHT` a slot. */
const measured = HTMLElement.prototype.getBoundingClientRect
HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
  if (this.classList.contains('zen-space-row') && this.parentElement) {
    const index = Array.prototype.indexOf.call(this.parentElement.children, this)
    return new DOMRect(0, index * ROW_HEIGHT, 300, ROW_HEIGHT)
  }
  return measured.call(this)
}

// --- a clock -----------------------------------------------------------------------------------

let now = 10_000
let nextFrame = 1
const frames = new Map<number, (t: number) => void>()
const elapse = (ms: number): void => {
  now += ms
  vi.advanceTimersByTime(ms)
}
const frame = (): void => {
  elapse(16)
  const batch = [...frames.values()]
  frames.clear()
  for (const cb of batch) cb(now)
}
const settleSprings = (): void => {
  for (let i = 0; i < 600 && frames.size; i++) frame()
}

// --- rendering ---------------------------------------------------------------------------------

let root: Root | null = null
let host: HTMLElement | null = null

function render(state: UIState): void {
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  act(() =>
    root!.render(
      createElement(StrictMode, null, createElement(SpacesDrawer, { state, isDark: false }))
    )
  )
}

const rows = (): HTMLElement[] => [...host!.querySelectorAll<HTMLElement>('li.zen-space-row')]
const names = (): string[] => rows().map((r) => r.getAttribute('aria-label')!)
const rowOf = (id: string): HTMLElement => rows().find((r) => r.getAttribute('aria-label') === id)!

function pointer(type: string, target: EventTarget, x: number, y: number): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        pointerId: POINTER,
        clientX: x,
        clientY: y,
        button: 0,
        bubbles: true,
        cancelable: true,
        pointerType: 'touch',
        isPrimary: true
      })
    )
  })
}

/** Hold the row `id` until it comes off the list; the finger is at its middle. */
function pickUp(id: string): { row: HTMLElement; x: number; y: number } {
  const row = rowOf(id)
  const index = rows().indexOf(row)
  const x = 150
  const y = index * ROW_HEIGHT + ROW_HEIGHT / 2
  pointer('pointerdown', row, x, y)
  act(() => elapse(HOLD_MS))
  expect(row.hasAttribute('data-held')).toBe(true)
  return { row, x, y }
}

const commands = (): Array<[string, unknown]> =>
  invoke.mock.calls.map(([name, args]) => [name, args] as [string, unknown])

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  frames.clear()
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    const id = nextFrame++
    frames.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  invoke.mockClear()
  drawerStore.set({ phase: 'open', progress: 1 })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  drawerStore.set({ phase: 'closed', progress: 0 })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('reordering the Spaces drawer’s rows', () => {
  it('the rows a held row passes glide to their slots on the FLIP, with no transition of their own', () => {
    render(stateOf(['one', 'two', 'three']))
    expect(names()).toEqual(['one', 'two', 'three'])
    // At rest every row is a cell of the list's set, and none is on its way anywhere.
    for (const r of rows()) {
      expect(r.getAttribute('data-cell')).toBe(r.getAttribute('aria-label'))
      expect(r.style.transition).toBe('')
      expect(r.style.transform).toBe('')
    }

    const { row, x, y } = pickUp('one')
    // In the hand: lifted at §1's scale, drawn by its own transform, no cell of the set.
    expect(row.style.transform).toBe(`translateY(0px) scale(${LIFT_SCALE})`)
    expect(row.hasAttribute('data-cell')).toBe(false)
    expect(rowOf('two').getAttribute('data-cell')).toBe('two')
    // The lift glides nothing.
    expect(frames.size).toBe(0)

    // One slot down: the rows are in the order the finger is making, the held one drawn where
    // the finger has it (its travel, less the slot it has moved by).
    pointer('pointermove', row, x, y + ROW_HEIGHT)
    expect(names()).toEqual(['two', 'one', 'three'])
    expect(row.style.transform).toBe(`translateY(0px) scale(${LIFT_SCALE})`)
    // `two` is laid out one slot up now and drawn where it was, to glide from there: the FLIP's
    // translation on the spring's frames, no `transition` written on the row.
    const two = rowOf('two')
    expect(two.style.transform).toBe(`translate(0px, ${ROW_HEIGHT}px)`)
    expect(two.style.transition).toBe('')
    expect(frames.size).toBeGreaterThan(0)
    act(() => frame())
    const mid = /translate\(0px, (-?[\d.]+)px\)/.exec(two.style.transform)
    expect(mid).toBeTruthy()
    expect(Number(mid![1])).toBeLessThan(ROW_HEIGHT)
    expect(Number(mid![1])).toBeGreaterThan(0)
    act(() => settleSprings())
    expect(two.style.transform).toBe('')
    // The row that did not change slot never moved.
    expect(rowOf('three').style.transform).toBe('')
  })

  it('the order the finger made stands after the drop until the browser’s order shows it, and nothing glides then', () => {
    render(stateOf(['one', 'two', 'three']))
    const { row, x, y } = pickUp('one')
    pointer('pointermove', row, x, y + ROW_HEIGHT)
    act(() => settleSprings())

    pointer('pointerup', row, x, y + ROW_HEIGHT)
    expect(commands()).toEqual([['space.reorder', { spaceId: 'one', index: 1 }]])
    // Dropped on its slot exactly: nothing left to land, the row is a cell again at once…
    expect(row.hasAttribute('data-held')).toBe(false)
    expect(row.style.transform).toBe('')
    expect(row.getAttribute('data-cell')).toBe('one')
    // …and the rows keep the dropped order while the browser's own order is on its way.
    expect(names()).toEqual(['two', 'one', 'three'])
    expect(frames.size).toBe(0)

    // The browser's order arrives: the same order, so no row moves and nothing glides.
    render(stateOf(['two', 'one', 'three']))
    expect(names()).toEqual(['two', 'one', 'three'])
    expect(frames.size).toBe(0)
    for (const r of rows()) expect(r.style.transform).toBe('')
  })

  it('a row dropped between slots springs the rest of the way into the slot it was dropped in', () => {
    render(stateOf(['one', 'two', 'three']))
    const { row, x, y } = pickUp('one')
    // 30 px down rounds to the next slot; the row is 18 px short of it.
    pointer('pointermove', row, x, y + 30)
    expect(names()).toEqual(['two', 'one', 'three'])
    expect(row.style.transform).toBe(`translateY(${30 - ROW_HEIGHT}px) scale(${LIFT_SCALE})`)
    act(() => settleSprings())

    pointer('pointerup', row, x, y + 30)
    expect(commands()).toEqual([['space.reorder', { spaceId: 'one', index: 1 }]])
    // Landing: drawn where the finger left it, by its own transform (no cell), heading for 0.
    expect(row.style.transform).toBe(`translateY(${30 - ROW_HEIGHT}px)`)
    expect(row.hasAttribute('data-cell')).toBe(false)
    expect(frames.size).toBeGreaterThan(0)
    act(() => frame())
    const mid = /translateY\((-?[\d.]+)px\)/.exec(row.style.transform)
    expect(mid).toBeTruthy()
    expect(Number(mid![1])).toBeGreaterThan(30 - ROW_HEIGHT)
    expect(Number(mid![1])).toBeLessThan(0)
    act(() => settleSprings())
    expect(row.style.transform).toBe('')
    expect(row.getAttribute('data-cell')).toBe('one')
    expect(names()).toEqual(['two', 'one', 'three'])
  })

  it('a drop the browser’s order never shows is let go of after the grace, and the rows glide home on the FLIP', () => {
    render(stateOf(['one', 'two', 'three']))
    const { row, x, y } = pickUp('one')
    pointer('pointermove', row, x, y + ROW_HEIGHT)
    act(() => settleSprings())
    // Dropped on its slot exactly: nothing lands, nothing glides, the grace starts here.
    pointer('pointerup', row, x, y + ROW_HEIGHT)
    expect(names()).toEqual(['two', 'one', 'three'])
    expect(frames.size).toBe(0)
    for (const r of rows()) expect(r.style.transform).toBe('')
    // The browser never shows the order (its store is not re-rendered): the grace runs out.
    act(() => elapse(REORDER_GRACE_MS - 1))
    expect(names()).toEqual(['two', 'one', 'three'])
    act(() => elapse(1))
    // The rows are laid out in the browser's order again – and measured: the two that changed
    // slot are drawn where the drop left them, to glide the slot back on the list's spring (the
    // same FLIP the rows stepping aside took), not set down in place. Both are cells of the set:
    // the dropped row comes home on the FLIP too, not on a transform of its own.
    expect(names()).toEqual(['one', 'two', 'three'])
    const one = rowOf('one')
    const two = rowOf('two')
    expect(one.getAttribute('data-cell')).toBe('one')
    expect(two.getAttribute('data-cell')).toBe('two')
    expect(one.style.transform).toBe(`translate(0px, ${ROW_HEIGHT}px)`)
    expect(two.style.transform).toBe(`translate(0px, ${-ROW_HEIGHT}px)`)
    expect(one.style.transition).toBe('')
    expect(rowOf('three').style.transform).toBe('')
    expect(frames.size).toBeGreaterThan(0)
    act(() => frame())
    const mid = /translate\(0px, (-?[\d.]+)px\)/.exec(one.style.transform)
    expect(mid).toBeTruthy()
    expect(Number(mid![1])).toBeLessThan(ROW_HEIGHT)
    expect(Number(mid![1])).toBeGreaterThan(0)
    act(() => settleSprings())
    for (const r of rows()) expect(r.style.transform).toBe('')
    // One reorder was asked for; the refusal asks for nothing more, and the next hold is free.
    expect(commands()).toEqual([['space.reorder', { spaceId: 'one', index: 1 }]])
    const again = pickUp('two')
    expect(again.row.hasAttribute('data-held')).toBe(true)
  })

  it('a drop the browser’s order has shown is forgotten at the grace with nothing measured or moved', () => {
    render(stateOf(['one', 'two', 'three']))
    const { row, x, y } = pickUp('one')
    pointer('pointermove', row, x, y + ROW_HEIGHT)
    pointer('pointerup', row, x, y + ROW_HEIGHT)
    act(() => settleSprings())
    render(stateOf(['two', 'one', 'three']))
    const layout = HTMLElement.prototype.getBoundingClientRect
    const measuredRows: HTMLElement[] = []
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.classList.contains('zen-space-row')) measuredRows.push(this)
      return layout.call(this)
    })
    act(() => elapse(REORDER_GRACE_MS))
    expect(names()).toEqual(['two', 'one', 'three'])
    expect(measuredRows).toEqual([])
    expect(frames.size).toBe(0)
    for (const r of rows()) expect(r.style.transform).toBe('')
  })

  it('under reduced motion a refused drop is a cut: the rows are back in their slots at once, through the tracker’s fade, nothing glides', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }))
    const faded: HTMLElement[] = []
    const animate = HTMLElement.prototype.animate
    HTMLElement.prototype.animate = function (this: HTMLElement) {
      faded.push(this)
      return { cancel: () => undefined, finished: Promise.resolve() } as unknown as Animation
    } as unknown as HTMLElement['animate']
    try {
      render(stateOf(['one', 'two', 'three']))
      const { row, x, y } = pickUp('one')
      pointer('pointermove', row, x, y + ROW_HEIGHT)
      pointer('pointerup', row, x, y + ROW_HEIGHT)
      expect(names()).toEqual(['two', 'one', 'three'])
      faded.length = 0
      act(() => elapse(REORDER_GRACE_MS))
      expect(names()).toEqual(['one', 'two', 'three'])
      expect(frames.size).toBe(0)
      for (const r of rows()) expect(r.style.transform).toBe('')
      // The two rows that changed slot took the §11.3 fade at their slots (the FLIP's own cut).
      expect(faded.map((r) => r.getAttribute('aria-label')).sort()).toEqual(['one', 'two'])
    } finally {
      if (animate) HTMLElement.prototype.animate = animate
      else delete (HTMLElement.prototype as { animate?: unknown }).animate
    }
  })

  it('a hold let go in place reorders nothing', () => {
    render(stateOf(['one', 'two', 'three']))
    const { row, x, y } = pickUp('one')
    pointer('pointerup', row, x, y)
    expect(commands()).toEqual([])
    expect(names()).toEqual(['one', 'two', 'three'])
    expect(row.hasAttribute('data-held')).toBe(false)
    expect(row.style.transform).toBe('')
  })

  it('under reduced motion the step is a cut: the rows are in their slots at once, nothing glides', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }))
    render(stateOf(['one', 'two', 'three']))
    const { row, x, y } = pickUp('one')
    pointer('pointermove', row, x, y + ROW_HEIGHT)
    expect(names()).toEqual(['two', 'one', 'three'])
    expect(rowOf('two').style.transform).toBe('')
    expect(frames.size).toBe(0)
  })
})
