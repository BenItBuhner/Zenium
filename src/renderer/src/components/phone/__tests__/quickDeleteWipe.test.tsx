// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Space, Tab, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'

/*
 * Quick Delete's tab motion on the phone (matrix MOT-24 / HB-07; Chrome 152.0.7977.89's
 * `QuickDeleteController.java:167–259`), sequenced by `quickDeleteClear` around the core's two
 * clears with the real `TabOverview` mounted in happy-dom, the frame loop and the clock cranked
 * by hand: the data goes first and the form with it, the overview opens and lands, the period's
 * tabs are read, their cards depart in place bottom-up by card bottom (a group's as one only
 * when whole), the core is asked to close the tabs only once every exit has rested, the commit
 * that shows the closes takes the exits with the slots, a tab the core kept gets its card back,
 * and the haptic comes last. A tabs clear that fails on the wire strands no exit: every card is
 * sent back and the grid is live again. Without `'tabs'` among the types the submit is the
 * plain clear; under reduced motion the period's cards fade together in place (§11.3), no sweep.
 */

const SPACE = 'space'
const GROUP = 'g'

/** The period's tabs, as the core would answer `privacy.tabsInRange`. */
let inRange: string[] = []
/** What the core was asked, in order, with the departures' state at the moment of each clear. */
let events: string[] = []
let settledAtTabsClear: string[] | null = null
/** Set, the tabs' clear fails on the wire (the IPC rejects) instead of answering. */
let tabsClearFailure: Error | null = null
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name, args) => {
  if (name === 'privacy.tabsInRange') {
    events.push('tabsInRange')
    return [...inRange]
  }
  if (name === 'privacy.clearBrowsingData') {
    const { types } = args as { types: string[] }
    events.push(`clear:${types.join('+')}`)
    if (types.includes('tabs')) settledAtTabsClear = [...departStore.get().settled].sort()
    if (types.includes('tabs') && tabsClearFailure) throw tabsClearFailure
    return { status: 'ok', value: { cleared: types } }
  }
  if (name === 'haptic') events.push(`haptic:${(args as { kind: string }).kind}`)
  return null
})
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { TabOverview } = await import('../TabOverview')
const { clearDepartures, departStore, isHeld } = await import('../departureStore')
const { CLOSE_SHOWN_WAIT_MS, QUICK_DELETE_GRID_CROSSING_MS, quickDeleteClear } =
  await import('../quickDelete')
const { cancelLift } = await import('../useCardLift')
const { layoutAnimations, REDUCED_FADE_MS } = await import('@renderer/lib/motion/flip')
const { FrameDialogHost } = await import('@renderer/lib/portals')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { browserStore, uiStore } = await import('@renderer/lib/ui')
const { stageStore } = await import('@renderer/lib/gestures/stage')
const { resetOverviewPane } = await import('@renderer/lib/privateTabs')

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

const folder: Folder = {
  id: GROUP,
  spaceId: SPACE,
  name: 'Research',
  icon: '📚',
  collapsed: false,
  color: 'blue'
}

/** `tabs` in track order; the first is active. */
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
    settings: { ...DEFAULT_SETTINGS, pinnedCloseBehavior: 'unload' },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: [],
    recentlyClosed: [],
    closingTabIds: [],
    sync: { enabled: false, scope: { openTabs: false } }
  } as unknown as UIState
}

/** Three loose cards and a group of two: a, b on the top row, c under them, the group last. */
const ALL = [
  tab('a'),
  tab('b'),
  tab('c'),
  tab('m1', { folderId: GROUP }),
  tab('m2', { folderId: GROUP })
]
const full = (): UIState => stateOf(ALL)
const without = (ids: string[]): UIState => stateOf(ALL.filter((t) => !ids.includes(t.id)))

/**
 * Where the cells stand, in window coordinates: the grid 100…700 tall; a and b on one row
 * (bottom 250), c on the next (bottom 450), the group card's bottom at the grid's bottom edge
 * (700), its member cards inside it.
 */
