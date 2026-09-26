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
 * The space strip (W8-F1): one pane per space, `spaces.length` panes wide, slid by whole panes
 * to bring the current space's pane over the container. A percentage in `translateX` is a
 * share of the element's OWN border box – the strip's, N panes – so one pane is `100 / N`
 * percent of it. The scaffold shifted by `activeIndex × 100%`: N panes at a time, the strip off
 * screen and the list blank on every space but the first (measured on the packaged build: three
 * spaces, the second current, the strip at x −720 for a pane of 240). happy-dom lays nothing
 * out, so the geometry is computed here from the inline styles under that CSS rule.
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

/** The percentage a `<n>%` or `translateX(<n>%)` inline value carries. */
const percent = (value: string): number => {
  const m = /(-?[\d.]+)%/.exec(value)
  expect(m, `a percentage in '${value}'`).toBeTruthy()
  return Number(m![1])
}

/**
 * The panes laid out under the CSS rule, for a container `width` wide: the strip's width is its
 * percentage of the container; its translate is its percentage of the STRIP's own width; each
 * pane's left edge is its index times its share of the strip, shifted by the translate – all
 * relative to the container's left edge.
 */
function laidOut(width = 240): {
  strip: number
  shift: number
  panes: Array<{ left: number; width: number }>
} {
  const el = strip()
  const stripWidth = (percent(el.style.width) / 100) * width
  const shift = (percent(el.style.transform) / 100) * stripWidth
  const panes = [...el.children].map((child, i) => {
    const paneWidth = (percent((child as HTMLElement).style.width) / 100) * stripWidth
    return { left: i * paneWidth + shift, width: paneWidth }
  })
  return { strip: stripWidth, shift, panes }
}

const activePane = (): number =>
  [...strip().children].findIndex(
    (child) => child.querySelector('[data-tab-panel]')?.getAttribute('data-active') === 'true'
  )

afterEach(() => {
  act(() => root?.unmount())
  root = null
  mount?.remove()
  mount = null
})

describe('the space strip slides by one pane per space (W8-F1)', () => {
  it('with two spaces: 200% wide, shifted by half of itself for the second', () => {
    sidebar(['work', 'home'], 'work')
    expect(strip().style.width).toBe('200%')
    expect(strip().style.transform).toBe('translateX(-0%)')
    expect(activePane()).toBe(0)

    sidebar(['work', 'home'], 'home')
    expect(strip().style.width).toBe('200%')
    expect(strip().style.transform).toBe('translateX(-50%)')
    expect(activePane()).toBe(1)
  })

  it('with three spaces: 300% wide, shifted by a third of itself per space', () => {
    const shifts = ['translateX(-0%)', `translateX(-${100 / 3}%)`, `translateX(-${200 / 3}%)`]
    expect(shifts).toEqual([
      'translateX(-0%)',
      'translateX(-33.333333333333336%)',
      'translateX(-66.66666666666667%)'
    ])
    const ids = ['work', 'home', 'play']
    for (const [i, id] of ids.entries()) {
      sidebar(ids, id)
      expect(strip().style.width).toBe('300%')
      expect(strip().style.transform).toBe(shifts[i])
      expect(strip().children).toHaveLength(3)
      for (const child of strip().children)
        expect(percent((child as HTMLElement).style.width)).toBeCloseTo(100 / 3, 10)
      expect(activePane()).toBe(i)
    }
  })

  it('lays the current pane over the container – its left edge the container’s, its width the container’s – on every space', () => {
    const ids = ['work', 'home', 'play']
    for (const [i, id] of ids.entries()) {
      sidebar(ids, id)
      const { strip: stripWidth, panes } = laidOut(240)
      expect(stripWidth).toBe(720)
      expect(panes).toHaveLength(3)
      // The current pane stands on the container; the others one pane apart on either side.
      expect(panes[i]!.left).toBeCloseTo(0, 6)
      expect(panes[i]!.width).toBeCloseTo(240, 6)
      for (const [k, pane] of panes.entries()) expect(pane.left).toBeCloseTo((k - i) * 240, 6)
    }
  })

  it('keeps the current pane in view for a single space and for many', () => {
    sidebar(['work'], 'work')
    expect(strip().style.width).toBe('100%')
    expect(laidOut(240).panes[0]!.left).toBe(0)

    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    sidebar(ids, 'f')
    expect(strip().style.width).toBe('700%')
    const { panes } = laidOut(300)
    expect(panes[5]!.left).toBeCloseTo(0, 6)
    expect(panes[5]!.width).toBeCloseTo(300, 6)
    expect(panes[6]!.left).toBeCloseTo(300, 6)
  })
})
