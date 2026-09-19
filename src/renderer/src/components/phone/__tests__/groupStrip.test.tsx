// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, StrictMode, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Folder, PhoneBarPosition, Space, Tab, UIState } from '@shared/types'
import { BLANK_URL } from '@shared/url'
import type { BarHoldHandlers } from '../useBarHold'
import type { PillGestureHandlers } from '../usePillGestures'

/*
 * The tab group strip (TAB-14, MOT-13) rendered for real in the phone bar: (A) its model from
 * the folders; (B) membership, the active mark and the chips' commands; (C) a touch on a chip
 * never reaches the pill's recogniser or the bar's hold; (D) the band variable – the content
 * inset's trigger – changes once per appearance and once per departure, while the tray slides
 * on the spring; (E) chips joining and leaving under StrictMode: one FLIP set, the entrance and
 * exit springs, and the fades of reduced motion.
 */

const SPACE = 'space'
const GROUP = 'g'

const invoke = vi.fn<(name: string, args?: unknown) => Promise<string | null>>(async (name) =>
  name === 'tab.create' ? 'new' : null
)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { PhoneBar } = await import('../PhoneShell')
const { useGroupStrip } = await import('../useGroupStrip')
const {
  GROUP_STRIP_HEIGHT,
  GROUP_STRIP_VAR,
  groupStripFor,
  leavingStripFor,
  newTabAnchor,
  stripKey
} = await import('@renderer/lib/groupStrip')
const { FlipTracker, REDUCED_FADE_MS } = await import('@renderer/lib/motion/flip')
const { phoneBandHeight, phoneBarHeight } = await import('@renderer/lib/gestures/dock')
const { dismissStage, stageStore } = await import('@renderer/lib/gestures/stage')
const { browserStore } = await import('@renderer/lib/ui')

// --- a profile ---------------------------------------------------------------------------------

function tab(id: string, patch: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: SPACE,
    containerId: 'default',
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

const member = (id: string, patch: Partial<Tab> = {}): Tab => tab(id, { folderId: GROUP, ...patch })

const folder: Folder = {
  id: GROUP,
  spaceId: SPACE,
  name: 'Research',
  icon: '📚',
  collapsed: false,
  color: 'blue'
}

/** `tabs` in track order, `active` the active one, in a phone at the bottom dock. */
function stateOf(tabs: Tab[], active: string, folders: Folder[] = [folder]): UIState {
  const space: Space = {
    id: SPACE,
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: tabs.map((t) => t.id),
    activeTabId: active,
    pinnedCollapsed: false
  }
  return {
    platform: 'android',
    capabilities: { windowControls: false },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [space],
    activeSpaceId: SPACE,
    folders: Object.fromEntries(folders.map((f) => [f.id, f])),
    essentialTabIds: [],
    containers: [],
    settings: { ...DEFAULT_SETTINGS, phoneBarPosition: 'bottom' },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: [],
    // The pill reads the translate slice for its chip (an engine that is up, no tab offered).
    translate: { available: true, tabs: {} }
  } as unknown as UIState
}

const three = (active = 'b'): UIState => stateOf([member('a'), member('b'), member('c')], active)
const loose = (): UIState => stateOf([member('a'), member('b'), tab('x')], 'x')

// --- a layout ----------------------------------------------------------------------------------

/** The chips' slot pitch: a 36 chip and its 4 gap. */
const PITCH = 40
/** The scroller's width on this phone. */
const SCROLLER_WIDTH = 200

/**
 * happy-dom lays nothing out: a chip answers `offsetLeft` and `getBoundingClientRect` from this
 * table, by its `data-cell` key, in the scroller's content coordinates – its window position is
 * that less the scroller's offset, as a real layout would have it.
 */
const layout = new Map<string, DOMRect>()
/** Lay the chips of `ids` out in a row, `PITCH` apart. */
const layChips = (ids: string[]): void => {
  layout.clear()
  ids.forEach((id, i) => layout.set(`strip:${id}`, new DOMRect(i * PITCH, 0, 36, 36)))
}
const measured = HTMLElement.prototype.getBoundingClientRect
HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
  const cell = this.closest<HTMLElement>('[data-cell]')
  const rect = cell ? layout.get(cell.getAttribute('data-cell')!) : undefined
  if (!rect) return measured.call(this)
  const scrolled = cell!.closest<HTMLElement>('.zen-group-scroller')?.scrollLeft ?? 0
  return new DOMRect(rect.left - scrolled, rect.top, rect.width, rect.height)
}
Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
  configurable: true,
  get(this: HTMLElement): number {
    const key = this.getAttribute('data-cell')
    return (key && layout.get(key)?.left) || 0
  }
})
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get(this: HTMLElement): number {
    const key = this.getAttribute('data-cell')
    return (key && layout.get(key)?.width) || 0
  }
})
Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get(this: HTMLElement): number {
    return this.classList.contains('zen-group-scroller') ? SCROLLER_WIDTH : 0
  }
})
/** Every programmatic scroll of a scroller: where to and how. */
const scrolls: ScrollToOptions[] = []
HTMLElement.prototype.scrollTo = function (this: HTMLElement, options?: ScrollToOptions | number) {
  if (typeof options !== 'object') return
  scrolls.push(options)
  this.scrollLeft = options.left ?? this.scrollLeft
} as HTMLElement['scrollTo']

