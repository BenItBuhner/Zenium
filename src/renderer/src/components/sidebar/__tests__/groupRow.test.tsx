// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Space, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID } from '@shared/types'
import { SPRING_GENTLE, type SpringConfig } from '@shared/spring'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

/** Every spring started in the panel – the list's FLIP glides among them – with its configuration and its way. */
const { starts } = vi.hoisted(() => ({
  starts: [] as Array<{ config: SpringConfig; from: number; to: number }>
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

import { run } from '@renderer/lib/api'
import { viewportStore } from '@renderer/lib/formFactor'
import { SlideMotion } from '@renderer/lib/motion/slide'
import { browserStore, uiStore } from '@renderer/lib/ui'
import { SpacePanel } from '../SpacePanel'
import { StripAxisContext, type StripAxis } from '../stripAxis'

/*
 * The tablet sidebar's tab group rendered for real (TABLET-04; design language v2 §9.36 as
 * amended, §11.4): a full-width 44 row like Zen's folder – the colour dot or the saved ring in
 * the glyph slot, the name at 14, the count as the 13 aside, the chevron on the close column,
 * the tabs indented 24 beneath while open; a tap folds it, the block's height on SPRING_GENTLE
 * with the rows it had kept drawn until the spring rests; a hold brings the group's menu at the
 * finger; a SAVED group – its tabs closed, its pages kept (TAB-16) – as a row with the ring and
 * the count of its pages whose tap opens it; the desktop's row on its own contract (TAB-16's
 * desktop half – desktopGroups.test.tsx), its fold the same spring (W4-2): the block's height
 * on SPRING_GENTLE with the rows it had – its tabs, or a saved folder's pages – kept drawn
 * until the spring rests, and the cut under reduced motion (§11.3); the strip's chip (§9.37)
 * the same fold along `x`. The rows below the block are kept honest: the list's FLIP baseline
 * follows every frame of the fold, and the block holds the header's height at a shut rest until
 * the commit that removes the kept rows, so no frame paints it open.
 */

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')

/** The text of the first `selector {` rule in the stylesheet. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROW = 44
const GAP = 2

/** The strip's chip along `x`, and a member tab's width beside it. */
const CHIP = 120
const STRIP_TAB = 180

// happy-dom lays nothing out: the fold reads the block's and the header's `offsetHeight`, so
// the block answers with the rows it holds – its tabs, or a saved folder's pages – and the
// header with the row; along the strip's `x` the same by `offsetWidth`, the chip and the tabs.
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get(this: HTMLElement): number {
    if (this.classList.contains('zen-group-fold')) {
      const rows = this.querySelectorAll('[data-tab-id], [data-saved-page]').length
      return ROW + rows * (ROW + GAP)
    }
    if (this.classList.contains('zen-tab')) return ROW
    return 0
  }
})
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get(this: HTMLElement): number {
    if (this.classList.contains('zen-group-fold')) {
      const rows = this.querySelectorAll('[data-tab-id]').length
      return CHIP + rows * (STRIP_TAB + GAP)
    }
    if (this.classList.contains('zen-strip-group-chip')) return CHIP
    return 0
  }
})

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: 'space',
    containerId: DEFAULT_CONTAINER_ID,
    url: `https://${id}.example/`,
    title: id.toUpperCase(),
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

function folder(over: Partial<Folder> = {}): Folder {
  return {
    id: 'g',
    spaceId: 'space',
    name: 'Research',
    icon: '📁',
    color: 'blue',
    collapsed: false,
    ...over
  } as Folder
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

/**
 * The panel with the space's tabs and folders; re-rendered with new state by the next call. The
 * layout is set after the browser store: the viewport re-derives itself from the window (a
 * desktop's, in happy-dom) whenever that store changes.
 */
function panel(
  tabs: Tab[],
  folders: Folder[],
  formFactor: 'tablet' | 'desktop' = 'tablet',
  windowKind: 'synced' | 'private' = 'synced',
  axis: StripAxis = 'y'
): void {
  const space: Space = {
    id: 'space',
    name: 'Work',
    icon: '',
    containerId: DEFAULT_CONTAINER_ID,
    theme: null,
    tabIds: tabs.map((t) => t.id),
    activeTabId: tabs[0]?.id ?? null,
    pinnedCollapsed: false
  }
  const state = {
    platform: 'android',
    window: { kind: windowKind },
    // The tablet keeps private browsing in tabs; the desktop in a private window.
    capabilities: { privateTabs: formFactor === 'tablet' },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [space],
    activeSpaceId: 'space',
    folders: Object.fromEntries(folders.map((f) => [f.id, f])),
    liveFolders: {},
    splitGroups: {},
    essentialTabIds: [],
    foreignTabIds: [],
    agents: [],
    containers: [],
    media: [],
    settings: { showTabSeparator: false }
  } as unknown as UIState
  browserStore.set({ state })
  const touch = formFactor === 'tablet'
  viewportStore.set({ ...viewportStore.get(), formFactor, coarse: touch, hover: !touch })
  render(
    <StripAxisContext.Provider value={axis}>
      <SpacePanel state={state} space={space} isActive compact={false} />
    </StripAxisContext.Provider>
  )
}

/** The fold's own springs: the block's height on SPRING_GENTLE, from one height to the other. */
const folds = (): Array<{ from: number; to: number }> =>
  starts.filter((s) => s.config === SPRING_GENTLE).map(({ from, to }) => ({ from, to }))

const grouped = (): Tab[] => [
  tab('home'),
  tab('alpha', { folderId: 'g' }),
  tab('beta', { folderId: 'g' }),
  tab('gamma')
]

const q = <T extends HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)
const header = (): HTMLElement => q<HTMLElement>('[data-tab-folder="g"]')!
const shell = (): HTMLElement => q<HTMLElement>('.zen-group-fold')!
/** The fold's progress the hook writes on the shell for the chevron ('' where the state binds). */
const progress = (): string => shell().style.getPropertyValue('--zen-fold-progress')
const memberRows = (): string[] =>
  [...shell().querySelectorAll<HTMLElement>('[data-tab-id]')].map((el) => el.dataset.tabId!)