const RECTS: Record<string, { y: number; height: number }> = {
  a: { y: 100, height: 150 },
  b: { y: 100, height: 150 },
  c: { y: 300, height: 150 },
  [`group:${GROUP}`]: { y: 500, height: 200 },
  m1: { y: 540, height: 150 },
  m2: { y: 540, height: 150 }
}
const GRID = { y: 100, height: 600 }

const AREA = { x: 0, y: 0, width: 220, height: 600 }

// --- a clock and a frame loop ------------------------------------------------------------------

/** A hand-cranked animation frame: `run(n)` advances the clock 16 ms a frame and runs the callbacks. */
class Frames {
  now = 0
  private queue = new Map<number, (now: number) => void>()
  private seq = 0

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++this.seq
      this.queue.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.queue.delete(id)
    })
    vi.spyOn(performance, 'now').mockImplementation(() => this.now)
  }

  run(n: number): void {
    for (let i = 0; i < n; i++) {
      this.now += 16
      const pending = [...this.queue.values()]
      this.queue.clear()
      for (const cb of pending) cb(this.now)
    }
  }
}

const frames = new Frames()
let root: Root | null = null
let host: HTMLElement | null = null
let rectDescriptor: PropertyDescriptor | undefined
let matchMediaDescriptor: PropertyDescriptor | undefined

/** The async work between one step and the next: a command's answer, a store's notify, a commit. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

/** Run the springs out: the overview lands, the exits rest. */
async function land(): Promise<void> {
  await act(async () => {
    frames.run(150)
  })
  await settle()
}

/** The clock: the wipe's schedule and the runner's waits are timers. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** The phone shell's seat for the overview: mounted while the stage has it, on the browser's state. */
function Host(): JSX.Element | null {
  const state = browserStore.use((s) => s.state)
  const overview = stageStore.use((s) => s.overview)
  if (!state || overview.phase === 'closed') return null
  return <TabOverview state={state} overview={overview} area={AREA} edge="bottom" />
}

/** The browser shows `state`. */
function show(state: UIState): void {
  act(() => browserStore.set({ state }))
}

const grid = (): HTMLElement | null => document.querySelector<HTMLElement>('.zen-overview-grid')
const keys = (): string[] =>
  departStore
    .get()
    .items.map((i) => i.key)
    .sort()
const released = (): string[] => [...departStore.get().released].sort()

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  })
  frames.install()
  inRange = []
  events = []
  settledAtTabsClear = null
  tabsClearFailure = null
  invoke.mockClear()
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
  rectDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect')
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Element): DOMRect {
      const cell = this.getAttribute('data-cell')
      const at = cell ? RECTS[cell] : this.classList.contains('zen-overview-grid') ? GRID : null
      const y = at?.y ?? 0
      const height = at?.height ?? 0
      return {
        x: 0,
        y,
        left: 0,
        top: y,
        width: 200,
        right: 200,
        height,
        bottom: y + height,
        toJSON: () => ({})
      } as DOMRect
    }
  })
  matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')
  uiStore.set({ toasts: [] })
  stageStore.set({
    ...stageStore.get(),
    overview: { phase: 'closed', progress: 0, heroTabId: null, target: 0 }
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      <FrameDialogHost>
        <Host />
      </FrameDialogHost>
    )
  )
})

afterEach(async () => {
  act(() => cancelLift())
  act(() => clearDepartures())
  act(() => root?.unmount())
  layoutAnimations.release()
  root = null
  host?.remove()
  host = null
  uiStore.set({ toasts: [] })
  browserStore.set({ state: null })
  resetOverviewPane()
  stageStore.set({
    ...stageStore.get(),
    overview: { phase: 'closed', progress: 0, heroTabId: null, target: 0 }
  })
  if (rectDescriptor)
    Object.defineProperty(Element.prototype, 'getBoundingClientRect', rectDescriptor)
  if (matchMediaDescriptor) Object.defineProperty(window, 'matchMedia', matchMediaDescriptor)
  else delete (window as unknown as Record<string, unknown>).matchMedia
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  frames.now = 0
})