/** The translation a cell is drawn with (the tracker's glide). */
const translate = (el: HTMLElement): number => {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style.transform)
  return m ? Number(m[1]) : 0
}
/** The tray's vertical offset, the strip's own slide. */
const slide = (el: HTMLElement): number => {
  const m = /translate3d\(0, (-?[\d.]+)px, 0\)/.exec(el.style.transform)
  return m ? Number(m[1]) : 0
}
const scaleOf = (el: HTMLElement): number => {
  const m = /scale\(([\d.]+)\)/.exec(el.style.transform)
  return m ? Number(m[1]) : 1
}

// --- a clock -----------------------------------------------------------------------------------

let now = 10_000
let nextFrame = 1
const frames = new Map<number, (t: number) => void>()
const elapse = (ms: number): void => {
  now += ms
  vi.advanceTimersByTime(ms)
}
/** One animation frame of every spring in flight. */
const frame = (): void => {
  elapse(16)
  const batch = [...frames.values()]
  frames.clear()
  for (const cb of batch) cb(now)
}
const settleSprings = (): void => {
  for (let i = 0; i < 600 && frames.size; i++) frame()
}
/** Frames pass until `when` holds; how many it took (600 at most). */
const framesUntil = (when: () => boolean): number => {
  let n = 0
  while (!when() && n < 600) {
    act(() => frame())
    n++
  }
  return n
}

