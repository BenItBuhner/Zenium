// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Space, SplitGroup, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'
import { SPRING_GENTLE, type SpringConfig } from '@shared/spring'

/** The main events the flyout subscribes to, by name, so a test can play the core's answer. */
const { handlers, starts } = vi.hoisted(() => ({
  handlers: new Map<string, Set<(payload: unknown) => void>>(),
  starts: [] as Array<{ config: SpringConfig; from: number; to: number }>
}))

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async (name: string) =>
    name === 'overlay.snapshot' ? 'data:image/png;base64,AA' : null
  ),
  run: vi.fn(),
  onEvent: vi.fn((name: string, handler: (payload: unknown) => void) => {
    let set = handlers.get(name)
    if (!set) handlers.set(name, (set = new Set()))
    set.add(handler)
    return () => {
      set!.delete(handler)
    }
  })
}))

vi.mock('@renderer/lib/motion/spring', async (original) => {
  const m = await original<typeof import('@renderer/lib/motion/spring')>()
  class Recorded extends m.SpringAnimation {
    private readonly configured: SpringConfig
    constructor(...args: ConstructorParameters<typeof m.SpringAnimation>) {
      super(...args)
      this.configured = args[0]
    }
    override start(from: number, velocity: number, to: number, config?: SpringConfig): void {
      starts.push({ config: config ?? this.configured, from, to })
      super.start(from, velocity, to, config)
    }
  }
  return { ...m, SpringAnimation: Recorded }
})

import { cmd } from '@renderer/lib/api'
import { viewportStore } from '@renderer/lib/formFactor'
import { browserStore, pageHidden, uiStore } from '@renderer/lib/ui'
import { COLLAPSED_WIDTH, Sidebar } from '../Sidebar'
import {
  RAIL_FLYOUT_COVER_WAIT_MS,
  RAIL_FLYOUT_DWELL_MS,
  RAIL_FLYOUT_GRACE_MS,
  RailFlyout
} from '../useRailFlyout'

/*
 * The collapsed rail's flyout (tabs-03; design language v2 §9.20's sidebar anchor and cascade,
 * §9.37, §11.4, §11.3): under the Collapsed sidebar layout with "Expand on hover" on, the
 * pointer resting on the docked rail for the dwell (Edge's ~300 ms) flies a second surface out
 * BESIDE the rail to the expanded sidebar's width OVER the page – the rail and the frame stay
 * put – on the sidebar's own SPRING_GENTLE, the page under it its picture (the capture,
 * `railFlyout` raised, the width off once the core has hidden the view); it folds back a grace
 * (Edge's ~400–500 ms) after the pointer has left, at once on Escape or a press into the page,
 * and the keyboard landing in the rail opens it with no dwell and holds it. The flyout's rows
 * are the rail's rows – the same elements, each running across the seam in its expanded form
 * while the flyout is out, its glyph in the rail's tile and its title in the panel – and the
 * head and foot keep the rail's geometry, so nothing moves under the pointer that opened it; the
 * row it opened from stays lit in the rail (`data-flyout-anchor`) until the fold rests, and the
 * panel's surface overlaps the rail by the 1 px of its hairline (main.css).
 */

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')

/** The text of the first `selector {` rule in the stylesheet. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The expanded sidebar's width: the panel's, beside the rail. */
const EXTENT = 240
/** The box's width with the flyout out: the rail and the panel. */
const OUT = COLLAPSED_WIDTH + EXTENT

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: 'work',
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

interface Scene {
  tabs?: Tab[]
  active?: string
  layout?: 'collapsed' | 'single' | 'multiple'
  expandOnHover?: boolean
  width?: number
  /** A touch screen: no pointer to rest. */
  coarse?: boolean
  side?: 'left' | 'right'
  folders?: Folder[]
  splitGroups?: SplitGroup[]
}

/** The desktop's sidebar under the Collapsed layout with Expand on hover on, by default. */
function sidebar({
  tabs = [tab('home'), tab('docs'), tab('news')],
  active = tabs[0]?.id,
  layout = 'collapsed',
  expandOnHover = true,
  width = EXTENT,
  coarse = false,
  side = 'left',
  folders = [],
  splitGroups = []
}: Scene = {}): UIState {
  const space = {
    id: 'work',
    name: 'Work',
    icon: '',
    containerId: DEFAULT_CONTAINER_ID,
    theme: null,
    tabIds: tabs.map((t) => t.id),
    activeTabId: active ?? null,
    pinnedCollapsed: false
  } as Space
  const splitOf = (id: string): string | null =>
    splitGroups.find((g) => g.tabIds.includes(id))?.id ?? null
  const state = {
    platform: 'linux',
    window: { kind: 'synced', fullscreen: false, htmlFullscreenTabId: null, chrome: 'full' },
    capabilities: { privateTabs: false, windowControls: false, windowControlsOverlay: false },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, { ...t, splitGroupId: splitOf(t.id) }])),
    spaces: [space],
    activeSpaceId: 'work',
    folders: Object.fromEntries(folders.map((f) => [f.id, f])),
    liveFolders: {},
    splitGroups: Object.fromEntries(splitGroups.map((g) => [g.id, g])),
    essentialTabIds: [],
    foreignTabIds: [],
    agents: [],
    containers: [],
    media: [],
    mods: [],
    settings: {
      showTabSeparator: false,
      sidebarExpanded: true,
      sidebarSide: side,
      sidebarWidth: width,
      sidebarExpandOnHover: expandOnHover,
      toolbarLayout: layout,
      containerSpecificEssentials: false
    }
  } as unknown as UIState
  browserStore.set({ state })
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse, hover: !coarse })
  render(<Sidebar state={state} isDark={false} navRow={false} />)
  return state
}

