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
import { browserStore, uiStore } from '@renderer/lib/ui'
import { SpacePanel } from '../SpacePanel'

/*
 * The tablet sidebar's tab group rendered for real (TABLET-04; design language v2 §9.36 as
 * amended, §11.4): a full-width 44 row like Zen's folder – the colour dot or the saved ring in
 * the glyph slot, the name at 14, the count as the 13 aside, the chevron on the close column,
 * the tabs indented 24 beneath while open; a tap folds it, the block's height on SPRING_GENTLE
 * with the rows it had kept drawn until the spring rests; a hold brings the group's menu at the
 * finger; a SAVED group – its tabs closed, its pages kept (TAB-16) – as a row with the ring and
 * the count of its pages whose tap opens it; the desktop's row on its own contract (TAB-16's
 * desktop half – desktopGroups.test.tsx), its fold no spring.
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

// happy-dom lays nothing out: the fold reads the block's and the header's `offsetHeight`, so
// the block answers with the rows it holds and the header with the row.
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get(this: HTMLElement): number {
    if (this.classList.contains('zen-group-fold')) {
      const rows = this.querySelectorAll('[data-tab-id]').length
      return ROW + rows * (ROW + GAP)
    }
    if (this.classList.contains('zen-tab')) return ROW
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
  windowKind: 'synced' | 'private' = 'synced'
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
  render(<SpacePanel state={state} space={space} isActive compact={false} />)
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
const memberRows = (): string[] =>
  [...shell().querySelectorAll<HTMLElement>('[data-tab-id]')].map((el) => el.dataset.tabId!)

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
    expect(glyph.style.getPropertyValue('--zen-group-rgb')).toBe('76 141 255')
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
    const chevron = rule('.zen-group-row-chevron')
    expect(chevron).toContain('width: 16px')
    expect(chevron).toContain('margin-right: 14px')
    expect(
      rule(
        ":root[data-form-factor='tablet'] .zen-group-fold > .zen-group-rows > .zen-tab:not(.justify-center)"
      )
    ).toContain('margin-left: 24px')
    expect(rule('.zen-group-fold[data-folding]')).toContain('overflow: hidden')
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

  it('leaves the desktop’s folder row on its own contract: Zen’s 32 header with the group’s glyph and no bar, the fold the state’s alone', () => {
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
    // The desktop's fold is the state's alone: no spring, the rows gone with the state.
    panel(grouped(), [folder({ collapsed: true })], 'desktop')
    expect(folds()).toEqual([])
    expect(memberRows()).toEqual([])
    expect(shell().hasAttribute('data-folding')).toBe(false)
    expect(shell().style.height).toBe('')
  })
})