beforeEach(() => {
  layout.clear()
  scrolls.length = 0
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
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  act(() => dismissStage())
  browserStore.set({ state: null })
  document.documentElement.style.removeProperty(GROUP_STRIP_VAR)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// --- rendering ---------------------------------------------------------------------------------

let root: Root | null = null
let host: HTMLElement | null = null

const noPill = (): PillGestureHandlers => ({
  onPointerDown: vi.fn(),
  onPointerMove: vi.fn(),
  onPointerUp: vi.fn(),
  onPointerCancel: vi.fn(),
  onClick: vi.fn(),
  onContextMenu: vi.fn(),
  style: {}
})
const noHold = (): BarHoldHandlers => ({
  onPointerDown: vi.fn(),
  onPointerMove: vi.fn(),
  onContextMenu: vi.fn()
})

interface HarnessProps {
  state: UIState
  edge: PhoneBarPosition
  pill: PillGestureHandlers
  hold: BarHoldHandlers
  overviewOpen: boolean
}

/** The bar as the shell mounts it: the strip's presence from the hook, drawn in the bar. */
function Harness({ state, edge, pill, hold, overviewOpen }: HarnessProps): JSX.Element {
  const strip = useGroupStrip(state)
  return createElement(PhoneBar, {
    state,
    edge,
    pill,
    hold,
    strip,
    overviewOpen,
    pillLook: 'docked'
  })
}

let pill = noPill()
let hold = noHold()

/**
 * Rendered under `StrictMode`, as every dev build (the preview host) renders it: React mounts,
 * runs every effect's cleanup and mounts again.
 */
function render(state: UIState, edge: PhoneBarPosition = 'bottom', overviewOpen = false): void {
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    pill = noPill()
    hold = noHold()
  }
  browserStore.set({ state })
  act(() =>
    root!.render(
      createElement(
        StrictMode,
        null,
        createElement(Harness, { state, edge, pill, hold, overviewOpen })
      )
    )
  )
}

const strip = (): HTMLElement | null => host!.querySelector<HTMLElement>('.zen-group-strip')
const tray = (): HTMLElement => host!.querySelector<HTMLElement>('.zen-group-tray')!
const scroller = (): HTMLElement => host!.querySelector<HTMLElement>('.zen-group-scroller')!
const chipOf = (id: string): HTMLElement =>
  host!.querySelector<HTMLElement>(`[data-strip-member="${id}"]`)!
const faceOf = (id: string): HTMLElement =>
  chipOf(id).querySelector<HTMLElement>('.zen-group-chip-face')!
const exitOf = (id: string): HTMLElement | null =>
  host!.querySelector<HTMLElement>(`[data-strip-exit="${id}"]`)
const plusChip = (): HTMLElement => host!.querySelector<HTMLElement>('[data-strip-plus]')!
const showChip = (): HTMLElement => host!.querySelector<HTMLElement>('[data-strip-show]')!
const members = (): string[] =>
  [...host!.querySelectorAll('[data-strip-member]')].map((el) =>
    el.getAttribute('data-strip-member')!
  )
const commands = (): Array<[string, unknown]> =>
  invoke.mock.calls.map(([name, args]) => [name, args] as [string, unknown])
/** The writes of the strip's band variable since `spy` was taken. */
const bandWrites = (spy: ReturnType<typeof vi.spyOn>): string[] =>
  spy.mock.calls.filter(([name]) => name === GROUP_STRIP_VAR).map(([, value]) => String(value))

// --- a finger ----------------------------------------------------------------------------------

const POINTER = 7

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

/** A tap as the browser delivers it: down, up, click. */
function tap(target: HTMLElement): void {
  pointer('pointerdown', target, 20, 20)
  pointer('pointerup', target, 20, 20)
  act(() => target.click())
}

/** A sideways drag of `dx` px that ends on `target`. */
function swipe(target: HTMLElement, dx: number): void {
  pointer('pointerdown', target, 20, 20)
  for (let i = 1; i <= 4; i++) pointer('pointermove', target, 20 + (dx * i) / 4, 20)
  pointer('pointerup', target, 20 + dx, 20)
}

// --- (A) the model -------------------------------------------------------------------------------

describe('the strip model from the folders', () => {
  it('is the active tab’s group with its members in track order, the active one marked', () => {
    const state = stateOf(
      [
        tab('p', { pinned: true, folderId: GROUP }),
        member('a'),
        tab('x'),
        member('b'),
        tab('o', { folderId: 'other' }),
        member('c')
      ],
      'b',
      [folder, { ...folder, id: 'other', name: 'Other' }]
    )
    const model = groupStripFor(state)!
    expect(model.group).toBe(folder)
    // The regular tabs carrying the group's id, in the order of the track: no pinned tab, no
    // loose tab, nothing of another group.
    expect(model.members.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(model.activeTabId).toBe('b')
    // The plus chip files its tab after the last member, so it lands in the group.
    expect(newTabAnchor(model)).toBe('c')
  })

  it('is nothing for a loose tab, or a tab whose group is gone', () => {
    expect(groupStripFor(loose())).toBeNull()
    expect(groupStripFor(stateOf([member('a'), member('b')], 'a', []))).toBeNull()
  })

  it('a strip on its way out shows the group as it stands, none of it active', () => {
    const last = groupStripFor(three('b'))!
    const model = leavingStripFor(loose(), last)
    expect(model.group).toBe(loose().folders[GROUP])
    expect(model.members.map((t) => t.id)).toEqual(['a', 'b'])
    expect(model.activeTabId).toBeNull()
  })

  it('a strip whose group is gone, or left in another space, goes out as it last stood (§11.2)', () => {
    const last = groupStripFor(three('b'))!
    // Dissolved: the folder is gone from the state, and the tabs are loose.
    const dissolved = leavingStripFor(stateOf([tab('a'), tab('b'), tab('c')], 'b', []), last)
    expect(dissolved.group).toBe(last.group)
    expect(dissolved.members).toBe(last.members)
    expect(dissolved.activeTabId).toBeNull()
    // Another space: the group stands, but not here.
    const away = { ...three('b'), activeSpaceId: 'elsewhere' } as UIState
    away.spaces = [
      ...away.spaces,
      { ...away.spaces[0], id: 'elsewhere', name: 'Home', tabIds: ['h'], activeTabId: 'h' }
    ]
    away.tabs.h = tab('h', { spaceId: 'elsewhere' })
    expect(groupStripFor(away)).toBeNull()
    const left = leavingStripFor(away, last)
    expect(left.members).toBe(last.members)
    expect(left.activeTabId).toBeNull()
  })

  it('the key is what the strip draws: two states that show the same strip share it', () => {
    const keyOf = (tabs: Tab[], active = 'b', folders = [folder]): string =>
      stripKey(groupStripFor(stateOf(tabs, active, folders))!)
    const abc = [member('a'), member('b'), member('c')]
    const key = keyOf(abc)
    // Another tab loading, a tick of anything the strip does not show: the same key.
    expect(keyOf([...abc, tab('x', { loading: true })])).toBe(key)
    // The mark moving, a member joining, a favicon or a title arriving, a member loading, a new
    // colour or name for the group: not.
    expect(keyOf(abc, 'a')).not.toBe(key)
    expect(keyOf([...abc, member('d')])).not.toBe(key)
    expect(keyOf([member('a', { favicon: 'data:,a' }), member('b'), member('c')])).not.toBe(key)
    expect(keyOf([member('a', { title: 'Alpha' }), member('b'), member('c')])).not.toBe(key)
    expect(keyOf([member('a', { loading: true }), member('b'), member('c')])).not.toBe(key)
    expect(keyOf(abc, 'b', [{ ...folder, color: 'red' }])).not.toBe(key)
    expect(keyOf(abc, 'b', [{ ...folder, name: 'Reading' }])).not.toBe(key)
  })
})

// --- (B) membership, the active mark, the chips' commands -----------------------------------------

describe('the strip in the bar', () => {
  it('draws a chip per member as a labelled button in the tab order, the active one current (§9.22)', () => {
    layChips(['a', 'b', 'c'])
    render(three('b'))
    expect(strip()!.dataset.phase).toBe('shown')
    expect(members()).toEqual(['a', 'b', 'c'])
    // The band is open by the strip's share.
    expect(document.documentElement.style.getPropertyValue(GROUP_STRIP_VAR)).toBe(
      `${GROUP_STRIP_HEIGHT}px`
    )
    for (const id of ['a', 'b', 'c']) {
      expect(chipOf(id).tagName).toBe('BUTTON')
      expect(chipOf(id).tabIndex).toBe(0)
    }
    expect(chipOf('a').getAttribute('aria-label')).toBe('A')
    expect(chipOf('a').getAttribute('aria-current')).toBeNull()
    expect(chipOf('b').getAttribute('aria-label')).toBe('B, current tab')
    expect(chipOf('b').getAttribute('aria-current')).toBe('true')
    expect(showChip().getAttribute('aria-label')).toBe('Show group, Research')
    expect(plusChip().getAttribute('aria-label')).toBe('New tab in Research')
    // The tray is a group named for TalkBack; the show chip leads, the plus chip closes.
    expect(tray().getAttribute('role')).toBe('group')
    expect(tray().getAttribute('aria-label')).toBe('Tab group, Research')
    const buttons = [...tray().querySelectorAll('button')]
    expect(buttons[0]).toBe(showChip())
    expect(buttons.at(-1)).toBe(plusChip())
    // Window family (§9.29): the strip sits on the bar's window surface.
    expect(strip()!.closest('[data-surface]')?.getAttribute('data-surface')).toBe('window')
  })

  it('a bottom-docked bar has the strip above its row, a top-docked one below', () => {
    layChips(['a', 'b', 'c'])
    render(three(), 'bottom')
    const bar = host!.querySelector<HTMLElement>('.zen-phone-bar')!
    expect(bar.firstElementChild).toBe(strip())
    expect(strip()!.dataset.edge).toBe('bottom')
    render(three(), 'top')
    expect(bar.lastElementChild).toBe(strip())
    expect(strip()!.dataset.edge).toBe('top')
  })

  it('a member chip activates its tab; the active chip does nothing', () => {
    layChips(['a', 'b', 'c'])
    render(three('b'))
    tap(chipOf('a'))
    expect(commands()).toEqual([['tab.activate', { tabId: 'a' }]])
    invoke.mockClear()
    tap(chipOf('b'))
    expect(commands()).toEqual([])
  })

  it('the plus chip opens a new tab in the group, after its last member', async () => {
    layChips(['a', 'b', 'c'])
    render(three('b'))
    // No origin animation here: the surface would grow out of the chip over a captured page.
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }))
    tap(plusChip())
    await act(async () => {})
    expect(commands()).toContainEqual([
      'tab.create',
      { url: BLANK_URL, active: true, afterTabId: 'c' }
    ])
  })

  it('the show-group chip opens the overview on the active tab and reads pressed while it is up', () => {
    layChips(['a', 'b', 'c'])
    render(three('b'))
    expect(showChip().getAttribute('aria-pressed')).toBe('false')
    tap(showChip())
    expect(stageStore.get().overview.phase).not.toBe('closed')
    expect(stageStore.get().overview.heroTabId).toBe('b')
    render(three('b'), 'bottom', true)
    expect(showChip().getAttribute('aria-pressed')).toBe('true')
    // With the overview up a member chip closes it into that tab's card.
    tap(chipOf('c'))
    expect(commands()).toContainEqual(['tab.activate', { tabId: 'c' }])
    expect(stageStore.get().overview.heroTabId).toBe('c')
  })

  it('keeps the active chip in view: at once on arrival, along with the scroller after', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `t${i}`)
    layChips(ids)
    render(
      stateOf(
        ids.map((id) => member(id)),
        't9'
      )
    )
    // t9 is at 360 in a 200 scroller: scrolled so that its far edge and 8 of room are in view.
    expect(scrolls).toEqual([{ left: 360 + 36 + 8 - SCROLLER_WIDTH, behavior: 'auto' }])
    expect(scroller().scrollLeft).toBe(204)
    // t0 becomes active: back to the start, smoothly this time.
    render(
      stateOf(
        ids.map((id) => member(id)),
        't0'
      )
    )
    expect(scrolls.at(-1)).toEqual({ left: 0, behavior: 'smooth' })
    // t3 (120..156, its room to 164) is in view already: nothing scrolls.
    scrolls.length = 0
    render(
      stateOf(
        ids.map((id) => member(id)),
        't3'
      )
    )
    expect(scrolls).toEqual([])
    // t4 (160..196) ends past the fading edge's room: the scroller moves just enough.
    render(
      stateOf(
        ids.map((id) => member(id)),
        't4'
      )
    )
    expect(scrolls).toEqual([{ left: 160 + 36 + 8 - SCROLLER_WIDTH, behavior: 'smooth' }])
  })
})