const q = <T extends HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)
const aside = (): HTMLElement => q<HTMLElement>('aside[aria-label="Sidebar"]')!
const flyout = (): HTMLElement => q<HTMLElement>('[data-rail-flyout]')!
const titles = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="tab-title"]')].map(
    (el) => el.textContent ?? ''
  )
/** The New Tab row's text: '' for the rail's glyph alone, 'New Tab' for the expanded row. */
const newTabRow = (): string | null => q<HTMLElement>('[data-new-tab]')?.textContent ?? null
const width = (): string => q<HTMLElement>('.zen-rail-flyout')?.style.width ?? ''
const row = (id: string): HTMLElement => q<HTMLElement>(`[data-tab-id="${id}"][role="tab"]`)!
/** The rows lit as the flyout's parent (`data-flyout-anchor`), by tab id / attribute. */
const anchors = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-flyout-anchor]')].map(
    (el) => el.dataset.tabId ?? el.dataset.newTab ?? el.className
  )
/** The head's, the Essentials' and the foot's boxes: their inline width while the flyout is out
 *  ('' at rest, the aside's width being the rail's already). */
const railBoxes = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-rail-box]')].map((el) => el.style.width)

const frames = new Map<number, (t: number) => void>()
let nextFrame = 1
let now = 10_000

beforeEach(() => {
  starts.length = 0
  handlers.clear()
  frames.clear()
  vi.useFakeTimers({ now })
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    const id = nextFrame++
    frames.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  uiStore.set({ drag: null, railFlyout: false, snapshot: null, snapshotTabId: null })
})

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  browserStore.set({ state: null })
  uiStore.set({ drag: null, railFlyout: false, snapshot: null, snapshotTabId: null })
  vi.mocked(cmd).mockClear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** One animation frame of every spring in flight. */
const frame = (): void => {
  now += 16
  vi.setSystemTime(now)
  const batch = [...frames.values()]
  frames.clear()
  for (const cb of batch) cb(now)
}
/** The frames to rest, the width after each (the rail's own once the inline width is cleared). */
const settle = (): number[] => {
  const widths: number[] = []
  act(() => {
    for (let i = 0; i < 600 && frames.size; i++) {
      frame()
      const w = width()
      widths.push(w === '' ? COLLAPSED_WIDTH : parseFloat(w))
    }
  })
  return widths
}
const wait = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}
/** The capture's promise, resolved. */
const captured = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}
/** The core's word that the view is hidden (`layout.applied`). */
const viewHidden = (): void => {
  act(() => {
    for (const h of handlers.get('layout.applied') ?? [])
      h({ contentHidden: true, hid: ['home'], shown: [] })
  })
}
const pointer = (type: string, target: EventTarget = aside()): void => {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: type !== 'pointerenter' && type !== 'pointerleave',
        pointerId: 1
      })
    )
  })
}
/** The pointer on the rail through the dwell and the capture: the flyout `opening`. */
const dwell = async (): Promise<void> => {
  pointer('pointerenter')
  wait(RAIL_FLYOUT_DWELL_MS)
  await captured()
}
/** …and out, the width on its way. */
const open = async (): Promise<void> => {
  await dwell()
  viewHidden()
}

const monotone = (values: number[], direction: 1 | -1): boolean =>
  values.every((v, i) => i === 0 || Math.sign(v - values[i - 1]) * direction >= 0)

