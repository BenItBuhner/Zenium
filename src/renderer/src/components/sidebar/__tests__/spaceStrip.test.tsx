// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { browserStore, uiStore } from '@renderer/lib/ui'
import { Sidebar } from '../Sidebar'

/*
 * The space strip (W8-F1): the strip is the container's width (`width: 100%`), one pane per
 * space at `flex: 0 0 100%` of it – so every pane is the container's box, laid side by side –
 * and it slides by whole panes: `translateX(-${activeIndex * 100}%)`, a percentage of the
 * strip's OWN width, which is one pane. (The scaffold made the strip N panes wide and shifted it
 * by `activeIndex × 100%` of THAT: N panes at a time, the list blank on every space but the
 * first – measured on the packaged build with three spaces, the second current, the strip at
 * x −720 for a pane of 240.) The form is exact for every N, and a space's create or delete no
 * longer changes the width the transform's percentage is taken of.
 *
 * The strip slides only for a SWITCH (v2 §11.4: a move). When the current pane's slot moves
 * under it with the same space current – a space created, deleted or reordered before it – the
 * strip is re-seated in place: `Sidebar` marks it `data-reflow` for that commit (main.css:
 * `transition: none` under the mark), pins a style change event while the mark is on, and lifts
 * the mark on the next animation frame, so no frame shows the pane anywhere but x 0 and the
 * next switch has its slide back.
 *
 * happy-dom lays nothing out, so the geometry is computed here from the inline styles under
 * the CSS rule.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function tab(id: string, spaceId: string): Tab {
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
    lastActiveAt: 0
  } as Tab
}

let root: Root | null = null
let mount: HTMLElement | null = null

/** Renders into ONE root, so a second call re-renders the same `Sidebar` (its refs kept). */
function render(el: ReactElement): void {
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() => root!.render(el))
}

/** The desktop sidebar with `ids` as its spaces, each with two tabs; `activeId` the one in view. */
function sidebar(ids: string[], activeId: string): void {
  const tabs = ids.flatMap((id) => [tab(`${id}-1`, id), tab(`${id}-2`, id)])
  const spaces = ids.map(
    (id) =>
      ({
        id,
        name: id[0]!.toUpperCase() + id.slice(1),
        icon: '',
        containerId: DEFAULT_CONTAINER_ID,
        theme: null,
        tabIds: [`${id}-1`, `${id}-2`],
        activeTabId: `${id}-1`,
        pinnedCollapsed: false
      }) as Space
  )
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
    capabilities: { privateTabs: false, windowControls: true, windowControlsOverlay: false },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces,
    activeSpaceId: activeId,
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
    uiStore.set({ drag: null, selectedTabIds: [], renamingTabId: null })
    browserStore.set({ state })
    viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false, hover: true })
  })
  render(<Sidebar state={state} isDark={false} compact={false} navRow={false} />)
}

const strip = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>('.zen-space-strip')
  expect(el).toBeTruthy()
  return el!
}
const panes = (): HTMLElement[] => [...strip().children] as HTMLElement[]

/** The percentage a `<n>%` or `translateX(<n>%)` inline value carries. */
const percent = (value: string): number => {
  const m = /(-?[\d.]+)%/.exec(value)
  expect(m, `a percentage in '${value}'`).toBeTruthy()
  return Number(m![1])
}

/** A pane's inline `flex`, as the shorthand or – a DOM shim that splits it – its longhands. */
const flexOf = (pane: HTMLElement): string => {
  const shorthand = pane.style.flex || pane.style.getPropertyValue('flex')
  if (shorthand) return shorthand
  const { flexGrow, flexShrink, flexBasis } = pane.style
  if (flexGrow || flexShrink || flexBasis) return `${flexGrow} ${flexShrink} ${flexBasis}`
  return /flex:\s*([^;]+)/.exec(pane.getAttribute('style') ?? '')?.[1]?.trim() ?? ''
}