// --- (C) the strip takes only its own band ---------------------------------------------------------

describe('a touch on the strip', () => {
  it('never reaches the pill’s recogniser or the bar’s hold, and the pill still hears its own', () => {
    layChips(['a', 'b', 'c'])
    render(three('b'))
    // A tap on a member chip, a swipe across the scroller, a tap on the plus and the show chip,
    // a sideways drag that starts on a chip: the chips' own handlers see them…
    tap(chipOf('a'))
    swipe(scroller(), 60)
    swipe(chipOf('c'), -60)
    tap(showChip())
    pointer('pointerdown', plusChip(), 20, 20)
    pointer('pointercancel', plusChip(), 20, 20)
    expect(commands()).toContainEqual(['tab.activate', { tabId: 'a' }])
    // …and nothing of it reached the pill or the row's hold.
    for (const handler of Object.values(pill))
      if (typeof handler === 'function') expect(handler).not.toHaveBeenCalled()
    for (const handler of Object.values(hold)) expect(handler).not.toHaveBeenCalled()
    // The strip's chips lie outside the row the hold listens on.
    const row = host!.querySelector<HTMLElement>('.zen-phone-bar-row')!
    expect(row.contains(strip()!)).toBe(false)
    expect(strip()!.contains(row)).toBe(false)
    // A long-press on a chip opens no context menu (the WebView's selection would take the touch).
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    act(() => {
      chipOf('a').dispatchEvent(menu)
    })
    expect(menu.defaultPrevented).toBe(true)
    // The pill itself still hears a finger: the spies are live.
    const address = host!.querySelector<HTMLElement>('.zen-phone-pill')!
    pointer('pointerdown', address, 100, 20)
    expect(pill.onPointerDown).toHaveBeenCalledTimes(1)
    expect(hold.onPointerDown).toHaveBeenCalledTimes(1)
  })
})