describe('the collapsed rail’s flyout (tabs-03): at rest', () => {
  it('is offered under the Collapsed layout with Expand on hover on a fine pointer: the aside keeps the rail’s 56, its rows compact in the flyout’s box at the aside’s width', () => {
    sidebar()
    expect(aside().hasAttribute('data-flyout-offered')).toBe(true)
    expect(aside().style.width).toBe(`${COLLAPSED_WIDTH}px`)
    expect(aside().dataset.surface).toBe('window')
    const box = flyout()
    expect(box.className).toContain('zen-rail-flyout')
    expect(box.className).toContain('absolute')
    expect(box.className).toContain('inset-y-0')
    expect(box.className).toContain('w-full')
    expect(box.className).toContain('left-0')
    expect(box.dataset.side).toBe('left')
    expect(box.hasAttribute('data-flyout')).toBe(false)
    expect(box.style.width).toBe('')
    // The rail's width, for the panel's surface and the rows' tiles to measure from.
    expect(box.style.getPropertyValue('--zen-rail-rest')).toBe(`${COLLAPSED_WIDTH}px`)
    // Compact rows: glyphs alone – no titles, the New Tab row its + alone; nothing lit.
    expect(titles()).toEqual([])
    expect(newTabRow()).toBe('')
    expect(anchors()).toEqual([])
    expect(railBoxes()).toEqual(['', '', ''])
    expect(uiStore.get().railFlyout).toBe(false)
  })

  it('is not offered with the setting off, nor under another layout, nor to a touch screen', () => {
    sidebar({ expandOnHover: false })
    expect(aside().hasAttribute('data-flyout-offered')).toBe(false)
    expect(flyout()).toBeNull()
    pointer('pointerenter')
    wait(RAIL_FLYOUT_DWELL_MS * 2)
    expect(vi.mocked(cmd)).not.toHaveBeenCalledWith('overlay.snapshot', expect.anything())

    sidebar({ layout: 'single' })
    expect(aside().hasAttribute('data-flyout-offered')).toBe(false)

    sidebar({ coarse: true })
    expect(aside().hasAttribute('data-flyout-offered')).toBe(false)
  })

  it('is the cascade’s surface (§9.20): the panel from the rail’s edge on the window’s own gradient fixed to the viewport, the frame’s shadow rule spreading its hairline 1 px into the rail, at 40, the title cut while the width moves', () => {
    expect(rule('.zen-rail-flyout[data-flyout]')).toContain('z-index: 40')
    // The box itself draws nothing: the panel's surface is its ::before, beginning at the
    // rail's width – so the shadow's 1 px spread lands in the rail's last column, the frame's
    // own hairline column at rest.
    const surface = rule('.zen-rail-flyout[data-flyout]::before')
    expect(surface).toContain('inset: 0 0 0 var(--zen-rail-rest)')
    expect(surface).toContain('background: var(--zen-bg)')
    expect(surface).toContain('background-attachment: fixed')
    expect(surface).toContain('box-shadow: var(--zen-frame-shadow)')
    expect(surface).toContain('z-index: -1')
    expect(css).toMatch(
      /--zen-frame-shadow:\s*0 0 0 1px rgb\(var\(--zen-fg-rgb\) \/ 0\.08\), 0 2px 14px rgb\(0 0 0 \/ 0\.08\)/
    )
    expect(rule(".zen-rail-flyout[data-flyout][data-side='right']::before")).toContain(
      'inset: 0 var(--zen-rail-rest) 0 0'
    )
    const grain = rule('.zen-rail-flyout[data-flyout] > .zen-texture')
    expect(grain).toContain('left: var(--zen-rail-rest)')
    expect(grain).toContain('background-attachment: fixed')
    expect(rule('.zen-rail-flyout[data-flyout-moving] .zen-tab-title')).toContain(
      'text-overflow: clip'
    )
  })

  it('lays each row across the seam (§9.20’s start alignment): the tile the compact row’s box in the rail, the panel’s row from the rail’s edge, the glyph centred in the tile and the title 10 into the panel, the parent row’s tile lit', () => {
    // The tile is the compact row's box: the rail's width less the list's inset each side, the
    // scrollbar's gutter while the rows overflow, and the row's indent (the rows' ml-5).
    const vars = rule(
      '.zen-rail-flyout[data-flyout] .zen-tab:not(.zen-split-seg),\n  .zen-rail-flyout[data-flyout] .zen-space-header,\n  .zen-rail-flyout[data-flyout] .zen-split-row'
    )
    expect(vars.replace(/\s+/g, ' ')).toContain(
      '--zen-tile-width: calc( var(--zen-rail-rest) - 2 * var(--zen-list-inset) - var(--zen-list-gutter, 0px) - var(--zen-row-indent, 0px) )'
    )
    expect(vars).toContain('--zen-glyph-lead: calc((var(--zen-tile-width) - 16px) / 2)')
    expect(
      rule(
        '.zen-rail-flyout[data-flyout] .zen-tab[data-indent]:not(.zen-split-seg),\n  .zen-rail-flyout[data-flyout] .zen-split-row[data-indent]'
      )
    ).toContain('--zen-row-indent: 1.25rem')
    // The row's own fill gives way to the two halves, under the row's content.
    expect(
      rule(
        '.zen-rail-flyout[data-flyout] .zen-tab:not(.zen-split-seg),\n  .zen-rail-flyout[data-flyout] .zen-space-header'
      )
    ).toContain('background: none')
    expect(rule('.zen-rail-flyout[data-flyout] .zen-tab:not(.zen-split-seg)')).toContain(
      'padding-left: 0'
    )
    const tile = rule(
      '.zen-rail-flyout[data-flyout] .zen-tab:not(.zen-split-seg)::before,\n  .zen-rail-flyout[data-flyout] .zen-space-header::before'
    )
    expect(tile).toContain('left: 0')
    expect(tile).toContain('width: var(--zen-tile-width)')
    expect(tile).toContain('background: var(--zen-tile-fill)')
    const panel = rule(
      '.zen-rail-flyout[data-flyout] .zen-tab:not(.zen-split-seg)::after,\n  .zen-rail-flyout[data-flyout] .zen-space-header::after'
    )
    expect(panel).toContain('left: var(--zen-rail-rest)')
    expect(panel).toContain('right: 0')
    expect(panel).toContain('background: var(--zen-row-fill)')
    // The glyph where the compact row centred it; the title at the panel row's 10, after the
    // row's 9 gap.
    const glyph = rule(
      '.zen-rail-flyout[data-flyout]\n    .zen-tab:not(.zen-split-seg)\n    > :is(.zen-tab-favicon, .zen-group-row-glyph),\n  .zen-rail-flyout[data-flyout] .zen-tab[data-new-tab] > svg'
    )
    expect(glyph).toContain('margin-left: var(--zen-glyph-lead)')
    expect(glyph).toContain(
      'margin-right: calc(var(--zen-rail-rest) + 10px - 16px - 9px - var(--zen-glyph-lead))'
    )
    // Hover lights both halves; the parent row its tile alone; the active row outranks it.
    expect(
      rule(
        ".zen-rail-flyout[data-flyout] .zen-tab:not(.zen-split-seg):hover,\n  .zen-rail-flyout[data-flyout] .zen-tab[data-editing]:not(.zen-split-seg, [data-active='true']),\n  .zen-rail-flyout[data-flyout] .zen-space-header:hover"
      )
    ).toContain('--zen-row-fill: var(--v2-window-fill-hover)')
    const lit = rule(
      '.zen-rail-flyout[data-flyout] .zen-tab[data-flyout-anchor]:not(.zen-split-seg),\n  .zen-rail-flyout[data-flyout] .zen-space-header[data-flyout-anchor]'
    )
    expect(lit).toContain('--zen-tile-fill: var(--v2-window-fill-hover)')
    expect(lit).not.toContain('--zen-row-fill')
    expect(css.indexOf('.zen-tab[data-flyout-anchor]:not(.zen-split-seg)')).toBeLessThan(
      css.indexOf(".zen-rail-flyout[data-flyout] .zen-tab[data-active='true']:not(.zen-split-seg)")
    )
    expect(rule('.zen-essential[data-flyout-anchor]')).toContain(
      'background: var(--v2-window-fill-hover)'
    )
    // The split group's rail column, boxed at the tile's width (the rule of its own, after the
    // one it shares the tile's measure in); the progress bar in the panel.
    const split = css.match(/\}\n {2}\.zen-rail-flyout\[data-flyout\] \.zen-split-row \{([^}]*)\}/)
    expect(split).not.toBeNull()
    expect(split![1]).toContain('width: var(--zen-tile-width)')
    expect(split![1]).toContain('align-self: flex-start')
    expect(
      rule('.zen-rail-flyout[data-flyout] .zen-tab:not(.zen-split-seg) > .zen-tab-progress')
    ).toContain('left: calc(var(--zen-rail-rest) + 10px)')
  })
})

