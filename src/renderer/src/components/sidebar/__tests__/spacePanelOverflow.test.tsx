// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Space, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { viewportStore } from '@renderer/lib/formFactor'
import { STRIP_FADE } from '@renderer/lib/tabStripLayout'
import { browserStore, uiStore } from '@renderer/lib/ui'
import { Sidebar } from '../Sidebar'
import { scrollRowIntoView } from '../useActiveRowInView'

/*
 * The vertical list's overflow (tabs-28, BUG-008): the space panel is the list's column – the
 * rows' scroller, then outside it the list's foot with the New Tab row and the empty room under
 * it, so the row stays in view however long the list (Zen's, the strip's + fixed at its end,
 * §9.37) – and activating a row scrolls the list the least distance that brings the row clear of
 * the edge fades (the strip's 24, `STRIP_FADE`): smooth, a cut under reduced motion or when the
 * panel has just come into view, never while a row is being dragged. The list's geometry is
 * stubbed: happy-dom lays nothing out.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROW = 32
/** The list's box: 300 tall from the top of the window. */
const LIST = { top: 0, bottom: 300 }

function tab(id: string, spaceId = 'work', over: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId,
    containerId: DEFAULT_CONTAINER_ID,
    url: `https://${id}.example/`,
    title: `${id.toUpperCase()} PAGE`,
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    progress: 0,
    canGoBack: false,
    canGoForward: false,
    audible: false,
    muted: false,
    discarded: false,
    frozen: false,
    cpuThrottle: 1,
    zoom: 1,
    splitGroupId: null,
    createdAt: 0,
    lastActiveAt: 0,
    ...over
  } as Tab
}

const many = (n: number, spaceId = 'work'): Tab[] =>
  Array.from({ length: n }, (_, i) => tab(`${spaceId}-${i}`, spaceId))

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): void {
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() => root!.render(el))
}

interface SpaceSpec {
  id: string
  tabs: Tab[]
  /** The space's active tab (its first by default). */
  active?: string
}

/** The desktop sidebar with the given spaces; `activeSpaceId` the one in view. */
function sidebar(specs: SpaceSpec[], activeSpaceId = specs[0]!.id): void {
  const spaces = specs.map(
    (spec) =>
      ({
        id: spec.id,
        name: spec.id[0]!.toUpperCase() + spec.id.slice(1),
        icon: '',
        containerId: DEFAULT_CONTAINER_ID,
        theme: null,
        tabIds: spec.tabs.map((t) => t.id),
        activeTabId: spec.active ?? spec.tabs[0]?.id ?? null,
        pinnedCollapsed: false
      }) as Space
  )
  const tabs = specs.flatMap((spec) => spec.tabs)
  const state = {
    platform: 'linux',
    window: {
      id: 'w1',
      kind: 'synced',
      fullscreen: false,
      htmlFullscreenTabId: null,
      chrome: 'full',
      name: null
    },
    capabilities: { privateTabs: true, windowControls: true, windowControlsOverlay: false },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces,
    activeSpaceId,
    folders: {},
    liveFolders: {},
    splitGroups: {},
    essentialTabIds: [],
    foreignTabIds: [],
    agents: [],
    containers: [],
    media: [],
    mods: [],
    settings: {
      showTabSeparator: false,
      sidebarExpanded: true,
      sidebarSide: 'left',
      toolbarLayout: 'multiple',
      containerSpecificEssentials: false
    }
  } as unknown as UIState
  act(() => {
    browserStore.set({ state })
    viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false, hover: true })
  })
  render(<Sidebar state={state} isDark={false} compact={false} navRow={false} />)
}

const q = <T extends HTMLElement>(selector: string, from: ParentNode = document): T | null =>
  from.querySelector<T>(selector)

const panel = (id = 'work'): HTMLElement => {
  const el = [...document.querySelectorAll<HTMLElement>('[data-tab-panel]')].find((p) =>
    p.querySelector(`[data-tab-id^="${id}-"]`)
  )
  expect(el).toBeTruthy()
  return el!
}
const scrollerOf = (p: HTMLElement): HTMLElement => {
  const el = q<HTMLElement>('[data-tab-scroller]', p)
  expect(el).toBeTruthy()
  return el!
}