// --- (D) the band opens and closes once; the tray slides on the spring ----------------------------

describe('the strip’s appearance and departure', () => {
  it('opens the band in one step as the tray sets out, slides in on the spring and closes it once the slide out has landed', () => {
    layChips(['a', 'b'])
    render(loose())
    expect(strip()).toBeNull()
    expect(document.documentElement.style.getPropertyValue(GROUP_STRIP_VAR)).toBe('0px')
    const writes = vi.spyOn(document.documentElement.style, 'setProperty')

    // The active tab joins the group: the strip enters from behind the bar's row (below, at the
    // bottom dock), the band open by its share from this very commit.
    render(stateOf([member('a'), member('b'), member('x')], 'x'))
    expect(strip()!.dataset.phase).toBe('entering')
    expect(members()).toEqual(['a', 'b', 'x'])
    expect(bandWrites(writes)).toEqual([`${GROUP_STRIP_HEIGHT}px`])
    expect(slide(tray())).toBe(GROUP_STRIP_HEIGHT)
    expect(tray().style.willChange).toBe('transform')
    // The tray closes in on its slot frame by frame, and the band is not written again.
    const halfway = framesUntil(() => slide(tray()) < GROUP_STRIP_HEIGHT / 2)
    expect(halfway).toBeGreaterThan(0)
    expect(strip()!.dataset.phase).toBe('entering')
    expect(bandWrites(writes)).toHaveLength(1)
    act(() => settleSprings())
    expect(strip()!.dataset.phase).toBe('shown')
    expect(tray().style.transform).toBe('')
    expect(tray().style.willChange).toBe('')
    expect(bandWrites(writes)).toHaveLength(1)

    // The tab leaves its group: the strip stays with the group's remaining chips, none of them
    // current, and slides back behind the row; the band stays open until it has landed.
    render(stateOf([member('a'), member('b'), tab('x')], 'x'))
    expect(strip()!.dataset.phase).toBe('leaving')
    expect(members()).toEqual(['a', 'b'])
    expect(host!.querySelector('[aria-current="true"]')).toBeNull()
    expect(bandWrites(writes)).toHaveLength(1)
    const gone = framesUntil(() => slide(tray()) > GROUP_STRIP_HEIGHT / 2)
    expect(gone).toBeGreaterThan(0)
    expect(strip()!.dataset.phase).toBe('leaving')
    expect(bandWrites(writes)).toHaveLength(1)
    act(() => settleSprings())
    expect(strip()).toBeNull()
    expect(bandWrites(writes)).toEqual([`${GROUP_STRIP_HEIGHT}px`, '0px'])
    expect(document.documentElement.style.getPropertyValue(GROUP_STRIP_VAR)).toBe('0px')
  })

  it('a grouped tab becoming active mid-departure turns the tray round on the same spring', () => {
    layChips(['a', 'b'])
    render(three('a'))
    expect(strip()!.dataset.phase).toBe('shown')
    const writes = vi.spyOn(document.documentElement.style, 'setProperty')
    render(stateOf([member('a'), member('b'), tab('x')], 'x'))
    expect(strip()!.dataset.phase).toBe('leaving')
    framesUntil(() => slide(tray()) > 10)
    const partWay = slide(tray())
    // Back to a member: the strip is simply shown again, its tray turning for home from where it
    // is – with the speed it had, so it overshoots a little first and never reaches the far end.
    render(stateOf([member('a'), member('b'), tab('x')], 'b'))
    expect(strip()!.dataset.phase).toBe('shown')
    expect(chipOf('b').getAttribute('aria-current')).toBe('true')
    let farthest = partWay
    const back = framesUntil(() => {
      farthest = Math.max(farthest, slide(tray()))
      return slide(tray()) < partWay
    })
    expect(back).toBeGreaterThan(0)
    expect(back).toBeLessThan(600)
    expect(farthest).toBeLessThan(GROUP_STRIP_HEIGHT)
    act(() => settleSprings())
    expect(tray().style.transform).toBe('')
    expect(strip()!.dataset.phase).toBe('shown')
    // The band never closed.
    expect(bandWrites(writes)).toEqual([])
  })

  it('at the top dock the tray slides from above the row', () => {
    layChips(['a', 'b'])
    render(loose(), 'top')
    render(stateOf([member('a'), member('b'), member('x')], 'x'), 'top')
    expect(strip()!.dataset.edge).toBe('top')
    expect(slide(tray())).toBe(-GROUP_STRIP_HEIGHT)
    act(() => settleSprings())
    expect(tray().style.transform).toBe('')
  })

  it('a dissolved group takes the strip out as it last stood: the chips it had, none current, the band closing when the slide has landed (§11.2)', () => {
    layChips(['a', 'x'])
    render(stateOf([member('a'), member('x')], 'x'))
    expect(strip()!.dataset.phase).toBe('shown')
    const writes = vi.spyOn(document.documentElement.style, 'setProperty')
    // The group is dissolved: the folder is gone from the state, its tabs loose. The strip has
    // no group to read any more, so it slides out with the last one it drew.
    render(stateOf([tab('a'), tab('x')], 'x', []))
    expect(strip()!.dataset.phase).toBe('leaving')
    expect(members()).toEqual(['a', 'x'])
    expect(host!.querySelector('[aria-current="true"]')).toBeNull()
    expect(showChip().getAttribute('aria-label')).toBe('Show group, Research')
    expect(slide(tray())).toBe(0)
    expect(bandWrites(writes)).toEqual([])
    const gone = framesUntil(() => slide(tray()) > GROUP_STRIP_HEIGHT / 2)
    expect(gone).toBeGreaterThan(0)
    expect(strip()!.dataset.phase).toBe('leaving')
    expect(members()).toEqual(['a', 'x'])
    expect(document.documentElement.style.getPropertyValue(GROUP_STRIP_VAR)).toBe(
      `${GROUP_STRIP_HEIGHT}px`
    )
    act(() => settleSprings())
    expect(strip()).toBeNull()
    expect(bandWrites(writes)).toEqual(['0px'])
  })

  it('a switch of space away from a grouped tab does the same: the strip leaves as it was', () => {
    layChips(['a', 'b'])
    const home = { ...stateOf([member('a'), member('b')], 'b') } as UIState
    render(home)
    expect(strip()!.dataset.phase).toBe('shown')
    // To another space, whose active tab is loose: the group stands, but not here.
    const away = { ...home, activeSpaceId: 'elsewhere' } as UIState
    away.spaces = [
      ...home.spaces,
      { ...home.spaces[0], id: 'elsewhere', name: 'Home', tabIds: ['h'], activeTabId: 'h' }
    ]
    away.tabs = { ...home.tabs, h: tab('h', { spaceId: 'elsewhere' }) }
    render(away)
    expect(strip()!.dataset.phase).toBe('leaving')
    expect(members()).toEqual(['a', 'b'])
    expect(host!.querySelector('[aria-current="true"]')).toBeNull()
    framesUntil(() => slide(tray()) > 10)
    // Back to the space, mid-slide: the strip turns round, b current again.
    render(home)
    expect(strip()!.dataset.phase).toBe('shown')
    expect(chipOf('b').getAttribute('aria-current')).toBe('true')
    act(() => settleSprings())
    expect(strip()!.dataset.phase).toBe('shown')
    expect(tray().style.transform).toBe('')
  })

  it('the band’s height is what the content column leaves free: the row plus the strip’s share', () => {
    expect(phoneBandHeight()).toBe(phoneBarHeight())
    document.documentElement.style.setProperty(GROUP_STRIP_VAR, `${GROUP_STRIP_HEIGHT}px`)
    expect(phoneBandHeight()).toBe(phoneBarHeight() + GROUP_STRIP_HEIGHT)
  })
})