describe('the collapsed rail’s flyout (tabs-03): the pointer', () => {
  it('flies out after the dwell (Edge’s ~300 ms): the page’s picture first, the flag, the width off on SPRING_GENTLE once the core has hidden the view, the rows in their expanded form', async () => {
    expect(RAIL_FLYOUT_DWELL_MS).toBe(300)
    sidebar()
    pointer('pointerenter')
    wait(RAIL_FLYOUT_DWELL_MS - 1)
    expect(vi.mocked(cmd)).not.toHaveBeenCalled()
    wait(1)
    // The dwell is up: the active tab's picture is asked for; nothing is raised until it comes.
    expect(vi.mocked(cmd)).toHaveBeenCalledWith('overlay.snapshot', { tabId: 'home' })
    expect(flyout().dataset.flyout).toBe('opening')
    expect(uiStore.get().railFlyout).toBe(false)
    await captured()
    // The picture stands in for the page (`pageHidden`: the reporter takes the view down).
    expect(uiStore.get().snapshotTabId).toBe('home')
    expect(uiStore.get().railFlyout).toBe(true)
    expect(pageHidden(uiStore.get())).toBe(true)
    expect(starts).toEqual([])
    expect(width()).toBe('')
    // The core's word: the width sets off, the rail's 56 → the rail plus the panel, 296, on
    // the sidebar's spring.
    viewHidden()
    expect(flyout().dataset.flyout).toBe('out')
    expect(flyout().hasAttribute('data-flyout-moving')).toBe(true)
    expect(starts).toEqual([{ config: SPRING_GENTLE, from: COLLAPSED_WIDTH, to: OUT }])
    // The rows in their expanded form from the first frame: titles, the New Tab row.
    expect(titles()).toEqual(['HOME PAGE', 'DOCS PAGE', 'NEWS PAGE'])
    expect(newTabRow()).toBe('New Tab')
    const widths = settle()
    expect(widths.length).toBeGreaterThan(10)
    expect(monotone(widths, 1)).toBe(true)
    expect(widths[0]).toBeGreaterThan(COLLAPSED_WIDTH)
    expect(widths[0]).toBeLessThan(OUT / 2)
    // At rest: the rail plus the panel exactly, the moving mark off, the flyout out and held.
    expect(width()).toBe(`${OUT}px`)
    expect(flyout().dataset.flyout).toBe('out')
    expect(flyout().hasAttribute('data-flyout-moving')).toBe(false)
    expect(uiStore.get().railFlyout).toBe(true)
    // The aside itself never moved: the frame stays where it is.
    expect(aside().style.width).toBe(`${COLLAPSED_WIDTH}px`)
  })

  it('opens from the row under the pointer and keeps it lit as the cascade’s parent (§9.20) until the fold rests; the head and the foot stay boxed at the rail’s width', async () => {
    sidebar()
    pointer('pointerenter')
    pointer('pointerover', row('docs'))
    wait(RAIL_FLYOUT_DWELL_MS)
    await captured()
    // Lit from the open's first frame – the picture on its way, the width still to set off.
    expect(anchors()).toEqual(['docs'])
    viewHidden()
    settle()
    expect(anchors()).toEqual(['docs'])
    // The pointer moving on to other rows lights them as hover does; the parent stays.
    pointer('pointerover', row('news'))
    expect(anchors()).toEqual(['docs'])
    // The rail's head, its Essentials and its foot keep the rail's width beside the panel.
    expect(railBoxes()).toEqual([
      `${COLLAPSED_WIDTH}px`,
      `${COLLAPSED_WIDTH}px`,
      `${COLLAPSED_WIDTH}px`
    ])
    // Folded: nothing lit, the boxes the aside's own again.
    pointer('pointerleave')
    wait(RAIL_FLYOUT_GRACE_MS)
    expect(anchors()).toEqual(['docs'])
    settle()
    expect(anchors()).toEqual([])
    expect(railBoxes()).toEqual(['', '', ''])

    // From the rail's blank – between the rows, the foot's empty room – nothing is lit.
    pointer('pointerenter')
    pointer('pointerover', row('home'))
    pointer('pointerover', q('[data-strip-empty]')!)
    wait(RAIL_FLYOUT_DWELL_MS)
    await captured()
    viewHidden()
    settle()
    expect(anchors()).toEqual([])
    expect(flyout().dataset.flyout).toBe('out')
  })

  it('lights the New Tab row and a folder header as parents too; a folder’s rows and a saved folder’s pages carry the indent the tile subtracts', async () => {
    const folder = {
      id: 'f1',
      spaceId: 'work',
      name: 'Trip',
      icon: '📁',
      color: 'green',
      collapsed: false
    } as Folder
    sidebar({
      tabs: [tab('home'), tab('docs', { folderId: 'f1' }), tab('news')],
      folders: [folder]
    })
    expect(row('docs').hasAttribute('data-indent')).toBe(true)
    expect(row('home').hasAttribute('data-indent')).toBe(false)
    expect(row('news').hasAttribute('data-indent')).toBe(false)
    const header = q<HTMLElement>('[data-tab-folder="f1"]')!
    expect(header.className).toContain('zen-tab')
    pointer('pointerenter')
    pointer('pointerover', header)
    wait(RAIL_FLYOUT_DWELL_MS)
    await captured()
    viewHidden()
    settle()
    expect(header.hasAttribute('data-flyout-anchor')).toBe(true)
    expect(anchors()).toHaveLength(1)
    pointer('pointerleave')
    wait(RAIL_FLYOUT_GRACE_MS)
    settle()
    expect(anchors()).toEqual([])

    pointer('pointerenter')
    pointer('pointerover', q('[data-new-tab]')!)
    wait(RAIL_FLYOUT_DWELL_MS)
    await captured()
    viewHidden()
    settle()
    expect(q<HTMLElement>('[data-new-tab]')!.hasAttribute('data-flyout-anchor')).toBe(true)
    expect(newTabRow()).toBe('New Tab')
  })

  it('keeps a split group’s row in its rail column while out (§9.35): its segments compact, the rows around it expanded, so nothing changes height', async () => {
    const group: SplitGroup = {
      id: 'g',
      spaceId: 'work',
      tabIds: ['docs', 'news'],
      layout: 'vertical',
      sizes: [0.5, 0.5]
    }
    sidebar({ splitGroups: [group] })
    const split = q<HTMLElement>('[data-split-row="g"]')!
    expect(split.className).toContain('zen-split-row-column')
    expect(split.hasAttribute('data-indent')).toBe(false)
    expect(titles()).toEqual([])
    await open()
    settle()
    expect(split.className).toContain('zen-split-row-column')
    // The loose row has its title; the segments have none.
    expect(titles()).toEqual(['HOME PAGE'])
    expect(split.querySelectorAll('.zen-split-seg')).toHaveLength(2)
    expect(split.querySelectorAll('[data-testid="tab-title"]')).toHaveLength(0)
    pointer('pointerleave')
    wait(RAIL_FLYOUT_GRACE_MS)
    settle()
    expect(split.className).toContain('zen-split-row-column')
  })

  it('mirrors for a rail on the right: the box at the right edge, the head and the foot boxed against it', async () => {
    sidebar({ side: 'right' })
    const box = flyout()
    expect(box.className).toContain('right-0')
    expect(box.className).not.toContain('left-0')
    expect(box.dataset.side).toBe('right')
    await open()
    settle()
    expect(width()).toBe(`${OUT}px`)
    for (const el of document.querySelectorAll<HTMLElement>('[data-rail-box]')) {
      expect(el.style.width).toBe(`${COLLAPSED_WIDTH}px`)
      expect(el.style.alignSelf).toBe('flex-end')
    }
  })

  it('waits no longer than the cover wait for the core: a window with no view to hide sets off regardless', async () => {
    sidebar()
    await dwell()
    expect(starts).toEqual([])
    wait(RAIL_FLYOUT_COVER_WAIT_MS - 1)
    expect(starts).toEqual([])
    wait(1)
    expect(starts).toHaveLength(1)
    expect(flyout().dataset.flyout).toBe('out')
    // The subscription is let go with the deadline.
    expect(handlers.get('layout.applied')?.size ?? 0).toBe(0)
  })

  it('folds back a grace (Edge’s ~400–500 ms) after the pointer leaves: the width home on the same spring, the flag down and the page back at the rest, the rows compact again', async () => {
    expect(RAIL_FLYOUT_GRACE_MS).toBe(450)
    sidebar()
    await open()
    settle()
    pointer('pointerleave')
    wait(RAIL_FLYOUT_GRACE_MS - 1)
    expect(flyout().dataset.flyout).toBe('out')
    expect(width()).toBe(`${OUT}px`)
    wait(1)
    expect(flyout().dataset.flyout).toBe('folding')
    expect(flyout().hasAttribute('data-flyout-moving')).toBe(true)
    // Folding, the rows keep their expanded form: a title is cut at the edge, not dropped.
    expect(titles()).toHaveLength(3)
    // Still the page's picture under it until the rest.
    expect(uiStore.get().railFlyout).toBe(true)
    const widths = settle()
    expect(widths.length).toBeGreaterThan(10)
    expect(monotone(widths, -1)).toBe(true)
    expect(widths.every((w) => w >= COLLAPSED_WIDTH)).toBe(true)
    // At rest: the box back at the aside's width, the flag down, the live page back.
    expect(flyout().hasAttribute('data-flyout')).toBe(false)
    expect(flyout().hasAttribute('data-flyout-moving')).toBe(false)
    expect(width()).toBe('')
    expect(uiStore.get().railFlyout).toBe(false)
    expect(uiStore.get().snapshotTabId).toBeNull()
    expect(pageHidden(uiStore.get())).toBe(false)
    expect(titles()).toEqual([])
    expect(newTabRow()).toBe('')
    // The fold from the rest was the spring's second start, the rail plus the panel to the rail.
    expect(starts).toHaveLength(2)
    expect(starts[1].to).toBe(COLLAPSED_WIDTH)
    expect(starts[1].from).toBeCloseTo(OUT, 0)
  })

  it('a pointer back before the grace is up keeps it; back during the fold turns it out again from where it is', async () => {
    sidebar()
    await open()
    settle()
    pointer('pointerleave')
    wait(RAIL_FLYOUT_GRACE_MS - 50)
    pointer('pointerenter')
    wait(RAIL_FLYOUT_GRACE_MS * 2)
    expect(flyout().dataset.flyout).toBe('out')
    expect(width()).toBe(`${OUT}px`)
    // Out, then away for the grace, then caught on its way back.
    pointer('pointerleave')
    wait(RAIL_FLYOUT_GRACE_MS)
    expect(flyout().dataset.flyout).toBe('folding')
    act(() => {
      for (let i = 0; i < 6; i++) frame()
    })
    const caught = parseFloat(width())
    expect(caught).toBeLessThan(OUT)
    expect(caught).toBeGreaterThan(COLLAPSED_WIDTH)
    pointer('pointerenter')
    expect(flyout().dataset.flyout).toBe('out')
    const widths = settle()
    expect(monotone(widths, 1)).toBe(true)
    expect(widths[widths.length - 1]).toBe(OUT)
    expect(width()).toBe(`${OUT}px`)
    expect(uiStore.get().railFlyout).toBe(true)
    // The open and the fold were the spring's starts; the turn back was a retarget of the fold
    // in flight, not a new start.
    expect(starts).toHaveLength(2)
  })

  it('leaving during the dwell arms nothing; leaving while the picture is on its way lets the open go with nothing moved', async () => {
    sidebar()
    pointer('pointerenter')
    wait(RAIL_FLYOUT_DWELL_MS - 100)
    pointer('pointerleave')
    wait(RAIL_FLYOUT_DWELL_MS * 2)
    expect(vi.mocked(cmd)).not.toHaveBeenCalled()
    expect(flyout().hasAttribute('data-flyout')).toBe(false)

    // The dwell up and the capture asked for; the pointer gone before the picture came back.
    pointer('pointerenter')
    wait(RAIL_FLYOUT_DWELL_MS)
    expect(flyout().dataset.flyout).toBe('opening')
    pointer('pointerleave')
    wait(RAIL_FLYOUT_GRACE_MS)
    await captured()
    expect(starts).toEqual([])
    expect(flyout().hasAttribute('data-flyout')).toBe(false)
    expect(uiStore.get().railFlyout).toBe(false)
    expect(uiStore.get().snapshotTabId).toBeNull()
    expect(titles()).toEqual([])
  })

  it('does not fly out with a tab in the hand: the rows are drop targets', async () => {
    sidebar()
    uiStore.set({ drag: { kind: 'tab' } as never })
    pointer('pointerenter')
    wait(RAIL_FLYOUT_DWELL_MS)
    await captured()
    expect(vi.mocked(cmd)).not.toHaveBeenCalled()
    expect(flyout().hasAttribute('data-flyout')).toBe(false)
  })

  it('takes a tab activated from its rows as the picture under it – a fresh one, the view being hidden already – and stays out', async () => {
    sidebar()
    await open()
    settle()
    vi.mocked(cmd).mockClear()
    sidebar({ active: 'docs' })
    expect(vi.mocked(cmd)).toHaveBeenCalledWith('overlay.snapshot', { tabId: 'docs', fresh: true })
    expect(flyout().dataset.flyout).toBe('out')
    expect(width()).toBe(`${OUT}px`)
  })

  it('follows the expanded sidebar’s width: a wider setting while out retargets the spring', async () => {
    sidebar()
    await open()
    settle()
    sidebar({ width: 320 })
    const widths = settle()
    expect(widths.length).toBeGreaterThan(0)
    expect(width()).toBe(`${COLLAPSED_WIDTH + 320}px`)
  })
})