// --- the sequence ------------------------------------------------------------------------------

describe('quickDeleteClear', () => {
  it('without the Tabs row on, the submit is the plain clear: no switcher, no motion', async () => {
    show(full())
    const dismiss = vi.fn()
    const outcome = await quickDeleteClear({ range: '15min', types: ['history', 'cache'] }, dismiss)
    expect(outcome).toEqual({ status: 'ok', value: { cleared: ['history', 'cache'] } })
    expect(events).toEqual(['clear:history+cache'])
    expect(dismiss).not.toHaveBeenCalled()
    expect(stageStore.get().overview.phase).toBe('closed')
    expect(keys()).toEqual([])
  })

  it('with it on: the data first, the form down, the switcher up and landed, the period read, the cards wiped bottom-up by card bottom – a group as one when whole – the tabs closed once every exit has rested, the exits gone with the slots, the haptic last', async () => {
    show(full())
    inRange = ['b', 'c', 'm1', 'm2']
    const dismiss = vi.fn(() => {
      events.push('dismiss')
    })
    const done = quickDeleteClear({ range: '15min', types: ['history', 'tabs'] }, dismiss)
    await settle()
    // 1. The data goes first (Chrome's `performQuickDelete`), the form with it, then the switcher
    //    is asked for (`navigateToTabSwitcher`); the period is not read before it has landed.
    expect(events).toEqual(['clear:history', 'dismiss'])
    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(stageStore.get().overview.phase).toBe('settling')
    await land()
    expect(stageStore.get().overview.phase).toBe('open')
    await settle()
    expect(events).toEqual(['clear:history', 'dismiss', 'tabsInRange'])
    // 2. The held exits: b and c as cards, the group as ONE (both its tabs are in the period);
    //    nothing over a, which stays. The grid takes no press meanwhile.
    expect(keys()).toEqual(['b', 'c', `group:${GROUP}`])
    expect(departStore.get().items.every(isHeld)).toBe(true)
    expect(grid()?.hasAttribute('inert')).toBe(true)
    expect(released()).toEqual([])
    // 3. Bottom-up by card bottom over the one crossing (250 ms for the grid's height): the
    //    group's card, its bottom at the grid's bottom edge, at once; c (bottom 450 of 100…700) at
    //    104 ms; a and b's row (bottom 250) at 188 ms – the same moment for both, had a been in
    //    the period. (The ticks below read the constant: they hold for any positive crossing.)
    await tick(0)
    expect(released()).toEqual([`group:${GROUP}`])
    await tick(Math.round((250 / 600) * QUICK_DELETE_GRID_CROSSING_MS) - 1)
    expect(released()).toEqual([`group:${GROUP}`])
    await tick(1)
    expect(released()).toEqual(['c', `group:${GROUP}`])
    await tick(
      Math.round((450 / 600) * QUICK_DELETE_GRID_CROSSING_MS) -
        Math.round((250 / 600) * QUICK_DELETE_GRID_CROSSING_MS)
    )
    expect(released()).toEqual(['b', 'c', `group:${GROUP}`])
    // 4. The core is not asked to close while an exit still runs (`closeTabsAndShowPostDeleteFeedback`
    //    at the animation's end): the tabs' clear comes once every exit has rested, and finds
    //    every one of them settled – no card is removed under a running departure.
    expect(events.filter((e) => e.startsWith('clear:tabs'))).toEqual([])
    await land()
    expect(events.at(-1)).toBe('clear:tabs')
    expect(settledAtTabsClear).toEqual(['b', 'c', `group:${GROUP}`])
    // The exits stand, out of view, over the slots the cards still hold, until the browser shows
    // the closes.
    expect(keys()).toEqual(['b', 'c', `group:${GROUP}`])
    expect(grid()?.hasAttribute('inert')).toBe(true)
    // 5. The commit that shows the closes takes the exits with the slots; the grid is free again.
    show(without(['b', 'c', 'm1', 'm2']))
    await settle()
    expect(keys()).toEqual([])
    expect(grid()?.hasAttribute('inert')).toBe(false)
    expect(grid()?.querySelector('[data-cell="a"]')).not.toBeNull()
    expect(grid()?.querySelector('[data-cell="b"]')).toBeNull()
    // 6. The haptic last (Chrome's `showPostDeleteFeedback`), and the merged outcome for the
    //    caller's toast – the form's `clearedToast(range, cleared)`.
    const outcome = await done
    expect(outcome).toEqual({ status: 'ok', value: { cleared: ['history', 'tabs'] } })
    expect(events).toEqual(['clear:history', 'dismiss', 'tabsInRange', 'clear:tabs', 'haptic:dock'])
  })

  it('a group whose tabs are not all in the period keeps its card: the member in range departs as a card of its own', async () => {
    show(full())
    inRange = ['m1']
    const done = quickDeleteClear({ range: '15min', types: ['tabs'] }, () => undefined)
    await settle()
    await land()
    await settle()
    // `types: ['tabs']` alone: no data clear, the period read straight after the landing.
    expect(events).toEqual(['tabsInRange'])
    expect(keys()).toEqual(['m1'])
    await tick(QUICK_DELETE_GRID_CROSSING_MS)
    await land()
    show(without(['m1']))
    await settle()
    expect(keys()).toEqual([])
    await expect(done).resolves.toEqual({ status: 'ok', value: { cleared: ['tabs'] } })
  })

  it('a tab the core kept gets its card back: its exit runs backwards and goes, the card shown again', async () => {
    show(full())
    inRange = ['b', 'c']
    const done = quickDeleteClear({ range: '15min', types: ['tabs'] }, () => undefined)
    await settle()
    await land()
    await settle()
    expect(keys()).toEqual(['b', 'c'])
    await tick(QUICK_DELETE_GRID_CROSSING_MS)
    await land()
    expect(events.at(-1)).toBe('clear:tabs')
    // The core closed b but kept c (it left the period between the read and the close).
    show(without(['b']))
    await settle()
    expect(keys()).toEqual(['c'])
    // The runner waits for the browser to show every close; c never goes, so the wait runs out
    // and c's exit is sent back.
    await tick(CLOSE_SHOWN_WAIT_MS)
    expect([...departStore.get().restoring]).toEqual(['c'])
    await land()
    expect(keys()).toEqual([])
    const card = grid()?.querySelector<HTMLElement>('[data-cell="c"] .zen-overview-card')
    expect(card).not.toBeNull()
    expect(card?.style.opacity).not.toBe('0')
    await expect(done).resolves.toEqual({ status: 'ok', value: { cleared: ['tabs'] } })
    expect(events.at(-1)).toBe('haptic:dock')
  })

  it('a tabs clear that fails on the wire strands nothing: every exit is sent back, the cards shown again, the grid live, the failure the caller’s', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    show(full())
    inRange = ['b', 'c']
    tabsClearFailure = new Error('ipc: channel closed')
    // The rejection is caught the moment it comes, so nothing goes unhandled while the motion
    // still runs; what the runner settled on is read at the end.
    const done = quickDeleteClear({ range: '15min', types: ['tabs'] }, () => undefined).then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    )
    await settle()
    await land()
    await settle()
    expect(keys()).toEqual(['b', 'c'])
    await tick(QUICK_DELETE_GRID_CROSSING_MS)
    await land()
    expect(events).toEqual(['tabsInRange', 'clear:tabs'])
    expect(settledAtTabsClear).toEqual(['b', 'c'])
    // The core closed nothing, so the wait for the closes runs out and BOTH exits are sent back
    // – the same path a kept tab takes – instead of standing settled over cards still open with
    // the grid inert under them.
    expect(keys()).toEqual(['b', 'c'])
    expect(grid()?.hasAttribute('inert')).toBe(true)
    expect([...departStore.get().restoring]).toEqual([])
    await tick(CLOSE_SHOWN_WAIT_MS)
    expect([...departStore.get().restoring].sort()).toEqual(['b', 'c'])
    await land()
    expect(keys()).toEqual([])
    expect(grid()?.hasAttribute('inert')).toBe(false)
    for (const id of ['b', 'c']) {
      const card = grid()?.querySelector<HTMLElement>(`[data-cell="${id}"] .zen-overview-card`)
      expect(card).not.toBeNull()
      expect(card?.style.opacity).not.toBe('0')
    }
    // No haptic – nothing was deleted – and the failure is the form's to show.
    await expect(done).resolves.toEqual({ error: tabsClearFailure })
    expect(events).toEqual(['tabsInRange', 'clear:tabs'])
  })

  it('under reduced motion the period’s cards fade together in place over §11.3’s 120 ms – no sweep, no spring – and the close takes them on its commit', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined
      })
    })
    // happy-dom's Web Animations run on their own clock: a stand-in records each `animate()`
    // and lets the test finish it.
    const proto = HTMLElement.prototype as { animate?: unknown }
    const hadAnimate = proto.animate
    const fades: Array<{ el: HTMLElement; frames: unknown; options: KeyframeAnimationOptions }> = []
    const finish: Array<() => void> = []
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
    try {
      show(full())
      inRange = ['b', 'c', 'm1', 'm2']
      const done = quickDeleteClear({ range: '15min', types: ['history', 'tabs'] }, () => undefined)
      await settle()
      await land()
      await settle()
      expect(events).toEqual(['clear:history', 'tabsInRange'])
      // The same exits as with motion, held – the group as one, whole – …
      expect(keys()).toEqual(['b', 'c', `group:${GROUP}`])
      expect(released()).toEqual([])
      expect(fades).toEqual([])
      // … and NO sweep: the group's card at the grid's bottom edge and b's row at its top set off
      // together on the first tick, where the sweep would have held b back 188 ms.
      await tick(0)
      expect(released()).toEqual(['b', 'c', `group:${GROUP}`])
      // Each fades in place over §11.3's 120 ms on `--zen-ease`, held at 0 – `Departures`'
      // reduced-motion run, no exit spring: b's and c's cards and the group's card, nothing else.
      const exits = fades.filter((f) => f.el.classList.contains('pointer-events-none'))
      expect(exits).toHaveLength(3)
      expect(
        exits.map((f) => (f.el.classList.contains('zen-group') ? 'group' : 'card')).sort()
      ).toEqual(['card', 'card', 'group'])
      for (const fade of exits) {
        expect(fade.frames).toEqual([{ opacity: 1 }, { opacity: 0 }])
        expect(fade.options).toEqual({
          duration: REDUCED_FADE_MS,
          easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
          fill: 'forwards'
        })
      }
      expect(REDUCED_FADE_MS).toBe(120)
      // The close still waits on the motion: with the fades running (the frame loop cranked all
      // it likes – no spring is on it) the core is not asked to close.
      await land()
      expect(events.filter((e) => e.startsWith('clear:tabs'))).toEqual([])
      // The fades finish: every exit rests in place, and the core is asked to close on that –
      // the same commit-gated close as with motion, every exit settled at the ask.
      await act(async () => {
        for (const end of finish) end()
      })
      await settle()
      expect(events.at(-1)).toBe('clear:tabs')
      expect(settledAtTabsClear).toEqual(['b', 'c', `group:${GROUP}`])
      expect(keys()).toEqual(['b', 'c', `group:${GROUP}`])
      // The commit that shows the closes takes the faded exits with the slots.
      show(without(['b', 'c', 'm1', 'm2']))
      await settle()
      expect(keys()).toEqual([])
      expect(grid()?.hasAttribute('inert')).toBe(false)
      await expect(done).resolves.toEqual({
        status: 'ok',
        value: { cleared: ['history', 'tabs'] }
      })
      expect(events).toEqual(['clear:history', 'tabsInRange', 'clear:tabs', 'haptic:dock'])
    } finally {
      proto.animate = hadAnimate
    }
  })
})