/** A saved folder's page rows in the block (the desktop's, TAB-16), by title. */
const pageRows = (): string[] =>
  [...shell().querySelectorAll<HTMLElement>('[data-saved-page]')].map((el) =>
    el.getAttribute('aria-label')!
  )

const PAGES = [
  { url: 'https://alpha.example/', title: 'ALPHA' },
  { url: 'https://beta.example/', title: 'BETA' },
  { url: 'https://delta.example/', title: 'DELTA' }
]

const frames = new Map<number, (t: number) => void>()
let nextFrame = 1
let now = 10_000

beforeEach(() => {
  starts.length = 0
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
})

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  browserStore.set({ state: null })
  uiStore.set({ selectedTabIds: [], drag: null, renamingFolderId: null })
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false, hover: true })
  vi.mocked(run).mockClear()
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
const settle = (): void => {
  act(() => {
    for (let i = 0; i < 600 && frames.size; i++) frame()
  })
}

/** A finger down on `el` at (x, y) that lifts after `holdMs`, the click a lift brings following unless `click` is off. */
function press(el: HTMLElement, x: number, y: number, holdMs: number, click = true): void {
  act(() => {
    el.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 1,
        button: 0,
        clientX: x,
        clientY: y
      })
    )
  })
  act(() => {
    vi.advanceTimersByTime(holdMs)
  })
  act(() => {
    el.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 1,
        button: 0,
        clientX: x,
        clientY: y
      })
    )
    if (click) el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('the tablet sidebar’s group row (TABLET-04, §9.36)', () => {
  it('is a full-width 44 row: the colour dot in the glyph slot, the name, the count as the 13 aside, the chevron; its tabs 24 in beneath', () => {
    panel(grouped(), [folder()])
    const row = header()
    expect(row.className).toContain('zen-group-row')
    expect(row.className).toContain('zen-tab')
    expect(row.getAttribute('role')).toBe('button')
    expect(row.getAttribute('aria-label')).toBe('Research')
    expect(row.getAttribute('aria-description')).toBe('Tab group, 2 tabs')
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(row.hasAttribute('data-saved')).toBe(false)
    const glyph = row.querySelector<HTMLElement>('[data-testid="group-row-glyph"]')!
    expect(glyph.hasAttribute('data-saved')).toBe(false)
    // §9.14's pair on the glyph; main.css picks `--zen-group-rgb` from it by the root's theme.
    expect(glyph.hasAttribute('data-group-rgb')).toBe(true)
    expect(glyph.style.getPropertyValue('--zen-group-rgb-light')).toBe('22 108 221')
    expect(glyph.style.getPropertyValue('--zen-group-rgb-dark')).toBe('138 180 248')
    expect(glyph.style.getPropertyValue('--zen-group-rgb')).toBe('')
    expect(glyph.querySelector('.zen-group-row-dot')).not.toBeNull()
    expect(glyph.querySelector('.zen-group-row-icon')).toBeNull()
    expect(row.querySelector('[data-testid="group-row-name"]')?.textContent).toBe('Research')
    expect(row.querySelector('[data-testid="group-row-count"]')?.textContent).toBe('2')
    expect(row.querySelector('svg.zen-group-row-chevron')).not.toBeNull()
    // The rows in order under the header, in the one block the fold runs.
    expect(memberRows()).toEqual(['alpha', 'beta'])
    expect(shell().firstElementChild).toBe(row)

    // The stylesheet: the tablet's 44 row at 14, the 10 dot, the 13 tabular count, the 16
    // chevron on the close X's column, the rows 24 in, the block clipped while it folds.
    const tabletRow = rule(":root[data-form-factor='tablet'] .zen-tab")
    expect(tabletRow).toContain('height: var(--v2-row, 44px)')
    expect(tabletRow).toContain('font-size: 14px')
    expect(rule('.zen-group-row-glyph')).toContain('width: 16px')
    const dot = rule('.zen-group-row-dot')
    expect(dot).toContain('width: 10px')
    expect(dot).toContain('background: rgb(var(--zen-group-rgb))')
    const ring = rule('.zen-group-row-glyph[data-saved] .zen-group-row-dot')
    expect(ring).toContain('background: transparent')
    expect(ring).toContain('box-shadow: inset 0 0 0 2px rgb(var(--zen-group-rgb))')
    const count = rule('.zen-group-row-count')
    expect(count).toContain('font-size: 13px')
    expect(count).toContain('font-variant-numeric: tabular-nums')
    expect(count).toContain('color: var(--v2-control-text-deemphasized')
    // The tablet row's chevron box, on the tablet row; the bare class is the turn (below).
    const chevron = rule('.zen-group-row .zen-group-row-chevron')
    expect(chevron).toContain('width: 16px')
    expect(chevron).toContain('margin-right: 14px')
    expect(chevron).toContain('opacity: 0.69')
    expect(
      rule(
        ":root[data-form-factor='tablet'] .zen-group-fold > .zen-group-rows > .zen-tab:not(.justify-center)"
      )
    ).toContain('margin-left: 24px')
    // `clip`, not `hidden`: the folding shell is no scroll container a focus could scroll.
    expect(rule('.zen-group-fold[data-folding]')).toContain('overflow: clip')
    expect(rule(":root[data-form-factor='tablet'] .zen-tab.zen-group-row input")).toContain(
      'font-size: 14px'
    )
  })

  it('keeps the folder’s own icon in the glyph slot where the desktop gave it one', () => {
    panel(grouped(), [folder({ icon: '🔬' })])
    const glyph = header().querySelector<HTMLElement>('[data-testid="group-row-glyph"]')!
    expect(glyph.querySelector('.zen-group-row-icon')?.textContent).toBe('🔬')
    expect(glyph.querySelector('.zen-group-row-dot')).toBeNull()
  })

  it('draws the same glyph in the horizontal strip’s chip (§9.37): the 10 dot, or the folder’s own icon', () => {
    // The strip's chip on the desktop (the list's axis `x`): the shared glyph ahead of the name,
    // the dot in the group's colour where the folder keeps the default icon…
    panel(grouped(), [folder()], 'desktop', 'synced', 'x')
    let chip = header()
    expect(chip.className).toContain('zen-strip-group-chip')
    let glyph = chip.querySelector<HTMLElement>('[data-testid="group-row-glyph"]')!
    expect(glyph).not.toBeNull()
    // §9.14's pair on the glyph; main.css picks `--zen-group-rgb` from it by the root's theme.
    expect(glyph.hasAttribute('data-group-rgb')).toBe(true)
    expect(glyph.style.getPropertyValue('--zen-group-rgb-light')).toBe('22 108 221')
    expect(glyph.style.getPropertyValue('--zen-group-rgb-dark')).toBe('138 180 248')
    expect(glyph.style.getPropertyValue('--zen-group-rgb')).toBe('')
    expect(glyph.querySelector('.zen-group-row-dot')).not.toBeNull()
    expect(glyph.querySelector('.zen-group-row-icon')).toBeNull()
    expect(glyph.nextElementSibling?.getAttribute('data-testid')).toBe('group-chip-name')
    expect(chip.querySelector('[data-testid="group-chip-name"]')?.textContent).toBe('Research')
    // The group's 2 px line along the band wears the same pair on itself and reads
    // `rgb(var(--zen-group-rgb))` from the stylesheet: no colour of its own inline.
    const line = shell().querySelector<HTMLElement>('[data-strip-group-line="g"]')!
    expect(line).not.toBeNull()
    expect(line.hasAttribute('data-group-rgb')).toBe(true)
    expect(line.style.getPropertyValue('--zen-group-rgb-light')).toBe('22 108 221')
    expect(line.style.getPropertyValue('--zen-group-rgb-dark')).toBe('138 180 248')
    expect(line.style.getPropertyValue('--zen-group-rgb')).toBe('')
    expect(line.style.background).toBe('')
    expect(line.style.backgroundColor).toBe('')
    const lineRule = rule('.zen-strip-group-line')
    expect(lineRule).toContain('height: 2px')
    expect(lineRule).toContain('top: 2px')
    expect(lineRule).toContain('background: rgb(var(--zen-group-rgb))')
    // …and the folder's own icon where it has one, as on every other host.
    panel(grouped(), [folder({ icon: '🔬' })], 'desktop', 'synced', 'x')
    chip = header()
    glyph = chip.querySelector<HTMLElement>('[data-testid="group-row-glyph"]')!
    expect(glyph.querySelector('.zen-group-row-icon')?.textContent).toBe('🔬')
    expect(glyph.querySelector('.zen-group-row-dot')).toBeNull()
  })

  it('draws a saved group in the strip as its chip alone (§9.37, TAB-16): the ring, the name, the count of its pages, and a press opens the folder', () => {
    const saved = folder({
      savedTabs: [
        { url: 'https://alpha.example/', title: 'ALPHA' },
        { url: 'https://beta.example/', title: 'BETA' }
      ]
    })
    panel([tab('home'), tab('gamma')], [saved], 'desktop', 'synced', 'x')
    const chip = header()
    expect(chip.className).toContain('zen-strip-group-chip')
    expect(chip.hasAttribute('data-saved')).toBe(true)
    expect(shell().dataset.groupKind).toBe('saved')
    // Nothing along the band to fold: no disclosure state, the description says saved.
    expect(chip.hasAttribute('aria-expanded')).toBe(false)
    expect(chip.getAttribute('aria-description')).toBe('Tab group, saved, 2 tabs')
    // The shared glyph wears the ring (its dot drawn hollow by `[data-saved]`), then the name,
    // then the count of the pages the group keeps as the 13 tabular aside.
    const glyph = chip.querySelector<HTMLElement>('[data-testid="group-row-glyph"]')!
    expect(glyph.hasAttribute('data-saved')).toBe(true)
    expect(glyph.querySelector('.zen-group-row-dot')).not.toBeNull()
    expect(glyph.nextElementSibling?.getAttribute('data-testid')).toBe('group-chip-name')
    const count = chip.querySelector<HTMLElement>('[data-testid="group-chip-count"]')!
    expect(count.textContent).toBe('2')
    expect(count.className).toContain('text-[13px]')
    expect(count.className).toContain('tabular-nums')
    expect(chip.querySelector('[data-testid="group-chip-name"]')?.nextElementSibling).toBe(count)
    // No member rows and no page rows along the band; the group's line spans the chip alone.
    expect(memberRows()).toEqual([])
    expect(shell().querySelector('[data-saved-pages]')).toBeNull()
    expect(shell().querySelector('[data-strip-group-line="g"]')).not.toBeNull()
    // A press brings the pages back as the group's tabs; it folds nothing.
    act(() => chip.click())
    expect(run).toHaveBeenCalledWith('folder.open', { folderId: 'g' })
    expect(run).not.toHaveBeenCalledWith('folder.update', expect.anything())
    // An open group's chip carries no count: its members are along the band.
    panel(grouped(), [folder()], 'desktop', 'synced', 'x')
    expect(header().querySelector('[data-testid="group-chip-count"]')).toBeNull()
    expect(header().getAttribute('aria-expanded')).toBe('true')
    expect(shell().dataset.groupKind).toBe('open')
  })

  it('folds on a tap: the block’s height runs on SPRING_GENTLE, the rows it had staying drawn until it rests', () => {
    panel(grouped(), [folder()])
    act(() => header().click())
    expect(run).toHaveBeenCalledWith('folder.update', {
      folderId: 'g',
      patch: { collapsed: true }
    })
    expect(folds()).toEqual([])

    // The core folds it: the rows stay for the very commit that folds, the block clipped and
    // its height set to run from the whole to the header alone, on the gentle spring.
    const whole = ROW + 2 * (ROW + GAP)
    panel(grouped(), [folder({ collapsed: true })])
    expect(memberRows()).toEqual(['alpha', 'beta'])
    expect(shell().hasAttribute('data-folding')).toBe(true)
    expect(shell().style.height).toBe(`${whole}px`)
    expect(folds()).toEqual([{ from: whole, to: ROW }])
    expect(header().getAttribute('aria-expanded')).toBe('false')
    expect(header().querySelector('[data-testid="group-row-count"]')?.textContent).toBe('2')
    expect(frames.size).toBeGreaterThan(0)
    // The spring in flight: the height between the two, the rows still there.
    act(() => {
      frame()
      frame()
    })
    const mid = parseFloat(shell().style.height)
    expect(mid).toBeLessThan(whole)
    expect(mid).toBeGreaterThan(ROW)
    expect(memberRows()).toEqual(['alpha', 'beta'])
    // At rest: the layout holds the height, the clip lifts, the kept rows go.
    settle()
    expect(shell().style.height).toBe('')
    expect(shell().hasAttribute('data-folding')).toBe(false)
    expect(memberRows()).toEqual([])
    expect(q('[data-tab-id="gamma"]')).not.toBeNull()
  })

  it('unfolds on the next tap: the rows come back in that commit and the height runs from the header to the whole', () => {
    panel(grouped(), [folder({ collapsed: true })])
    expect(memberRows()).toEqual([])
    act(() => header().click())
    expect(run).toHaveBeenLastCalledWith('folder.update', {
      folderId: 'g',
      patch: { collapsed: false }
    })
    panel(grouped(), [folder({ collapsed: false })])
    expect(memberRows()).toEqual(['alpha', 'beta'])
    expect(shell().hasAttribute('data-folding')).toBe(true)
    expect(shell().style.height).toBe(`${ROW}px`)
    expect(folds()).toEqual([{ from: ROW, to: ROW + 2 * (ROW + GAP) }])
    act(() => {
      frame()
      frame()
    })
    expect(parseFloat(shell().style.height)).toBeGreaterThan(ROW)
    settle()
    expect(shell().style.height).toBe('')
    expect(shell().hasAttribute('data-folding')).toBe(false)
    expect(header().getAttribute('aria-expanded')).toBe('true')
  })

  it('brings the group’s menu at the finger on a hold, the click after it swallowed', () => {
    panel(grouped(), [folder()])
    // The menu on the release, at the point the finger went down: on the click that follows the
    // lift, which the row swallows instead of folding.
    press(header(), 130, 210, 400)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('folder.contextMenu', { folderId: 'g', x: 130, y: 210 })
    // No click after the lift (the touch ended without one): the menu a moment later all the same.
    vi.mocked(run).mockClear()
    press(header(), 140, 220, 400, false)
    expect(run).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(run).toHaveBeenCalledWith('folder.contextMenu', { folderId: 'g', x: 140, y: 220 })
    expect(run).not.toHaveBeenCalledWith('folder.update', expect.anything())
    // A tap – the finger up before the hold – folds instead.
    vi.mocked(run).mockClear()
    press(header(), 130, 210, 100)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(run).toHaveBeenCalledWith('folder.update', {
      folderId: 'g',
      patch: { collapsed: true }
    })
    expect(run).not.toHaveBeenCalledWith('folder.contextMenu', expect.anything())
  })

  it('lists a saved group as a row with the ring, the count of its pages and no chevron, whose tap opens it', () => {
    const saved = folder({
      savedTabs: [
        { url: 'https://alpha.example/', title: 'ALPHA' },
        { url: 'https://beta.example/', title: 'BETA' }
      ]
    })
    panel([tab('home'), tab('gamma')], [saved])
    const row = header()
    expect(row.hasAttribute('data-saved')).toBe(true)
    expect(row.hasAttribute('aria-expanded')).toBe(false)
    expect(row.getAttribute('aria-description')).toBe('Tab group, saved, 2 tabs')
    const glyph = row.querySelector<HTMLElement>('[data-testid="group-row-glyph"]')!
    expect(glyph.hasAttribute('data-saved')).toBe(true)
    expect(glyph.querySelector('.zen-group-row-dot')).not.toBeNull()
    expect(row.querySelector('[data-testid="group-row-count"]')?.textContent).toBe('2')
    // Nothing to fold: the chevron's box stays, empty, so the counts share one edge.
    expect(row.querySelector('svg.zen-group-row-chevron')).toBeNull()
    expect(row.querySelector('span.zen-group-row-chevron')).not.toBeNull()
    expect(memberRows()).toEqual([])
    act(() => row.click())
    expect(run).toHaveBeenCalledWith('folder.open', { folderId: 'g' })
    expect(run).not.toHaveBeenCalledWith('folder.update', expect.anything())
  })

  it('puts the name being edited in the name’s slot, the taps kept off the fold meanwhile', () => {
    uiStore.set({ renamingFolderId: 'g' })
    panel(grouped(), [folder()])
    const field = header().querySelector<HTMLInputElement>('input')!
    expect(document.activeElement).toBe(field)
    expect(field.value).toBe('Research')
    expect(header().querySelector('[data-testid="group-row-name"]')).toBeNull()
    act(() => header().click())
    expect(run).not.toHaveBeenCalled()
  })

  it('PRIVATE-BROWSING LEAK, fixed: a group that private tabs alone fill is no row of the sidebar – its name nowhere in it – and a group’s private members are not its rows or its count', () => {
    const privateTab = (id: string, over: Partial<Tab> = {}): Tab =>
      tab(id, { containerId: PRIVATE_CONTAINER_ID, ...over })
    // Ghost: private tabs alone, nothing saved – a PRIVATE group (`isPrivateGroup`), which the
    // sidebar itself can make on a host that keeps private browsing in tabs (the space holds
    // them among the regular tabs; `regularOf` lists both). Research: one regular member beside
    // a private one. Trip: two pages saved and a private tab dropped in since. Vault: Ghost's
    // case folded – `isPrivateGroup` is read before any fold, so a collapsed private-only group
    // is no row either (not a folded header with a count).
    const ghost = folder({ id: 'ghost', name: 'Ghost', color: 'red' })
    const vault = folder({ id: 'vault', name: 'Vault', color: 'orange', collapsed: true })
    const research = folder()
    const trip = folder({
      id: 'trip',
      name: 'Trip',
      color: 'green',
      savedTabs: [
        { url: 'https://t1.example/', title: 'T1' },
        { url: 'https://t2.example/', title: 'T2' }
      ]
    })
    const tabs = [
      tab('home'),
      privateTab('g1', { folderId: 'ghost' }),
      privateTab('g2', { folderId: 'ghost' }),
      privateTab('v1', { folderId: 'vault' }),
      privateTab('v2', { folderId: 'vault' }),
      tab('alpha', { folderId: 'g' }),
      privateTab('p1', { folderId: 'g' }),
      privateTab('t1', { folderId: 'trip' }),
      tab('gamma')
    ]
    panel(tabs, [ghost, vault, research, trip])
    const panelEl = q<HTMLElement>('[data-tab-list="regular"]')!.parentElement!.parentElement!
    // No row of Ghost's or Vault's – no header, no fold, open or collapsed – and their names in
    // no text or attribute of the panel (the rows' labels, the descriptions for TalkBack, the
    // folds' keys).
    expect(q('[data-tab-folder="ghost"]')).toBeNull()
    expect(q('[data-tab-folder="vault"]')).toBeNull()
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-tab-folder]')].map(
        (el) => el.dataset.tabFolder
      )
    ).toEqual(['g', 'trip'])
    for (const name of ['Ghost', 'ghost', 'Vault', 'vault']) {
      expect(panelEl.textContent).not.toContain(name)
      expect(panelEl.innerHTML).not.toContain(name)
    }
    // Research counts and holds its regular member alone: the private one is no row of its fold.
    expect(header().getAttribute('aria-description')).toBe('Tab group, 1 tab')
    expect(header().querySelector('[data-testid="group-row-count"]')?.textContent).toBe('1')
    expect(memberRows()).toEqual(['alpha'])
    // Trip is a SAVED group of its two pages (saved pages are regular), the private tab in it
    // no part of its count and no row of it.
    const tripRow = q<HTMLElement>('[data-tab-folder="trip"]')!
    expect(tripRow.hasAttribute('data-saved')).toBe(true)
    expect(tripRow.getAttribute('aria-description')).toBe('Tab group, saved, 2 tabs')
    expect(tripRow.querySelector('[data-testid="group-row-count"]')?.textContent).toBe('2')
    expect(tripRow.parentElement!.querySelectorAll('[data-tab-id]')).toHaveLength(0)
    // The private tabs themselves are no rows of the panel at all (W4-11: the sidebar's REGULAR
    // pose lists the space's regular tabs and never a private one; the private pose lists them,
    // `sidebarPrivate.test.tsx`): the loose rows are the regular ones alone.
    const loose = [
      ...document.querySelectorAll<HTMLElement>('[data-tab-list="regular"] > [data-tab-id]')
    ].map((el) => el.dataset.tabId)
    expect(loose).toEqual(['home', 'gamma'])
    for (const id of ['g1', 'g2', 'v1', 'v2', 'p1', 't1'])
      expect(q(`[data-tab-id="${id}"]`)).toBeNull()

    // The desktop's regular spaces hold no private tab, so the predicate touches nothing
    // there; in a PRIVATE window – private mode itself – the window's own groups stand whole,
    // their private members their rows, since nothing leaks inside the mode.
    panel(
      [
        privateTab('one', { folderId: 'g' }),
        privateTab('two', { folderId: 'g' }),
        privateTab('three')
      ],
      [research],
      'desktop',
      'private'
    )
    expect(q('[data-tab-folder="g"]')).not.toBeNull()
    expect(header().getAttribute('aria-description')).toBe('Folder, 2 tabs')
    expect(memberRows()).toEqual(['one', 'two'])
  })

  it('leaves the desktop’s folder row on its own contract: Zen’s 32 header with the group’s glyph and no bar, its fold the same spring', () => {
    // Stale `savedTabs` beside live members are no saved group: the row is an open folder's.
    panel(
      grouped(),
      [folder({ savedTabs: [{ url: 'https://x.example/', title: 'X' }] })],
      'desktop'
    )
    const row = header()
    expect(row.className).not.toContain('zen-group-row')
    expect(row.hasAttribute('data-saved')).toBe(false)
    expect(row.getAttribute('aria-description')).toBe('Folder, 2 tabs')
    expect(row.getAttribute('aria-expanded')).toBe('true')
    // The same glyph as the tablet's in the favicon slot – the dot for the default icon – and
    // no bar on the fold block (desktopGroups.test.tsx has the desktop's own contract).
    const glyph = row.querySelector<HTMLElement>('[data-testid="group-row-glyph"]')!
    expect(glyph.hasAttribute('data-saved')).toBe(false)
    expect(glyph.querySelector('.zen-group-row-dot')).not.toBeNull()
    expect(row.textContent).not.toContain('📁')
    expect(shell().hasAttribute('data-group-bar')).toBe(false)
    expect(shell().dataset.groupKind).toBe('open')
    expect(row.querySelector('[data-testid="group-count"]')?.textContent).toBe('2')
    expect(row.querySelector('[data-testid="group-row-count"]')).toBeNull()
    // The desktop's fold is the tablet's spring (W4-2): the rows kept for the commit that folds,
    // the block clipped, its height run from the whole to the header alone on SPRING_GENTLE…
    const whole = ROW + 2 * (ROW + GAP)
    panel(grouped(), [folder({ collapsed: true })], 'desktop')
    expect(memberRows()).toEqual(['alpha', 'beta'])
    expect(shell().hasAttribute('data-folding')).toBe(true)
    expect(shell().style.height).toBe(`${whole}px`)
    expect(folds()).toEqual([{ from: whole, to: ROW }])
    expect(row.getAttribute('aria-expanded')).toBe('false')
    act(() => {
      frame()
      frame()
    })
    const mid = parseFloat(shell().style.height)
    expect(mid).toBeLessThan(whole)
    expect(mid).toBeGreaterThan(ROW)
    expect(memberRows()).toEqual(['alpha', 'beta'])
    // …and at rest the clip lifts, the layout holds the header's height, the kept rows go.
    settle()
    expect(shell().style.height).toBe('')
    expect(shell().hasAttribute('data-folding')).toBe(false)
    expect(memberRows()).toEqual([])
  })

  it('keeps the rows below honest (W4-2): the list’s baseline follows every frame of the fold, and the block holds the header’s height at a shut rest until the kept rows go', () => {
    const record = vi.spyOn(SlideMotion.prototype, 'record')
    panel(grouped(), [folder()], 'desktop')
    expect(record).not.toHaveBeenCalled()
    // The folding commit records nothing itself: the panel's FLIP measures there, the block
    // set to its whole. Each frame after moves the layout under the rows below with no commit
    // between – and re-records where they are, so the commit after finds them there rather
    // than a block's height away.
    panel(grouped(), [folder({ collapsed: true })], 'desktop')
    expect(record).not.toHaveBeenCalled()
    act(() => {
      frame()
      frame()
    })
    expect(record).toHaveBeenCalledTimes(2)
    // The spring rests on a frame while the kept rows are still in the DOM. Were the layout to
    // hold the height there, the frame before their removal commits would paint the block
    // whole: the shell stands at the header's height, clipped, until that commit lets go.
    let rested: { height: string; folding: boolean; rows: string[] } | null = null
    act(() => {
      for (let i = 0; i < 600 && frames.size; i++) {
        frame()
        if (!frames.size)
          rested = {
            height: shell().style.height,
            folding: shell().hasAttribute('data-folding'),
            rows: memberRows()
          }
      }
    })
    expect(rested).toEqual({ height: `${ROW}px`, folding: true, rows: ['alpha', 'beta'] })
    expect(shell().style.height).toBe('')
    expect(shell().hasAttribute('data-folding')).toBe(false)
    expect(memberRows()).toEqual([])
    // The baseline was recorded on every frame and at the rest.
    const foldFrames = record.mock.calls.length
    expect(foldFrames).toBeGreaterThan(3)
    // A commit at rest records nothing more.
    panel(grouped(), [folder({ collapsed: true })], 'desktop')
    expect(record).toHaveBeenCalledTimes(foldFrames)
    // Resting open, the layout holds the whole in that very frame: nothing to hold for.
    record.mockClear()
    panel(grouped(), [folder()], 'desktop')
    expect(record).not.toHaveBeenCalled()
    let open: { height: string; folding: boolean; rows: string[] } | null = null
    act(() => {
      for (let i = 0; i < 600 && frames.size; i++) {
        frame()
        if (!frames.size)
          open = {
            height: shell().style.height,
            folding: shell().hasAttribute('data-folding'),
            rows: memberRows()
          }
      }
    })
    expect(open).toEqual({ height: '', folding: false, rows: ['alpha', 'beta'] })
    expect(record.mock.calls.length).toBeGreaterThan(3)
  })

  it('keeps a saved folder’s pages through the desktop’s fold (W4-2, #360’s F5): the block measures whole as it shuts, the pages drawn until the spring rests, and back in the commit that unfolds', () => {
    // A SAVED folder unfolded on the desktop: its pages under the header as rows of the block.
    panel([tab('home'), tab('gamma')], [folder({ savedTabs: PAGES })], 'desktop')
    const row = header()
    expect(row.hasAttribute('data-saved')).toBe(true)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(shell().dataset.groupKind).toBe('saved')
    expect(memberRows()).toEqual([])
    expect(pageRows()).toEqual(['ALPHA', 'BETA', 'DELTA'])
    expect(folds()).toEqual([])
    // Folded: the pages stay for the folding commit – so the shell measures the whole block,
    // header and three page rows, not the header alone – clipped, the height on SPRING_GENTLE
    // from that whole to the header. (Before W4-2 the pages went with the state and the fold
    // measured `whole == alone`: a cut shut and a spring open.)
    const whole = ROW + PAGES.length * (ROW + GAP)
    panel([tab('home'), tab('gamma')], [folder({ savedTabs: PAGES, collapsed: true })], 'desktop')
    expect(pageRows()).toEqual(['ALPHA', 'BETA', 'DELTA'])
    expect(shell().hasAttribute('data-folding')).toBe(true)
    expect(shell().style.height).toBe(`${whole}px`)
    expect(folds()).toEqual([{ from: whole, to: ROW }])
    expect(header().getAttribute('aria-expanded')).toBe('false')
    expect(header().querySelector('[data-testid="group-count"]')?.textContent).toBe('3')
    act(() => {
      frame()
      frame()
    })
    const mid = parseFloat(shell().style.height)
    expect(mid).toBeLessThan(whole)
    expect(mid).toBeGreaterThan(ROW)
    expect(pageRows()).toEqual(['ALPHA', 'BETA', 'DELTA'])
    // At rest the pages go and the clip lifts; the loose rows were never touched.
    settle()
    expect(pageRows()).toEqual([])
    expect(shell().querySelector('[data-saved-pages]')).toBeNull()
    expect(shell().hasAttribute('data-folding')).toBe(false)
    expect(shell().style.height).toBe('')
    expect(q('[data-tab-id="gamma"]')).not.toBeNull()
    // Unfolded: the pages back in that commit, the height from the header to the whole.
    starts.length = 0
    panel([tab('home'), tab('gamma')], [folder({ savedTabs: PAGES })], 'desktop')
    expect(pageRows()).toEqual(['ALPHA', 'BETA', 'DELTA'])
    expect(shell().hasAttribute('data-folding')).toBe(true)
    expect(shell().style.height).toBe(`${ROW}px`)
    expect(folds()).toEqual([{ from: ROW, to: whole }])
    act(() => {
      frame()
      frame()
    })
    expect(parseFloat(shell().style.height)).toBeGreaterThan(ROW)
    expect(parseFloat(shell().style.height)).toBeLessThan(whole)
    settle()
    expect(shell().style.height).toBe('')
    expect(shell().hasAttribute('data-folding')).toBe(false)
    expect(pageRows()).toEqual(['ALPHA', 'BETA', 'DELTA'])
    expect(header().getAttribute('aria-expanded')).toBe('true')
  })

  it('turns the chevron on the fold’s progress (§9.36 as amended, §11.1): one glyph, the shell’s --zen-fold-progress written from the height on every frame, off at the open rest, 0 through the shut hold and gone at release', () => {
    // The desktop's open folder: ONE glyph – the › with the turning class – and no ⌄ to swap
    // in. At the open rest nothing is inline: the header's state (`aria-expanded`) binds the
    // rest angle through the stylesheet, 1 for open.
    panel(grouped(), [folder()], 'desktop')
    const glyph = header().querySelector<SVGElement>('svg.zen-group-row-chevron')!
    expect(glyph).not.toBeNull()
    expect(glyph.classList.contains('lucide-chevron-right')).toBe(true)
    expect(header().querySelector('svg.lucide-chevron-down')).toBeNull()
    expect(header().querySelectorAll('.zen-group-row-chevron')).toHaveLength(1)
    expect(header().getAttribute('aria-expanded')).toBe('true')
    expect(progress()).toBe('')
    // The folding commit: the header's state has already turned to the rest the fold heads
    // for (0), so the hook writes the start's progress, 1, with the start's height – the glyph
    // reads the folded state no earlier than the first frame does. The very same element.
    const whole = ROW + 2 * (ROW + GAP)
    const share = (h: number): number => (h - ROW) / (whole - ROW)
    panel(grouped(), [folder({ collapsed: true })], 'desktop')
    expect(header().getAttribute('aria-expanded')).toBe('false')
    expect(shell().style.height).toBe(`${whole}px`)
    expect(parseFloat(progress())).toBe(1)
    expect(header().querySelector('svg.zen-group-row-chevron')).toBe(glyph)
    expect(header().querySelector('svg.lucide-chevron-down')).toBeNull()
    // Every frame: the progress is the height's place between the header alone and the whole –
    // the one value (§11.1) – falling with it, 0.5 where the height is halfway.
    const down: Array<{ h: number; p: number }> = []
    let rested: { height: string; folding: boolean; progress: string; rows: string[] } | null = null
    act(() => {
      for (let i = 0; i < 600 && frames.size; i++) {
        frame()
        if (frames.size)
          down.push({ h: parseFloat(shell().style.height), p: parseFloat(progress()) })
        else
          rested = {
            height: shell().style.height,
            folding: shell().hasAttribute('data-folding'),
            progress: progress(),
            rows: memberRows()
          }
      }
    })
    expect(down.length).toBeGreaterThan(3)
    for (const { h, p } of down) expect(p).toBeCloseTo(share(h), 3)
    for (let i = 1; i < down.length; i++) expect(down[i]!.p).toBeLessThanOrEqual(down[i - 1]!.p)
    expect(down[0]!.p).toBeGreaterThan(0.9)
    expect(down[down.length - 1]!.p).toBeLessThan(0.1)
    const midpoint = ROW + (whole - ROW) / 2
    const nearest = down.reduce((a, b) =>
      Math.abs(b.h - midpoint) < Math.abs(a.h - midpoint) ? b : a
    )
    expect(nearest.p).toBeCloseTo(0.5 + (nearest.h - midpoint) / (whole - ROW), 3)
    // At the shut rest, the kept rows still in the DOM: the height held at the header's, the
    // progress held at exactly 0 (the last frame stood a hair off), the clip on…
    expect(rested).toEqual({
      height: `${ROW}px`,
      folding: true,
      progress: '0.0000',
      rows: ['alpha', 'beta']
    })
    // …and gone with the height in the commit that removes them: the header's state binds 0.
    expect(shell().style.height).toBe('')
    expect(progress()).toBe('')
    expect(shell().hasAttribute('data-folding')).toBe(false)
    expect(memberRows()).toEqual([])
    expect(header().getAttribute('aria-expanded')).toBe('false')
    expect(header().querySelector('svg.zen-group-row-chevron')).toBe(glyph)
    // Unfolding: the start's progress, 0, with the header's height in the commit (the state
    // already says open), then up the frames with the height, off at the open rest.
    panel(grouped(), [folder()], 'desktop')
    expect(header().getAttribute('aria-expanded')).toBe('true')
    expect(shell().style.height).toBe(`${ROW}px`)
    expect(parseFloat(progress())).toBe(0)
    const up: Array<{ h: number; p: number }> = []
    act(() => {
      for (let i = 0; i < 600 && frames.size; i++) {
        frame()
        if (frames.size) up.push({ h: parseFloat(shell().style.height), p: parseFloat(progress()) })
      }
    })
    expect(up.length).toBeGreaterThan(3)
    for (const { h, p } of up) expect(p).toBeCloseTo(share(h), 3)
    for (let i = 1; i < up.length; i++) expect(up[i]!.p).toBeGreaterThanOrEqual(up[i - 1]!.p)
    expect(shell().style.height).toBe('')
    expect(progress()).toBe('')
    expect(shell().hasAttribute('data-folding')).toBe(false)
    expect(header().querySelector('svg.zen-group-row-chevron')).toBe(glyph)
    // A fold reversed mid-flight: the run measures its ends again and the spring goes on
    // writing the height's share from them, back up to the whole, monotone from where it was.
    panel(grouped(), [folder({ collapsed: true })], 'desktop')
    act(() => {
      frame()
      frame()
      frame()
      frame()
    })
    const caught = { h: parseFloat(shell().style.height), p: parseFloat(progress()) }
    expect(caught.h).toBeLessThan(whole)
    expect(caught.p).toBeCloseTo(share(caught.h), 3)
    panel(grouped(), [folder()], 'desktop')
    expect(parseFloat(progress())).toBeCloseTo(share(parseFloat(shell().style.height)), 3)
    const back: Array<{ h: number; p: number }> = []
    act(() => {
      for (let i = 0; i < 600 && frames.size; i++) {
        frame()
        if (frames.size)
          back.push({ h: parseFloat(shell().style.height), p: parseFloat(progress()) })
      }
    })
    expect(back.length).toBeGreaterThan(3)
    for (const { h, p } of back) expect(p).toBeCloseTo(share(h), 3)
    expect(back[back.length - 1]!.p).toBeGreaterThan(caught.p)
    expect(progress()).toBe('')
    expect(shell().style.height).toBe('')

    // The stylesheet: the one rule turns the glyph 90° on the progress about its centre, with
    // no transition of its own (the spring is the one clock, §11); the rest values stand on the
    // SHELL from the header's state – declared there, not on the header, since an element's own
    // declaration would beat the shell's inherited in-flight value – and the hook's inline value
    // beats them on the same element while the fold runs.
    const turn = rule('.zen-group-row-chevron')
    expect(turn).toContain('transform: rotate(calc(var(--zen-fold-progress) * 90deg))')
    expect(turn).toContain('transform-origin: center')
    expect(turn).not.toContain('transition')
    expect(css).not.toMatch(/\.zen-group-row-chevron[^{]*\{[^}]*transition/)
    expect(rule(".zen-group-fold:has(> [aria-expanded='true'])")).toContain(
      '--zen-fold-progress: 1'
    )
    expect(rule(".zen-group-fold:has(> [aria-expanded='false'])")).toContain(
      '--zen-fold-progress: 0'
    )
    expect(css).not.toMatch(/\[aria-expanded='(true|false)'\]\s*\{[^}]*--zen-fold-progress/)
  })

  it('turns the tablet row’s chevron the same way: the shared hook writes the progress on its shell, the one glyph on the row', () => {
    panel(grouped(), [folder()])
    const glyph = header().querySelector<SVGElement>('svg.zen-group-row-chevron')!
    expect(glyph).not.toBeNull()
    expect(glyph.classList.contains('lucide-chevron-right')).toBe(true)
    expect(header().querySelector('svg.lucide-chevron-down')).toBeNull()
    expect(progress()).toBe('')
    const whole = ROW + 2 * (ROW + GAP)
    panel(grouped(), [folder({ collapsed: true })])
    expect(parseFloat(progress())).toBe(1)
    expect(header().querySelector('svg.zen-group-row-chevron')).toBe(glyph)
    const down: Array<{ h: number; p: number }> = []
    act(() => {
      for (let i = 0; i < 600 && frames.size; i++) {
        frame()
        if (frames.size)
          down.push({ h: parseFloat(shell().style.height), p: parseFloat(progress()) })
      }
    })
    expect(down.length).toBeGreaterThan(3)
    for (const { h, p } of down) expect(p).toBeCloseTo((h - ROW) / (whole - ROW), 3)
    for (let i = 1; i < down.length; i++) expect(down[i]!.p).toBeLessThanOrEqual(down[i - 1]!.p)
    // Rested shut and the kept rows gone: the property off, the row's state binding 0.
    expect(progress()).toBe('')
    expect(memberRows()).toEqual([])
    expect(header().getAttribute('aria-expanded')).toBe('false')
    expect(header().querySelector('svg.zen-group-row-chevron')).toBe(glyph)
  })

  it('cuts under reduced motion (§11.3): the height jumps, the block never clipped, the rows gone in the folding commit', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }))
    // The desktop's open folder…
    panel(grouped(), [folder()], 'desktop')
    expect(memberRows()).toEqual(['alpha', 'beta'])
    panel(grouped(), [folder({ collapsed: true })], 'desktop')
    // The spring is asked for the fold and jumps to its target in the same breath: no frame
    // scheduled, the clip on and off within the commit, the kept rows released with it.
    expect(folds()).toEqual([{ from: ROW + 2 * (ROW + GAP), to: ROW }])
    expect(frames.size).toBe(0)
    expect(memberRows()).toEqual([])
    expect(shell().hasAttribute('data-folding')).toBe(false)
    expect(shell().style.height).toBe('')
    expect(header().getAttribute('aria-expanded')).toBe('false')
    // The chevron's cut is the same cut: the hook writes no progress – not the start's, not a
    // frame's, not the hold's – so the header's state binds the rest angle in the folding
    // commit itself (the ruled cut: no frame at a fractional angle).
    expect(progress()).toBe('')
    // …and its saved folder, the same cut over its pages (the unfold that opens it here is a
    // jump of its own; the recorder is cleared after it).
    panel([tab('home')], [folder({ savedTabs: PAGES })], 'desktop')
    expect(pageRows()).toEqual(['ALPHA', 'BETA', 'DELTA'])
    expect(frames.size).toBe(0)
    expect(progress()).toBe('')
    starts.length = 0
    panel([tab('home')], [folder({ savedTabs: PAGES, collapsed: true })], 'desktop')
    expect(folds()).toEqual([{ from: ROW + PAGES.length * (ROW + GAP), to: ROW }])
    expect(frames.size).toBe(0)
    expect(pageRows()).toEqual([])
    expect(shell().hasAttribute('data-folding')).toBe(false)
    expect(shell().style.height).toBe('')
    expect(progress()).toBe('')
    // The tablet's row takes the same cut.
    panel(grouped(), [folder()])
    starts.length = 0
    panel(grouped(), [folder({ collapsed: true })])
    expect(folds()).toEqual([{ from: ROW + 2 * (ROW + GAP), to: ROW }])
    expect(frames.size).toBe(0)
    expect(memberRows()).toEqual([])
    expect(shell().hasAttribute('data-folding')).toBe(false)
    expect(progress()).toBe('')
  })

  it('folds the strip’s chip along `x` (§9.37): the block’s width on SPRING_GENTLE from the chip with its members to the chip alone, the members kept until it rests', () => {
    panel(grouped(), [folder()], 'desktop', 'synced', 'x')
    expect(header().className).toContain('zen-strip-group-chip')
    expect(memberRows()).toEqual(['alpha', 'beta'])
    // The chip draws no chevron (§9.37): nothing along the band turns with the fold.
    expect(header().querySelector('.zen-group-row-chevron')).toBeNull()
    expect(header().querySelector('svg.lucide-chevron-right, svg.lucide-chevron-down')).toBeNull()
    const whole = CHIP + 2 * (STRIP_TAB + GAP)
    panel(grouped(), [folder({ collapsed: true })], 'desktop', 'synced', 'x')
    expect(memberRows()).toEqual(['alpha', 'beta'])
    expect(shell().hasAttribute('data-folding')).toBe(true)
    expect(shell().style.width).toBe(`${whole}px`)
    expect(shell().style.height).toBe('')
    expect(folds()).toEqual([{ from: whole, to: CHIP }])
    act(() => {
      frame()
      frame()
    })
    const mid = parseFloat(shell().style.width)
    expect(mid).toBeLessThan(whole)
    expect(mid).toBeGreaterThan(CHIP)
    expect(memberRows()).toEqual(['alpha', 'beta'])
    settle()
    expect(shell().style.width).toBe('')
    expect(shell().hasAttribute('data-folding')).toBe(false)
    expect(memberRows()).toEqual([])
    // Unfolded: the members back, the width from the chip to the whole.
    starts.length = 0
    panel(grouped(), [folder()], 'desktop', 'synced', 'x')
    expect(memberRows()).toEqual(['alpha', 'beta'])
    expect(shell().style.width).toBe(`${CHIP}px`)
    expect(folds()).toEqual([{ from: CHIP, to: whole }])
    settle()
    expect(shell().style.width).toBe('')
    expect(shell().hasAttribute('data-folding')).toBe(false)
  })
})