describe('the collapsed rail’s flyout (tabs-03): dismiss and the keyboard', () => {
  it('folds at once on Escape, and on a press into the page – the press not consumed', async () => {
    sidebar()
    await open()
    settle()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(flyout().dataset.flyout).toBe('folding')
    settle()
    expect(flyout().hasAttribute('data-flyout')).toBe(false)
    expect(uiStore.get().railFlyout).toBe(false)

    // Out again; a press anywhere outside the sidebar folds it.
    pointer('pointerleave')
    await open()
    settle()
    const page = document.createElement('div')
    document.body.append(page)
    const press = new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 })
    act(() => {
      page.dispatchEvent(press)
    })
    expect(press.defaultPrevented).toBe(false)
    expect(flyout().dataset.flyout).toBe('folding')
    settle()
    expect(flyout().hasAttribute('data-flyout')).toBe(false)
    page.remove()

    // A press on a row is the flyout's own: nothing folds.
    pointer('pointerleave')
    await open()
    settle()
    const row = q<HTMLElement>('[data-testid="tab"]')!
    act(() => {
      row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
    })
    expect(flyout().dataset.flyout).toBe('out')
  })

  it('after a dismiss the pointer still on the rail arms no dwell: it has to leave and come back', async () => {
    sidebar()
    await open()
    settle()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    settle()
    wait(RAIL_FLYOUT_DWELL_MS * 3)
    expect(flyout().hasAttribute('data-flyout')).toBe(false)
    // The open and the fold; no third start from a dwell the pointer never re-armed.
    expect(starts).toHaveLength(2)
    expect(vi.mocked(cmd)).toHaveBeenCalledTimes(1)
    pointer('pointerleave')
    pointer('pointerenter')
    wait(RAIL_FLYOUT_DWELL_MS)
    await captured()
    expect(flyout().dataset.flyout).toBe('opening')
  })

  it('the setting turned off while out folds it; unmounting drops the flag and brings the page back', async () => {
    sidebar()
    await open()
    settle()
    sidebar({ expandOnHover: false })
    // The offer withdrawn: the machine folds; the box keeps the flyout's positioning and its
    // rows their expanded form until the fold rests, then the flag drops and the box is the
    // aside's plain column again.
    expect(aside().hasAttribute('data-flyout-offered')).toBe(false)
    expect(flyout().dataset.flyout).toBe('folding')
    expect(flyout().className).toContain('absolute')
    const widths = settle()
    expect(monotone(widths, -1)).toBe(true)
    expect(uiStore.get().railFlyout).toBe(false)
    expect(q('[data-rail-flyout]')).toBeNull()
    expect(q<HTMLElement>('.zen-rail-flyout')!.className).not.toContain('absolute')
    expect(width()).toBe('')
    expect(titles()).toEqual([])

    sidebar()
    await open()
    settle()
    expect(uiStore.get().railFlyout).toBe(true)
    act(() => root?.unmount())
    root = null
    mount?.remove()
    mount = null
    expect(uiStore.get().railFlyout).toBe(false)
    expect(uiStore.get().snapshotTabId).toBeNull()
  })

  it('cuts under reduced motion (§11.3): the width jumps to the rail plus the panel and back with no frame between', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }))
    sidebar()
    await open()
    // No frame run: the start was the cut, the spring at rest in the same breath.
    expect(starts).toHaveLength(1)
    expect(width()).toBe(`${OUT}px`)
    expect(flyout().dataset.flyout).toBe('out')
    expect(flyout().hasAttribute('data-flyout-moving')).toBe(false)
    expect(titles()).toHaveLength(3)
    pointer('pointerleave')
    wait(RAIL_FLYOUT_GRACE_MS)
    expect(starts).toHaveLength(2)
    expect(width()).toBe('')
    expect(flyout().hasAttribute('data-flyout')).toBe(false)
    expect(uiStore.get().railFlyout).toBe(false)
    expect(titles()).toEqual([])
  })
})