/**
 * The panes laid out under the CSS rule, for a container `width` wide: the strip's width is its
 * percentage of the container; every pane is `flex: 0 0 100%` of the strip – one container
 * width – side by side; the strip's translate is its percentage of the STRIP's own width; each
 * pane's left edge is its index times a pane, shifted by the translate – all relative to the
 * container's left edge.
 */
function laidOut(width = 240): {
  strip: number
  shift: number
  panes: Array<{ left: number; width: number }>
} {
  const el = strip()
  const stripWidth = (percent(el.style.width) / 100) * width
  const shift = (percent(el.style.transform) / 100) * stripWidth
  const laid = panes().map((pane, i) => {
    expect(flexOf(pane)).toBe('0 0 100%')
    return { left: i * stripWidth + shift, width: stripWidth }
  })
  return { strip: stripWidth, shift, panes: laid }
}

const activePane = (): number =>
  panes().findIndex(
    (child) => child.querySelector('[data-tab-panel]')?.getAttribute('data-active') === 'true'
  )

/** The no-slide mark on the strip for the commit that re-seats it. */
const reflowMarked = (): boolean => strip().hasAttribute('data-reflow')

/**
 * The animation frames the component asks for, held back until `nextFrame()` runs them – the
 * mark is lifted on the frame after the commit that set it.
 */
const frames = new Map<number, FrameRequestCallback>()
let handles = 0
function holdFrames(): void {
  frames.clear()
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.set(++handles, cb)
    return handles
  })
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((handle) => {
    frames.delete(handle)
  })
}
/** Runs the frames asked for so far; the number run. */
function nextFrame(): number {
  const due = [...frames.values()]
  frames.clear()
  act(() => {
    for (const cb of due) cb(performance.now())
  })
  return due.length
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  mount?.remove()
  mount = null
  vi.restoreAllMocks()
})

describe('the space strip slides by one pane per space (W8-F1)', () => {
  it.each([
    { ids: ['work', 'home'] },
    { ids: ['work', 'home', 'play'] },
    { ids: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }
  ])(
    'with $ids: 100% wide, one pane per space at 100% of it, shifted by whole panes',
    ({ ids }) => {
      for (const [i, id] of ids.entries()) {
        sidebar(ids, id)
        expect(strip().style.width).toBe('100%')
        expect(strip().style.transform).toBe(`translateX(-${i * 100}%)`)
        expect(panes()).toHaveLength(ids.length)
        for (const pane of panes()) expect(flexOf(pane)).toBe('0 0 100%')
        expect(activePane()).toBe(i)
      }
    }
  )

  it('lays the current pane over the container – its left edge the container’s, its width the container’s – on every space', () => {
    const ids = ['work', 'home', 'play']
    for (const [i, id] of ids.entries()) {
      sidebar(ids, id)
      const { strip: stripWidth, panes: laid } = laidOut(240)
      expect(stripWidth).toBe(240)
      expect(laid).toHaveLength(3)
      // The current pane stands on the container; the others one pane apart on either side.
      expect(laid[i]!.left).toBe(0)
      expect(laid[i]!.width).toBe(240)
      for (const [k, pane] of laid.entries()) expect(pane.left).toBe((k - i) * 240)
    }
  })

  it('keeps the current pane in view for a single space and for many', () => {
    sidebar(['work'], 'work')
    expect(strip().style.width).toBe('100%')
    expect(laidOut(240).panes[0]!.left).toBe(0)

    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    sidebar(ids, 'f')
    expect(strip().style.transform).toBe('translateX(-500%)')
    const { panes: laid } = laidOut(300)
    expect(laid[5]!.left).toBe(0)
    expect(laid[5]!.width).toBe(300)
    expect(laid[6]!.left).toBe(300)
    expect(laid[0]!.left).toBe(-1500)
  })
})