interface Geometry {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** Give a scroller a scroll position and an extent; its `scrollBy` is a spy. */
function lay(el: HTMLElement, g: Geometry): ReturnType<typeof vi.fn> {
  el.setAttribute('data-tab-scroller', '')
  for (const [key, value] of Object.entries(g))
    Object.defineProperty(el, key, { value, configurable: true, writable: true })
  const scrollBy = vi.fn()
  el.scrollBy = scrollBy as unknown as typeof el.scrollBy
  return scrollBy
}

/**
 * The rows' boxes, by tab id, read through `getBoundingClientRect` – set before a row is
 * rendered, so the list's motion (`SlideMotion.flip`) measures the row there from its first
 * layout and springs nothing (a row whose box jumped between two commits glides, and its
 * resting box is where the layout puts it, not where the glide has it – the hook reads that).
 */
const rowTops = new Map<string, number>()
const place = (id: string, top: number): void => {
  rowTops.set(id, top)
}
const realRect = HTMLElement.prototype.getBoundingClientRect

function reduceMotion(reduced: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduced && query === '(prefers-reduced-motion: reduce)',
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }))
}

beforeEach(() => {
  uiStore.set({ drag: null, selectedTabIds: [], renamingTabId: null })
  reduceMotion(false)
  rowTops.clear()
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    const id = this.dataset.tabId
    if (id !== undefined && rowTops.has(id)) {
      // As the engine's: the box is read with the row's glide (its `translateY`) on it.
      const glide = Number(/translateY\((-?[\d.]+)px\)/.exec(this.style.transform)?.[1] ?? 0)
      return new DOMRect(8, rowTops.get(id)! + glide, 224, ROW)
    }
    if (this.hasAttribute('data-tab-scroller'))
      return new DOMRect(0, LIST.top, 240, LIST.bottom - LIST.top)
    return realRect.call(this)
  }
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  mount?.remove()
  mount = null
  HTMLElement.prototype.getBoundingClientRect = realRect
  vi.unstubAllGlobals()
})

describe('the vertical list’s column (tabs-28)', () => {
  it('holds the rows in the scroller and the New Tab row in the foot after it, outside the scroller', () => {
    sidebar([{ id: 'work', tabs: many(3) }])
    const p = panel()
    const scroller = scrollerOf(p)
    const foot = q<HTMLElement>('[data-strip-foot]', p)
    expect(foot).toBeTruthy()
    expect(foot!.classList.contains('zen-list-foot')).toBe(true)
    // The foot is the scroller's next sibling in the panel's column.
    expect(scroller.parentElement).toBe(p)
    expect(scroller.nextElementSibling).toBe(foot)
    expect(scroller.querySelectorAll('[data-tab-id]')).toHaveLength(3)
    expect(q('[data-new-tab]', foot!)).toBeTruthy()
    expect(q('[data-strip-empty]', foot!)).toBeTruthy()
    expect(q('[data-new-tab]', scroller)).toBeNull()
    expect(q('[data-strip-empty]', scroller)).toBeNull()
    // The scroller gives way to the foot, never the other way round.
    expect(scroller.className).toMatch(/\bshrink\b/)
    expect(scroller.className).toMatch(/\bmin-h-0\b/)
    expect(foot!.className).toMatch(/\bshrink-0\b/)
    expect(foot!.className).toMatch(/\bgrow\b/)
  })

  it('fades the list’s edges at the strip’s depth (§9.37), on the scroller', async () => {
    let frame: (() => void) | null = null
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      frame = cb
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    sidebar([{ id: 'work', tabs: many(30) }])
    const scroller = scrollerOf(panel())
    expect(scroller.dataset.fadeAxis).toBe('y')
    // With nothing past either edge (happy-dom lays out no overflow) both fades are 0.
    expect(scroller.style.getPropertyValue('--zen-fade-start')).toBe('0px')
    expect(scroller.style.getPropertyValue('--zen-fade-end')).toBe('0px')
    // Scrolled into a long list, both edges fade at 24.
    lay(scroller, { scrollTop: 200, scrollHeight: 30 * ROW, clientHeight: 300 })
    act(() => {
      scroller.dispatchEvent(new Event('scroll'))
    })
    expect(frame).not.toBeNull()
    act(() => frame!())
    expect(scroller.style.getPropertyValue('--zen-fade-start')).toBe(`${STRIP_FADE}px`)
    expect(scroller.style.getPropertyValue('--zen-fade-end')).toBe(`${STRIP_FADE}px`)
    expect(STRIP_FADE).toBe(24)
  })

  it('the panel’s empty-room menu covers the foot too: a context menu there is the strip’s', () => {
    sidebar([{ id: 'work', tabs: many(3) }])
    const empty = q<HTMLElement>('[data-tab-panel][data-active="true"] [data-strip-empty]')
    expect(empty).toBeTruthy()
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    act(() => {
      empty!.dispatchEvent(ev)
    })
    expect(ev.defaultPrevented).toBe(true)
  })
})