describe('the collapsed rail’s flyout (tabs-03): the machine’s keyboard side', () => {
  /** The machine on a box of its own, past the DOM's `:focus-visible`, which happy-dom lays no claim to. */
  function machine(): { f: RailFlyout; box: HTMLDivElement; out: boolean[] } {
    const box = document.createElement('div')
    document.body.append(box)
    const out: boolean[] = []
    const f = new RailFlyout({ current: box }, (o) => out.push(o))
    f.configure(COLLAPSED_WIDTH, EXTENT)
    f.setActiveTab('home')
    return { f, box, out }
  }
  /** The capture's chain of awaits, run out. */
  const resolved = async (): Promise<void> => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  }
  const hidden = (): void => {
    for (const h of handlers.get('layout.applied') ?? [])
      h({ contentHidden: true, hid: ['home'], shown: [] })
  }
  const run = (): void => {
    for (let i = 0; i < 600 && frames.size; i++) frame()
  }

  it('the keyboard landing in the rail flies it out with no dwell and holds it while the focus stays; a grace after the focus leaves', async () => {
    const { f, box, out } = machine()
    f.keyboardIn()
    expect(box.dataset.flyout).toBe('opening')
    expect(vi.mocked(cmd)).toHaveBeenCalledWith('overlay.snapshot', { tabId: 'home' })
    await resolved()
    hidden()
    expect(box.dataset.flyout).toBe('out')
    expect(out).toEqual([true])
    run()
    expect(box.style.width).toBe(`${OUT}px`)
    // The pointer comes and goes: the keyboard inside holds it through every grace.
    f.pointerEnter()
    f.pointerLeave()
    vi.advanceTimersByTime(RAIL_FLYOUT_GRACE_MS * 3)
    expect(box.dataset.flyout).toBe('out')
    // The focus leaves: the grace, then the fold.
    f.keyboardOut()
    vi.advanceTimersByTime(RAIL_FLYOUT_GRACE_MS - 1)
    expect(box.dataset.flyout).toBe('out')
    vi.advanceTimersByTime(1)
    expect(box.dataset.flyout).toBe('folding')
    run()
    expect(box.hasAttribute('data-flyout')).toBe(false)
    expect(out).toEqual([true, false])
    expect(uiStore.get().railFlyout).toBe(false)
    f.dispose()
    box.remove()
  })

  it('the pointer leaving while the keyboard is inside folds nothing; the keyboard leaving while the pointer is inside folds nothing', async () => {
    const { f, box } = machine()
    f.pointerEnter()
    vi.advanceTimersByTime(RAIL_FLYOUT_DWELL_MS)
    await resolved()
    hidden()
    run()
    f.keyboardIn()
    f.pointerLeave()
    vi.advanceTimersByTime(RAIL_FLYOUT_GRACE_MS * 2)
    expect(box.dataset.flyout).toBe('out')
    f.pointerEnter()
    f.keyboardOut()
    vi.advanceTimersByTime(RAIL_FLYOUT_GRACE_MS * 2)
    expect(box.dataset.flyout).toBe('out')
    // Both gone: one grace.
    f.pointerLeave()
    vi.advanceTimersByTime(RAIL_FLYOUT_GRACE_MS)
    expect(box.dataset.flyout).toBe('folding')
    run()
    expect(box.hasAttribute('data-flyout')).toBe(false)
    f.dispose()
    box.remove()
  })

  it('a dismiss folds it whatever holds it, the keyboard included', async () => {
    const { f, box } = machine()
    f.keyboardIn()
    await resolved()
    hidden()
    run()
    f.dismiss()
    expect(box.dataset.flyout).toBe('folding')
    run()
    expect(box.hasAttribute('data-flyout')).toBe(false)
    f.dispose()
    box.remove()
  })

  it('the keyboard’s row is the parent it lights, as the pointer’s is; the row is let go at the fold’s rest and on dispose', async () => {
    const { f, box } = machine()
    const focused = document.createElement('div')
    focused.className = 'zen-tab'
    document.body.append(focused)
    f.keyboardIn(focused)
    expect(f.anchorRow).toBe(focused)
    expect(focused.hasAttribute('data-flyout-anchor')).toBe(true)
    await resolved()
    hidden()
    run()
    expect(focused.hasAttribute('data-flyout-anchor')).toBe(true)
    f.dismiss()
    expect(focused.hasAttribute('data-flyout-anchor')).toBe(true)
    run()
    expect(focused.hasAttribute('data-flyout-anchor')).toBe(false)
    expect(f.anchorRow).toBeNull()
    // The pointer's: the row under it when the dwell is up.
    const hovered = document.createElement('div')
    document.body.append(hovered)
    f.pointerOver(hovered)
    f.pointerEnter()
    vi.advanceTimersByTime(RAIL_FLYOUT_DWELL_MS)
    expect(f.anchorRow).toBe(hovered)
    f.dispose()
    expect(hovered.hasAttribute('data-flyout-anchor')).toBe(false)
    focused.remove()
    hovered.remove()
    box.remove()
  })
})
