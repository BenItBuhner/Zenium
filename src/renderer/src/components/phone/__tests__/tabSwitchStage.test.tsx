// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Space, Tab, UIState } from '@shared/types'

/*
 * The tab track of a pill swipe (`TabSwitchStage`): React mounts the cards the track's window
 * holds, and the finger moves them without it – each card writes its transform and its layers'
 * opacity to the DOM from the store (PERF-5: a render of three page-sized cards per pixel of a
 * swipe was most of the drag's script). The store's position moving inside the window renders
 * nothing; crossing a card mounts the next one where the track is from its first frame; and
 * main.css keeps the track's three animated layers on transform / opacity, with no backdrop
 * blur riding a moving card.
 */

const SPACE = 'space'
const GROUP = 'g'
const ADVANCE = 232
const AREA = { x: 0, y: 56, width: 220, height: 500 }

Object.assign(window, { zen: { invoke: async () => null, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The preview is a stub that counts its renders per tab. */
const previews: string[] = []
vi.mock('../TabPreview', () => ({
  TabPreview: ({ tab }: { tab: Tab }) => {
    previews.push(tab.id)
    return createElement('div', { 'data-preview': tab.id })
  }
}))

const { TabSwitchStage } = await import('../TabSwitchStage')
const { stageStore } = await import('@renderer/lib/gestures/stage')

function tab(id: string, patch: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: SPACE,
    containerId: 'default',
    url: `https://${id}.example/`,
    title: id,
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
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
    errorCode: null,
    bookmarked: false,
    readerable: false,
    blockedCount: 0,
    ...patch
  } as Tab
}

const folder: Folder = {
  id: GROUP,
  spaceId: SPACE,
  name: 'Research',
  icon: '📚',
  collapsed: false,
  color: 'blue'
}

const TABS = [tab('a'), tab('b', { folderId: GROUP }), tab('c'), tab('d'), tab('e')]

function stateOf(tabs: Tab[]): UIState {
  const space: Space = {
    id: SPACE,
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: tabs.map((t) => t.id),
    activeTabId: tabs[0]?.id ?? null,
    pinnedCollapsed: false
  }
  return {
    platform: 'android',
    capabilities: { windowControls: false },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [space],
    activeSpaceId: SPACE,
    folders: { [GROUP]: folder },
    essentialTabIds: [],
    containers: [],
    settings: { colorScheme: 'light', sidebarSide: 'left' },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: []
  } as unknown as UIState
}

/** The track's order, fixed for the gesture as the store keeps it (`{ ...tabs, position }` per move). */
const ORDER = TABS.map((t) => t.id)

function track(position: number, origin = 0): void {
  stageStore.set({ tabs: { phase: 'dragging', order: ORDER, position, origin, advance: ADVANCE } })
}

const card = (id: string): HTMLElement =>
  document.querySelector(`[data-preview="${id}"]`)!.closest('.zen-stage-card') as HTMLElement
const layer = (id: string, cls: string): HTMLElement => card(id).querySelector(cls) as HTMLElement
const placement = (index: number, position: number): string => {
  const offset = index - position
  return `translate3d(${offset * ADVANCE}px, 0, 0) scale(${1 - 0.06 * Math.min(1, Math.abs(offset))})`
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  previews.length = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  stageStore.set({
    tabs: { phase: 'idle', order: [], position: 0, origin: 0, advance: 0 }
  })
})

function mount(position: number): void {
  track(position)
  act(() => {
    root.render(createElement(TabSwitchStage, { state: stateOf(TABS), area: AREA }))
  })
}

describe('the tab track follows the finger from the store, not through a render', () => {
  it('mounts the cards of the track window where the track is: the one under the finger, a neighbour each side and one more', () => {
    mount(0.2)
    // floor(0.2) - 1 < 0 → from 0; ceil(0.2) + 1 = 2.
    expect(previews).toEqual(['a', 'b', 'c'])
    expect(card('a').style.transform).toBe(placement(0, 0.2))
    expect(card('b').style.transform).toBe(placement(1, 0.2))
    expect(card('c').style.transform).toBe(placement(2, 0.2))
    // The card is page-sized, where the page is.
    expect(card('a').style.top).toBe('56px')
    expect(card('a').style.height).toBe('500px')
    // The dim deepens with the distance from the centre; the ribbon of the grouped card fades in
    // with the movement (0.2 × 2.5).
    expect(Number(layer('a', '.zen-stage-dim').style.opacity)).toBeCloseTo(0.22 * 0.2, 9)
    expect(Number(layer('b', '.zen-stage-dim').style.opacity)).toBeCloseTo(0.22 * 0.8, 9)
    expect(Number(layer('b', '.zen-group-ribbon').style.opacity)).toBeCloseTo(0.5, 9)
    expect(card('a').querySelector('.zen-group-ribbon')).toBeNull()
    expect(layer('b', '.zen-group-ribbon').textContent).toContain('Research')
  })

  it('a move of the finger inside the window writes the transforms and opacities to the elements and renders no card', () => {
    mount(0.2)
    const rendered = previews.length
    act(() => track(0.6))
    expect(previews.length).toBe(rendered)
    expect(card('a').style.transform).toBe(placement(0, 0.6))
    expect(card('b').style.transform).toBe(placement(1, 0.6))
    expect(card('c').style.transform).toBe(placement(2, 0.6))
    expect(Number(layer('a', '.zen-stage-dim').style.opacity)).toBeCloseTo(0.22 * 0.6, 9)
    expect(Number(layer('b', '.zen-stage-dim').style.opacity)).toBeCloseTo(0.22 * 0.4, 9)
    expect(Number(layer('b', '.zen-group-ribbon').style.opacity)).toBe(1)
    // Every frame of a settle writes too – and a frame that lands where the last one was writes
    // nothing new (the same string).
    act(() => track(0.6))
    act(() => track(0.61))
    expect(previews.length).toBe(rendered)
    expect(card('b').style.transform).toBe(placement(1, 0.61))
  })

  it("the commit's move of the origin onto the landed card takes the ribbon out, though the transform is already there", () => {
    // The drag from `a` towards `b` … the spring's last step lands exactly on 1 (`spring.ts`
    // snaps it), the ribbon full.
    mount(0.2)
    act(() => track(1, 0))
    expect(card('b').style.transform).toBe(placement(1, 1))
    expect(Number(layer('b', '.zen-group-ribbon').style.opacity)).toBe(1)
    // The commit (`stage.ts`): the same position, the origin moved onto it – the transform does
    // not change, the ribbon's distance from the origin does (to 0: it fades with movement, and
    // the landed page is at rest again).
    act(() =>
      stageStore.set({
        tabs: { phase: 'committing', order: ORDER, position: 1, origin: 1, advance: ADVANCE }
      })
    )
    expect(card('b').style.transform).toBe(placement(1, 1))
    expect(Number(layer('b', '.zen-group-ribbon').style.opacity)).toBe(0)
    expect(previews.length).toBe(3)
  })

  it('the finger crossing a card mounts the next one, standing where the track is from its first frame', () => {
    mount(0.2)
    expect(document.querySelectorAll('.zen-stage-card')).toHaveLength(3)
    act(() => track(1.2))
    // floor(1.2) - 1 = 0 … ceil(1.2) + 1 = 3: `d` joins, `a` stays.
    expect(document.querySelectorAll('.zen-stage-card')).toHaveLength(4)
    expect(card('d').style.transform).toBe(placement(3, 1.2))
    expect(card('a').style.transform).toBe(placement(0, 1.2))
    act(() => track(2.4))
    // floor(2.4) - 1 = 1 … ceil(2.4) + 1 = 4: `a` leaves, `e` joins.
    expect(document.querySelector('[data-preview="a"]')).toBeNull()
    expect(card('e').style.transform).toBe(placement(4, 2.4))
  })
})

describe("main.css: the track's animated layers", () => {
  const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')
  const rule = (selector: string): string => {
    const at = css.indexOf(`${selector} {`)
    expect(at, selector).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('}', at))
  }

  it('are promoted for what moves them – transform on the card, opacity on the dim and the ribbon', () => {
    expect(rule('.zen-stage-card')).toMatch(/will-change: transform;/)
    expect(rule('.zen-stage-dim')).toMatch(/will-change: opacity;/)
    expect(rule('.zen-group-ribbon')).toMatch(/will-change: opacity;/)
  })

  it("the group ribbon is an opaque band in the group's colour: no backdrop blur rides a moving card (v2 §1: blur only where the platform composites it, otherwise opaque)", () => {
    expect(rule('.zen-group-ribbon')).not.toMatch(/backdrop-filter/)
    expect(rule('.zen-group-ribbon')).toMatch(
      /background: color-mix\(in srgb, rgb\(var\(--zen-group-rgb\)\) 22%, var\(--zen-bg-solid\)\);/
    )
  })
})