describe('the strip slides only for a switch (v2 §11.4; W8-F1)', () => {
  it('a space deleted before the current one re-seats the strip in place: the pane at 0 throughout, the mark for that commit and not the next', () => {
    holdFrames()
    sidebar(['work', 'home', 'play'], 'play')
    expect(strip().style.transform).toBe('translateX(-200%)')
    expect(reflowMarked()).toBe(false)
    const before = strip()

    sidebar(['home', 'play'], 'play')
    // The same strip element, its slot moved: one pane less before the current one.
    expect(strip()).toBe(before)
    expect(strip().style.transform).toBe('translateX(-100%)')
    expect(activePane()).toBe(1)
    expect(laidOut(240).panes[1]!.left).toBe(0)
    // The commit that moved the slot carries the mark – `transition: none` under it.
    expect(reflowMarked()).toBe(true)
    expect(frames.size).toBe(1)

    // The next frame lifts it: the switch after this one has its slide.
    expect(nextFrame()).toBe(1)
    expect(reflowMarked()).toBe(false)
    expect(strip().style.transform).toBe('translateX(-100%)')
    expect(laidOut(240).panes[1]!.left).toBe(0)
  })

  it('a space created before the current one, or reordered past it, re-seats the strip the same way', () => {
    holdFrames()
    sidebar(['home', 'play'], 'play')
    expect(strip().style.transform).toBe('translateX(-100%)')

    sidebar(['work', 'home', 'play'], 'play')
    expect(strip().style.transform).toBe('translateX(-200%)')
    expect(laidOut(240).panes[2]!.left).toBe(0)
    expect(reflowMarked()).toBe(true)
    nextFrame()
    expect(reflowMarked()).toBe(false)

    // A reorder: the current space carried to the front, no switch.
    sidebar(['play', 'work', 'home'], 'play')
    expect(strip().style.transform).toBe('translateX(-0%)')
    expect(laidOut(240).panes[0]!.left).toBe(0)
    expect(reflowMarked()).toBe(true)
    nextFrame()
    expect(reflowMarked()).toBe(false)
  })

  it('a space created after the current one moves nothing – and needs no mark', () => {
    holdFrames()
    sidebar(['work', 'home'], 'work')
    expect(strip().style.transform).toBe('translateX(-0%)')

    sidebar(['work', 'home', 'extra'], 'work')
    expect(strip().style.transform).toBe('translateX(-0%)')
    expect(panes()).toHaveLength(3)
    expect(laidOut(240).panes[0]!.left).toBe(0)
    expect(reflowMarked()).toBe(false)
    expect(frames.size).toBe(0)

    // Nor does one deleted after it.
    sidebar(['work', 'home'], 'work')
    expect(strip().style.transform).toBe('translateX(-0%)')
    expect(reflowMarked()).toBe(false)
    expect(frames.size).toBe(0)
  })

  it('a switch keeps its slide: no mark, the transform alone changes', () => {
    holdFrames()
    sidebar(['work', 'home', 'play'], 'work')

    sidebar(['work', 'home', 'play'], 'home')
    expect(strip().style.transform).toBe('translateX(-100%)')
    expect(activePane()).toBe(1)
    expect(reflowMarked()).toBe(false)
    expect(frames.size).toBe(0)

    // Even a switch that comes with a create – `space.create` switches to the new space.
    sidebar(['work', 'home', 'play', 'more'], 'more')
    expect(strip().style.transform).toBe('translateX(-300%)')
    expect(reflowMarked()).toBe(false)
    expect(frames.size).toBe(0)
  })

  it('a switch in the frame the mark is still up lifts it with the commit, not the frame', () => {
    holdFrames()
    sidebar(['work', 'home', 'play'], 'play')
    sidebar(['home', 'play'], 'play')
    expect(reflowMarked()).toBe(true)

    // The switch's commit runs the previous effect's cleanup: the mark goes with it and its
    // frame is cancelled, so the switch's own transform change transitions.
    sidebar(['home', 'play'], 'home')
    expect(strip().style.transform).toBe('translateX(-0%)')
    expect(reflowMarked()).toBe(false)
    expect(frames.size).toBe(0)
    expect(nextFrame()).toBe(0)
    expect(reflowMarked()).toBe(false)
  })
})