describe('the active row comes into view on activation (BUG-008)', () => {
  /** A 30-row list mounted with `active` in view, laid at `g`; `scrollBy` the spy. */
  const list = (
    g: Geometry,
    active = 'work-0'
  ): { tabs: Tab[]; scrollBy: ReturnType<typeof vi.fn> } => {
    const tabs = many(30)
    sidebar([{ id: 'work', tabs, active }])
    return { tabs, scrollBy: lay(scrollerOf(panel()), g) }
  }

  it('scrolls a row below the view up by the least distance that clears the bottom fade, smoothly', () => {
    // Row 20 stands at 640: 340 below the box's foot, 372 below the fade's edge.
    place('work-20', 20 * ROW)
    const { tabs, scrollBy } = list({ scrollTop: 0, scrollHeight: 30 * ROW, clientHeight: 300 })
    sidebar([{ id: 'work', tabs, active: 'work-20' }])
    expect(scrollBy).toHaveBeenCalledTimes(1)
    expect(scrollBy).toHaveBeenCalledWith({
      top: 20 * ROW + ROW - (LIST.bottom - STRIP_FADE),
      behavior: 'smooth'
    })
  })

  it('scrolls a row above the view down, clear of the top fade while the list is scrolled', () => {
    // Row 3 stands 40 above the box's top: 64 above the fade's edge.
    place('work-3', -40)
    const { tabs, scrollBy } = list({ scrollTop: 300, scrollHeight: 30 * ROW, clientHeight: 300 })
    sidebar([{ id: 'work', tabs, active: 'work-3' }])
    expect(scrollBy).toHaveBeenCalledWith({ top: -40 - STRIP_FADE, behavior: 'smooth' })
  })

  it('leaves a row already in view where it is', () => {
    place('work-5', 100)
    const { tabs, scrollBy } = list({ scrollTop: 100, scrollHeight: 30 * ROW, clientHeight: 300 })
    sidebar([{ id: 'work', tabs, active: 'work-5' }])
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('cuts to the row under reduced motion (§11.3)', () => {
    reduceMotion(true)
    place('work-20', 20 * ROW)
    const { tabs, scrollBy } = list({ scrollTop: 0, scrollHeight: 30 * ROW, clientHeight: 300 })
    sidebar([{ id: 'work', tabs, active: 'work-20' }])
    expect(scrollBy).toHaveBeenCalledWith({
      top: 20 * ROW + ROW - (LIST.bottom - STRIP_FADE),
      behavior: 'auto'
    })
  })

  it('never moves the list while a row is being dragged: the drag’s autoscroll is the drag’s', () => {
    place('work-20', 20 * ROW)
    const { tabs, scrollBy } = list({ scrollTop: 0, scrollHeight: 30 * ROW, clientHeight: 300 })
    act(() => {
      uiStore.set({
        drag: {
          tabId: 'work-1',
          remote: false,
          title: 'WORK-1 PAGE',
          favicon: null,
          width: 224,
          height: ROW,
          tile: false,
          settling: false
        }
      })
    })
    sidebar([{ id: 'work', tabs, active: 'work-20' }])
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('reads the row where it rests, not where its glide has it (`SlideMotion.restingRect`)', () => {
    // Row 20 is laid out at 640 while another row's closing moved it there from 672: the list's
    // motion draws it 32 down and springs it up; the list scrolls to its resting box all the same.
    place('work-20', 21 * ROW)
    const { tabs, scrollBy } = list({ scrollTop: 0, scrollHeight: 30 * ROW, clientHeight: 300 })
    place('work-20', 20 * ROW)
    sidebar([{ id: 'work', tabs: tabs.filter((t) => t.id !== 'work-2'), active: 'work-20' }])
    expect(scrollBy).toHaveBeenCalledWith({
      top: 20 * ROW + ROW - (LIST.bottom - STRIP_FADE),
      behavior: 'smooth'
    })
  })

  it('places the row with a cut when its panel has just come into view (a space switch)', () => {
    const work = many(3, 'work')
    const home = many(30, 'home')
    place('home-20', 20 * ROW)
    sidebar([
      { id: 'work', tabs: work },
      { id: 'home', tabs: home, active: 'home-20' }
    ])
    const scroller = scrollerOf(panel('home'))
    expect(scroller.dataset.active).toBe('false')
    const scrollBy = lay(scroller, { scrollTop: 0, scrollHeight: 30 * ROW, clientHeight: 300 })
    sidebar(
      [
        { id: 'work', tabs: work },
        { id: 'home', tabs: home, active: 'home-20' }
      ],
      'home'
    )
    expect(scrollBy).toHaveBeenCalledWith({
      top: 20 * ROW + ROW - (LIST.bottom - STRIP_FADE),
      behavior: 'auto'
    })
  })
})

describe('scrollRowIntoView', () => {
  const scroller = (g: Geometry): { el: HTMLElement; scrollBy: ReturnType<typeof vi.fn> } => {
    const el = document.createElement('div')
    const scrollBy = lay(el, g)
    return { el, scrollBy }
  }
  const row = (top: number): DOMRect => new DOMRect(0, top, 200, ROW)

  it('counts no top fade at the list’s start and no bottom fade at its end', () => {
    const start = scroller({ scrollTop: 0, scrollHeight: 900, clientHeight: 300 })
    // A row 10 under the top edge is in view: the top fade is not drawn at scrollTop 0.
    expect(scrollRowIntoView(start.el, row(10), 'auto')).toBe(0)
    expect(start.scrollBy).not.toHaveBeenCalled()
    const end = scroller({ scrollTop: 600, scrollHeight: 900, clientHeight: 300 })
    // A row ending at the box's foot is in view at the list's end: no bottom fade there.
    expect(scrollRowIntoView(end.el, row(300 - ROW), 'auto')).toBe(0)
    // Up from the end the top fade counts: a row 10 under the edge asks for 14 up.
    expect(scrollRowIntoView(end.el, row(10), 'auto')).toBe(10 - STRIP_FADE)
    expect(end.scrollBy).toHaveBeenCalledWith({ top: 10 - STRIP_FADE, behavior: 'auto' })
  })

  it('moves by the row’s overshoot past the fade, and no further (`block: nearest`)', () => {
    const s = scroller({ scrollTop: 100, scrollHeight: 900, clientHeight: 300 })
    // 8 past the bottom fade's edge.
    expect(scrollRowIntoView(s.el, row(300 - STRIP_FADE - ROW + 8), 'smooth')).toBe(8)
    expect(s.scrollBy).toHaveBeenLastCalledWith({ top: 8, behavior: 'smooth' })
    // 12 past the top fade's edge.
    expect(scrollRowIntoView(s.el, row(STRIP_FADE - 12), 'smooth')).toBe(-12)
    expect(s.scrollBy).toHaveBeenLastCalledWith({ top: -12, behavior: 'smooth' })
    // A list that fits has no fade at all: a row at the box's very top is in view.
    const fits = scroller({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 })
    expect(scrollRowIntoView(fits.el, row(0), 'smooth')).toBe(0)
    expect(scrollRowIntoView(fits.el, row(300 - ROW), 'smooth')).toBe(0)
  })
})