// --- (E) chips joining and leaving under StrictMode (MOT-13) --------------------------------------

describe('a chip joining or leaving the strip', () => {
  it('the members are one FLIP set on the scroller: a chip joining scales in at its slot while the chips after it glide over', () => {
    layChips(['a', 'b', 'c'])
    render(three('a'))
    const commit = vi.spyOn(FlipTracker.prototype, 'commit')
    // d joins between a and b (dropped there in the overview): b and c are laid out a slot over.
    layChips(['a', 'd', 'b', 'c'])
    render(stateOf([member('a'), member('d'), member('b'), member('c')], 'a'))
    expect(members()).toEqual(['a', 'd', 'b', 'c'])
    // Exactly the members went to the one tracker, with the scroller as their root.
    const last = commit.mock.calls.at(-1)!
    expect([...last[0].keys()]).toEqual(['strip:a', 'strip:d', 'strip:b', 'strip:c'])
    expect(last[1]).toBe(scroller())
    // b and c are drawn where they were and glide over; a stays.
    expect(translate(chipOf('b'))).toBe(-PITCH)
    expect(translate(chipOf('c'))).toBe(-PITCH)
    expect(chipOf('a').style.transform).toBe('')
    // d's face sets out small and clear, on its own spring – the cell itself is the tracker's –
    // with the stylesheet's transition (the pressed state's ease) paused while the spring
    // writes, and promoted (`will-change`) for just those frames; the chips at rest are not.
    expect(scaleOf(faceOf('d'))).toBeCloseTo(0.6, 3)
    expect(faceOf('d').style.opacity).toBe('0.000')
    expect(faceOf('d').style.transition).toBe('none')
    expect(faceOf('d').style.willChange).toBe('transform, opacity')
    expect(chipOf('d').style.transform).toBe('')
    for (const id of ['a', 'b', 'c']) {
      expect(faceOf(id).style.transform).toBe('')
      expect(faceOf(id).style.willChange).toBe('')
    }
    // Both run together…
    const midway = framesUntil(() => translate(chipOf('b')) > -PITCH / 2)
    expect(midway).toBeGreaterThan(0)
    expect(scaleOf(faceOf('d'))).toBeGreaterThan(0.6)
    expect(scaleOf(faceOf('d'))).toBeLessThan(1)
    // …and settle clean, the transition back with the face at rest and nothing promoted.
    act(() => settleSprings())
    for (const id of ['a', 'd', 'b', 'c']) {
      expect(chipOf(id).style.transform).toBe('')
      expect(faceOf(id).style.transform).toBe('')
      expect(faceOf(id).style.opacity).toBe('')
      expect(faceOf(id).style.transition).toBe('')
      expect(faceOf(id).style.willChange).toBe('')
    }
  })

  it('sits out a browser state that changes nothing it draws: no render, no chip measured', () => {
    layChips(['a', 'b', 'c'])
    render(three('b'))
    const commit = vi.spyOn(FlipTracker.prototype, 'commit')
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    const chips = [...host!.querySelectorAll<HTMLElement>('[data-strip-member]')]
    // Another tab starts loading, a setting changes: the bar re-renders on each, and the strip
    // is handed the model it had – the tracker commits nothing, no chip is measured.
    render(stateOf([member('a'), member('b'), member('c'), tab('x', { loading: true })], 'b'))
    const three2 = three('b')
    render({ ...three2, settings: { ...three2.settings, theme: 'dark' } } as UIState)
    expect(commit).not.toHaveBeenCalled()
    expect(rect.mock.contexts.filter((el) => chips.includes(el as HTMLElement))).toHaveLength(0)
    // A favicon arriving for a member is drawn: one render, one commit of the whole set.
    render(stateOf([member('a', { favicon: 'data:,a' }), member('b'), member('c')], 'b'))
    expect(commit).toHaveBeenCalledTimes(1)
    expect(chipOf('a').querySelector('img')?.getAttribute('src')).toBe('data:,a')
  })

  it('the cell is the tracker’s alone: the stylesheet eases the face, never the chip (§11)', () => {
    // A transition on the cell's transform would ease each frame of a glide towards the last:
    // a neighbour would jump to its new slot and drift back before it glided (seen frame by frame
    // in the preview host). The pressed squeeze and its ease live on the face instead.
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/assets/main.css'), 'utf8')
    const rule = (selector: string): string => {
      const start = css.indexOf(`\n  ${selector} {`)
      expect(start, `${selector} in main.css`).toBeGreaterThan(-1)
      return css.slice(start, css.indexOf('}', start))
    }
    expect(rule('.zen-group-chip')).not.toMatch(/transition|transform/)
    expect(rule('.zen-group-chip-face')).toMatch(/transition:[^;]*transform 120ms/)
    // The press is v2's .98; and nothing is promoted at rest – `will-change` is the spring's,
    // for the frames it writes (§11).
    expect(rule('.zen-group-chip:active .zen-group-chip-face')).toMatch(/transform: scale\(0\.98\)/)
    expect(rule('.zen-group-chip-face')).not.toMatch(/will-change/)
    expect(rule('.zen-group-chip')).not.toMatch(/will-change/)
    expect(css).not.toMatch(/\n {2}\.zen-group-chip:active \{/)
  })

  it('a chip leaving shrinks out where it stood while the chips after it glide back', () => {
    layChips(['a', 'b', 'c'])
    render(three('a'))
    // b leaves the group (dragged out in the overview): c is laid out a slot back.
    layChips(['a', 'c'])
    render(stateOf([member('a'), tab('b'), member('c')], 'a'))
    expect(members()).toEqual(['a', 'c'])
    expect(translate(chipOf('c'))).toBe(PITCH)
    // b's stand-in is where its slot was, out of the flow, shrinking.
    const exit = exitOf('b')!
    expect(exit).toBeTruthy()
    expect(exit.style.left).toBe(`${PITCH}px`)
    expect(exit.getAttribute('aria-hidden')).toBe('true')
    const face = exit.querySelector<HTMLElement>('.zen-group-chip-face')!
    expect(scaleOf(face)).toBeCloseTo(1, 3)
    expect(face.style.transition).toBe('none')
    expect(face.style.willChange).toBe('transform, opacity')
    const shrinking = framesUntil(() => scaleOf(face) < 0.9)
    expect(shrinking).toBeGreaterThan(0)
    expect(Number(face.style.opacity)).toBeLessThan(1)
    expect(translate(chipOf('c'))).toBeLessThan(PITCH)
    expect(translate(chipOf('c'))).toBeGreaterThan(0)
    act(() => settleSprings())
    expect(exitOf('b')).toBeNull()
    expect(chipOf('c').style.transform).toBe('')
  })

  it('a strip that has just arrived takes its chips as they are: no chip enters twice', () => {
    layChips(['a', 'b'])
    render(loose())
    render(stateOf([member('a'), member('b'), member('x')], 'x'))
    // While the tray slides nothing scales in – the strip as a whole is what appears.
    for (const id of ['a', 'b', 'x']) {
      expect(faceOf(id).style.transform).toBe('')
      expect(chipOf(id).style.transform).toBe('')
    }
    act(() => settleSprings())
    expect(strip()!.dataset.phase).toBe('shown')
    // And now a chip that joins does enter.
    layChips(['a', 'b', 'x', 'y'])
    render(stateOf([member('a'), member('b'), member('x'), member('y')], 'x'))
    expect(scaleOf(faceOf('y'))).toBeCloseTo(0.6, 3)
    for (const id of ['a', 'b', 'x']) expect(faceOf(id).style.transform).toBe('')
    act(() => settleSprings())
    expect(faceOf('y').style.transform).toBe('')
  })

  describe('under reduced motion (§11.3)', () => {
    const proto = HTMLElement.prototype as { animate?: unknown }
    const hadAnimate = proto.animate
    let fades: Array<{ el: HTMLElement; frames: unknown; options: KeyframeAnimationOptions }> = []
    let finish: Array<() => void> = []

    beforeEach(() => {
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }))
      fades = []
      finish = []
      proto.animate = function (
        this: HTMLElement,
        frames: unknown,
        options: KeyframeAnimationOptions
      ): { onfinish: (() => void) | null; cancel: () => void } {
        fades.push({ el: this, frames, options })
        const fade = { onfinish: null as (() => void) | null, cancel: () => undefined }
        finish.push(() => fade.onfinish?.())
        return fade
      }
    })
    afterEach(() => {
      proto.animate = hadAnimate
    })
    const fadesOf = (el: HTMLElement): typeof fades => fades.filter((f) => f.el === el)

    it('the strip appears and leaves as a 120 ms fade in place, the band still once at each end', () => {
      layChips(['a', 'b'])
      render(loose())
      const writes = vi.spyOn(document.documentElement.style, 'setProperty')
      render(stateOf([member('a'), member('b'), member('x')], 'x'))
      expect(strip()!.dataset.phase).toBe('entering')
      expect(tray().style.transform).toBe('')
      expect(frames.size).toBe(0)
      const [appear] = fadesOf(tray())
      expect(appear.frames).toEqual([{ opacity: 0 }, { opacity: 1 }])
      expect(appear.options).toMatchObject({ duration: REDUCED_FADE_MS, fill: 'forwards' })
      expect(bandWrites(writes)).toEqual([`${GROUP_STRIP_HEIGHT}px`])
      act(() => finish.forEach((done) => done()))
      expect(strip()!.dataset.phase).toBe('shown')
      fades = []
      finish = []
      render(stateOf([member('a'), member('b'), tab('x')], 'x'))
      expect(strip()!.dataset.phase).toBe('leaving')
      const [leave] = fadesOf(tray())
      expect(leave.frames).toEqual([{ opacity: 1 }, { opacity: 0 }])
      expect(bandWrites(writes)).toHaveLength(1)
      act(() => finish.forEach((done) => done()))
      expect(strip()).toBeNull()
      expect(bandWrites(writes)).toEqual([`${GROUP_STRIP_HEIGHT}px`, '0px'])
    })

    it('a chip joining fades in at its slot, the chips after it cross-fade into theirs; a chip leaving fades out where it stood', () => {
      layChips(['a', 'b', 'c'])
      render(three('a'))
      layChips(['a', 'd', 'b', 'c'])
      render(stateOf([member('a'), member('d'), member('b'), member('c')], 'a'))
      expect(frames.size).toBe(0)
      // d's face fades in; no scale.
      const [enter] = fadesOf(faceOf('d'))
      expect(enter.frames).toEqual([{ opacity: 0 }, { opacity: 1 }])
      expect(enter.options).toMatchObject({ duration: REDUCED_FADE_MS })
      expect(faceOf('d').style.transform).toBe('')
      // b and c are at their new slots, fading in there rather than gliding.
      for (const id of ['b', 'c']) {
        expect(chipOf(id).style.transform).toBe('')
        expect(fadesOf(chipOf(id))[0]?.frames).toEqual([{ opacity: 0 }, { opacity: 1 }])
      }
      act(() => finish.forEach((done) => done()))
      fades = []
      finish = []
      // d leaves: its stand-in fades out in place over 120 ms, held at the end.
      layChips(['a', 'b', 'c'])
      render(stateOf([member('a'), tab('d'), member('b'), member('c')], 'a'))
      const exit = exitOf('d')!
      const [leave] = fadesOf(exit.querySelector<HTMLElement>('.zen-group-chip-face')!)
      expect(leave.frames).toEqual([{ opacity: 1 }, { opacity: 0 }])
      expect(leave.options).toMatchObject({ duration: REDUCED_FADE_MS, fill: 'forwards' })
      expect(exit.style.left).toBe(`${PITCH}px`)
      act(() => finish.forEach((done) => done()))
      expect(exitOf('d')).toBeNull()
    })
  })
})
